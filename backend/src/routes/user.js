const express = require('express');
const c = require('../controllers/userController');
const dash = require('../controllers/dashboardController');
const notifications = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/dashboard', dash.getDashboard);
router.get('/dashboard/lifetime-stats', dash.getLifetimeStats);
router.get('/dashboard/monthly-series', dash.getMonthlySeries);
router.put('/profile', c.updateProfile);
router.post('/kyc', c.submitKYC);
router.get('/kyc/status', c.getKycStatus);
router.get('/accounts', c.listAccounts);
router.post('/accounts', c.createAccount);
// Account-type catalogue — public to authenticated users. The FE picker
// reads this so a new tier (added in config/accountTypes.js) shows up
// without any frontend deploy.
router.get('/account-types', (req, res) => {
  const { listPublicAccountTypes } = require('../config/accountTypes');
  res.json({ success: true, data: listPublicAccountTypes() });
});

// Leverage — effective cap + source ("VIP Plan" / "Admin Override").
// FE OrderForm reads this to bound the leverage slider and show the
// source chip.
router.get('/leverage', async (req, res, next) => {
  try {
    const leverageService = require('../services/leverageService');
    // Optional ?accountId=... — when provided, demo/virtual accounts
    // bypass admin overrides and return 1:Unlimited. Without it, the
    // call returns the user-level effective state (used by legacy
    // callers / global UI badges).
    let accountType = null;
    if (req.query.accountId) {
      const TradingAccount = require('../models/TradingAccount');
      const acc = await TradingAccount.findOne({
        _id: req.query.accountId,
        userId: req.userId,
      }).select('accountType').lean();
      if (acc) accountType = acc.accountType;
    }
    const state = await leverageService.getEffective(req.userId, { accountType });
    res.json({ success: true, data: state });
  } catch (e) { next(e); }
});

// Feedback
router.post('/feedback', c.submitFeedback);
router.get('/feedback', c.listMyFeedback);

// In-app notifications (bell) — persisted list + mark-read.
router.get('/notifications', notifications.listMine);
router.post('/notifications/read', notifications.markRead);

// Push notification tokens
const pushService = require('../services/pushService');
router.post('/push-tokens', async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ success: false, error: { message: 'token required' } });
    await pushService.registerToken(req.userId, token, platform);
    res.json({ success: true, data: { ok: true } });
  } catch (e) { next(e); }
});
router.delete('/push-tokens/:token', async (req, res, next) => {
  try {
    await pushService.unregisterToken(req.userId, req.params.token);
    res.json({ success: true, data: { ok: true } });
  } catch (e) { next(e); }
});

module.exports = router;
