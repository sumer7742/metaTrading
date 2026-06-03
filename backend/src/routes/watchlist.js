const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/watchlistController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Per-user rate limit (keyed by user id, not IP, so shared NAT doesn't
// starve other users). Generous for normal use; cuts off a runaway client.
const _userKey = (req) => String(req.userId || req.ip);
const wlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WATCHLIST_PER_MIN) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: _userKey,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many watchlist requests, slow down.' } },
});
router.use(wlLimiter);

// ─── Watchlists ──────────────────────────────────────────────────────
// Static / specific paths MUST precede the `/:id` param routes so Express
// doesn't treat "reorder" / "last-selected" as an :id.
router.get('/', c.list);
router.post('/', c.create);
router.post('/reorder', c.reorder);
router.patch('/last-selected', c.setLastSelected);

router.patch('/:id', c.update);
router.delete('/:id', c.remove);
router.post('/:id/duplicate', c.duplicate);

// ─── Items ───────────────────────────────────────────────────────────
router.get('/:id/items', c.listItems);
router.post('/:id/items/bulk', c.bulkAddItems);
router.post('/:id/items/reorder', c.reorderItems);
router.post('/:id/items', c.addItem);
router.delete('/:id/items/:itemId', c.removeItem);
router.post('/:id/items/:itemId/move', c.moveItem);
router.post('/:id/items/:itemId/copy', c.copyItem);
router.post('/:id/items/:itemId/pin', c.pinItem);

module.exports = router;
