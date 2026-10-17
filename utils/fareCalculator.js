const { db } = require('../config/firebaseAdmin');
const { DEFAULT_CONFIG } = require('../config/constants');
const { getRoadDistance } = require('../services/googleMapsService');
const { haversineKm } = require('./haversine');

const CONFIG_COLLECTION = 'systemConfig';
const CONFIG_DOC = 'global';

function isValidCoord(p) {
  return (
    p && typeof p.lat === 'number' && typeof p.lng === 'number' &&
    Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180
  );
}

/**
 * Load live pricing config from Firestore, falling back to defaults.
 */
async function loadPricingConfig() {
  const snap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
  const stored = snap.exists ? snap.data() : {};
  return { ...DEFAULT_CONFIG, ...stored };
}

/**
 * Pure fare math (agent.md §1):
 *   Total Fare = Base Fare + max(0, distanceKm - baseDistanceKm) * ratePerKm
 *   Commission = fare * (platformCommissionPercent / 100)
 */
function computeFare(distanceKm, cfg) {
  const billableKm = Math.max(0, distanceKm - cfg.baseDistanceKm);
  const fare = cfg.baseFare + billableKm * cfg.ratePerKm;
  const commission = fare * (cfg.platformCommissionPercent / 100);
  // Round money to 2 decimals (paise precision).
  const round2 = (n) => Math.round(n * 100) / 100;
  return { billableKm: round2(billableKm), fare: round2(fare), commission: round2(commission) };
}

/**
 * Full fare estimate: road distance via Maps API, fallback to haversine
 * if the Maps call fails (flagged in response so callers know).
 */
async function estimateFare(pickup, dropoff) {
  if (!isValidCoord(pickup) || !isValidCoord(dropoff)) {
    const err = new Error('pickup and dropoff must be {lat:number,lng:number} within valid ranges');
    err.status = 400;
    throw err;
  }

  const cfg = await loadPricingConfig();

  let distanceKm;
  let durationSeconds = 0;
  let distanceSource = 'road';

  try {
    const road = await getRoadDistance(pickup, dropoff);
    distanceKm = road.distanceKm;
    durationSeconds = road.durationSeconds;
  } catch (err) {
    // Fallback only — straight-line distance underestimates real routes,
    // so it must never silently replace road distance.
    console.warn('[fare] Maps API failed, using haversine fallback:', err.message);
    distanceKm = haversineKm(pickup, dropoff);
    distanceSource = 'haversine_fallback';
  }

  const { billableKm, fare, commission } = computeFare(distanceKm, cfg);

  return {
    distanceKm: Math.round(distanceKm * 100) / 100,
    distanceMeters: Math.round(distanceKm * 1000),
    durationSeconds,
    distanceSource,
    fare,
    commission,
    billableKm,
    breakdown: {
      baseFare: cfg.baseFare,
      baseDistanceKm: cfg.baseDistanceKm,
      ratePerKm: cfg.ratePerKm,
      platformCommissionPercent: cfg.platformCommissionPercent,
    },
  };
}

module.exports = { estimateFare, computeFare, loadPricingConfig, isValidCoord };
