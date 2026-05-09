const express = require('express');
const c = require('../controllers/orderController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Orders
router.post('/orders', c.placeOrder);
router.post('/orders/oco', c.placeOcoOrder);
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

module.exports = router;
