/**
 * /api/broker — connections, portfolio, market data and health.
 *
 * All broker-agnostic. The `:broker` path segment names a CONNECTION, it does
 * not select code — the registry does that at runtime.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const c = require('../controllers/brokerController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const validate = require('../middleware/validate');
const schemas = require('../brokers/validation/schemas');
const { brokerContext, brokerErrors, requireBrokerModule } = require('../middleware/brokerContext');

const router = express.Router();

router.use(requireBrokerModule);
router.use(authenticate);
router.use(brokerContext);

const byUser = (req) => String(req.userId || req.ip);

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.BROKER_RATE_LIMIT_READS_PER_MIN) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUser,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests — slow down.' } },
});

// Connecting a broker is rare and expensive (it calls the broker to validate
// the token). A tight limit here also blunts token-guessing attempts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.BROKER_RATE_LIMIT_CONNECT_PER_15MIN) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byUser,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many broker connection attempts. Try again later.' } },
});

// ─── Catalogue ───────────────────────────────────────────────────────
router.get('/brokers', readLimiter, c.listBrokers);

// ─── Connections ─────────────────────────────────────────────────────
router.get('/connections', readLimiter, c.listConnections);
router.post('/connections', authLimiter, validate(schemas.connectBroker), c.connect);
router.post('/connections/:broker/verify', authLimiter, validate(schemas.brokerParam, 'params'), c.verify);
router.patch('/connections/:broker/default', readLimiter, validate(schemas.brokerParam, 'params'), c.setDefault);
router.post('/connections/:broker/stream', readLimiter, validate(schemas.brokerParam, 'params'), c.startStream);
router.delete('/connections/:broker/stream', readLimiter, validate(schemas.brokerParam, 'params'), c.stopStream);
router.delete('/connections/:broker', authLimiter, validate(schemas.brokerParam, 'params'), c.disconnect);

// ─── OAuth (MODE 2 — returns 501 until a broker registers a provider) ──
router.get('/oauth/:broker/authorize', authLimiter, validate(schemas.brokerParam, 'params'), c.oauthAuthorize);
router.get('/oauth/:broker/callback', authLimiter, validate(schemas.brokerParam, 'params'), c.oauthCallback);

// ─── Portfolio ───────────────────────────────────────────────────────
router.get('/portfolio/summary', readLimiter, validate(schemas.portfolioQuery, 'query'), c.summary);
router.get('/portfolio/positions', readLimiter, validate(schemas.portfolioQuery, 'query'), c.positions);
router.get('/portfolio/holdings', readLimiter, validate(schemas.portfolioQuery, 'query'), c.holdings);
router.get('/portfolio/funds', readLimiter, validate(schemas.portfolioQuery, 'query'), c.funds);
router.post('/portfolio/sync', readLimiter, c.sync);

// ─── Market data ─────────────────────────────────────────────────────
router.get('/market/quotes', readLimiter, validate(schemas.quotesQuery, 'query'), c.quotes);
router.get('/market/status', readLimiter, validate(schemas.marketStatusQuery, 'query'), c.marketStatus);

// ─── Health (admin only — queue depth, sockets, encryption posture) ──
router.get('/health', requireAdmin, c.health);

router.use(brokerErrors);

module.exports = router;
