/**
 * Helpdesk chat service — user ↔ assigned-manager messaging on the
 * existing `ws` broadcaster. Additive; reuses user.managerId for routing
 * and authorization. SuperAdmin can act on / view any conversation.
 */
const mongoose = require('mongoose');
const { Conversation, ChatMessage } = require('../models/Chat');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { AppError } = require('../utils/errors');
const broadcaster = require('../websocket/server');

const systemSettings = require('./systemSettings.service');
const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

// ── Chat file-upload limits (Super-Admin configurable via SystemSetting) ──
//
// Executable / unsafe extensions are ALWAYS blocked, regardless of the
// admin-configured allowlist — a security floor that can't be turned off.
const BLOCKED_EXTENSIONS = [
  'exe', 'bat', 'sh', 'apk', 'msi', 'cmd', 'com', 'scr', 'pif', 'jar',
  'dll', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'ps2', 'psc1',
  'app', 'deb', 'rpm', 'bin', 'gadget', 'msc', 'reg', 'hta', 'cpl', 'inf',
];
const extOf = (name) => { const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; };

// Resolve the global upload config from settings (defaults applied in service).
async function getUploadConfig() {
  const [enabled, maxFileMB, maxTotalMB, maxFiles, allowed, roles] = await Promise.all([
    systemSettings.getSetting('chat.upload.enabled'),
    systemSettings.getSetting('chat.upload.maxFileMB'),
    systemSettings.getSetting('chat.upload.maxTotalMB'),
    systemSettings.getSetting('chat.upload.maxFiles'),
    systemSettings.getSetting('chat.upload.allowedExtensions'),
    systemSettings.getSetting('chat.upload.roles'),
  ]);
  const nn = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
  return {
    enabled: enabled !== false,
    maxFileMB: Number(maxFileMB) > 0 ? Number(maxFileMB) : 5,
    maxTotalMB: nn(maxTotalMB),  // 0 = unlimited
    maxFiles: nn(maxFiles),      // 0 = unlimited
    allowedExtensions: Array.isArray(allowed) ? allowed.map((e) => String(e).toLowerCase().replace(/^\./, '')).filter(Boolean) : [],
    roles: roles && typeof roles === 'object' ? roles : {},
    blockedExtensions: BLOCKED_EXTENSIONS,
  };
}

// Effective limits for a specific role — per-role override wins when > 0,
// else the global value. SUPER_ADMIN maps to the ADMIN bucket but is always
// allowed to upload.
async function getEffectiveUploadConfig(role) {
  const cfg = await getUploadConfig();
  const key = role === 'SUPER_ADMIN' ? 'ADMIN' : role;
  const rc = (cfg.roles && cfg.roles[key]) || {};
  return {
    enabled: cfg.enabled && (role === 'SUPER_ADMIN' || rc.enabled !== false),
    maxFileMB:  Number(rc.maxFileMB)  > 0 ? Number(rc.maxFileMB)  : cfg.maxFileMB,
    maxTotalMB: Number(rc.maxTotalMB) > 0 ? Number(rc.maxTotalMB) : cfg.maxTotalMB,
    maxFiles:   Number(rc.maxFiles)   > 0 ? Number(rc.maxFiles)   : cfg.maxFiles,
    allowedExtensions: cfg.allowedExtensions,
    blockedExtensions: cfg.blockedExtensions,
  };
}

// ── role of a requester WITHIN a conversation ────────────────────────
function roleInConversation(conv, requester) {
  if (String(conv.userId) === String(requester._id)) return 'USER';
  if (requester.role === ROLES.SUPER_ADMIN) return 'SUPER_ADMIN';
  return 'MANAGER';
}

function authorize(conv, requester) {
  if (!conv) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
  if (requester.role === ROLES.SUPER_ADMIN) return true;
  if (String(conv.userId) === String(requester._id)) return true;
  if (conv.managerId && String(conv.managerId) === String(requester._id)) return true;
  throw new AppError('Not allowed', 403, 'FORBIDDEN');
}

function partyIds(conv) {
  const ids = [String(conv.userId)];
  if (conv.managerId) ids.push(String(conv.managerId));
  return ids;
}

