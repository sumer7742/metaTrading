/**
 * Global Alert Popup system.
 *
 *   • User-facing  — pending alerts for the signed-in user + acknowledge.
 *   • Admin-facing — full CRUD, enable/disable, delivery stats + acknowledger
 *                    list. Super Admin = platform-wide; Admin = own subtree.
 *
 * Real-time: every state change publishes a lightweight `alerts:refresh` nudge
 * over WebSocket; clients re-pull /alerts/pending so new alerts appear without
 * a re-login. All targeting/scope filtering is done server-side in `pending`.
 */
const GlobalAlert = require('../models/GlobalAlert');
const AlertAcknowledgement = require('../models/AlertAcknowledgement');
const User = require('../models/User');
const { AuditLog } = require('../models');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { sanitizeHtml } = require('../utils/cms');
const { ROLES } = require('../config/constants');
const broadcaster = require('../websocket/server');
const notificationService = require('../services/notificationService');

const PRIORITIES = ['INFO', 'WARNING', 'CRITICAL'];
const PRIORITY_RANK = { CRITICAL: 0, WARNING: 1, INFO: 2 };
const TARGET_TYPES = ['ALL', 'ROLE', 'USER'];

async function audit(req, action, targetId, metadata = {}) {
  try {
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId, actorRole: req.user?.role, action,
      targetType: 'GLOBAL_ALERT', targetId: targetId != null ? String(targetId) : undefined,
      metadata, ip: req.ip, userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

// Lightweight "something changed, re-pull pending" nudge — public channel both
// the client and admin apps subscribe to.
function broadcastRefresh() {
  try { broadcaster.publish('alerts:refresh', { at: Date.now() }); } catch (_) { /* never break a request */ }
}

// Alerts a given actor may see/manage. Super Admin → all; Admin → only the
// ones they own (their subtree scope).
function manageScope(actor) {
  if (actor.role === ROLES.SUPER_ADMIN) return {};
  return { scopeAdminId: actor._id };
}

/* ─────────────────────────── USER-FACING ─────────────────────────── */

// Active, in-window, targeted, not-yet-suppressed alerts for the caller,
// ordered Critical → Warning → Info (then oldest first).
const pending = asyncHandler(async (req, res) => {
  const u = req.user;
  if (!u) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const now = new Date();

  // Targeting the caller.
  const targetOr = [
    { targetType: 'USER', targetUserIds: u._id },
    { targetType: 'ROLE', targetRoles: u.role },
  ];
  // "All Users" reaches customer (USER) accounts only.
  if (u.role === ROLES.USER) targetOr.push({ targetType: 'ALL' });

  // Hierarchy scope: platform-wide OR the caller's own admin subtree.
  const scopeOr = [{ scopeAdminId: null }];
  if (u.adminId) scopeOr.push({ scopeAdminId: u.adminId });

  const query = {
    isActive: true,
    $and: [
      { $or: [{ startAt: null }, { startAt: { $lte: now } }] },
      { $or: [{ endAt: null }, { endAt: { $gte: now } }] },
      { $or: targetOr },
      { $or: scopeOr },
    ],
  };

  const alerts = await GlobalAlert.find(query).sort({ createdAt: 1 }).lean();
  if (!alerts.length) return sendSuccess(res, []);

  // Suppress non-repeat alerts the user already acknowledged.
  const ids = alerts.map((a) => a._id);
  const acked = new Set(
    (await AlertAcknowledgement.find({ userId: u._id, alertId: { $in: ids } }).distinct('alertId')).map(String)
  );

  const out = alerts
    .filter((a) => a.repeatDisplay || !acked.has(String(a._id)))
    .map((a) => ({
      _id: a._id,
      title: a.title,
      message: a.message,
      priority: a.priority,
      requireAcknowledgement: a.requireAcknowledgement,
      repeatDisplay: a.repeatDisplay,
      createdAt: a.createdAt,
    }))
    .sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (new Date(a.createdAt) - new Date(b.createdAt)));

  sendSuccess(res, out);
});

// Record the user's acknowledgement (idempotent upsert). The popup's only
// action is OK, which always calls this — that is what suppresses redisplay of
// non-repeat alerts and prevents bypassing a required acknowledgement.
const acknowledge = asyncHandler(async (req, res) => {
  const u = req.user;
  if (!u) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  const alert = await GlobalAlert.findById(req.params.id).lean();
  if (!alert) throw new AppError('Alert not found', 404, 'NOT_FOUND');

  await AlertAcknowledgement.updateOne(
    { alertId: alert._id, userId: u._id },
    { $set: { acknowledgedAt: new Date() } },
    { upsert: true }
  );
  audit(req, 'GLOBAL_ALERT_ACK', alert._id, { title: alert.title });
  sendSuccess(res, { ok: true });
});

/* ─────────────────────────── ADMIN-FACING ────────────────────────── */

const adminList = asyncHandler(async (req, res) => {
  const filter = { ...manageScope(req.user) };
  if (PRIORITIES.includes(req.query.priority)) filter.priority = req.query.priority;
  if (req.query.status === 'active') filter.isActive = true;
  if (req.query.status === 'inactive') filter.isActive = false;
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ title: rx }, { message: rx }];
  }

  const items = await GlobalAlert.find(filter).sort({ createdAt: -1 }).lean();
  const ids = items.map((i) => i._id);
  const counts = ids.length
    ? await AlertAcknowledgement.aggregate([
        { $match: { alertId: { $in: ids } } },
        { $group: { _id: '$alertId', c: { $sum: 1 } } },
      ])
    : [];
  const cmap = new Map(counts.map((c) => [String(c._id), c.c]));
  items.forEach((i) => { i.ackCount = cmap.get(String(i._id)) || 0; });
  sendSuccess(res, items);
});

