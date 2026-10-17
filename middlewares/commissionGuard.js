const { db } = require('../config/firebaseAdmin');
const { loadPricingConfig } = require('../utils/fareCalculator');

const USERS_COLLECTION = 'users';

/**
 * commissionGuard — Express middleware (agent.md §3.3 / Task 9).
 *
 * Reads maxCommissionOwed from systemConfig/global, then checks the
 * driver's commissionOwed balance (users/{driverId}).
 * Returns HTTP 403 when the threshold is exceeded.
 *
 * Driver identity: query ?driverId= or body { driverId }.
 * NOTE: no auth middleware exists yet (planned pre-production per agent.md).
 * TODO(production): derive driverId from verified auth token instead of
 * trusting the client-supplied value.
 */
async function commissionGuard(req, res, next) {
  try {
    const driverId =
      (req.query && req.query.driverId) ||
      (req.body && req.body.driverId);

    if (!driverId || typeof driverId !== 'string' || !driverId.trim()) {
      return res.status(400).json({ error: 'driverId is required' });
    }
    const cleanId = driverId.trim();

    const [pricing, userSnap] = await Promise.all([
      loadPricingConfig(),
      db.collection(USERS_COLLECTION).doc(cleanId).get(),
    ]);

    const maxOwed = pricing.maxCommissionOwed;
    const owed = userSnap.exists ? (userSnap.data().commissionOwed || 0) : 0;

    if (owed > maxOwed) {
      return res.status(403).json({
        error: `Account suspended: unpaid commission ₹${owed} exceeds the allowed limit of ₹${maxOwed}. Please settle your dues to accept new rides.`,
        commissionOwed: owed,
        maxCommissionOwed: maxOwed,
      });
    }

    // Attach for downstream handlers to avoid a re-read.
    req.driverCommission = { driverId: cleanId, commissionOwed: owed, maxCommissionOwed: maxOwed };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { commissionGuard, USERS_COLLECTION };
