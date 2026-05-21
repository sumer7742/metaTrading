const express = require('express');
const c = require('../controllers/userController');
const dash = require('../controllers/dashboardController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/dashboard', dash.getDashboard);
router.put('/profile', c.updateProfile);
router.post('/kyc', c.submitKYC);
router.get('/kyc/status', c.getKycStatus);
router.get('/accounts', c.listAccounts);
router.post('/accounts', c.createAccount);

// Leverage — effective cap + source ("VIP Plan" / "Admin Override").
// FE OrderForm reads this to bound the leverage slider and show the
// source chip.
router.get('/leverage', async (req, res, next) => {
  try {
    const leverageService = require('../services/leverageService');
    const state = await leverageService.getEffective(req.userId);
    res.json({ success: true, data: state });
  } catch (e) { next(e); }
});

// Feedback
router.post('/feedback', c.submitFeedback);
router.get('/feedback', c.listMyFeedback);

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
