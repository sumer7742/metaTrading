const express = require('express');
const c = require('../controllers/walletController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/balances', c.getBalances);
router.get('/ledger', c.getLedger);

router.post('/deposits', c.createDeposit);
router.get('/deposits', c.listDeposits);

// Razorpay deposit flow (alongside the manual screenshot method above):
//   create-order → user pays via Razorpay Checkout → verify → wallet credited
router.post('/razorpay/order', c.createRazorpayOrder);
router.post('/razorpay/verify', c.verifyRazorpayPayment);
// Webhook is authenticated by HMAC signature (not by JWT). Mounted on the
// public path below in server.js (this file requires auth on every route).

router.post('/withdrawals', c.requestWithdrawal);
router.get('/withdrawals', c.listWithdrawals);

router.post('/transfers', c.internalTransfer);

module.exports = router;
module.exports.razorpayWebhookHandler = c.razorpayWebhook;