const adminGet = asyncHandler(async (req, res) => {
  const a = await GlobalAlert.findOne({ _id: req.params.id, ...manageScope(req.user) }).lean();
  if (!a) throw new AppError('Alert not found', 404, 'NOT_FOUND');
  sendSuccess(res, a);
});

// Resolve a list of email / ObjectId tokens to in-scope user _ids.
async function resolveTargetUsers(actor, tokensRaw) {
  const tokens = (Array.isArray(tokensRaw) ? tokensRaw : String(tokensRaw || '').split(/[\s,]+/))
    .map((s) => String(s).trim()).filter(Boolean);
  if (!tokens.length) return [];
  const ids = tokens.filter((t) => /^[0-9a-fA-F]{24}$/.test(t));
  const emails = tokens.filter((t) => t.includes('@')).map((e) => e.toLowerCase());
  const or = [];
  if (ids.length) or.push({ _id: { $in: ids } });
  if (emails.length) or.push({ email: { $in: emails } });
  if (!or.length) return [];
  let filter = { $or: or };
  // Admins may only target their own subtree.
  if (actor.role !== ROLES.SUPER_ADMIN) filter = { $and: [filter, { adminId: actor._id }] };
  return User.find(filter).distinct('_id');
}

// Roles an actor may target. Admins can't target other admins / super admins.
function allowedTargetRoles(actor, requested) {
  const wanted = (Array.isArray(requested) ? requested : []).filter((r) => ['USER', 'MANAGER', 'ADMIN'].includes(r));
  if (actor.role === ROLES.SUPER_ADMIN) return wanted;
  return wanted.filter((r) => ['USER', 'MANAGER'].includes(r));
}

