const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/orderController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Per-user rate limits on order placement. Keyed by user id so a shared IP
// (corporate NAT, dorm WiFi) doesn't starve other users. Caps are
// generous for normal use but cut off a runaway bot before it spams the
// matching engine. Tune via env if a market maker needs higher caps.
const _userKey = (req) => String(req.userId || req.ip);
const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_ORDERS_PER_MIN) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: _userKey,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many orders, slow down.' } },
});
const closeAllLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_CLOSE_ALL_PER_MIN) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: _userKey,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many close-all requests.' } },
});

// Orders
router.post('/orders', orderLimiter, c.placeOrder);
router.post('/orders/oco', orderLimiter, c.placeOcoOrder);
router.get('/orders/open', c.listOpen);
router.get('/orders/history', c.listHistory);
router.put('/orders/:id', c.modifyOrder);
router.delete('/orders/:id', c.cancelOrder);

// Positions
router.get('/positions', c.listPositions);
router.get('/positions/history', c.positionHistory);
router.put('/positions/:id', c.modifyPosition);
router.put('/positions/:id/trailing-stop', c.setTrailingStop);
router.post('/positions/:id/close', c.closePosition);
router.post('/positions/:id/partial-close', c.partialClose);
router.post('/positions/close-all', closeAllLimiter, c.closeAllPositions);

module.exports = router;
