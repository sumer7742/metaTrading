const mongoose = require('mongoose');

/**
 * AccountPlan — dynamic trading-account tier (replaces the hardcoded
 * config/accountTypes.js as the source of truth). Admin can CRUD these
 * from the admin panel; the matching engine, order controller, and
 * frontend all read from this collection (with a small in-memory cache).
 *
 * Each plan defines:
 *   - Identity              : code (unique), name, description
 *   - Deposit + leverage    : minDeposit, maxLeverage (null = unlimited)
 *   - Fee model             : feeKind, feeValue, lossWaive
 *       PCT_OF_VALUE       — value × notional (raw decimal, NOT %)
 *       FIXED_PER_TRADE    — flat $value per close
 *       PCT_OF_PROFIT      — value × max(pnl, 0)
 *       lossWaive: true    → zero fee when the close booked a loss
 *   - Trading restriction   : buyCloseOnly (true → "IC" variant, BUY-only
 *                             entries, SELL allowed only as a close)
 *   - Display               : feeDisplay (free-text label),
 *                             support label, instruments label
 *   - Visibility            : isActive, sortOrder, isPopular, isRecommended
 *   - Branding              : accentColor (hex), icon (emoji/glyph),
 *                             badge (free-text ribbon e.g. "Most Popular")
 */
const accountPlanSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },

    // Hard rules
    minDeposit:  { type: Number, default: 0 },
    maxLeverage: { type: Number, default: null }, // null = unlimited
    feeKind: {
      type: String,
      enum: ['PCT_OF_VALUE', 'FIXED_PER_TRADE', 'PCT_OF_PROFIT'],
      default: 'PCT_OF_VALUE',
    },
    feeValue:  { type: Number, default: 0 }, // raw decimal — 0.00005 = 0.005%
    lossWaive: { type: Boolean, default: false },
    buyCloseOnly: { type: Boolean, default: false },

    // Display
    feeDisplay:        { type: String, default: '' }, // human-readable fee summary
    supportLabel:      { type: String, default: 'Standard support' },
    instrumentsLabel:  { type: String, default: 'All instruments' },
    accessLabel:       { type: String, default: '24/7 access' },

    // Visibility / ordering
    isActive:      { type: Boolean, default: true },
    sortOrder:     { type: Number, default: 0, index: true },
    isPopular:     { type: Boolean, default: false },
    isRecommended: { type: Boolean, default: false },

    // Branding
    badge:       { type: String, default: '' },
    accentColor: { type: String, default: null },
    icon:        { type: String, default: null },
  },
  { timestamps: true }
);

accountPlanSchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model('AccountPlan', accountPlanSchema);
