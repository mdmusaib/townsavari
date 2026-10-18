const { db } = require('../config/firebaseAdmin');

const USERS_COLLECTION = 'users';
const DRIVERS_COLLECTION = 'drivers';

/**
 * POST /api/v1/users/fcm-token
 * Body: { userId:string, token:string, role?:'RIDER'|'DRIVER' }
 *
 * Persists the device's FCM registration token so the backend can deliver
 * real ride notifications (agent.md Task 7).
 *
 * Tokens are stored on users/{userId}.fcmToken (riders) and, when role is
 * DRIVER, also on drivers/{userId}.fcmToken so ride-request fan-out can find
 * online drivers without a second lookup.
 *
 * NOTE: no auth middleware exists yet (planned pre-production per agent.md).
 * TODO(production): derive userId from a verified auth token.
 */
async function saveFcmToken(req, res, next) {
  try {
    const { userId, token, role } = req.body || {};

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token is required' });
    }

    const cleanId = userId.trim();
    const cleanToken = token.trim();
    const now = new Date().toISOString();

    const writes = [
      db
        .collection(USERS_COLLECTION)
        .doc(cleanId)
        .set({ fcmToken: cleanToken, fcmTokenUpdatedAt: now, updatedAt: now }, { merge: true }),
    ];

    if (role === 'DRIVER') {
      writes.push(
        db
          .collection(DRIVERS_COLLECTION)
          .doc(cleanId)
          .set({ fcmToken: cleanToken, fcmTokenUpdatedAt: now, updatedAt: now }, { merge: true })
      );
    }

    await Promise.all(writes);

    return res.status(200).json({ ok: true, userId: cleanId, role: role || 'RIDER' });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/v1/users/fcm-token
 * Body: { userId:string, role?:'RIDER'|'DRIVER' }
 *
 * Clears a stale/invalid token (e.g. on logout) so the backend stops
 * targeting a device that can no longer receive pushes.
 */
async function clearFcmToken(req, res, next) {
  try {
    const { userId, role } = req.body || {};
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const cleanId = userId.trim();
    const now = new Date().toISOString();

    const writes = [
      db
        .collection(USERS_COLLECTION)
        .doc(cleanId)
        .set({ fcmToken: null, fcmTokenUpdatedAt: now, updatedAt: now }, { merge: true }),
    ];
    if (role === 'DRIVER') {
      writes.push(
        db
          .collection(DRIVERS_COLLECTION)
          .doc(cleanId)
          .set({ fcmToken: null, fcmTokenUpdatedAt: now, updatedAt: now }, { merge: true })
      );
    }
    await Promise.all(writes);

    return res.status(200).json({ ok: true, userId: cleanId });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  saveFcmToken,
  clearFcmToken,
  USERS_COLLECTION,
  DRIVERS_COLLECTION,
};
