const { db, admin } = require('../config/firebaseAdmin');
const { estimateFare, loadPricingConfig } = require('../utils/fareCalculator');
const { sendToUser, sendToTokens } = require('../utils/notificationService');

const RIDES_COLLECTION = 'rides';
const USERS_COLLECTION = 'users';
const DRIVERS_COLLECTION = 'drivers';

// Ride lifecycle (single source of truth for status values).
const STATUS = {
  REQUESTED: 'REQUESTED',
  ACCEPTED: 'ACCEPTED',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

// A REQUESTED ride nobody accepts within this window is stale and expires,
// so it can never resurrect as a "notification" hours later.
const REQUEST_EXPIRY_MINUTES = 8;

const round2 = (n) => Math.round(n * 100) / 100;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Mark a REQUESTED ride as EXPIRED when it is older than the accept window.
 * Returns true when the document was (this call) transitioned to EXPIRED.
 * Idempotent and safe to call from read paths.
 */
async function expireIfStale(ride, docRef) {
  if (!ride || ride.status !== STATUS.REQUESTED) return false;
  const createdMs = Date.parse(ride.createdAt || '');
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = Date.now() - createdMs;
  if (ageMs < REQUEST_EXPIRY_MINUTES * 60 * 1000) return false;

  const now = new Date().toISOString();
  try {
    await docRef.update({
      status: STATUS.EXPIRED,
      expiredAt: now,
      updatedAt: now,
    });
    ride.status = STATUS.EXPIRED;
    ride.expiredAt = now;
    ride.updatedAt = now;
    return true;
  } catch (err) {
    // Another writer already changed the doc — re-read wins.
    console.warn(`[rides] expire race for ${docRef.id}: ${err.message}`);
    return false;
  }
}

/**
 * Attach the assigned driver's public profile to a ride response so the rider
 * gets driver identity from the backend instead of any client-side mock.
 */
async function attachDriverProfile(ride) {
  if (!ride || !ride.driverId) return ride;
  try {
    const [userSnap, driverSnap] = await Promise.all([
      db.collection(USERS_COLLECTION).doc(String(ride.driverId)).get(),
      db.collection(DRIVERS_COLLECTION).doc(String(ride.driverId)).get(),
    ]);
    const user = userSnap.exists ? userSnap.data() : {};
    const driver = driverSnap.exists ? driverSnap.data() : {};
    return {
      ...ride,
      driver: {
        id: String(ride.driverId),
        name: user.name || driver.name || '',
        phone: user.phone || driver.phone || '',
        rating: typeof user.rating === 'number' ? user.rating : 0,
        vehicleType: driver.vehicleType || user.vehicleType || '',
        vehicleNumber: driver.vehicleNumber || user.vehicleNumber || '',
      },
    };
  } catch (err) {
    console.warn(`[rides] driver profile lookup failed: ${err.message}`);
    return ride;
  }
}

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
 * Creates a ride in REQUESTED state with a server-calculated fare estimate,
 * then dispatches it to eligible online drivers (FCM, best effort) and records
 * which drivers were notified so the same request is never double-sent.
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
      status: STATUS.REQUESTED,
      paymentStatus: 'UNPAID',
      pickup,
      dropoff,
      distanceKm: estimate.distanceKm,
      distanceMeters: estimate.distanceMeters,
      durationSeconds: estimate.durationSeconds,
      distanceSource: estimate.distanceSource,
      fare: estimate.fare,
      commission: estimate.commission,
      commissionPercent: estimate.breakdown ? estimate.breakdown.platformCommissionPercent : null,
      breakdown: estimate.breakdown || null,
      dismissedBy: [],
      notifiedDriverIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const docRef = await db.collection(RIDES_COLLECTION).add(rideData);

    // Fire-and-forget: a push failure must never fail the ride request.
    dispatchRideToOnlineDrivers(docRef.id, { id: docRef.id, ...rideData });

    return res.status(201).json({ id: docRef.id, ...rideData });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/rides/:rideId
 * Public ride status poll used by the rider app while searching / on trip.
 */
async function getRide(req, res, next) {
  try {
    const { rideId } = req.params || {};
    if (!rideId || !rideId.trim()) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    const ref = db.collection(RIDES_COLLECTION).doc(rideId.trim());
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: `Ride ${rideId} not found` });
    }
    const ride = { id: snap.id, ...snap.data() };
    await expireIfStale(ride, ref);
    return res.status(200).json(await attachDriverProfile(ride));
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
        throw httpError(404, `Ride ${rideId} not found`);
      }

      const ride = snap.data();
      // Guard: only a fresh request with no driver can be accepted.
      if (ride.status !== STATUS.REQUESTED || (ride.driverId !== null && ride.driverId !== undefined)) {
        throw httpError(
          409,
          `Ride ${rideId} is no longer available (status: ${ride.status || 'unknown'})`
        );
      }

      const now = new Date().toISOString();
      const update = {
        driverId: driverId.trim(),
        status: STATUS.ACCEPTED,
        acceptedAt: now,
        updatedAt: now,
      };
      tx.update(rideRef, update);
      acceptedRide = { id: snap.id, ...ride, ...update };
    });

    // Fire-and-forget notifications (never fail the accept).
    sendToUser(
      acceptedRide.riderId,
      'Driver found! 🛵',
      'Your driver accepted the ride and is on the way.',
      { rideId: acceptedRide.id, type: 'RIDE_ACCEPTED', driverId: acceptedRide.driverId }
    );

    return res.status(200).json(await attachDriverProfile(acceptedRide));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
}

