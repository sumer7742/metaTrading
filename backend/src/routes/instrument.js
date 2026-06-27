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
router.get('/:symbol', c.getOne);
router.get('/:symbol/volume-usage', c.volumeUsage);
router.get('/:symbol/candles', c.candles);
router.get('/:symbol/orderbook', c.orderbook);

// Admin only
router.post('/', authenticate, requireAdmin, c.create);
router.post('/bulk-routing', authenticate, requireAdmin, c.bulkRouting); // before /:symbol
router.put('/:symbol', authenticate, requireAdmin, c.update);
router.delete('/:symbol', authenticate, requireAdmin, c.remove);

module.exports = router;
