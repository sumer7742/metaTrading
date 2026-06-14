/**
 * In-app notification service — persists a Notification document (so it shows
 * in the user's bell on next login) AND pushes it live over WebSocket on the
 * `user:notifications:<id>` channel (so an online user sees it instantly).
 *
 * The client bell (useNotifications) both fetches persisted notifications and
 * subscribes to that channel, so delivery is reliable online or offline.
 */
const { Notification } = require('../models');
const broadcaster = require('../websocket/server');

const _pushWS = (doc) => {
  try {
    broadcaster.notifyUser(String(doc.userId), 'notifications', {
      _id: String(doc._id),
      type: doc.type,
      title: doc.title,
      message: doc.message,
      link: doc.data?.link || null,
      status: doc.data?.status || 'info',
      createdAt: doc.createdAt,
    });
  } catch (_) { /* never let a WS hiccup break the caller */ }
};

// Send to a single user. Returns the created Notification.
async function sendToUser(userId, { type = 'ANNOUNCEMENT', title, message = '', link = null, status = 'info', data = {}, createdBy } = {}) {
  const doc = await Notification.create({
    userId,
    type,
    title,
    message,
    data: { ...data, link: link || null, status },
    channels: ['IN_APP'],
    isRead: false,
    createdBy: createdBy || undefined,
  });
  _pushWS(doc);
  return doc;
}

// Fan-out to many users (bulk insert + per-user live push). Returns the count.
async function sendToUsers(userIds, { type = 'ANNOUNCEMENT', title, message = '', link = null, status = 'info', data = {}, createdBy } = {}) {
  const ids = (userIds || []).filter(Boolean);
  if (!ids.length) return 0;
  const base = {
    type, title, message,
    data: { ...data, link: link || null, status },
    channels: ['IN_APP'], isRead: false, createdBy: createdBy || undefined,
  };
  const created = await Notification.insertMany(ids.map((userId) => ({ ...base, userId })));
  for (const doc of created) _pushWS(doc);
  return created.length;
}

module.exports = { sendToUser, sendToUsers };
