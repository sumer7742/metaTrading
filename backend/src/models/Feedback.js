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
    // Admin-side notes — kept in the same doc so the audit trail is
    // self-contained without a join.
    adminNote: String,
    resolvedAt: Date,
  },
  { timestamps: true }
);

feedbackSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
