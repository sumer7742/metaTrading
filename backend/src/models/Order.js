const mongoose = require('mongoose');
const { ORDER_SIDE, ORDER_TYPE, ORDER_STATUS, ROUTING, EXECUTION_SOURCE, EXECUTION_MODE, ROUTING_RESULT } = require('../config/constants');

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true, index: true },
    symbol: { type: String, required: true, index: true },

    side: { type: String, enum: Object.values(ORDER_SIDE), required: true },
    // Hedge-mode target. Tells the matching engine which side of the book
    // the resulting fill should land on (LONG vs SHORT). For opening orders
    // it's derived from `side` (BUY→LONG, SELL→SHORT). For close orders the
    // controller stamps it from the source Position so a SELL close-order
    // doesn't accidentally hit the SHORT position (which is the user's open
    // exposure on the same instrument).
    positionSide: { type: String, enum: ['LONG', 'SHORT'], default: null, index: true },
    // True means "this order can only reduce/close an existing position on
    // the matching positionSide — never open a new one". Used by the engine
    // to refuse opening a phantom position when the target side has nothing
    // to close (e.g. user cancels a SELL while the system queues a SELL
    // close-order). Distinct from `closeOnly` (legacy) only in semantics:
    // we still honour closeOnly for backward compatibility.
    reduceOnly: { type: Boolean, default: false },
    type: { type: String, enum: Object.values(ORDER_TYPE), required: true },

    quantity: { type: String, required: true }, // decimal as string
    filledQuantity: { type: String, default: '0' },

    price: String, // limit price
    stopPrice: String, // stop trigger
    avgFillPrice: String,

    stopLoss: String,
    takeProfit: String,

    leverage: { type: Number, default: 1 },
    // Indian cash-equity product type (DELIVERY / INTRADAY). NORMAL = n/a for
    // forex/crypto/F&O. Carried onto the Position at open.
    productType: { type: String, enum: ['DELIVERY', 'INTRADAY', 'NORMAL'], default: 'NORMAL' },

    status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING, index: true },
    // @deprecated — preserved for backward compat with existing reports.
    // New code should read `executionSource` instead.
    routing: { type: String, enum: Object.values(ROUTING), default: ROUTING.INTERNAL },
    // Set by orderRouter at the moment of routing. One of:
    //   INTERNAL         (B_BOOK account)
    //   LP               (A_BOOK account)
    //   HYBRID_INTERNAL  (HYBRID account, risk engine chose internal)
    //   HYBRID_LP        (HYBRID account, risk engine chose LP)
    executionSource: {
      type: String,
      enum: Object.values(EXECUTION_SOURCE),
      default: EXECUTION_SOURCE.INTERNAL,
      index: true,
    },
    // The execution MODE this order was routed under (what the admin/global
    // or per-user setting selected). For HYBRID this stays 'HYBRID' while
    // `routingResult` records what the risk engine actually chose.
    executionMode: {
      type: String,
      enum: Object.values(EXECUTION_MODE),
      default: EXECUTION_MODE.B_BOOK,
      index: true,
    },
    // The concrete venue the order executed on (INTERNAL_MATCHING|B_BOOK|A_BOOK).
    routingResult: {
      type: String,
      enum: [...Object.values(ROUTING_RESULT), null],
      default: null,
      index: true,
    },
    // LP audit trail — populated by lpExecution.service when the order
    // was routed A-book. Lets ops correlate an internal order id with
    // the upstream provider's order id during disputes/recon.
    lpProvider: { type: String, default: null },
    lpProviderOrderId: { type: String, default: null },

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
