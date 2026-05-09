/**
 * Push Notification Service (Firebase Cloud Messaging).
 *
 * Wires to FCM when FCM_SERVER_KEY env var is set; otherwise logs to console.
 *
 * Setup:
 *   1. Create Firebase project, enable Cloud Messaging
 *   2. Get Server Key from Project Settings > Cloud Messaging > Cloud Messaging API (Legacy)
 *   3. Set FCM_SERVER_KEY=<server_key> in .env
 *   4. Mobile/web clients register their FCM device token via POST /api/user/push-tokens
 *
 * For modern setups, migrate to HTTP v1 API with service account JSON.
 */

const User = require('../models/User');

let provider = 'console';

const init = () => {
  if (process.env.FCM_SERVER_KEY) {
    provider = 'fcm';
    console.log('[Push] FCM configured');
  } else {
    console.log('[Push] No FCM_SERVER_KEY - push notifications will be logged to console');
  }
};

/**
 * Send a push notification to a single device token.
 */
const sendToToken = async ({ token, title, body, data }) => {
  if (!token) return;
  if (provider === 'fcm') {
    try {
      const res = await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          Authorization: `key=${process.env.FCM_SERVER_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: token,
          notification: { title, body },
          data: data || {},
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn('[Push] FCM responded:', res.status, text);
      }
    } catch (e) {
      console.error('[Push] FCM send failed:', e.message);
    }
  } else {
    console.log('\n========== PUSH (console mode) ==========');
    console.log(`Token: ${token.slice(0, 20)}...`);
    console.log(`Title: ${title}`);
    console.log(`Body:  ${body}`);
    if (data) console.log('Data:', JSON.stringify(data));
    console.log('=========================================\n');
  }
};

/**
 * Send to all of a user's registered push tokens.
 */
const sendToUser = async ({ userId, title, body, data }) => {
  const user = await User.findById(userId).select('pushTokens').lean();
  if (!user || !user.pushTokens || user.pushTokens.length === 0) return 0;
  for (const t of user.pushTokens) {
    await sendToToken({ token: t.token, title, body, data });
  }
  return user.pushTokens.length;
};

/**
 * Register a device's push token for a user. Idempotent.
 */
const registerToken = async (userId, token, platform = 'unknown') => {
  if (!token) return;
  await User.findByIdAndUpdate(userId, {
    $pull: { pushTokens: { token } },
  });
  await User.findByIdAndUpdate(userId, {
    $push: { pushTokens: { token, platform, registeredAt: new Date() } },
  });
};

const unregisterToken = async (userId, token) => {
  await User.findByIdAndUpdate(userId, { $pull: { pushTokens: { token } } });
};

module.exports = { init, sendToToken, sendToUser, registerToken, unregisterToken };
