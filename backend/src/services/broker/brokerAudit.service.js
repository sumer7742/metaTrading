/**
 * brokerAudit.service.js — the complete audit trail.
 *
 *   Request → Queue → Broker → Exchange → Response → Frontend
 *
 * Every stage above writes here. Three sinks, three purposes:
 *   BrokerLog   — stage-by-stage narrative (TTL 30d)
 *   BrokerError — normalized failures for ops/alerting (TTL 90d)
 *   OrderAudit  — immutable order state transitions (no TTL, compliance)
 *
 * Two hard rules:
 *   1. NEVER log a secret. `redact()` runs on every payload, at every depth,
 *      and drops any key whose name looks credential-ish plus any value that
 *      looks like a JWT. It is applied inside this service so no caller can
 *      forget it.
 *   2. NEVER let auditing break trading. Writes are fire-and-forget; a Mongo
 *      hiccup degrades to a console warning, it does not fail an order.
 */

const BrokerLog = require('../../models/BrokerLog');
const BrokerErrorModel = require('../../models/BrokerError');
const OrderAudit = require('../../models/OrderAudit');
const logger = require('../../utils/logger');
const { BrokerError } = require('../../brokers/base/BrokerError');
const { UPDATE_SOURCE } = require('../../brokers/constants');

const STAGE = BrokerLog.STAGE;

// Any key matching this is replaced with '[REDACTED]', at any nesting depth.
const SECRET_KEY = /(token|secret|password|passwd|pwd|apikey|api_key|authorization|auth|credential|privatekey|private_key|clientsecret|client_secret|totp|pin|otp|signature)/i;

// Value-shaped detection, for secrets that arrive under an innocent key name
// (`{ jwt: … }`, `{ value: … }`, a broker echoing the token back inside an
// error body). Two patterns:
//   1. JWT anywhere in the string — 2 or 3 dot-separated segments starting
//      'ey'. Matching ANYWHERE matters: brokers embed tokens in messages like
//      "invalid token: eyJ...".
//   2. A long opaque bearer-style blob as the entire value.
const JWT_VALUE = /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)?/;
const OPAQUE_VALUE = /^[A-Za-z0-9_-]{60,}$/;
const looksSecret = (s) => JWT_VALUE.test(s) || OPAQUE_VALUE.test(s);

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

