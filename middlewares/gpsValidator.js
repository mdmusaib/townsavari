const { haversineKm } = require('../utils/haversine');

// Maximum plausible ground speed for a bike-taxi (agent.md §3.2).
const MAX_SPEED_KMH = 120;

/**
 * Speed check between two fixes.
 * @returns {{speedKmh:number, plausible:boolean}}
 */
function speedBetween(prev, next) {
  const km = haversineKm(
    { lat: prev.lat, lng: prev.lng },
    { lat: next.lat, lng: next.lng }
  );
  const seconds = (next.timestampMs - prev.timestampMs) / 1000;
  if (!(seconds > 0)) return { speedKmh: 0, plausible: true };
  const speedKmh = km / (seconds / 3600);
  return { speedKmh, plausible: speedKmh <= MAX_SPEED_KMH };
}

/**
 * Validate coordinate ranges. Shared by loadPreviousFix and gpsValidator
 * so out-of-range input is rejected before any speed comparison.
 */
function assertValidCoords(lat, lng) {
  if (
    typeof lat !== 'number' || typeof lng !== 'number' ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    const err = new Error('lat/lng must be valid coordinates');
    err.status = 400;
    throw err;
  }
}

/**
 * gpsValidator — Express middleware (agent.md §3.2).
 *
 * Expects { driverId, lat, lng } in the body plus req.driverPrev
 * (previous fix loaded by the controller: { lat, lng, timestampMs }).
 * Validates coords first, then rejects with HTTP 400 when implied
 * speed exceeds MAX_SPEED_KMH.
 */
function gpsValidator(req, res, next) {
  try {
    const { lat, lng } = req.body || {};
    assertValidCoords(lat, lng);

    const prev = req.driverPrev;
    // First-ever fix: nothing to compare against.
    if (!prev) return next();

    const nowMs = Date.now();
    const { speedKmh, plausible } = speedBetween(
      { lat: prev.lat, lng: prev.lng, timestampMs: prev.timestampMs },
      { lat, lng, timestampMs: nowMs }
    );

    if (!plausible) {
      return res.status(400).json({
        error: `Implausible movement rejected: ${speedKmh.toFixed(1)} km/h exceeds ${MAX_SPEED_KMH} km/h limit`,
        speedKmh: Math.round(speedKmh * 10) / 10,
        maxSpeedKmh: MAX_SPEED_KMH,
      });
    }
    return next();
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }
}

module.exports = { gpsValidator, speedBetween, assertValidCoords, MAX_SPEED_KMH };
