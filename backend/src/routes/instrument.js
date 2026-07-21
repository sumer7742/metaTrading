const express = require('express');
const c = require('../controllers/instrumentController');
const rec = require('../controllers/recommendedMarketController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', c.list);
router.get('/watchlist', c.watchlist);
router.get('/recommended', rec.publicList);  // before /:symbol — admin-curated strip/selector set
router.get('/option-chain', c.optionChain); // before /:symbol so it isn't matched as a symbol
router.get('/search', c.search);            // before /:symbol so "search" isn't a symbol
router.get('/economic-calendar', c.economicCalendar); // before /:symbol — live Forex Factory feed
router.get('/:symbol', c.getOne);
router.get('/:symbol/volume-usage', c.volumeUsage);
router.get('/:symbol/candles', c.candles);
router.get('/:symbol/orderbook', c.orderbook);
router.get('/:symbol/fundamentals', c.fundamentals);
router.get('/:symbol/news', c.news);

// Admin only
router.post('/', authenticate, requireAdmin, c.create);
router.post('/bulk-routing', authenticate, requireAdmin, c.bulkRouting); // before /:symbol
router.post('/sync-indian', authenticate, requireAdmin, c.syncIndian);  // on-demand Dhan import (Indian)
router.put('/:symbol', authenticate, requireAdmin, c.update);
router.delete('/:symbol', authenticate, requireAdmin, c.remove);

module.exports = router;
