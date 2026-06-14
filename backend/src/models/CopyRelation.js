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
    // Owner of the box (master USER) — kept for performance-fee earnings.
    masterId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The SPECIFIC source account being copied (the box). All mirroring keys
    // off this — trades on the master's other accounts are NOT copied.
    masterAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', index: true },
    masterBoxId:     { type: mongoose.Schema.Types.ObjectId, ref: 'CopyBox', index: true },
    followerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },

    investment:  { type: String,  default: '0' },   // string-decimal USD
    // How much of `investment` is currently LOCKED (held) on the follower's
    // funding account as the copy allocation. Reserved on start/resume, released
    // on stop. Kept separate from per-trade margin so the hold is exact.
    heldAmount:  { type: String,  default: '0' },
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

// One subscription per (follower, box) — enforced in the service via upsert
// on { followerId, masterAccountId }. (Not a DB unique index: a follower may
// copy several boxes, including multiple boxes from the same master user.)
copyRelationSchema.index({ followerId: 1, masterAccountId: 1 });
copyRelationSchema.index({ masterAccountId: 1, status: 1 });
copyRelationSchema.index({ masterId: 1, status: 1 });

const CopyRelation = mongoose.model('CopyRelation', copyRelationSchema);

// Migration: the model used to be keyed by (follower, master USER) with a
// UNIQUE compound index. That index would now wrongly block a follower from
// copying two boxes of the same master. Drop it once the connection is up.
function dropLegacyIndex() {
  CopyRelation.collection.dropIndex('followerId_1_masterId_1').catch(() => {});
}
if (mongoose.connection.readyState === 1) dropLegacyIndex();
else mongoose.connection.once('connected', dropLegacyIndex);

module.exports = CopyRelation;
