const express = require('express');
const alerts = require('../controllers/priceAlertController');
const exportCtrl = require('../controllers/exportController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Price alerts
router.get('/alerts', alerts.list);
router.post('/alerts', alerts.create);
router.delete('/alerts/:id', alerts.remove);
router.put('/alerts/:id/toggle', alerts.toggle);

// CSV exports
router.get('/export/orders.csv', exportCtrl.exportOrderHistory);
router.get('/export/positions.csv', exportCtrl.exportClosedPositions);
router.get('/export/ledger.csv', exportCtrl.exportLedger);

module.exports = router;
