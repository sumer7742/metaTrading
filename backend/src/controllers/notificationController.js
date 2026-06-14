/**
 * User-facing in-app notifications (the bell). List the caller's notifications
 * and mark them read. Notifications are created by notificationService (admin
 * sends + system events) and delivered live over WebSocket.
 */
const { Notification } = require('../models');
const { sendSuccess, asyncHandler } = require('../utils/errors');

// Newest-first list for the signed-in user.
const listMine = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const items = await Notification.find({ userId: req.userId })
    .sort({ createdAt: -1 }).limit(limit).lean();
  sendSuccess(res, items);
});

// Mark specific ids read, or all of the caller's notifications when { all: true }.
const markRead = asyncHandler(async (req, res) => {
  const { ids, all } = req.body || {};
  const filter = { userId: req.userId };
  if (!all) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return sendSuccess(res, { updated: 0 });
    filter._id = { $in: list };
  }
  const r = await Notification.updateMany(filter, { $set: { isRead: true } });
  sendSuccess(res, { updated: r.modifiedCount ?? r.nModified ?? 0 });
});

module.exports = { listMine, markRead };
