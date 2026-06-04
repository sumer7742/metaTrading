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

const MAX_ATTACHMENTS = 4;
const MAX_ATTACH_BYTES = 1024 * 1024; // ~1MB per attachment (data URL)
const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

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
  for (const id of partyIds(conv)) {
    broadcaster.notifyUser(id, 'chat', { event, conversationId: String(conv._id), ...payload });
  }
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
function validateAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  if (attachments.length > MAX_ATTACHMENTS) throw new AppError(`Max ${MAX_ATTACHMENTS} attachments`, 400);
  return attachments.map((a) => {
    const dataUrl = String(a.dataUrl || '');
    if (!dataUrl.startsWith('data:')) throw new AppError('Invalid attachment', 400);
    const b64 = dataUrl.split(',')[1] || '';
    const bytes = Math.floor(b64.length * 0.75);
    if (bytes > MAX_ATTACH_BYTES) throw new AppError('Attachment exceeds 1MB', 413, 'ATTACH_TOO_LARGE');
    return { name: String(a.name || '').slice(0, 200), mimeType: String(a.mimeType || ''), dataUrl, sizeBytes: bytes };
  });
}

async function sendMessage(conversationId, requester, { text, attachments } = {}) {
  const conv = await Conversation.findById(conversationId);
  authorize(conv, requester);
  const cleanText = String(text || '').trim();
  const atts = validateAttachments(attachments);
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
  const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName email userUid').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const items = convs.map((c) => {
    const u = byId.get(String(c.userId));
    return {
      _id: String(c._id),
      userId: String(c.userId),
      user: u ? { name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email, email: u.email, userUid: u.userUid || null } : null,
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
  emitTyping: (conv, requester) => emit(conv, 'typing', { by: roleInConversation(conv, requester), at: Date.now() }),
};