/**
 * POST /api/v1/rides/reject   (driver declines an offered request)
 * Body: { rideId:string, driverId:string }
 *
 * Marks the ride as dismissed for that driver so it is never offered again.
 * Does NOT change the ride status; another driver can still accept it.
 */
async function rejectRide(req, res, next) {
  try {
    const { rideId, driverId } = req.body || {};
    if (!rideId || !rideId.trim()) {
      return res.status(400).json({ error: 'rideId is required' });
    }
    if (!driverId || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    const ref = db.collection(RIDES_COLLECTION).doc(rideId.trim());
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: `Ride ${rideId} not found` });
    }
    const ride = snap.data();
    if (ride.driverId) {
      return res.status(409).json({ error: 'Ride is already assigned' });
    }
    await ref.update({
      dismissedBy: admin.firestore.FieldValue.arrayUnion(driverId.trim()),
      updatedAt: new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, rideId: rideId.trim(), driverId: driverId.trim() });
  } catch (err) {
    return next(err);
  }
}

/**
 * Shared driver-only transition helper: verifies ownership + allowed source
 * status, then atomically advances the ride to `toStatus`.
 */
async function driverTransition(rideId, driverId, allowedFrom, toStatus, extraFields = {}) {
  const ref = db.collection(RIDES_COLLECTION).doc(rideId);
  let updated;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, `Ride ${rideId} not found`);
    const ride = snap.data();
    if (ride.driverId !== driverId) {
      throw httpError(403, 'Driver does not own this ride');
    }
    if (!allowedFrom.includes(ride.status)) {
      throw httpError(409, `Ride ${rideId} cannot move to ${toStatus} (status: ${ride.status || 'unknown'})`);
    }
    const now = new Date().toISOString();
    const update = { status: toStatus, updatedAt: now, ...extraFields(now) };
    tx.update(ref, update);
    updated = { id: snap.id, ...ride, ...update };
  });
  return updated;
}

/**
 * POST /api/v1/rides/arrived   (driver reached pickup)
 * Body: { rideId, driverId }
 */
