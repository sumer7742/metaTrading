const mongoose = require('mongoose');
const {
  BROKER_CODES, ORDER_STATUSES, ORDER_STATUS, ORDER_SIDE, ORDER_TYPE,
  PRODUCT_TYPE, VALIDITY, EXCHANGES, UPDATE_SOURCE,
} = require('../brokers/constants');

/**
 * OrderSync — our system-of-record for every broker order.
 *
 * "System of record" for the REQUEST and its LIFECYCLE, not for the money:
 * the broker's books remain authoritative for fills. This collection exists so
 * that we can, at any moment, answer:
 *   - what did the user ask for, exactly (the request we validated),
 *   - what did we send, when, and how many attempts did it take,
 *   - what did the broker/exchange say at each stage,
 *   - is a retry a duplicate (idempotency),
 *   - and reconcile all of that against the broker's order book.
 *
 * Idempotency: `clientOrderId` is uniquely indexed. A repeat submission with
 * the same id never reaches the broker — the stored response is replayed.
 *
 * This collection is entirely separate from the existing `Order` model used
 * by the forex/crypto matching engine. Neither knows about the other.
 */

const timelineSchema = new mongoose.Schema({
  created: { type: Date, default: null },
  validated: { type: Date, default: null },
  queued: { type: Date, default: null },
  brokerAccepted: { type: Date, default: null },
  exchangeAccepted: { type: Date, default: null },
  partiallyFilled: { type: Date, default: null },
  filled: { type: Date, default: null },
  cancelled: { type: Date, default: null },
  rejected: { type: Date, default: null },
  expired: { type: Date, default: null },
  failed: { type: Date, default: null },
}, { _id: false });

const requestSchema = new mongoose.Schema({
  symbol: { type: String, uppercase: true, required: true },
  exchange: { type: String, uppercase: true, enum: EXCHANGES, required: true },
  securityId: { type: String, default: null },       // broker instrument id we resolved to
  side: { type: String, enum: Object.values(ORDER_SIDE), required: true },
  qty: { type: Number, required: true, min: 1 },
  orderType: { type: String, enum: Object.values(ORDER_TYPE), required: true },
  productType: { type: String, enum: Object.values(PRODUCT_TYPE), required: true },
  price: { type: Number, default: 0 },
  triggerPrice: { type: Number, default: 0 },
  validity: { type: String, enum: Object.values(VALIDITY), default: VALIDITY.DAY },
  disclosedQty: { type: Number, default: 0 },
  amo: { type: Boolean, default: false },            // after-market order
  tag: { type: String, default: null },              // free-form client tag
}, { _id: false });

const orderSyncSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    broker: { type: String, required: true, uppercase: true, enum: BROKER_CODES, index: true },
    connectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrokerConnection', default: null },

    // ── Idempotency key: PX-YYYYMMDD-XXXXXXXX ──
    clientOrderId: { type: String, required: true, unique: true, index: true },

    // Broker + exchange identifiers (populated as the order progresses).
    brokerOrderId: { type: String, default: null, index: true },
    exchangeOrderId: { type: String, default: null },

    // What the user asked for (post-validation, pre-translation).
    request: { type: requestSchema, required: true },

    status: { type: String, enum: ORDER_STATUSES, default: ORDER_STATUS.CREATED, index: true },
    previousStatus: { type: String, enum: ORDER_STATUSES, default: null },
    statusMessage: { type: String, default: null },

    filledQty: { type: Number, default: 0 },
    pendingQty: { type: Number, default: 0 },
    averagePrice: { type: Number, default: 0 },

    timeline: { type: timelineSchema, default: () => ({}) },

    // The normalized ack we returned to the caller. Replayed verbatim when a
    // duplicate clientOrderId arrives — the client can retry a timed-out HTTP
    // request safely and get the SAME answer.
    response: {
      success: { type: Boolean, default: null },
      orderId: { type: String, default: null },
      status: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },

    // Normalized failure (code + user-safe message only).
    error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },

    // ── Operational metadata ──
    attempts: { type: Number, default: 0 },            // broker send attempts
    queueWaitMs: { type: Number, default: 0 },
    brokerLatencyMs: { type: Number, default: 0 },
    requestId: { type: String, default: null, index: true }, // HTTP request id
    lastUpdateSource: { type: String, enum: Object.values(UPDATE_SOURCE), default: UPDATE_SOURCE.API },
    lastSyncedAt: { type: Date, default: null },

    // Modify/cancel trail on the same order.
    revisions: [{
      action: { type: String, enum: ['MODIFY', 'CANCEL'] },
      at: { type: Date, default: Date.now },
      changes: { type: mongoose.Schema.Types.Mixed, default: null },
      result: { type: String, default: null },
      _id: false,
    }],
  },
  { timestamps: true }
);

// Order book for a user, newest first.
orderSyncSchema.index({ userId: 1, createdAt: -1 });
// The reconciliation sweep: open orders per broker.
orderSyncSchema.index({ broker: 1, status: 1, updatedAt: -1 });
// "Find my order for this symbol today".
orderSyncSchema.index({ userId: 1, 'request.symbol': 1, createdAt: -1 });

/** Frontend-safe projection — no internals, no broker payloads. */
orderSyncSchema.methods.toClientJSON = function toClientJSON() {
  return {
    clientOrderId: this.clientOrderId,
    orderId: this.brokerOrderId,
    exchangeOrderId: this.exchangeOrderId,
    broker: this.broker,
    symbol: this.request.symbol,
    exchange: this.request.exchange,
    side: this.request.side,
    qty: this.request.qty,
    filledQty: this.filledQty,
    pendingQty: this.pendingQty,
    price: this.request.price,
    triggerPrice: this.request.triggerPrice,
    averagePrice: this.averagePrice,
    orderType: this.request.orderType,
    productType: this.request.productType,
    validity: this.request.validity,
    status: this.status,
    statusMessage: this.statusMessage,
    timeline: this.timeline,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

module.exports = mongoose.model('OrderSync', orderSyncSchema);
