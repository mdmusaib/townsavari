const { admin, db } = require('../config/firebaseAdmin');

const USERS_COLLECTION = 'users';

/**
 * Send a push notification via Firebase Cloud Messaging (agent.md Task 7).
 *
 * @param {string} fcmToken - device registration token
 * @param {string} title - notification title
 * @param {string} body - notification body
 * @param {Object} [dataPayload={}] - extra string key/values delivered to the app
 * @returns {Promise<{messageId:string}>}
 */
async function sendPushNotification(fcmToken, title, body, dataPayload = {}) {
  if (!fcmToken || typeof fcmToken !== 'string' || !fcmToken.trim()) {
    const err = new Error('fcmToken is required');
    err.status = 400;
    throw err;
  }
  if (!title || typeof title !== 'string') {
    const err = new Error('title is required');
    err.status = 400;
    throw err;
  }

  // FCM data payload values must be strings — coerce defensively.
  const data = {};
  for (const [k, v] of Object.entries(dataPayload || {})) {
    data[String(k)] = v === null || v === undefined ? '' : String(v);
  }

  const message = {
    token: fcmToken.trim(),
    notification: { title, body: body || '' },
    ...(Object.keys(data).length > 0 ? { data } : {}),
    android: {
      priority: 'high',
      notification: { channelId: 'townsavari_rides', sound: 'default' },
    },
  };

  const messageId = await admin.messaging().send(message);
  return { messageId };
}

/**
 * Resolve a single user's FCM token from users/{userId}.fcmToken.
 * Returns null when the user has no registered device token.
 */
async function getFcmToken(userId) {
  if (!userId) return null;
  const snap = await db.collection(USERS_COLLECTION).doc(String(userId)).get();
  if (!snap.exists) return null;
  const token = snap.data().fcmToken;
  return token && typeof token === 'string' && token.trim() ? token.trim() : null;
}

/**
 * Best-effort notification to one user (by id). Never throws — push delivery
 * must not fail the surrounding business operation.
 * @returns {Promise<{sent:boolean, messageId?:string, reason?:string}>}
 */
async function sendToUser(userId, title, body, dataPayload = {}) {
  try {
    const token = await getFcmToken(userId);
    if (!token) return { sent: false, reason: 'no_fcm_token' };
    const { messageId } = await sendPushNotification(token, title, body, dataPayload);
    return { sent: true, messageId };
  } catch (err) {
    console.warn(`[fcm] sendToUser(${userId}) failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

/**
 * Best-effort fan-out to many device tokens. Invalid/expired tokens fail
 * individually and are skipped. Never throws.
 * @returns {Promise<{attempted:number, sent:number, failed:number}>}
 */
async function sendToTokens(tokens, title, body, dataPayload = {}) {
  const unique = [...new Set((tokens || []).filter((t) => t && typeof t === 'string'))];
  let sent = 0;
  let failed = 0;
  const results = await Promise.allSettled(
    unique.map((t) => sendPushNotification(t, title, body, dataPayload))
  );
  for (const r of results) {
    if (r.status === 'fulfilled') sent++;
    else failed++;
  }
  return { attempted: unique.length, sent, failed };
}

module.exports = {
  sendPushNotification,
  sendToUser,
  sendToTokens,
  getFcmToken,
  USERS_COLLECTION,
};