async function arrivedRide(req, res, next) {
  try {
    const { rideId, driverId } = req.body || {};
    if (!rideId || !rideId.trim()) return res.status(400).json({ error: 'rideId is required' });
    if (!driverId || !driverId.trim()) return res.status(400).json({ error: 'driverId is required' });

    const ride = await driverTransition(
      rideId.trim(), driverId.trim(), [STATUS.ACCEPTED], STATUS.ARRIVED,
      (now) => ({ arrivedAt: now })
    );

    sendToUser(ride.riderId, 'Driver arrived 📍', 'Your driver has arrived at the pickup point.', {
      rideId: ride.id, type: 'RIDE_ARRIVED', driverId: ride.driverId,
    });
    return res.status(200).json(ride);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * POST /api/v1/rides/start   (driver starts the trip)
 * Body: { rideId, driverId }
 */
async function startRide(req, res, next) {
  try {
    const { rideId, driverId } = req.body || {};
    if (!rideId || !rideId.trim()) return res.status(400).json({ error: 'rideId is required' });
    if (!driverId || !driverId.trim()) return res.status(400).json({ error: 'driverId is required' });

    const ride = await driverTransition(
      rideId.trim(), driverId.trim(), [STATUS.ARRIVED, STATUS.ACCEPTED], STATUS.IN_PROGRESS,
      (now) => ({ startedAt: now, startTime: now })
    );

    sendToUser(ride.riderId, 'Trip started 🛵', 'You are on the way to your destination.', {
      rideId: ride.id, type: 'RIDE_STARTED', driverId: ride.driverId,
    });
    return res.status(200).json(ride);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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

    let result;

    await db.runTransaction(async (tx) => {
      // ALL READS FIRST (Firestore requirement), then all writes.
      const rideSnap = await tx.get(rideRef);
      if (!rideSnap.exists) {
        throw httpError(404, `Ride ${cleanRideId} not found`);
      }
      const driverSnap = await tx.get(driverRef);
      const ride = rideSnap.data();

      // Ownership ALWAYS enforced — even on idempotent replays, so a
      // stranger can't probe another driver's completed ride details.
      if (ride.driverId !== cleanDriverId) {
        throw httpError(403, 'Driver does not own this ride');
      }

      // Idempotency: already completed -> return state, charge nothing.
      if (ride.status === STATUS.COMPLETED) {
        const owed = driverSnap.exists ? (driverSnap.data().commissionOwed || 0) : 0;
        result = {
          id: rideSnap.id, ...ride,
          commissionCharged: 0, alreadyCompleted: true,
          driverCommissionOwed: round2(owed),
        };
        return;
      }

      if (![STATUS.ACCEPTED, STATUS.ARRIVED, STATUS.IN_PROGRESS].includes(ride.status)) {
        throw httpError(409, `Ride ${cleanRideId} cannot be completed (status: ${ride.status || 'unknown'})`);
      }

      // Server-calculated commission on cash actually collected.
      const fare = round2(amountCollected);
      const commission = round2((fare * commissionPct) / 100);

      const now = new Date().toISOString();
      tx.update(rideRef, {
        status: STATUS.COMPLETED, paymentStatus: 'PAID',
        amountCollected: fare, fare, commission,
        commissionPercent: commissionPct,
        completedAt: now, endTime: now, updatedAt: now,
      });

      const prevOwed = driverSnap.exists ? (driverSnap.data().commissionOwed || 0) : 0;
      const newOwed = round2(prevOwed + commission);
      tx.set(driverRef, { commissionOwed: newOwed, updatedAt: now }, { merge: true });

      result = {
        id: rideSnap.id, ...ride,
        status: STATUS.COMPLETED, paymentStatus: 'PAID',
        amountCollected: fare, fare, commission,
        commissionPercent: commissionPct,
        completedAt: now, endTime: now, updatedAt: now,
        commissionCharged: commission, alreadyCompleted: false,
        driverCommissionOwed: newOwed,
      };
    });

    // Notify the rider with the server-calculated fare (fire-and-forget).
    sendToUser(
      result.riderId,
      'Trip completed ✅',
      `Fare ₹${result.fare}. Please pay the driver in cash.`,
      { rideId: result.id, type: 'RIDE_COMPLETED', fare: result.fare }
    );

    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return next(err);
  }
}

/**
 * POST /api/v1/rides/cancel
 * Body: { rideId, actorId, actorRole:'RIDER'|'DRIVER', reason? }
 *
 * Only REQUESTED / ACCEPTED / ARRIVED rides can be cancelled (not once the
 * trip is in progress). Ownership is enforced by actorId.
 */
async function cancelRide(req, res, next) {
  try {
    const { rideId, actorId, actorRole, reason } = req.body || {};
    if (!rideId || !rideId.trim()) return res.status(400).json({ error: 'rideId is required' });
    if (!actorId || !actorId.trim()) return res.status(400).json({ error: 'actorId is required' });
    if (actorRole !== 'RIDER' && actorRole !== 'DRIVER') {
      return res.status(400).json({ error: "actorRole must be 'RIDER' or 'DRIVER'" });
    }

    const cleanId = rideId.trim();
    const cleanActor = actorId.trim();
    const ref = db.collection(RIDES_COLLECTION).doc(cleanId);

    let updated;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, `Ride ${cleanId} not found`);
      const ride = snap.data();

      if (actorRole === 'RIDER' && ride.riderId !== cleanActor) {
        throw httpError(403, 'Rider does not own this ride');
      }
      if (actorRole === 'DRIVER' && ride.driverId !== cleanActor) {
        throw httpError(403, 'Driver does not own this ride');
      }
      if (ride.status === STATUS.CANCELLED) {
        updated = { id: snap.id, ...ride, alreadyCancelled: true };
        return;
      }
      if (![STATUS.REQUESTED, STATUS.ACCEPTED, STATUS.ARRIVED].includes(ride.status)) {
        throw httpError(409, `Ride ${cleanId} cannot be cancelled (status: ${ride.status || 'unknown'})`);
      }

      const now = new Date().toISOString();
      const update = {
        status: STATUS.CANCELLED,
        cancelledAt: now,
        cancelledBy: actorRole,
        cancelReason: typeof reason === 'string' ? reason.slice(0, 200) : '',
        updatedAt: now,
      };
      tx.update(ref, update);
      updated = { id: snap.id, ...ride, ...update };
    });

    if (!updated.alreadyCancelled) {
      if (actorRole === 'RIDER' && updated.driverId) {
        sendToUser(updated.driverId, 'Ride cancelled', 'The rider cancelled this ride.', {
          rideId: updated.id, type: 'RIDE_CANCELLED',
        });
      }
      if (actorRole === 'DRIVER') {
        sendToUser(updated.riderId, 'Ride cancelled', 'The driver cancelled this ride.', {
          rideId: updated.id, type: 'RIDE_CANCELLED',
        });
      }
    }

    return res.status(200).json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * POST /api/v1/rides/confirm-payment
 * Body: { rideId, riderId, amount?, method? }
 *
 * Rider confirms cash handover. The collected fare is the server-calculated
 * amount (client amount is informational only). Idempotent.
 */
async function confirmPayment(req, res, next) {
  try {
    const { rideId, riderId } = req.body || {};
    if (!rideId || !rideId.trim()) return res.status(400).json({ error: 'rideId is required' });
    if (!riderId || !riderId.trim()) return res.status(400).json({ error: 'riderId is required' });

    const cleanId = rideId.trim();
    const ref = db.collection(RIDES_COLLECTION).doc(cleanId);
    let result;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw httpError(404, `Ride ${cleanId} not found`);
      const ride = snap.data();
      if (ride.riderId !== riderId.trim()) {
        throw httpError(403, 'Rider does not own this ride');
      }
      if (ride.paymentStatus === 'PAID') {
        result = { id: snap.id, ...ride, alreadyPaid: true };
        return;
      }
      if (ride.status !== STATUS.COMPLETED) {
        throw httpError(409, `Ride ${cleanId} is not completed yet (status: ${ride.status || 'unknown'})`);
      }
      const now = new Date().toISOString();
      const update = {
        paymentStatus: 'PAID',
        paymentMethod: 'cash',
        paymentConfirmedAt: now,
        updatedAt: now,
      };
      tx.update(ref, update);
      result = { id: snap.id, ...ride, ...update };
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * POST /api/v1/rides/rate
 * Body: { rideId, riderId, rating:number(1-5), comment? }
 */
async function rateRide(req, res, next) {
  try {
    const { rideId, riderId, rating, comment } = req.body || {};
    if (!rideId || !rideId.trim()) return res.status(400).json({ error: 'rideId is required' });
    if (!riderId || !riderId.trim()) return res.status(400).json({ error: 'riderId is required' });
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'rating must be a number between 1 and 5' });
    }

    const cleanId = rideId.trim();
    const ref = db.collection(RIDES_COLLECTION).doc(cleanId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: `Ride ${cleanId} not found` });
    const ride = snap.data();
    if (ride.riderId !== riderId.trim()) {
      return res.status(403).json({ error: 'Rider does not own this ride' });
    }
    const now = new Date().toISOString();
    await ref.update({
      rating: round2(rating),
      ratingComment: typeof comment === 'string' ? comment.slice(0, 500) : '',
      ratedAt: now,
      updatedAt: now,
    });
    return res.status(200).json({ ok: true, rideId: cleanId, rating: round2(rating) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
}

/**
 * GET /api/v1/rider/history?riderId=...
 * Returns the rider's rides, newest first. Index-free: filter in memory.
 */
async function riderHistory(req, res, next) {
  try {
    const riderId = (req.query && req.query.riderId) || (req.body && req.body.riderId);
    if (!riderId || !String(riderId).trim()) {
      return res.status(400).json({ error: 'riderId is required' });
    }
    const snap = await db
      .collection(RIDES_COLLECTION)
      .where('riderId', '==', String(riderId).trim())
      .limit(100)
      .get();
    const rides = [];
    snap.forEach((doc) => rides.push({ id: doc.id, ...doc.data() }));
    rides.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.status(200).json({ riderId: String(riderId).trim(), count: rides.length, rides });
  } catch (err) {
    return next(err);
  }
}

/**
 * Fan out a new ride request to eligible online drivers.
 * - Only drivers with isOnline === true AND a registered fcmToken are targeted.
 * - Already-notified drivers are skipped (dedupe), and the ride records them.
 * - Never throws: dispatch failures must not fail the ride request.
 */
async function dispatchRideToOnlineDrivers(rideId, ride) {
  try {
    const snap = await db
      .collection(DRIVERS_COLLECTION)
      .where('isOnline', '==', true)
      .limit(100)
      .get();

    const drivers = [];
    snap.forEach((doc) => {
      const d = doc.data();
      if (d.fcmToken && d.isOnline === true) {
        drivers.push({ driverId: doc.id, token: d.fcmToken });
      }
    });

    const alreadyNotified = new Set(ride.notifiedDriverIds || []);
    const targets = drivers.filter((d) => !alreadyNotified.has(d.driverId));
    if (targets.length === 0) {
      console.log(`[dispatch] ride ${rideId}: no eligible online drivers`);
      return;
    }

    const fare = typeof ride.fare === 'number' ? `₹${ride.fare}` : 'fare pending';
    const result = await sendToTokens(
      targets.map((t) => t.token),
      'New ride request 🛵',
      `${fare} • ${ride.distanceKm ?? '?'} km — tap to accept`,
      { rideId, type: 'RIDE_REQUEST' }
    );

    await db.collection(RIDES_COLLECTION).doc(rideId).update({
      notifiedDriverIds: admin.firestore.FieldValue.arrayUnion(...targets.map((t) => t.driverId)),
      lastDispatchedAt: new Date().toISOString(),
    });
    console.log(`[dispatch] ride ${rideId}: sent ${result.sent}/${result.attempted} (${targets.length} online drivers)`);
  } catch (err) {
    console.warn(`[dispatch] ride ${rideId} failed: ${err.message}`);
  }
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
    const { sendPushNotification } = require('../utils/notificationService');
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

module.exports = {
  estimateRide,
  requestRide,
  getRide,
  acceptRide,
  rejectRide,
  arrivedRide,
  startRide,
  completeRide,
  cancelRide,
  confirmPayment,
  rateRide,
  riderHistory,
  devNotifyTest,
  dispatchRideToOnlineDrivers,
  expireIfStale,
  STATUS,
  RIDES_COLLECTION,
  USERS_COLLECTION,
  DRIVERS_COLLECTION,
};