// Build the persisted shape from a request body (shared by create + update).
async function buildPayload(req, existing) {
  const b = req.body || {};
  const out = {};

  if (b.title !== undefined || !existing) {
    if (!b.title || !String(b.title).trim()) throw new AppError('Title is required', 400);
    out.title = String(b.title).trim();
  }
  if (b.message !== undefined || !existing) {
    if (!b.message || !String(b.message).trim()) throw new AppError('Message is required', 400);
    out.message = sanitizeHtml(b.message);
  }
  if (b.priority !== undefined) out.priority = PRIORITIES.includes(b.priority) ? b.priority : 'INFO';
  if (b.startAt !== undefined) out.startAt = b.startAt ? new Date(b.startAt) : null;
  if (b.endAt !== undefined) out.endAt = b.endAt ? new Date(b.endAt) : null;
  if (b.requireAcknowledgement !== undefined) out.requireAcknowledgement = b.requireAcknowledgement !== false;
  if (b.repeatDisplay !== undefined) out.repeatDisplay = !!b.repeatDisplay;
  if (b.isActive !== undefined) out.isActive = b.isActive !== false;

  const targetType = b.targetType !== undefined
    ? (TARGET_TYPES.includes(b.targetType) ? b.targetType : 'ALL')
    : (existing ? existing.targetType : 'ALL');
  if (b.targetType !== undefined || !existing) out.targetType = targetType;

  if (b.targetType !== undefined || b.targetRoles !== undefined || b.targetUsers !== undefined || !existing) {
    out.targetRoles = targetType === 'ROLE' ? allowedTargetRoles(req.user, b.targetRoles) : [];
    out.targetUserIds = targetType === 'USER' ? await resolveTargetUsers(req.user, b.targetUsers) : [];
    if (targetType === 'ROLE' && !out.targetRoles.length) throw new AppError('Select at least one role', 400);
    if (targetType === 'USER' && !out.targetUserIds.length) throw new AppError('No matching users found for the given emails / IDs', 400);
  }
  return out;
}

const adminCreate = asyncHandler(async (req, res) => {
  const payload = await buildPayload(req, null);
  payload.scopeAdminId = req.user.role === ROLES.SUPER_ADMIN ? null : req.user._id;
  payload.createdBy = req.userId;
  const doc = await GlobalAlert.create(payload);
  audit(req, 'GLOBAL_ALERT_CREATE', doc._id, { title: doc.title, priority: doc.priority, targetType: doc.targetType });
  broadcastRefresh();
  sendSuccess(res, doc, 201);
});

const adminUpdate = asyncHandler(async (req, res) => {
  const a = await GlobalAlert.findOne({ _id: req.params.id, ...manageScope(req.user) });
  if (!a) throw new AppError('Alert not found', 404, 'NOT_FOUND');
  const payload = await buildPayload(req, a);
  Object.assign(a, payload);
  a.updatedBy = req.userId;
  await a.save();
  audit(req, 'GLOBAL_ALERT_UPDATE', a._id, { title: a.title, priority: a.priority });
  broadcastRefresh();
  sendSuccess(res, a);
});

const adminSetActive = asyncHandler(async (req, res) => {
  const a = await GlobalAlert.findOne({ _id: req.params.id, ...manageScope(req.user) });
  if (!a) throw new AppError('Alert not found', 404, 'NOT_FOUND');
  a.isActive = req.body.isActive !== false;
  a.updatedBy = req.userId;
  await a.save();
  audit(req, a.isActive ? 'GLOBAL_ALERT_ENABLE' : 'GLOBAL_ALERT_DISABLE', a._id, { title: a.title });
  broadcastRefresh();
  sendSuccess(res, { _id: a._id, isActive: a.isActive });
});

const adminDelete = asyncHandler(async (req, res) => {
  const a = await GlobalAlert.findOneAndDelete({ _id: req.params.id, ...manageScope(req.user) });
  if (!a) throw new AppError('Alert not found', 404, 'NOT_FOUND');
  await AlertAcknowledgement.deleteMany({ alertId: a._id });
  audit(req, 'GLOBAL_ALERT_DELETE', a._id, { title: a.title });
  broadcastRefresh();
  sendSuccess(res, { ok: true });
});

