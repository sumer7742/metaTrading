const mongoose = require('mongoose');

/**
 * TraderProfile — the public-facing master-trader record. Lives 1:1
 * with a User, but kept separate so the leaderboard query stays cheap:
 * stats are denormalised here and incremented on each closed trade.
 *
 *   isPublic    — opt-in flag; only listed on the leaderboard when true
 *   riskBadge   — admin/self-set bucket; 'LOW' | 'MEDIUM' | 'HIGH'
 *   totalTrades — lifetime closed-trade counter
 *   wins        — lifetime profitable closed-trade counter
 *   roiPct      — running approximation: cumulativeReturn / initialEquity * 100
 *   followers   — denormalised count (kept in sync by copyTradingService)
 */
const traderProfileSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    displayName: { type: String, default: '' },
    avatarUrl:   { type: String, default: '' },
    bio:         { type: String, default: '' },
    isPublic:    { type: Boolean, default: false, index: true },
    riskBadge:   { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },

    // Denormalised stats — updated on each closed trade in
    // copyTradingService.onMasterTradeClosed().
    totalTrades:    { type: Number, default: 0 },
    wins:           { type: Number, default: 0 },
    cumulativePnl:  { type: String, default: '0' }, // signed string-decimal in USD
    initialEquity:  { type: String, default: '1000' }, // ROI denominator
    roiPct:         { type: Number, default: 0 },
    followers:      { type: Number, default: 0, index: true },
  },
  { timestamps: true }
);

traderProfileSchema.virtual('winRate').get(function () {
  if (!this.totalTrades) return 0;
  return (this.wins / this.totalTrades) * 100;
});
traderProfileSchema.set('toJSON', { virtuals: true });
traderProfileSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('TraderProfile', traderProfileSchema);
