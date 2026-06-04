/**
 * Helpdesk chat controller — thin HTTP layer over chatService. Auth is
 * enforced inside the service (authorize: the conversation's user, its
 * manager, or SuperAdmin). Standard sendSuccess / AppError envelope.
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const chat = require('../services/chatService');
const { Conversation } = require('../models/Chat');
const { ROLES } = require('../config/constants');

// GET /chat/conversation — the caller's own conversation (auto-resolve the
// assigned manager) + counterpart + history. User-facing entry point.
const myConversation = asyncHandler(async (req, res) => {
  const conv = await chat.getOrCreateForUser(req.userId);
  const [counterpart, messages] = await Promise.all([
    chat.counterpartInfo(conv, req.user),
    chat.history(conv._id, req.user, { limit: 50 }),
  ]);
  sendSuccess(res, {
    conversation: {
      _id: String(conv._id), userId: String(conv.userId), managerId: conv.managerId ? String(conv.managerId) : null,
      unread: conv.unreadForUser, status: conv.status,
    },
    counterpart, // { id, name, email, online } or null when no manager yet
    messages,
  });
});

// GET /chat/conversations — manager → own users' convos; SuperAdmin → all.
const listConversations = asyncHandler(async (req, res) => {
  const opts = { search: req.query.search, page: req.query.page, limit: req.query.limit };
  if (req.user.role === ROLES.SUPER_ADMIN) return sendSuccess(res, await chat.listAll(opts));
  if (req.user.role === ROLES.MANAGER || req.user.role === ROLES.ADMIN) {
    return sendSuccess(res, await chat.listForManager(req.userId, opts));
  }
  throw new AppError('Not allowed', 403, 'FORBIDDEN');
});

// POST /chat/conversations/open  { userId } — manager/SuperAdmin starts (or
// reopens) a conversation with one of their assigned users. Scope enforced in
// the service (manager → own users only; SuperAdmin → any).
const openConversation = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN && req.user.role !== ROLES.MANAGER && req.user.role !== ROLES.ADMIN) {
    throw new AppError('Not allowed', 403, 'FORBIDDEN');
  }
  if (!req.body.userId) throw new AppError('userId is required', 400, 'VALIDATION');
  const conv = await chat.getOrCreateWithUser(req.body.userId, req.user);
  const [counterpart, messages] = await Promise.all([
    chat.counterpartInfo(conv, req.user),
    chat.history(conv._id, req.user, { limit: 50 }),
  ]);
  sendSuccess(res, {
    conversation: {
      _id: String(conv._id), userId: String(conv.userId), managerId: conv.managerId ? String(conv.managerId) : null,
      unread: conv.unreadForManager, status: conv.status,
    },
    counterpart, messages,
  }, 201);
});

// GET /chat/conversations/:id/messages?before=&limit=
const getMessages = asyncHandler(async (req, res) => {
  const msgs = await chat.history(req.params.id, req.user, { before: req.query.before, after: req.query.after, limit: req.query.limit });
  sendSuccess(res, msgs);
});

// POST /chat/conversations/:id/messages  { text?, attachments? }
const postMessage = asyncHandler(async (req, res) => {
  const msg = await chat.sendMessage(req.params.id, req.user, { text: req.body.text, attachments: req.body.attachments });
  sendSuccess(res, chat.serializeMessage(msg), 201);
});

// POST /chat/conversations/:id/seen
const postSeen = asyncHandler(async (req, res) => {
  await chat.markSeen(req.params.id, req.user);
  sendSuccess(res, { ok: true });
});

// POST /chat/conversations/:id/typing — ephemeral, no DB write.
const postTyping = asyncHandler(async (req, res) => {
  const conv = await Conversation.findById(req.params.id);
  chat.authorize(conv, req.user);
  chat.emitTyping(conv, req.user);
  sendSuccess(res, { ok: true });
});

module.exports = { myConversation, listConversations, openConversation, getMessages, postMessage, postSeen, postTyping };
