const mongoose = require('mongoose');

/**
 * Helpdesk chat — a single conversation per user with their assigned
 * manager (user.managerId). Additive: independent of the legacy
 * ticket/feedback support flow. Authorization (only the user, their
 * manager, or a SuperAdmin) is enforced in chatService, never here.
 */
const conversationSchema = new mongoose.Schema(
  {
    // One conversation per user (with whoever their current manager is).
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN' },

    lastMessageAt: { type: Date, default: null },
    lastMessageText: { type: String, default: '' },
    lastSenderRole: { type: String, default: '' }, // USER | MANAGER | SUPER_ADMIN

    // Per-side unread counters (reset when that side opens / marks seen).
    unreadForUser: { type: Number, default: 0 },
    unreadForManager: { type: Number, default: 0 },
  },
  { timestamps: true }
);
conversationSchema.index({ managerId: 1, lastMessageAt: -1 });

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    dataUrl: { type: String, required: true }, // base64 data URL (≤~1MB, validated in service)
    sizeBytes: { type: Number, default: 0 },
  },
  { _id: false }
);

const chatMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: ['USER', 'MANAGER', 'SUPER_ADMIN'], required: true },
    text: { type: String, default: '' },
    attachments: { type: [attachmentSchema], default: [] },
    seenAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);
chatMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = {
  Conversation: mongoose.model('Conversation', conversationSchema),
  ChatMessage: mongoose.model('ChatMessage', chatMessageSchema),
};
