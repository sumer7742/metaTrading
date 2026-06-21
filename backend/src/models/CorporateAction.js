const mongoose = require('mongoose');

/**
 * Corporate action on a (cash equity) instrument. Applied automatically by the
 * background worker on/after exDate, once.
 *
 *   SPLIT / BONUS — position-adjusting. Multiplier = ratioTo / ratioFrom.
 *     1:2 split  → ratioFrom 1, ratioTo 2  → qty ×2, entry ÷2 (notional same).
 *     1:1 bonus  → ratioFrom 1, ratioTo 2  (1 extra share per 1 held).
 *   DIVIDEND — cash. `amount` per share: long positions credited, shorts debited
 *     (B-book CFD dividend adjustment).
 */
const corporateActionSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, uppercase: true, index: true },
    type: { type: String, enum: ['SPLIT', 'BONUS', 'DIVIDEND'], required: true },
    ratioFrom: { type: Number, default: 1 }, // SPLIT/BONUS
    ratioTo: { type: Number, default: 1 },   // SPLIT/BONUS
    amount: { type: String, default: '0' },  // DIVIDEND per share (quote currency)
    exDate: { type: Date, required: true, index: true },
    applied: { type: Boolean, default: false, index: true },
    appliedAt: { type: Date, default: null },
    appliedCount: { type: Number, default: 0 }, // positions affected
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CorporateAction', corporateActionSchema);
