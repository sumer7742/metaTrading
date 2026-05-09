const mongoose = require('mongoose');
const { ROUTING } = require('../config/constants');

const tradeSchema = new mongoose.Schema(
  {
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
    symbol: { type: String, required: true, index: true },

    buyOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    sellOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },

    buyUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sellUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    buyAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },
    sellAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },

    price: { type: String, required: true },
    quantity: { type: String, required: true },

    routing: { type: String, enum: Object.values(ROUTING), required: true },
    feeBuyer: { type: String, default: '0' },
    feeSeller: { type: String, default: '0' },

    executedAt: { type: Date, default: Date.now, immutable: true, index: true },
  },
  { timestamps: false }
);

// Optimization indexes — speed up trade history and reports
tradeSchema.index({ symbol: 1, executedAt: -1 });          // recent trades by symbol
tradeSchema.index({ buyUserId: 1, executedAt: -1 });       // user's buy history
tradeSchema.index({ sellUserId: 1, executedAt: -1 });      // user's sell history
tradeSchema.index({ routing: 1, executedAt: -1 });         // B-book exposure reports
// Dashboard hits trade collection with $or on buy/sellAccountId — without
// these indexes the dashboard endpoint scans the whole trades collection
// on every page load (the most common cause of slow dashboard "Loading…").
tradeSchema.index({ buyAccountId: 1, executedAt: -1 });
tradeSchema.index({ sellAccountId: 1, executedAt: -1 });

module.exports = mongoose.model('Trade', tradeSchema);
