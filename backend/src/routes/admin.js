const express = require('express');
const c = require('../controllers/adminController');
const { authenticate, requireAdmin, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const riskService = require('../services/riskService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/dashboard', c.dashboard);
router.get('/dashboard/analytics', c.getDashboardAnalytics);

// Read-only "View As User" — start an impersonation session (ADMIN + SUPER_ADMIN
// only; the router-level requireAdmin already blocks MANAGER / USER).
router.post('/impersonate/:userId', c.startImpersonation);

router.get('/users', c.listUsers);
router.get('/users/:id', c.getUser);
router.put('/users/:id/status', c.updateUserStatus);
router.post('/users/:id/kyc-review', c.reviewKyc);
router.post('/users/:id/balance-adjustment', c.adjustBalance);
router.post('/users/:id/affiliate-bonus', c.creditAffiliateBonus);
router.post('/users/:id/set-referrer', c.setReferrer);
router.get('/users/:id/referral-diagnostic', c.referralDiagnostic);

// Leverage management (admin → user override + audit)
router.get   ('/users/:id/leverage',         c.getLeverage);
router.put   ('/users/:id/leverage',         c.setLeverage);
router.delete('/users/:id/leverage',         c.clearLeverage);
router.get   ('/users/:id/leverage/history', c.getLeverageHistory);
router.post  ('/leverage/bulk',              c.bulkSetLeverage);

router.get('/withdrawals', c.listWithdrawals);
router.post('/withdrawals/:id/approve', c.approveWithdrawal);
router.post('/withdrawals/:id/reject', c.rejectWithdrawal);

router.get('/deposits', c.listDeposits);
router.post('/deposits/:id/confirm', c.confirmDeposit);
router.post('/deposits/:id/reject', c.rejectDeposit);

router.get('/audit-log', c.listAuditLog);
router.get('/reports/trades', c.tradesReport);

// User-to-user transfer log (paired ledger rows enriched with names).
router.get('/transfers/user', c.listUserTransfers);

// Partner / Referral admin endpoints.
router.get('/partners',              c.listPartners);
router.get('/partners/analytics',    c.partnerAnalytics);
router.put('/partners/:id/level',    c.setPartnerLevel);
router.post('/partners/:id/block',   c.setPartnerBlocked);

// Update per-account execution config (book type / LP / leverage / etc.)
// Kept for backwards-compat with older admin builds; new global routing
// supersedes per-account choices in orderRouter.service.
router.patch('/accounts/:accountId/execution-config', c.updateAccountExecutionConfig);

// Per-user risk controls (forceABook override, userGroup, blockedInstruments)
router.patch('/users/:id/risk-controls', c.updateUserRiskControls);

// Global system settings — execution mode + default LP provider.
// These are the SINGLE knobs that decide INTERNAL_MATCHING / B-Book / A-Book /
// Hybrid platform-wide (per-user overrides live on risk-controls).
router.get('/system/settings', c.getSystemSettings);
router.put('/system/settings', c.updateSystemSettings);

// Portfolio — platform-wide statistics, SUPER_ADMIN only (403 otherwise).
router.get('/portfolio', requireRole(ROLES.SUPER_ADMIN), c.getPortfolio);

// Execution-mode analytics + routing-decision audit log.
router.get('/execution/stats', c.getExecutionStats);
router.get('/execution/decisions', c.listRoutingDecisions);

// Multi-account management.
// NOTE: static paths (/accounts/users, /accounts/bulk) MUST be registered
// before the dynamic /accounts/:accountId, or ":accountId" would swallow them.
router.get('/accounts/users',                      c.listAccountUsers);          // user-first list
router.get('/accounts/users/:userId/accounts',     c.getUserAccounts);           // lazy child list
router.post('/accounts/bulk',                      c.bulkAccountAction);         // bulk actions
router.get('/accounts',                            c.listAccounts);              // (legacy) flat list
router.get('/accounts/:accountId',                 c.getAccountDetail);
router.get('/accounts/:accountId/positions',       c.getAccountPositions);
router.patch('/accounts/:accountId/status',        c.setAccountStatus);
router.post('/accounts/:accountId/notes',          c.addAccountNote);

// Scheduled instrument leverage / volume overrides (admin CRUD).
const ov = require('../controllers/instrumentOverrideController');
router.get   ('/instruments/:symbol/leverage-overrides', ov.listLeverage);
router.post  ('/instruments/:symbol/leverage-overrides', ov.createLeverage);
router.put   ('/leverage-overrides/:id',                 ov.updateLeverage);
router.delete('/leverage-overrides/:id',                 ov.deleteLeverage);
router.get   ('/instruments/:symbol/volume-overrides',   ov.listVolume);
router.post  ('/instruments/:symbol/volume-overrides',   ov.createVolume);
router.put   ('/volume-overrides/:id',                    ov.updateVolume);
router.delete('/volume-overrides/:id',                    ov.deleteVolume);

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
