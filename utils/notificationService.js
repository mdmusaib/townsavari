const { admin } = require('../config/firebaseAdmin');

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
    android: { priority: 'high' },
  };

  const messageId = await admin.messaging().send(message);
  return { messageId };
}

module.exports = { sendPushNotification };
