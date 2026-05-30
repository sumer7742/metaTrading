const mongoose = require('mongoose');

/**
 * CopyTrade — links one master order/position to the mirrored
 * follower order/position. Lets us:
 *   1. Look up the follower's mirror when the master closes →
 *      we know exactly which positionId to close on the follower side.
 *   2. Propagate SL/TP edits to the right follower position.
 *   3. Report per-follower P&L on the master's trade.
 */
const copyTradeSchema = new mongoose.Schema(
  {
    relationId:        { type: mongoose.Schema.Types.ObjectId, ref: 'CopyRelation', required: true, index: true },
    masterId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    followerId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Source (master) trade refs
    masterOrderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    masterPositionId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Position', index: true },

    // Mirror (follower) trade refs
    followerOrderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    followerPositionId:{ type: mongoose.Schema.Types.ObjectId, ref: 'Position', index: true },

    symbol:   String,
    side:     String,            // 'BUY' | 'SELL'
    masterQty:   { type: String, default: '0' },
    followerQty: { type: String, default: '0' },
    multiplier:  { type: String, default: '0' }, // followerQty / masterQty

    status: { type: String, enum: ['OPEN', 'CLOSED', 'FAILED'], default: 'OPEN', index: true },
    closeReason: String, // 'master_closed' | 'follower_closed' | 'failed'
    realizedPnl: { type: String, default: '0' },

    closedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('CopyTrade', copyTradeSchema);