/**
 * Deep-redact an arbitrary payload. Returns a NEW object; the input is never
 * mutated (callers pass live request bodies).
 */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (typeof value === 'string') {
    if (looksSecret(value)) return '[REDACTED]';
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…+${value.length - MAX_ARRAY} more`);
    return out;
  }

  if (typeof value === 'object') {
    // Errors: keep the message, drop everything else that might carry a body.
    if (value instanceof Error) return { name: value.name, message: value.message, code: value.code || null };
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

const _fire = (promise, what) => {
  Promise.resolve(promise).catch((e) => logger.warn(`Broker audit write failed (${what})`, { err: e }));
};

/**
 * Stage log.
 * @param {object} entry
 * @param {string} entry.broker
 * @param {string} entry.stage    BrokerLog.STAGE.*
 * @param {string} entry.action
 * @param {string} [entry.userId]
 * @param {string} [entry.clientOrderId] / [entry.brokerOrderId] / [entry.requestId]
 * @param {string} [entry.message]
 * @param {object} [entry.payload]  redacted automatically
 * @param {number} [entry.durationMs] / [entry.httpStatus] / [entry.attempt]
 * @param {boolean} [entry.success]
 * @param {'debug'|'info'|'warn'|'error'} [entry.level]
 */
function log(entry = {}) {
  const level = entry.level || 'info';
  // Mirror to stdout so the JSON log stream tells the same story as the DB.
  logger[level === 'debug' ? 'debug' : level](
    `[broker:${entry.stage || 'LOG'}] ${entry.action || ''} ${entry.message || ''}`.trim(),
    {
      broker: entry.broker,
      userId: entry.userId ? String(entry.userId) : undefined,
      clientOrderId: entry.clientOrderId || undefined,
      requestId: entry.requestId || undefined,
      durationMs: entry.durationMs,
    }
  );

  if (String(process.env.BROKER_LOG_PERSIST || 'true').toLowerCase() === 'false') return;

  _fire(BrokerLog.create({
    userId: entry.userId || null,
    broker: entry.broker,
    stage: entry.stage || STAGE.REQUEST,
    action: entry.action || 'unknown',
    level,
    clientOrderId: entry.clientOrderId || null,
    brokerOrderId: entry.brokerOrderId || null,
    requestId: entry.requestId || null,
    message: entry.message || null,
    payload: entry.payload ? redact(entry.payload) : null,
    httpStatus: entry.httpStatus != null ? entry.httpStatus : null,
    durationMs: entry.durationMs != null ? entry.durationMs : null,
    attempt: entry.attempt != null ? entry.attempt : null,
    success: entry.success != null ? entry.success : null,
  }), 'BrokerLog');
}

/**
 * Normalized error record. Accepts a BrokerError (or anything, which is
 * coerced first) so call sites never build the shape by hand.
 */
function recordError(err, ctx = {}) {
  const e = BrokerError.from(err, ctx.broker);
  logger.error(`[broker:ERROR] ${ctx.operation || ''} ${e.code}`, {
    broker: e.broker || ctx.broker,
    userId: ctx.userId ? String(ctx.userId) : undefined,
    code: e.code,
    clientOrderId: ctx.clientOrderId || undefined,
    requestId: ctx.requestId || undefined,
    errMessage: e.message,
  });

  _fire(BrokerErrorModel.create({
    userId: ctx.userId || null,
    broker: e.broker || ctx.broker,
    code: e.code,
    message: e.message,
    retryable: !!e.retryable,
    httpStatus: e.statusCode || null,
    brokerCode: (e.details && (e.details.brokerCode || e.details.errorCode)) || null,
    brokerMessage: (e.details && e.details.brokerMessage) || null,
    operation: ctx.operation || null,
    clientOrderId: ctx.clientOrderId || null,
    brokerOrderId: ctx.brokerOrderId || null,
    requestId: ctx.requestId || null,
    attempt: ctx.attempt != null ? ctx.attempt : null,
    context: ctx.context ? redact(ctx.context) : null,
    stack: String(process.env.BROKER_ERROR_STACKS || '').toLowerCase() === 'true'
      ? String((e.cause && e.cause.stack) || e.stack || '').slice(0, 4000)
      : null,
  }), 'BrokerError');

  return e;
}

/**
 * Immutable order state transition.
 * @param {object} t { clientOrderId, orderSyncId?, userId, broker, brokerOrderId?,
 *                     fromStatus?, toStatus, source?, actor?, message?, snapshot?,
 *                     requestId?, latencyMs? }
 */
function transition(t = {}) {
  _fire(OrderAudit.create({
    clientOrderId: t.clientOrderId,
    orderSyncId: t.orderSyncId || null,
    userId: t.userId,
    broker: t.broker,
    brokerOrderId: t.brokerOrderId || null,
    fromStatus: t.fromStatus || null,
    toStatus: t.toStatus,
    source: t.source || UPDATE_SOURCE.API,
    actor: t.actor || 'SYSTEM',
    message: t.message || null,
    snapshot: t.snapshot ? redact(t.snapshot) : null,
    requestId: t.requestId || null,
    latencyMs: t.latencyMs != null ? t.latencyMs : null,
  }), 'OrderAudit');
}

/** Full trail for one order — support/compliance lookup. */
async function trail(clientOrderId) {
  const [transitions, logs, errors] = await Promise.all([
    OrderAudit.find({ clientOrderId }).sort({ createdAt: 1 }).lean(),
    BrokerLog.find({ clientOrderId }).sort({ createdAt: 1 }).lean(),
    BrokerErrorModel.find({ clientOrderId }).sort({ createdAt: 1 }).lean(),
  ]);
  return { clientOrderId, transitions, logs, errors };
}

module.exports = { log, recordError, transition, trail, redact, STAGE };