// Emit a chat event to every party of the conversation.
function emit(conv, event, payload) {
  const data = { event, conversationId: String(conv._id), ...payload };
  for (const id of partyIds(conv)) {
    broadcaster.notifyUser(id, 'chat', data);
  }
  // Fan out to the shared admin channel too. notifyUser only reaches the user
  // and the assigned manager — a SUPER_ADMIN watching a conversation they
  // aren't the manager of (Support Chats lists ALL conversations for them)
  // would otherwise only see new messages on refresh. Super-admins subscribe
  // to 'admin:chat'; they're never a party, so there's no double delivery.
  broadcaster.publish('admin:chat', data);
}

// ── conversation lifecycle ───────────────────────────────────────────
async function getOrCreateForUser(userId) {
  const user = await User.findById(userId).select('managerId').lean();
  if (!user) throw new AppError('User not found', 404);
  let conv = await Conversation.findOne({ userId });
  if (!conv) {
    conv = await Conversation.create({ userId, managerId: user.managerId || null });
  } else if (String(conv.managerId || '') !== String(user.managerId || '')) {
    // User was (re)assigned — keep the same thread, point it at the new manager.
    conv.managerId = user.managerId || null;
    await conv.save();
  }
  return conv;
}

// Manager (or SuperAdmin) initiates — get-or-create the conversation with a
// specific user. Scoped: SuperAdmin → any user; Manager → only their own
// assigned users (user.managerId must equal the requester). Mirrors the
// authorize() rule so a manager can never open a chat outside their scope.
async function getOrCreateWithUser(targetUserId, requester) {
  const user = await User.findById(targetUserId).select('managerId').lean();
  if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');
  if (requester.role !== ROLES.SUPER_ADMIN) {
    if (!user.managerId || String(user.managerId) !== String(requester._id)) {
      throw new AppError('This user is not assigned to you', 403, 'OUT_OF_SCOPE');
    }
  }
  let conv = await Conversation.findOne({ userId: targetUserId });
  if (!conv) {
    conv = await Conversation.create({ userId: targetUserId, managerId: user.managerId || null });
  } else if (String(conv.managerId || '') !== String(user.managerId || '')) {
    conv.managerId = user.managerId || null;
    await conv.save();
  }
  return conv;
}

async function counterpartInfo(conv, requester) {
  // Whom is the requester talking to? user→manager, manager/super→user.
  const otherId = String(conv.userId) === String(requester._id) ? conv.managerId : conv.userId;
  if (!otherId) return null;
  const u = await User.findById(otherId).select('firstName lastName email role userUid').lean();
  if (!u) return null;
  return {
    id: String(u._id),
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    email: u.email,
    userUid: u.userUid || null,
    role: u.role,
    online: broadcaster.isOnline(String(u._id)),
  };
}