// Delivery statistics + the list of users who acknowledged.
const adminStats = asyncHandler(async (req, res) => {
  const a = await GlobalAlert.findOne({ _id: req.params.id, ...manageScope(req.user) }).lean();
  if (!a) throw new AppError('Alert not found', 404, 'NOT_FOUND');

  // Targeted-user count (mirrors the pending-match rules).
  let userMatch;
  if (a.targetType === 'ALL') userMatch = { role: ROLES.USER };
  else if (a.targetType === 'ROLE') userMatch = a.targetRoles.length ? { role: { $in: a.targetRoles } } : { _id: null };
  else userMatch = { _id: { $in: a.targetUserIds || [] } };
  if (a.scopeAdminId && a.targetType !== 'USER') userMatch.adminId = a.scopeAdminId;

  const [targeted, acknowledged, acks] = await Promise.all([
    User.countDocuments(userMatch),
    AlertAcknowledgement.countDocuments({ alertId: a._id }),
    AlertAcknowledgement.find({ alertId: a._id }).sort({ acknowledgedAt: -1 }).limit(500)
      .populate('userId', 'firstName lastName email').lean(),
  ]);

  const acknowledgers = acks.map((k) => ({
    userId: k.userId?._id || null,
    name: [k.userId?.firstName, k.userId?.lastName].filter(Boolean).join(' ') || (k.userId?.email || '—'),
    email: k.userId?.email || '—',
    acknowledgedAt: k.acknowledgedAt,
  }));

  sendSuccess(res, {
    targeted,
    acknowledged,
    pending: Math.max(0, targeted - acknowledged),
    ackRate: targeted ? Math.round((acknowledged / targeted) * 100) : 0,
    acknowledgers,
  });
});

/* ───────────────────────── ADMIN: SEND BELL NOTIFICATION ───────────────────────── */

// Enumerate concrete recipient user _ids for a send (in-scope), mirroring the
// alert targeting rules. Unlike alerts (matched lazily), a notification fans
// out to persisted per-user docs, so we resolve the recipient set up front.
async function resolveRecipients(actor, body) {
  const targetType = TARGET_TYPES.includes(body.targetType) ? body.targetType : 'ALL';
  if (targetType === 'USER') {
    const ids = await resolveTargetUsers(actor, body.targetUsers);
    if (!ids.length) throw new AppError('No matching users found for the given emails / IDs', 400);
    return ids;
  }
  let filter;
  if (targetType === 'ALL') {
    filter = { role: ROLES.USER };
  } else { // ROLE
    const roles = allowedTargetRoles(actor, body.targetRoles);
    if (!roles.length) throw new AppError('Select at least one role', 400);
    filter = { role: { $in: roles } };
  }
  if (actor.role !== ROLES.SUPER_ADMIN) filter.adminId = actor._id;
  return User.find(filter).distinct('_id');
}

const STATUSES = ['info', 'success', 'warning', 'error'];

// Push an in-app bell notification to the targeted users (persisted + live).
const adminNotify = asyncHandler(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) throw new AppError('Title is required', 400);
  if (!b.message || !String(b.message).trim()) throw new AppError('Message is required', 400);

  const recipients = await resolveRecipients(req.user, b);
  const sent = await notificationService.sendToUsers(recipients, {
    type: 'ANNOUNCEMENT',
    title: String(b.title).trim(),
    message: String(b.message).trim(),
    link: b.link ? String(b.link).trim() : null,
    status: STATUSES.includes(b.status) ? b.status : 'info',
    createdBy: req.userId,
  });

  audit(req, 'ADMIN_NOTIFICATION_SEND', null, {
    sent, targetType: b.targetType || 'ALL', title: String(b.title).trim(),
  });
  sendSuccess(res, { sent });
});

module.exports = {
  // user
  pending, acknowledge,
  // admin
  adminList, adminGet, adminCreate, adminUpdate, adminSetActive, adminDelete, adminStats,
  adminNotify,
};
