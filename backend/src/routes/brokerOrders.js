/**
 * /api/orders — the broker-agnostic order API.
 *
 * The frontend NEVER calls a broker and never varies its endpoint by broker:
 *
 *   POST /api/orders  { symbol, exchange, qty, side, orderType, productType, broker? }
 *
 * The optional `broker` field selects a connection; omit it and the user's
 * default is used. BrokerRouter takes it from there.
 *
 * Mounted at /api/orders — entirely separate from the existing
 * /api/trading/orders route used by the forex/crypto matching engine, which
 * is untouched.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const c = require('../controllers/brokerOrderController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../brokers/validation/schemas');
const { brokerContext, brokerErrors, idempotencyKey, requireBrokerModule } = require('../middleware/brokerContext');

const router = express.Router();

router.use(requireBrokerModule);
router.use(authenticate);
router.use(brokerContext);

// Per-USER limits (not per-IP): shared office NAT must not starve one trader
// because a colleague is active. This is our own abuse guard — the broker's
// published limits are enforced separately and authoritatively by the
// RateLimiter in front of every adapter call.
const byUser = (req) => String(req.userId || req.ip);

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.BROKER_RATE_LIMIT_ORDERS_PER_MIN) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUser,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many order requests — slow down.' } },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.BROKER_RATE_LIMIT_READS_PER_MIN) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUser,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' } },
});

// ─── Commands ────────────────────────────────────────────────────────
router.post('/', writeLimiter, idempotencyKey, validate(schemas.placeOrder), c.place);

// ─── Queries ─────────────────────────────────────────────────────────
// Static paths BEFORE /:clientOrderId so "history" isn't parsed as an id.
router.get('/history', readLimiter, validate(schemas.historyQuery, 'query'), c.history);
router.get('/', readLimiter, validate(schemas.listOrders, 'query'), c.list);

router.get('/:clientOrderId/audit', readLimiter, c.trail);
router.get('/:clientOrderId', readLimiter, c.getOne);

router.put('/:clientOrderId', writeLimiter, validate(schemas.modifyOrder), c.modify);
router.delete('/:clientOrderId', writeLimiter, c.cancel);

// Broker failures → normalized HTTP responses. Scoped to this router so the
// platform's global error handler is unchanged for every other route.
router.use(brokerErrors);

module.exports = router;
