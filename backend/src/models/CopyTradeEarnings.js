const mongoose = require('mongoose');

/**
 * CopyTradeEarnings — immutable audit record of ONE performance-fee charge.
 *
 * Created exactly once per profitable follower mirror close. The unique
 * index on `followerPositionId` is the idempotency guard: a settled
 * follower position can be charged at most once, ever — no double charging
 * even if the close hook runs twice (master-driven + reconcile).
 *
 * Money convention:
 *   realizedProfit / feeAmount  → FOLLOWER account currency (what was debited)
 *   feeAmountUsd                → USD value credited to the master Bonus Wallet
 *                                 (currency-agnostic, so dashboards/analytics
 *                                 can $sum across mixed-currency followers)
 *
 * Loss/breakeven closes NEVER create a row (no fee is ever charged).
 */
const copyTradeEarningsSchema = new mongoose.Schema(
  {
    masterId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relationId: { type: mongoose.Schema.Types.ObjectId, ref: 'CopyRelation' },
    copyTradeId:{ type: mongoose.Schema.Types.ObjectId, ref: 'CopyTrade' },

    masterPositionId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Position' },
    // Idempotency key — one fee per settled follower position, ever.
    followerPositionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Position', required: true, unique: true },

    symbol: { type: String, default: '' },

    currency:       { type: String, default: 'USD' }, // follower account currency
    realizedProfit: { type: String, default: '0' },   // follower realized profit (account ccy)
    feePercent:     { type: Number, default: 0 },
    feeAmount:      { type: String, default: '0' },    // master fee (account ccy)
    feeAmountUsd:   { type: Number, default: 0, index: true }, // credited to master Bonus Wallet (USD)
    // Follower net profit (realizedProfit − fee) — credited to the follower's
    // MAIN WALLET (not the trading account). USD value is what was credited.
    followerNetProfit: { type: String, default: '0' }, // account ccy
    followerNetUsd:    { type: Number, default: 0 },   // credited to follower Main Wallet (USD)
    fxRate:         { type: Number, default: 1 },      // account-ccy → USD rate used
  },
  { timestamps: true }
);

// "Earnings for this master, newest first" + time-window aggregation.
copyTradeEarningsSchema.index({ masterId: 1, createdAt: -1 });

module.exports = mongoose.model('CopyTradeEarnings', copyTradeEarningsSchema);
