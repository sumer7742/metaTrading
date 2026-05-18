const express = require('express');
const c = require('../controllers/walletController');
const { authenticate } = require('../middleware/auth');

console.log('[wallet routes] module loaded — controller has:', Object.keys(c).join(', '));

const router = express.Router();

// Public diagnostic ping — no auth, lists every registered wallet
// route. Use this in the browser to confirm the running server is
// actually serving THIS file:
//   http://localhost:5000/api/wallet/__routes
// 404 here → wallet router not mounted at all.
// Empty list → file loaded but no routes registered.
// Full list → the route exists; the 404 is something else (stale
// frontend bundle, typo in path, wrong process listening).
router.get('/__routes', (req, res) => {
  const list = router.stack
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} /api/wallet${l.route.path}`);
  res.json({ ok: true, count: list.length, routes: list });
});

// Request-trace middleware — prints every wallet request as it lands,
// before auth runs. Lets you see whether Express is matching the
// request to this router at all (vs falling through to notFound).
router.use((req, _res, next) => {
  console.log(`[wallet] ${req.method} ${req.originalUrl}`);
  next();
});

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
router.post('/convert', c.convertCurrency);

console.log('[wallet routes] registered:', router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`).join(', '));

module.exports = router;
module.exports.razorpayWebhookHandler = c.razorpayWebhook;
