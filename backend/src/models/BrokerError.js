const mongoose = require('mongoose');
const { BROKER_CODES } = require('../brokers/constants');
const { ERROR_CODE } = require('../brokers/base/BrokerError');

/**
 * BrokerError — every normalized failure, kept for triage and alerting.
 *
 * Separate from BrokerLog on purpose: logs are high-volume and TTL'd
 * aggressively, whereas errors are what ops actually query ("did Dhan start
 * rejecting everything at 09:15?", "how many INVALID_TOKEN in the last hour?").
 * Keeping them apart means an error sweep never scans millions of info rows.
 *
 * `brokerCode` / `brokerMessage` retain the broker's OWN error identifiers for
 * support escalation — these are diagnostic strings (e.g. 'DH-906'), never
 * credentials, and are visible to admins only, never returned to users.
 */

const _ttlDays = Number(process.env.BROKER_ERROR_TTL_DAYS) || 90;

const brokerErrorSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    broker: { type: String, uppercase: true, enum: BROKER_CODES, required: true, index: true },

    // Our normalized code — what all alerting/branching keys off.
    code: { type: String, enum: Object.values(ERROR_CODE), required: true, index: true },
    message: { type: String, required: true },       // user-safe message
    retryable: { type: Boolean, default: false },
    httpStatus: { type: Number, default: null },

    // Broker's own identifiers (admin-only diagnostics).
    brokerCode: { type: String, default: null },
    brokerMessage: { type: String, default: null },

    operation: { type: String, default: null },      // 'placeOrder', 'funds', …
    clientOrderId: { type: String, default: null, index: true },
    brokerOrderId: { type: String, default: null },
    requestId: { type: String, default: null },
    attempt: { type: Number, default: null },

    // Redacted context — symbol/qty/status codes, never tokens.
    context: { type: mongoose.Schema.Types.Mixed, default: null },
    stack: { type: String, default: null },          // captured only when BROKER_ERROR_STACKS=true

    // No `index: true` here — the TTL index below already covers {createdAt: 1}.
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false }
);

brokerErrorSchema.index({ createdAt: 1 }, { expireAfterSeconds: _ttlDays * 24 * 60 * 60 });
brokerErrorSchema.index({ broker: 1, code: 1, createdAt: -1 });
brokerErrorSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('BrokerError', brokerErrorSchema);
