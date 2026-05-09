const mongoose = require('mongoose');
const { ORDER_SIDE, ORDER_TYPE, ORDER_STATUS, ROUTING } = require('../config/constants');

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
    symbol: { type: String, required: true, index: true },

    side: { type: String, enum: Object.values(ORDER_SIDE), required: true },
    type: { type: String, enum: Object.values(ORDER_TYPE), required: true },

    quantity: { type: String, required: true }, // decimal as string
    filledQuantity: { type: String, default: '0' },

    price: String, // limit price
    stopPrice: String, // stop trigger
    avgFillPrice: String,

    stopLoss: String,
    takeProfit: String,

    leverage: { type: Number, default: 1 },

    status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING, index: true },
    routing: { type: String, enum: Object.values(ROUTING), default: ROUTING.INTERNAL },

    idempotencyKey: { type: String, unique: true, sparse: true },
    rejectionReason: String,

    // Margin locked at order placement that is reserved on the wallet.
    // Released proportionally as the order cancels or fills into a position.
    lockedMargin: { type: String, default: '0' },

    filledAt: Date,
    cancelledAt: Date,

    // For STOP orders: timestamp at which lastPrice crossed stopPrice and the
    // worker submitted the order to the matching engine. Set once; non-null
    // means "this stop has fired". Original `type` stays as STOP for the audit
    // trail — the engine treats stop-with-no-price as MARKET, stop-with-price
    // as LIMIT (i.e., STOP-LIMIT semantics).
    triggeredAt: Date,
    triggeredPrice: String,

    // OCO (One-Cancels-Other): when one order in the group fills/cancels,
    // the linked order(s) are automatically cancelled by the worker.
    ocoGroupId: { type: String, index: true }, // shared id between linked orders

    // closeOnly: when true, the engine caps the closing qty at the current
    // open position size — preventing an unintended flip when a worker- or
    // controller-generated close order lags behind a concurrent reduction.
    closeOnly: { type: Boolean, default: false },
  },
  { timestamps: true }
);

orderSchema.index({ accountId: 1, status: 1 });
orderSchema.index({ symbol: 1, status: 1, side: 1, price: 1 });

// Optimization indexes
orderSchema.index({ userId: 1, status: 1, createdAt: -1 });   // user's open orders
orderSchema.index({ userId: 1, createdAt: -1 });               // history pagination
orderSchema.index({ status: 1, type: 1 });                     // worker STOP triggers

module.exports = mongoose.model('Order', orderSchema);
