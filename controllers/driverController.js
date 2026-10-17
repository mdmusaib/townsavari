const { geohashForLocation } = require('geofire-common');
const { db } = require('../config/firebaseAdmin');

const DRIVERS_COLLECTION = 'drivers';
const RIDES_COLLECTION = 'rides';

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
 * GET /api/v1/driver/available-rides?driverId=...
 * Returns REQUESTED rides (unassigned). Chain: commissionGuard -> here,
 * so over-limit drivers get 403 before seeing any rides (agent.md Task 9).
 */
async function listAvailableRides(req, res, next) {
  try {
    // No orderBy: keeps the query index-free (where-only needs no composite
    // index). Sort in memory instead — fine at 10-100 rides/day scale.
    const snap = await db
      .collection(RIDES_COLLECTION)
      .where('status', '==', 'REQUESTED')
      .limit(50)
      .get();

    const rides = [];
    snap.forEach((doc) => {
      const r = doc.data();
      // Only unassigned rides are available.
      if (r.driverId === null || r.driverId === undefined) {
        rides.push({ id: doc.id, ...r });
      }
    });
    rides.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return res.status(200).json({
      driverId: req.driverCommission ? req.driverCommission.driverId : null,
      commissionOwed: req.driverCommission ? req.driverCommission.commissionOwed : null,
      count: rides.length,
      rides,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { loadPreviousFix, updateLocation, listAvailableRides, DRIVERS_COLLECTION, RIDES_COLLECTION };
