const mongoose = require('mongoose');
const { BROKER_CODES, ORDER_STATUSES, UPDATE_SOURCE } = require('../brokers/constants');

/**
 * OrderAudit — append-only record of every order state transition.
 *
 * OrderSync holds the CURRENT state; this holds HOW it got there. Rows are
 * immutable (no updates, no TTL) because this is the compliance artefact:
 * "prove the user's cancel was received at 14:59:58 and sent to the broker at
 * 14:59:58.412".
 *
 * One row per transition:
 *   CREATED → VALIDATED → QUEUED → BROKER_ACCEPTED → EXCHANGE_ACCEPTED →
 *   PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED
 */
const orderAuditSchema = new mongoose.Schema(
  {
    clientOrderId: { type: String, required: true, index: true },
    orderSyncId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderSync', default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    broker: { type: String, uppercase: true, enum: BROKER_CODES, required: true, index: true },
    brokerOrderId: { type: String, default: null },

    fromStatus: { type: String, enum: [...ORDER_STATUSES, null], default: null },
    toStatus: { type: String, enum: ORDER_STATUSES, required: true, index: true },

    // What triggered the transition.
    source: { type: String, enum: Object.values(UPDATE_SOURCE), default: UPDATE_SOURCE.API },
    // Who: 'USER' | 'SYSTEM' | 'BROKER' | 'ADMIN:<userId>'
    actor: { type: String, default: 'SYSTEM' },

    message: { type: String, default: null },
    // Redacted snapshot of what changed (qty/price/status), never credentials.
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    requestId: { type: String, default: null },
    latencyMs: { type: Number, default: null },

    createdAt: { type: Date, default: Date.now, immutable: true, index: true },
  },
  { timestamps: false }
);

orderAuditSchema.index({ clientOrderId: 1, createdAt: 1 });
orderAuditSchema.index({ userId: 1, createdAt: -1 });

// Append-only: block any attempt to mutate history through the ODM.
const _blockUpdate = function blockUpdate(next) {
  next(new Error('OrderAudit is append-only — transitions cannot be modified.'));
};
orderAuditSchema.pre('updateOne', _blockUpdate);
orderAuditSchema.pre('updateMany', _blockUpdate);
orderAuditSchema.pre('findOneAndUpdate', _blockUpdate);

module.exports = mongoose.model('OrderAudit', orderAuditSchema);
