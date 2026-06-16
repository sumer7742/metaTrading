const mongoose = require('mongoose');

/**
 * CopyBox — a copy-trading "box" bound to ONE specific trading account.
 *
 *   • A master trader creates a box from a chosen source TradingAccount.
 *   • ONLY trades executed on that source account are mirrored to the box's
 *     followers (other accounts of the same user are NOT copied).
 *   • A user may create multiple boxes (one per account).
 *   • Followers subscribe to a box (CopyRelation.masterAccountId), not to the
 *     master user globally.
 *
 * Account number / type are denormalized so the box can always display its
 * linked account without an extra join. Owner-level concerns (performance fee,
 * Bonus-Wallet earnings) stay on the user's TraderProfile.
 */
const copyBoxSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The single source account this box copies from. Unique → one box / account.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, unique: true, index: true },
    accountNumber: { type: String, default: '' },
    accountType:   { type: String, default: '' },

    displayName: { type: String, default: '' },
    bio:         { type: String, default: '' },
    avatarUrl:   { type: String, default: '' },
    isPublic:    { type: Boolean, default: false, index: true },
    riskBadge:   { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },

    // Per-box performance fee (% of a follower's winning copied-trade profit,
    // credited to this owner's Main Wallet). null = fall back to the owner's
    // TraderProfile fee, then the platform default. Always clamped to
    // [copyTrading.minFee, copyTrading.maxFee] when set.
    performanceFeePercent: { type: Number, default: null },

    // Denormalised performance stats — updated on each closed copied trade.
    totalTrades:   { type: Number, default: 0 },
    wins:          { type: Number, default: 0 },
    cumulativePnl: { type: String, default: '0' }, // signed string-decimal USD
    initialEquity: { type: String, default: '1000' }, // ROI denominator
    roiPct:        { type: Number, default: 0 },
    followers:     { type: Number, default: 0, index: true },

    // Soft-delete / archive — a "deleted" box is archived (kept for history),
    // hidden from the owner's active list + leaderboard. Can be restored or
    // permanently purged.
    archived:   { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

copyBoxSchema.index({ isPublic: 1, roiPct: -1 });

module.exports = mongoose.model('CopyBox', copyBoxSchema);
