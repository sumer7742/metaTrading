const mongoose = require('mongoose');

/**
 * CopyRelation — links a follower to a master box. One row per "copy session".
 *
 * ARCHITECTURE (v2 — account-based): the follower copies trades DIRECTLY into
 * one of their own trading accounts (`followerAccountId`). There is NO separate
 * investment wallet / held allocation — mirrored trades fund their margin from
 * the destination account exactly like a normal trade. Sizing is LOT-based:
 *
 *   baseLot   = CUSTOM ? customLot : masterLot × { LOW:0.5, MEDIUM:1, HIGH:1.5 }
 *   finalLot  = clamp( baseLot × lotMultiplier × riskMultiplier, lotStep, maxLot )
 *
 * Lifecycle: ACTIVE → PAUSED (stop new copies, keep positions) → resume back to
 * ACTIVE. STOP sets STOPPED but the row (config + history + analytics) is NEVER
 * deleted, so Resume restores everything with no duplicate session.
 */
const copyRelationSchema = new mongoose.Schema(
  {
    followerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    masterId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The SPECIFIC source account being copied (the box). All mirroring keys off
    // this — trades on the master's other accounts are NOT copied.
    masterAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', index: true },
    masterBoxId:     { type: mongoose.Schema.Types.ObjectId, ref: 'CopyBox', index: true },
    // Destination trading account — mirrored trades land here (editable).
    followerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },

    // ── Lot sizing ──────────────────────────────────────────────────────
    lotMode:       { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CUSTOM'], default: 'MEDIUM' },
    customLot:     { type: Number, default: null },   // fixed lot per trade when lotMode === 'CUSTOM'
    lotMultiplier: { type: Number, default: 1 },       // scales the base lot
    riskMultiplier:{ type: Number, default: 1 },       // extra risk scaling on top
    maxLot:        { type: Number, default: null },    // hard cap per copied trade (null = uncapped)
    maxOpenTrades: { type: Number, default: null },    // skip new copies past this many open copied positions (null = unlimited)

    // ── Copy toggles ────────────────────────────────────────────────────
    copySL:        { type: Boolean, default: true },   // mirror the master's stop-loss
    copyTP:        { type: Boolean, default: true },   // mirror the master's take-profit
    copyPending:   { type: Boolean, default: false },  // also mirror pending (limit/stop) orders

    // ── Lifecycle / resume state ────────────────────────────────────────
    status:      { type: String, enum: ['ACTIVE', 'PAUSED', 'STOPPED'], default: 'ACTIVE', index: true },
    startedAt:   { type: Date, default: Date.now },
    pausedAt:    { type: Date, default: null },
    stoppedAt:   { type: Date, default: null },

    // ── Analytics / fees / performance (kept fresh by the service so the
    //    dashboard never has to aggregate trade tables on every render) ──
    grossProfit:       { type: String, default: '0' }, // Σ winning realized PnL (before fee)
    runningPnl:        { type: String, default: '0' }, // Σ net realized PnL
    netProfit:         { type: String, default: '0' }, // Σ realized PnL after performance fee
    performanceFeePaid:{ type: String, default: '0' },
    commissionPaid:    { type: String, default: '0' },
    swapPaid:          { type: String, default: '0' },
    largestWin:        { type: String, default: '0' },
    largestLoss:       { type: String, default: '0' },
    wins:              { type: Number, default: 0 },
    losses:            { type: Number, default: 0 },
    tradesCopied:      { type: Number, default: 0 },

    // ── Legacy (v1 investment-wallet) — retained ONLY so the migration can
    //    release held funds and back-fill the new fields. Not used for sizing
    //    or funding any more. Safe to drop after the migration has run.
    investment:       { type: String,  default: '0' },
    heldAmount:       { type: String,  default: '0' },
    riskLevel:        { type: String, default: null },
    customMultiplier: { type: Number, default: null },
    syncSlTp:         { type: Boolean, default: true },
  },
  { timestamps: true }
);

// A follower may copy several boxes (including multiple boxes of the same
// master), so this is NON-unique. One "session" per (follower, masterAccount)
// is enforced in the service (resume reuses the STOPPED row).
copyRelationSchema.index({ followerId: 1, masterAccountId: 1 });
copyRelationSchema.index({ masterAccountId: 1, status: 1 });
copyRelationSchema.index({ masterId: 1, status: 1 });
copyRelationSchema.index({ followerAccountId: 1, status: 1 });

const CopyRelation = mongoose.model('CopyRelation', copyRelationSchema);

// Drop the old UNIQUE (follower, master USER) index if it lingers — it would
// wrongly block copying two boxes of the same master.
function dropLegacyIndex() {
  CopyRelation.collection.dropIndex('followerId_1_masterId_1').catch(() => {});
}
if (mongoose.connection.readyState === 1) dropLegacyIndex();
else mongoose.connection.once('connected', dropLegacyIndex);

module.exports = CopyRelation;
