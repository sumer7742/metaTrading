const express = require('express');
const c = require('../controllers/adminController');
const { authenticate, requireAdmin } = require('../middleware/auth');
const riskService = require('../services/riskService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/dashboard', c.dashboard);

router.get('/users', c.listUsers);
router.get('/users/:id', c.getUser);
router.put('/users/:id/status', c.updateUserStatus);
router.post('/users/:id/kyc-review', c.reviewKyc);
router.post('/users/:id/balance-adjustment', c.adjustBalance);

router.get('/withdrawals', c.listWithdrawals);
router.post('/withdrawals/:id/approve', c.approveWithdrawal);
router.post('/withdrawals/:id/reject', c.rejectWithdrawal);

router.get('/deposits', c.listDeposits);
router.post('/deposits/:id/confirm', c.confirmDeposit);
router.post('/deposits/:id/reject', c.rejectDeposit);

router.get('/audit-log', c.listAuditLog);
router.get('/reports/trades', c.tradesReport);

// Account metrics for any user
router.get(
  '/accounts/:accountId/metrics',
  asyncHandler(async (req, res) => {
    // assuming admin can read any account's metrics; userId is derived from account
    const TradingAccount = require('../models/TradingAccount');
    const account = await TradingAccount.findById(req.params.accountId);
    if (!account) return res.status(404).json({ success: false, error: { message: 'Account not found' } });
    const metrics = await riskService.calculateAccountMetrics(account.userId, account._id, account.baseCurrency);
    sendSuccess(res, metrics);
  })
);

// Trigger affiliate commission payout batch (run on a cron in production)
router.post(
  '/affiliate/payout',
  asyncHandler(async (req, res) => {
    const affiliateService = require('../services/affiliateService');
    const paid = await affiliateService.runPayoutBatch();
    sendSuccess(res, { paid });
  })
);

// B-book exposure for an instrument (broker risk view)
router.get(
  '/exposure/:symbol',
  asyncHandler(async (req, res) => {
    const routingService = require('../services/routingService');
    const exposure = await routingService.getBBookExposure(req.params.symbol.toUpperCase());
    sendSuccess(res, exposure);
  })
);

// ============== Feed orchestrator (data feed status) ==============
router.get(
  '/data-feeds',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const orch = require('../services/feedOrchestrator');
    sendSuccess(res, orch.getStatus());
  })
);

router.post(
  '/data-feeds/force-switch',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { provider } = req.body;
    if (!provider) throw new AppError('provider required', 400);
    const orch = require('../services/feedOrchestrator');
    const result = orch.forceSwitch(provider);
    sendSuccess(res, result);
  })
);

module.exports = router;
