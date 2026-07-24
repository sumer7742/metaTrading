/**
 * Broker request middleware.
 *
 * Three small, additive pieces used only by the broker routes:
 *
 *   brokerContext   — assembles req.brokerCtx once (userId, requestId, actor,
 *                     ip, user-agent) so no controller rebuilds it.
 *   brokerErrors    — converts a BrokerError into the platform's standard
 *                     error envelope with the right HTTP status. Without it
 *                     every broker failure would surface as a generic 500.
 *   idempotencyKey  — lifts the `Idempotency-Key` header into the body, so a
 *                     client can make retries safe using an HTTP convention.
 */

const { AppError } = require('../utils/errors');
const { BrokerError } = require('../brokers/base/BrokerError');

/** Attach the per-request broker context. */
const brokerContext = (req, res, next) => {
  req.brokerCtx = {
    userId: req.userId ? String(req.userId) : null,
    requestId: req.id || req.headers['x-request-id'] || null,
    // Impersonated admin sessions are read-only (enforced in middleware/auth),
    // but the audit trail should still name who acted.
    actor: req.user && req.user.isImpersonation ? `ADMIN:${req.user.impersonatedBy}` : 'USER',
    ip: req.ip,
    userAgent: req.headers['user-agent'] || null,
  };
  next();
};

/**
 * `Idempotency-Key: PX-20260718-9F3A21C4` → body.clientOrderId
 * An explicit body value always wins.
 */
const idempotencyKey = (req, res, next) => {
  const header = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (header && req.body && !req.body.clientOrderId) {
    req.body.clientOrderId = String(header).trim().toUpperCase();
  }
  next();
};

/**
 * BrokerError → HTTP. Mounted at the END of the broker routers so it only
 * affects broker endpoints; every other route keeps the existing handler.
 */
const brokerErrors = (err, req, res, next) => {
  if (!err || !(err.isBrokerError || err instanceof BrokerError)) return next(err);

  const payload = err.toResponse ? err.toResponse() : { code: err.code, message: err.message };
  // Give clients something to back off on instead of hammering a 429.
  if (err.code === 'RATE_LIMIT') {
    const retryMs = (err.details && err.details.retryAfterMs) || 1000;
    res.set('Retry-After', String(Math.ceil(retryMs / 1000)));
  }

  return res.status(err.statusCode || 500).json({
    success: false,
    error: {
      message: payload.message,
      code: payload.code,
      broker: payload.broker || null,
      retryable: !!payload.retryable,
      ...(payload.details ? { details: payload.details } : {}),
    },
  });
};

/**
 * Feature flag. `BROKER_MODULE_ENABLED=false` makes every broker route behave
 * as if it doesn't exist — a kill switch that leaves forex/crypto untouched.
 */
const requireBrokerModule = (req, res, next) => {
  if (String(process.env.BROKER_MODULE_ENABLED || 'true').toLowerCase() === 'false') {
    return next(new AppError('Not found', 404, 'NOT_FOUND'));
  }
  next();
};

module.exports = { brokerContext, brokerErrors, idempotencyKey, requireBrokerModule };
