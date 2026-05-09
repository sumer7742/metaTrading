const mongoose = require('mongoose');

/**
 * User-configured price alerts (doc §7.14).
 * Worker checks active alerts every tick; when triggered, sends notification + email
 * and marks the alert as triggered.
 */
const priceAlertSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true, index: true },
    direction: { type: String, enum: ['ABOVE', 'BELOW'], required: true },
    targetPrice: { type: String, required: true },
    note: String,
    isActive: { type: Boolean, default: true, index: true },
    triggeredAt: Date,
    triggeredPrice: String,
    repeatable: { type: Boolean, default: false }, // if true, re-arm after trigger instead of disabling
  },
  { timestamps: true }
);

priceAlertSchema.index({ userId: 1, isActive: 1 });
priceAlertSchema.index({ symbol: 1, isActive: 1 });

module.exports = mongoose.model('PriceAlert', priceAlertSchema);