// ── messaging ────────────────────────────────────────────────────────
// Validate + normalise attachments against the Super-Admin-configured limits
// for the sender's role. Throws a friendly AppError on the first violation
// and logs every rejection (and the accepted batch) for the audit trail.
async function validateAttachments(attachments, requester) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const role = requester?.role || 'USER';
  const who = requester?._id ? String(requester._id) : 'unknown';
  const lim = await getEffectiveUploadConfig(role);

  const reject = (msg, code, meta = {}) => {
    console.warn(`[chat][upload-rejected] user=${who} role=${role} code=${code} :: ${msg}`, meta);
    try {
      const { AuditLog } = require('../models');
      if (AuditLog) AuditLog.create({ actorId: requester?._id, actorRole: role, action: 'CHAT_UPLOAD_REJECTED', targetType: 'CHAT', metadata: { code, msg, ...meta } }).catch(() => {});
    } catch (_) { /* logging is best-effort */ }
    const status = code === 'UPLOADS_DISABLED' ? 403 : code === 'ATTACH_TOO_LARGE' || code === 'TOTAL_TOO_LARGE' ? 413 : 400;
    throw new AppError(msg, status, code);
  };

  if (!lim.enabled) reject('File uploads are currently disabled by the administrator.', 'UPLOADS_DISABLED');
  if (lim.maxFiles > 0 && attachments.length > lim.maxFiles) reject(`You can attach at most ${lim.maxFiles} file(s) per message.`, 'TOO_MANY_FILES', { count: attachments.length });

  const perFileBytes = lim.maxFileMB * 1024 * 1024;
  const totalCapBytes = lim.maxTotalMB * 1024 * 1024;
  let total = 0;

  const out = attachments.map((a) => {
    const name = String(a.name || '').slice(0, 200);
    const dataUrl = String(a.dataUrl || '');
    if (!dataUrl.startsWith('data:')) reject('Invalid attachment.', 'BAD_ATTACHMENT', { name });
    const ext = extOf(name);
    if (lim.blockedExtensions.includes(ext)) reject(`Executable / unsafe files are not allowed (.${ext}).`, 'BLOCKED_TYPE', { name, ext });
    if (lim.allowedExtensions.length && !lim.allowedExtensions.includes(ext)) {
      reject(`File type .${ext || '?'} is not allowed. Allowed: ${lim.allowedExtensions.join(', ')}.`, 'UNSUPPORTED_TYPE', { name, ext });
    }
    const b64 = dataUrl.split(',')[1] || '';
    const bytes = Math.floor(b64.length * 0.75);
    if (bytes > perFileBytes) reject(`"${name || 'File'}" exceeds the ${lim.maxFileMB} MB per-file limit.`, 'ATTACH_TOO_LARGE', { name, bytes });
    total += bytes;
    return { name, mimeType: String(a.mimeType || ''), dataUrl, sizeBytes: bytes };
  });

  if (lim.maxTotalMB > 0 && total > totalCapBytes) reject(`Total attachments exceed the ${lim.maxTotalMB} MB per-message limit.`, 'TOTAL_TOO_LARGE', { totalBytes: total });

  console.log(`[chat][upload-accepted] user=${who} role=${role} files=${out.length} totalKB=${Math.round(total / 1024)}`);
  return out;
}

async function sendMessage(conversationId, requester, { text, attachments } = {}) {
  const conv = await Conversation.findById(conversationId);
  authorize(conv, requester);
  const cleanText = String(text || '').trim();
  const atts = await validateAttachments(attachments, requester);
  if (!cleanText && !atts.length) throw new AppError('Message is empty', 400);
  if (!conv.managerId && String(conv.userId) === String(requester._id)) {
    throw new AppError('No manager is assigned to you yet', 409, 'NO_MANAGER');
  }

  const senderRole = roleInConversation(conv, requester);
  const msg = await ChatMessage.create({
    conversationId: conv._id,
    senderId: requester._id,
    senderRole,
    text: cleanText,
    attachments: atts,
  });

  // The recipient is the OTHER side; bump their unread.
  const fromUser = senderRole === 'USER';
  if (fromUser) conv.unreadForManager += 1; else conv.unreadForUser += 1;
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessageText = cleanText || (atts.length ? '📎 Attachment' : '');
  conv.lastSenderRole = senderRole;
  await conv.save();

  emit(conv, 'message', { message: serializeMessage(msg), unreadForUser: conv.unreadForUser, unreadForManager: conv.unreadForManager });
  return msg;
}

async function markSeen(conversationId, requester) {
  const conv = await Conversation.findById(conversationId);
  authorize(conv, requester);
  const asUser = String(conv.userId) === String(requester._id);
  // Mark inbound (from the other side) unseen messages as seen.
  const inboundRole = asUser ? { $ne: 'USER' } : 'USER';
  await ChatMessage.updateMany(
    { conversationId: conv._id, senderRole: inboundRole, seenAt: null },
    { $set: { seenAt: new Date() } }
  );
  if (asUser) conv.unreadForUser = 0; else conv.unreadForManager = 0;
  await conv.save();
  emit(conv, 'seen', { by: asUser ? 'USER' : 'MANAGER' });
  return conv;
}

function serializeMessage(m) {
  return {
    _id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: String(m.senderId),
    senderRole: m.senderRole,
    text: m.text,
    attachments: (m.attachments || []).map((a) => ({ name: a.name, mimeType: a.mimeType, dataUrl: a.dataUrl, sizeBytes: a.sizeBytes })),
    seenAt: m.seenAt,
    createdAt: m.createdAt,
  };
}

