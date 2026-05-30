const mongoose = require('mongoose');

/**
 * CopyRelation — links a follower to a master. One row per
 * follower/master pair (unique compound index).
 *
 *   investment    — USD the follower has allocated to this copy. Used
 *                   as the proportional sizing denominator for mirrored
 *                   trades (followerLots ≈ masterLots × investment/masterEquity).
 *   riskLevel     — 'LOW' | 'MEDIUM' | 'HIGH'. Scales the multiplier
 *                   so the follower can be more or less aggressive
 *                   than the master independent of investment size.
 *   status        — ACTIVE / PAUSED / STOPPED. Only ACTIVE mirrors.
 *   syncSlTp      — when true, follower's SL/TP move in proportion to
 *                   the master's on update.
 *   followerAccountId — which TradingAccount the mirrored trades land in.
 */
const copyRelationSchema = new mongoose.Schema(
  {
    followerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    masterId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    followerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },

    investment:  { type: String,  default: '0' },   // string-decimal USD
    riskLevel:   { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
    syncSlTp:    { type: Boolean, default: true },

    status:      { type: String, enum: ['ACTIVE', 'PAUSED', 'STOPPED'], default: 'ACTIVE', index: true },
    startedAt:   { type: Date, default: Date.now },
    pausedAt:    { type: Date, default: null },
    stoppedAt:   { type: Date, default: null },

    // Running totals — kept fresh by copyTradingService for the
    // follower dashboard so we don't aggregate trade tables on every render.
    runningPnl:  { type: String, default: '0' },
    tradesCopied: { type: Number, default: 0 },
  },
  { timestamps: true }
);

copyRelationSchema.index({ followerId: 1, masterId: 1 }, { unique: true });
copyRelationSchema.index({ masterId: 1, status: 1 });

module.exports = mongoose.model('CopyRelation', copyRelationSchema);
