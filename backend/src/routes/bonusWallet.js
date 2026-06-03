const express = require('express');
const c = require('../controllers/bonusWalletController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// User-facing — read-only. The Bonus Wallet is funded automatically by
// referral/partner earnings and by internal transfers IN; it has NO
// deposit or withdrawal endpoint by design.
router.get('/', authenticate, c.getWallet);
router.get('/summary', authenticate, c.getSummary);
router.get('/history', authenticate, c.history);
// "Add funds" — instant transfer from a trading account, or a manual
// (UPI/Bank/Crypto/…) deposit that an admin verifies. Funds IN only;
// there is still no withdrawal path.
router.post('/deposit', authenticate, c.deposit);
router.post('/manual-deposit', authenticate, c.manualDeposit);
router.post('/auto-renew', authenticate, c.toggleAutoRenew);

// Admin
router.post('/admin/credit', authenticate, requireAdmin, c.adminCredit);
router.post('/admin/debit', authenticate, requireAdmin, c.adminDebit);
router.get('/admin/balances', authenticate, requireAdmin, c.adminBalances);
router.get('/admin/logs', authenticate, requireAdmin, c.adminLogs);

module.exports = router;
