const { db } = require('../config/firebaseAdmin');
const { estimateFare, loadPricingConfig } = require('../utils/fareCalculator');
const { sendPushNotification } = require('../utils/notificationService');

const RIDES_COLLECTION = 'rides';
const USERS_COLLECTION = 'users';

/**
 * POST /api/v1/rides/estimate
 * Body: { pickup:{lat,lng}, dropoff:{lat,lng} }
 * Returns road distance, estimated fare, and commission breakdown.
 */
async function estimateRide(req, res, next) {
  try {
    const { pickup, dropoff } = req.body || {};
    const result = await estimateFare(pickup, dropoff);
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
}

/**
 * POST /api/v1/rides/request
 * Body: { riderId:string, pickup:{lat,lng}, dropoff:{lat,lng} }
 *
 * Creates a ride in REQUESTED state with a server-calculated fare estimate.
 * (Enabler for the accept -> complete flow; no prior task defined creation.)
 */
async function requestRide(req, res, next) {
  try {
    const { riderId, pickup, dropoff } = req.body || {};

    if (!riderId || typeof riderId !== 'string' || !riderId.trim()) {
      return res.status(400).json({ error: 'riderId is required' });
    }

    let estimate;
    try {
      estimate = await estimateFare(pickup, dropoff);
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const now = new Date().toISOString();
    const rideData = {
      riderId: riderId.trim(),
      driverId: null,
      status: 'REQUESTED',
      paymentStatus: 'UNPAID',
      pickup,
      dropoff,
      distanceKm: estimate.distanceKm,
      distanceMeters: estimate.distanceMeters,
      durationSeconds: estimate.durationSeconds,
      distanceSource: estimate.distanceSource,
      fare: estimate.fare,
      commission: estimate.commission,
      createdAt: now,
      updatedAt: now,
    };
    const docRef = await db.collection(RIDES_COLLECTION).add(rideData);

    return res.status(201).json({ id: docRef.id, ...rideData });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/rides/accept
 * Body: { rideId:string, driverId:string }
 *
 * Atomically assigns the driver to the ride (agent.md §3.1 / Task 5).
 * Accept only if ride.status === 'REQUESTED' AND ride.driverId is null.
 * Otherwise returns HTTP 409 Conflict.
 */
async function acceptRide(req, res, next) {
  try {
    const { rideId, driverId } = req.body || {};

    if (!rideId || typeof rideId !== 'string' || !rideId.trim()) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }

    const rideRef = db.collection(RIDES_COLLECTION).doc(rideId.trim());

    let acceptedRide;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rideRef);
      if (!snap.exists) {
        const err = new Error(`Ride ${rideId} not found`);
        err.status = 404;
        throw err;
      }

      const ride = snap.data();
      // Guard: only a fresh request with no driver can be accepted.
      if (ride.status !== 'REQUESTED' || (ride.driverId !== null && ride.driverId !== undefined)) {
        const err = new Error(
          `Ride ${rideId} is no longer available (status: ${ride.status || 'unknown'})`
        );
        err.status = 409;
        throw err;
      }

      const now = new Date().toISOString();
      const update = {
        driverId: driverId.trim(),
        status: 'ACCEPTED',
        acceptedAt: now,
        updatedAt: now,
      };
      tx.update(rideRef, update);
      acceptedRide = { id: snap.id, ...ride, ...update };
    });

    // Fire-and-forget: never let push failures fail the accept (Task 7).
    notifyRiderOnAccept(acceptedRide);

    return res.status(200).json(acceptedRide);
  } catch (err) {
    if (err.status === 404 || err.status === 409 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
}

/**
 * POST /api/v1/rides/complete
 * Body: { rideId:string, driverId:string, amountCollected:number }
 *
 * Cash settlement + commission ledger (agent.md Task 8).
 * Single Firestore transaction: marks ride COMPLETED/PAID and increments
 * users/{driverId}.commissionOwed by the SERVER-calculated commission.
 * Idempotent: replays return the completed ride with commissionCharged 0.
 */
async function completeRide(req, res, next) {
  try {
    const { rideId, driverId, amountCollected } = req.body || {};

    if (!rideId || typeof rideId !== 'string' || !rideId.trim()) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    if (typeof amountCollected !== 'number' || !Number.isFinite(amountCollected) || amountCollected < 0) {
      return res.status(400).json({ error: 'amountCollected must be a non-negative number' });
    }

    // NOTE: no auth middleware exists yet (planned pre-production per agent.md).
    // Ownership is enforced by matching ride.driverId to the supplied driverId.
    // TODO(production): derive driverId from verified auth token.
    const cleanRideId = rideId.trim();
    const cleanDriverId = driverId.trim();
    const rideRef = db.collection(RIDES_COLLECTION).doc(cleanRideId);
    const driverRef = db.collection(USERS_COLLECTION).doc(cleanDriverId);

    // Live commission % read BEFORE the transaction (all reads inside
    // runTransaction must go through tx.get; the callback may retry).
    const pricing = await loadPricingConfig();
    const commissionPct = pricing.platformCommissionPercent;

    const round2 = (n) => Math.round(n * 100) / 100;
    let result;

    await db.runTransaction(async (tx) => {
      // ALL READS FIRST (Firestore requirement), then all writes.
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) {
        const err = new Error(`Ride ${cleanRideId} not found`);
        err.status = 404;
        throw err;
      }
      const driverSnap = await tx.get(driverRef);
      const ride = rideSnap.data();

      // Ownership ALWAYS enforced — even on idempotent replays, so a
      // stranger can't probe another driver's completed ride details.
      if (ride.driverId !== cleanDriverId) {
        const err = new Error('Driver does not own this ride');
        err.status = 403;
        throw err;
      }

      // Idempotency: already completed -> return state, charge nothing.
      if (ride.status === 'COMPLETED') {
        const owed = driverSnap.exists ? (driverSnap.data().commissionOwed || 0) : 0;
        result = {
          id: rideSnap.id, ...ride,
          commissionCharged: 0, alreadyCompleted: true,
          driverCommissionOwed: round2(owed),
        };
        return;
      }

      if (ride.status !== 'ACCEPTED' && ride.status !== 'IN_PROGRESS') {
        const err = new Error(`Ride ${cleanRideId} cannot be completed (status: ${ride.status || 'unknown'})`);
        err.status = 409;
        throw err;
      }

      // Server-calculated commission on cash actually collected.
      const fare = round2(amountCollected);
      const commission = round2((fare * commissionPct) / 100);

      const now = new Date().toISOString();
      tx.update(rideRef, {
        status: 'COMPLETED', paymentStatus: 'PAID',
        amountCollected: fare, fare, commission,
        commissionPercent: commissionPct,
        completedAt: now, updatedAt: now,
      });

      const prevOwed = driverSnap.exists ? (driverSnap.data().commissionOwed || 0) : 0;
      const newOwed = round2(prevOwed + commission);
      tx.set(driverRef, { commissionOwed: newOwed, updatedAt: now }, { merge: true });

      result = {
        id: rideSnap.id, ...ride,
        status: 'COMPLETED', paymentStatus: 'PAID',
        amountCollected: fare, fare, commission,
        commissionPercent: commissionPct,
        completedAt: now, updatedAt: now,
        commissionCharged: commission, alreadyCompleted: false,
        driverCommissionOwed: newOwed,
      };
    });

    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 404 || err.status === 409 || err.status === 403 || err.status === 400) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
}

/**
 * Fire-and-forget rider notification after a successful accept.
 * Runs AFTER the 200 response so a push failure can never fail the accept.
 * Looks up the rider's FCM token at users/{riderId}.fcmToken.
 */
function notifyRiderOnAccept(ride) {
  (async () => {
    try {
      if (!ride.riderId) {
        console.log('[fcm] skip: ride has no riderId');
        return;
      }
      const userSnap = await db.collection('users').doc(String(ride.riderId)).get();
      const fcmToken = userSnap.exists ? userSnap.data().fcmToken : null;
      if (!fcmToken) {
        console.log(`[fcm] skip: no fcmToken for rider ${ride.riderId}`);
        return;
      }
      const { messageId } = await sendPushNotification(
        fcmToken,
        'Driver found! 🛵',
        `Driver ${ride.driverId} accepted your ride.`,
        { rideId: ride.id, type: 'RIDE_ACCEPTED', driverId: ride.driverId }
      );
      console.log(`[fcm] ride-accepted notification sent to rider ${ride.riderId}: ${messageId}`);
    } catch (err) {
      // Log only — accept already succeeded.
      console.warn('[fcm] ride-accepted notification failed:', err.message);
    }
  })();
}

/**
 * POST /api/v1/dev/notify-test  (DEVELOPMENT ONLY — remove before production)
 * Body: { fcmToken, title?, body? }
 * Sends a test push via FCM. Requires a REAL device token —
 * a mock token cannot prove delivery (agent.md Task 7).
 */
async function devNotifyTest(req, res, next) {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Test route disabled in production' });
    }
    const { fcmToken, title, body } = req.body || {};
    const { messageId } = await sendPushNotification(
      fcmToken,
      title || 'Townsavari test 🔔',
      body || 'Push notifications are working.'
    );
    return res.status(200).json({ ok: true, messageId });
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    // Surface FCM errors (e.g. invalid token) with their message.
    return res.status(502).json({ error: `FCM send failed: ${err.message}` });
  }
}

module.exports = { estimateRide, requestRide, acceptRide, completeRide, devNotifyTest, notifyRiderOnAccept, RIDES_COLLECTION, USERS_COLLECTION };

