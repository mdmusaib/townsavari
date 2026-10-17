const { db } = require('../config/firebaseAdmin');
const { DEFAULT_CONFIG } = require('../config/constants');

const CONFIG_COLLECTION = 'systemConfig';
const CONFIG_DOC = 'global';

const CONFIG_FIELDS = [
  'baseFare',
  'baseDistanceKm',
  'ratePerKm',
  'platformCommissionPercent',
  'maxCommissionOwed',
];

/**
 * Validate a full or partial config payload.
 * Returns { valid:boolean, errors:string[] }.
 */
function validateConfig(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }
  for (const field of CONFIG_FIELDS) {
    if (payload[field] === undefined) continue; // partial update allowed
    const v = payload[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      errors.push(`${field} must be a non-negative number`);
    }
  }
  if (payload.platformCommissionPercent !== undefined && payload.platformCommissionPercent > 100) {
    errors.push('platformCommissionPercent cannot exceed 100');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * GET /api/v1/admin/config
 * Returns the stored config merged over defaults (defaults fill missing fields).
 */
async function getConfig(req, res, next) {
  try {
    const snap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
    const stored = snap.exists ? snap.data() : {};
    return res.status(200).json({
      ...DEFAULT_CONFIG,
      ...stored,
      _source: snap.exists ? 'firestore' : 'defaults',
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/admin/config
 * Creates/merges pricing parameters into systemConfig/global.
 * NOTE: agent.md says to protect with admin authorization before production use.
 * TODO(production): add authMiddleware + admin-role check to this route.
 */
async function updateConfig(req, res, next) {
  try {
    const { valid, errors } = validateConfig(req.body);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid configuration', details: errors });
    }

    const docRef = db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC);
    const updates = { updatedAt: new Date().toISOString() };
    for (const field of CONFIG_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    await docRef.set(updates, { merge: true });

    const snap = await docRef.get();
    return res.status(200).json({ ...DEFAULT_CONFIG, ...snap.data() });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getConfig, updateConfig, validateConfig, CONFIG_COLLECTION, CONFIG_DOC };