async function history(conversationId, requester, { before, after, limit = 50 } = {}) {
  const conv = await Conversation.findById(conversationId);
  authorize(conv, requester);
  const q = { conversationId: conv._id };
  const l = Math.min(100, Math.max(1, Number(limit) || 50));
  // Incremental poll: messages strictly AFTER a timestamp, oldest-first.
  // Lets the live-chat UI fetch only NEW messages (no re-downloading the
  // full thread + attachment data URLs every few seconds).
  if (after) {
    q.createdAt = { $gt: new Date(after) };
    const rows = await ChatMessage.find(q).sort({ createdAt: 1 }).limit(l).lean();
    return rows.map(serializeMessage);
  }
  if (before) q.createdAt = { $lt: new Date(before) };
  const rows = await ChatMessage.find(q).sort({ createdAt: -1 }).limit(l).lean();
  return rows.reverse().map(serializeMessage); // oldest-first for rendering
}

// ── lists (manager / superadmin) ─────────────────────────────────────
async function _listConversations(filter, { search, page = 1, limit = 50 } = {}) {
  if (search) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matched = await User.find({ $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { userUid: rx }] }).select('_id').lean();
    filter.userId = { $in: matched.map((u) => u._id) };
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const [convs, total] = await Promise.all([
    Conversation.find(filter).sort({ lastMessageAt: -1, updatedAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    Conversation.countDocuments(filter),
  ]);
  const userIds = convs.map((c) => c.userId);
  const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName email userUid adminId managerId').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  // Resolve each user's Admin + Manager display names (their hierarchy) so the
  // chat header can show who the user belongs to.
  const staffIds = new Set();
  users.forEach((u) => { if (u.adminId) staffIds.add(String(u.adminId)); if (u.managerId) staffIds.add(String(u.managerId)); });
  const staff = staffIds.size
    ? await User.find({ _id: { $in: [...staffIds] } }).select('firstName lastName email').lean()
    : [];
  const staffName = new Map(staff.map((s) => [String(s._id), [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email]));
  const items = convs.map((c) => {
    const u = byId.get(String(c.userId));
    return {
      _id: String(c._id),
      userId: String(c.userId),
      user: u ? {
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
        email: u.email,
        userUid: u.userUid || null,
        admin: u.adminId ? (staffName.get(String(u.adminId)) || null) : null,
        manager: u.managerId ? (staffName.get(String(u.managerId)) || null) : null,
      } : null,
      online: broadcaster.isOnline(String(c.userId)),
      unread: c.unreadForManager,
      lastMessageText: c.lastMessageText,
      lastMessageAt: c.lastMessageAt,
      lastSenderRole: c.lastSenderRole,
    };
  });
  return { items, total, page: p, limit: l };
}

const listForManager = (managerId, opts) => _listConversations({ managerId: oid(managerId) }, opts);
const listAll = (opts) => _listConversations({}, opts);

// ── presence → notify the conversation counterpart(s) ────────────────
// Registered once at module load. On connect/disconnect of `userId`, push a
// `presence` event to whoever is talking to them.
let _presenceWired = false;
function wirePresence() {
  if (_presenceWired) return;
  _presenceWired = true;
  broadcaster.onPresence(async (userId, online) => {
    try {
      // If userId is a chat user → tell their manager.
      const asUser = await Conversation.findOne({ userId: oid(userId) }).select('managerId').lean();
      if (asUser && asUser.managerId) {
        broadcaster.notifyUser(String(asUser.managerId), 'chat', { event: 'presence', userId: String(userId), online });
      }
      // If userId is a manager → tell each of their conversation users.
      const asMgr = await Conversation.find({ managerId: oid(userId) }).select('userId').lean();
      for (const c of asMgr) {
        broadcaster.notifyUser(String(c.userId), 'chat', { event: 'presence', userId: String(userId), online });
      }
    } catch (_) { /* presence is best-effort */ }
  });
}
wirePresence();

module.exports = {
  getOrCreateForUser, getOrCreateWithUser, counterpartInfo, authorize, roleInConversation,
  sendMessage, markSeen, history, listForManager, listAll, serializeMessage,
  getUploadConfig, getEffectiveUploadConfig,
  emitTyping: (conv, requester) => emit(conv, 'typing', { by: roleInConversation(conv, requester), at: Date.now() }),
};
