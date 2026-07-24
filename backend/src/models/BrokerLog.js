const mongoose = require('mongoose');
const { BROKER_CODES } = require('../brokers/constants');

/**
 * BrokerLog — the complete audit trail of every broker interaction.
 *
 *   Request → Queue → Broker → Exchange → Response → Frontend
 *
 * One row per stage transition. Combined with OrderAudit (status transitions)
 * this reconstructs exactly what happened to any order, in order, with timings
 * — which is what support and compliance actually need at 09:16 on expiry day.
 *
 * REDACTION: `payload` is written through brokerAudit.service.redact(), which
 * strips every credential-shaped key at any depth. Tokens are never persisted
 * here, and the service refuses to write a payload it could not redact.
 *
 * Retention: TTL index drops rows after BROKER_LOG_TTL_DAYS (default 30).
 * Order-critical history lives in OrderSync/OrderAudit, which have no TTL.
 */

const STAGE = {
  REQUEST: 'REQUEST',       // received from the frontend
  VALIDATE: 'VALIDATE',     // schema + business validation
  QUEUE: 'QUEUE',           // enqueued / dequeued
  BROKER: 'BROKER',         // HTTP call to the broker
  EXCHANGE: 'EXCHANGE',     // exchange-level acknowledgement
  RESPONSE: 'RESPONSE',     // what we returned to the caller
  WEBSOCKET: 'WEBSOCKET',   // broker socket lifecycle + updates
  AUTH: 'AUTH',             // connect / validate / disconnect
  SYNC: 'SYNC',             // reconciliation sweep
};

const _ttlDays = Number(process.env.BROKER_LOG_TTL_DAYS) || 30;

const brokerLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    broker: { type: String, uppercase: true, enum: BROKER_CODES, required: true, index: true },

    stage: { type: String, enum: Object.values(STAGE), required: true, index: true },
    action: { type: String, required: true },        // 'placeOrder', 'connect', 'orderUpdate', …
    level: { type: String, enum: ['debug', 'info', 'warn', 'error'], default: 'info', index: true },

    // Correlation keys — every log line for one order shares these.
    clientOrderId: { type: String, default: null, index: true },
    brokerOrderId: { type: String, default: null },
    requestId: { type: String, default: null, index: true },

    message: { type: String, default: null },
    // Redacted structured context. NEVER contains tokens/secrets.
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    httpStatus: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    attempt: { type: Number, default: null },
    success: { type: Boolean, default: null },

    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false }
);

brokerLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: _ttlDays * 24 * 60 * 60 });
brokerLogSchema.index({ broker: 1, stage: 1, createdAt: -1 });
brokerLogSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('BrokerLog', brokerLogSchema);
module.exports.STAGE = STAGE;
