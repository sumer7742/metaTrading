const express = require('express');
const c = require('../controllers/subscriptionWalletController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// User-facing
router.get('/', authenticate, c.getWallet);
router.post('/deposit', authenticate, c.deposit);
router.post('/manual-deposit', authenticate, c.manualDeposit);
router.post('/withdraw', authenticate, c.requestWithdrawal);
router.post('/auto-renew', authenticate, c.toggleAutoRenew);

// Admin
router.post('/admin/credit', authenticate, requireAdmin, c.adminCredit);
router.post('/admin/debit', authenticate, requireAdmin, c.adminDebit);
router.patch('/admin/:userId/auto-renew', authenticate, requireAdmin, c.adminSetAutoRenew);
router.patch('/admin/:userId/grace-period', authenticate, requireAdmin, c.adminSetGracePeriod);
router.get('/admin/logs', authenticate, requireAdmin, c.adminLogs);

module.exports = router;
