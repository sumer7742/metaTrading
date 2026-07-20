const mongoose = require('mongoose');

/**
 * User-submitted feedback. Lightweight on purpose — bug reports / feature
 * requests / general comments all flow through one schema, distinguished by
 * `category`. Admins triage by changing `status`.
 */
const feedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: {
      type: String,
      enum: ['BUG', 'FEATURE', 'UX', 'SUPPORT', 'OTHER'],
      default: 'OTHER',
      index: true,
    },
    subject: { type: String, required: true, maxlength: 200 },
    message: { type: String, required: true, maxlength: 4000 },
    // Optional single attachment (screenshot / doc) — stored as a base64
    // `data:` URI (image or PDF). Null when the user didn't attach anything.
    attachment: { type: String, default: null },
    attachmentName: { type: String, default: null },
    // 1-5; null when the user skipped the rating step.
    rating: { type: Number, min: 1, max: 5, default: null },
    // Free-form context the client snapshots so admins can reproduce: page
    // URL when submitted, browser UA, app version. All optional.
    context: {
      page: String,
      userAgent: String,
      appVersion: String,
    },
    status: {
      type: String,
      enum: ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX'],
      default: 'OPEN',
      index: true,
    },
    // Admin-side INTERNAL notes — triage / resolution scratchpad. Never
    // surfaced to the user (stripped from the user-facing feedback list).
    adminNote: String,
    // Admin's REPLY to the user — this IS shown back to the user in their
    // "My Tickets" view (and best-effort emailed). Distinct from adminNote.
    adminReply: { type: String, default: null },
    repliedAt: { type: Date, default: null },
    resolvedAt: Date,
  },
  { timestamps: true }
);

feedbackSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
