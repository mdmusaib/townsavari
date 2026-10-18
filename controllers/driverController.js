const { geohashForLocation } = require('geofire-common');
const { db } = require('../config/firebaseAdmin');
const { expireIfStale, STATUS } = require('./rideController');

const DRIVERS_COLLECTION = 'drivers';
const RIDES_COLLECTION = 'rides';
const USERS_COLLECTION = 'users';

/**
 * Load the driver's previous fix into req.driverPrev for gpsValidator.
 * Previous fix shape: { lat, lng, timestampMs }.
 */
async function loadPreviousFix(req, res, next) {
  try {
    const { driverId } = req.body || {};
    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    const snap = await db.collection(DRIVERS_COLLECTION).doc(driverId.trim()).get();
    if (snap.exists) {
      const d = snap.data();
      if (
        typeof d.lat === 'number' && typeof d.lng === 'number' &&
        typeof d.timestampMs === 'number'
      ) {
        req.driverPrev = { lat: d.lat, lng: d.lng, timestampMs: d.timestampMs };
      }
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/driver/location
 * Body: { driverId, lat, lng }
 * Stores lat/lng, server timestamp, and geohash (geofire-common).
 * Chain: loadPreviousFix -> gpsValidator -> updateLocation
 */
async function updateLocation(req, res, next) {
  try {
    const { driverId, lat, lng } = req.body || {};

    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    if (
      typeof lat !== 'number' || typeof lng !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180
    ) {
      return res.status(400).json({ error: 'lat/lng must be valid coordinates' });
    }

    const timestampMs = Date.now();
    const geohash = geohashForLocation([lat, lng]);

    const doc = {
      lat,
      lng,
      geohash,
      timestampMs,
      updatedAt: new Date(timestampMs).toISOString(),
    };
    await db.collection(DRIVERS_COLLECTION).doc(driverId.trim()).set(doc, { merge: true });

    return res.status(200).json({ driverId: driverId.trim(), ...doc });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/driver/status
 * Body: { driverId, isOnline:boolean, lat?, lng?, fcmToken? }
 *
 * Online/offline switch that also stores the FCM token used to dispatch real
 * ride-request pushes to eligible drivers. Also records the last known fix.
 */
async function setStatus(req, res, next) {
  try {
    const { driverId, isOnline, lat, lng, fcmToken } = req.body || {};
    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({ error: 'isOnline must be a boolean' });
    }

    const timestampMs = Date.now();
    const doc = {
      isOnline,
      statusUpdatedAt: new Date(timestampMs).toISOString(),
      timestampMs,
      updatedAt: new Date(timestampMs).toISOString(),
    };
    if (typeof lat === 'number' && typeof lng === 'number' &&
        Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      doc.lat = lat;
      doc.lng = lng;
      doc.geohash = geohashForLocation([lat, lng]);
    }
    if (typeof fcmToken === 'string' && fcmToken.trim()) {
      doc.fcmToken = fcmToken.trim();
    }

    await db.collection(DRIVERS_COLLECTION).doc(driverId.trim()).set(doc, { merge: true });
    return res.status(200).json({ driverId: driverId.trim(), ...doc });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/driver/available-rides?driverId=...
 * Returns REQUESTED rides that this driver has NOT already dismissed.
 * Expired requests are filtered out so they cannot resurrect.
 * Chain: commissionGuard -> here, so over-limit drivers get 403 first.
 */
async function listAvailableRides(req, res, next) {
  try {
    // No orderBy: keeps the query index-free (where-only needs no composite
    // index). Sort in memory instead — fine at 10-100 rides/day scale.
    const snap = await db
      .collection(RIDES_COLLECTION)
      .where('status', '==', STATUS.REQUESTED)
      .limit(50)
      .get();

    const callerId = req.driverCommission ? req.driverCommission.driverId : null;
    const rides = [];
    for (const doc of snap.docs) {
      const r = doc.data();
      // Only unassigned rides are available.
      if (r.driverId !== null && r.driverId !== undefined) continue;
      // Never re-offer a ride this driver already declined.
      if (Array.isArray(r.dismissedBy) && callerId && r.dismissedBy.includes(callerId)) continue;

      const ride = { id: doc.id, ...r };
      // Drop stale requests (and never show them again).
      const expired = await expireIfStale(ride, doc.ref);
      if (expired) continue;

      rides.push(ride);
    }
    rides.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return res.status(200).json({
      driverId: callerId,
      commissionOwed: req.driverCommission ? req.driverCommission.commissionOwed : null,
      count: rides.length,
      rides,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/driver/stats?driverId=...
 * Today's earnings (cash collected) and completed ride count.
 * Index-free: filter in memory.
 */
async function getStats(req, res, next) {
  try {
    const driverId = (req.query && req.query.driverId) || (req.body && req.body.driverId);
    if (!driverId || !String(driverId).trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    const cleanId = String(driverId).trim();

    const snap = await db
      .collection(RIDES_COLLECTION)
      .where('driverId', '==', cleanId)
      .where('status', '==', STATUS.COMPLETED)
      .limit(200)
      .get();

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    let todayEarnings = 0;
    let completedRides = 0;
    snap.forEach((doc) => {
      const r = doc.data();
      const when = Date.parse(r.completedAt || r.updatedAt || r.createdAt || '');
      if (!Number.isFinite(when) || when < startMs) return;
      completedRides += 1;
      todayEarnings += typeof r.amountCollected === 'number'
        ? r.amountCollected
        : (typeof r.fare === 'number' ? r.fare : 0);
    });

    const userSnap = await db.collection(USERS_COLLECTION).doc(cleanId).get();
    const commissionOwed = userSnap.exists ? (userSnap.data().commissionOwed || 0) : 0;

    return res.status(200).json({
      driverId: cleanId,
      todayEarnings: Math.round(todayEarnings * 100) / 100,
      completedRides,
      commissionOwed: Math.round(commissionOwed * 100) / 100,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/drivers/:driverId
 * Public driver profile used by the rider's "Driver assigned" screen.
 * Merges users/{id} + drivers/{id}; no invented values.
 */
async function getDriverProfile(req, res, next) {
  try {
    const { driverId } = req.params || {};
    if (!driverId || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    const cleanId = driverId.trim();
    const [userSnap, driverSnap] = await Promise.all([
      db.collection(USERS_COLLECTION).doc(cleanId).get(),
      db.collection(DRIVERS_COLLECTION).doc(cleanId).get(),
    ]);
    if (!userSnap.exists && !driverSnap.exists) {
      return res.status(404).json({ error: `Driver ${cleanId} not found` });
    }
    const user = userSnap.exists ? userSnap.data() : {};
    const driver = driverSnap.exists ? driverSnap.data() : {};
    return res.status(200).json({
      id: cleanId,
      name: user.name || driver.name || '',
      phone: user.phone || driver.phone || '',
      rating: typeof user.rating === 'number' ? user.rating : 0,
      vehicleType: driver.vehicleType || user.vehicleType || '',
      vehicleNumber: driver.vehicleNumber || user.vehicleNumber || '',
      isOnline: driver.isOnline === true,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  loadPreviousFix,
  updateLocation,
  setStatus,
  listAvailableRides,
  getStats,
  getDriverProfile,
  DRIVERS_COLLECTION,
  RIDES_COLLECTION,
  USERS_COLLECTION,
};
