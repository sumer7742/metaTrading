const mongoose = require('mongoose');

/**
 * Records that a user acknowledged (clicked OK on) a Global Alert. One row per
 * (alert, user) — upserted, so re-acknowledging a repeat-display alert just
 * refreshes the timestamp. Drives delivery statistics + suppresses redisplay
 * of non-repeat alerts.
 */
const alertAcknowledgementSchema = new mongoose.Schema(
  {
    alertId: { type: mongoose.Schema.Types.ObjectId, ref: 'GlobalAlert', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    acknowledgedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One acknowledgement per (alert, user).
alertAcknowledgementSchema.index({ alertId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('AlertAcknowledgement', alertAcknowledgementSchema);
