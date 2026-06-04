/**
 * User-facing Partner / Referral routes. All under /partner, all require
 * auth, all read-only from the user's perspective (writes flow through
 * deposit confirmation + trade settlement, not direct user actions).
 *
 *   GET /partner/dashboard      → all dashboard cards in one payload
 *   GET /partner/referrals      → paginated list of referees with status
 *   GET /partner/commissions    → paginated commission ledger
 *   GET /partner/settings       → public settings the form needs (bonus, tiers)
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { sendSuccess, asyncHandler } = require('../utils/errors');
const partnerService = require('../services/partnerService');

const router = express.Router();
router.use(authenticate);

router.get('/dashboard', asyncHandler(async (req, res) => {
  const data = await partnerService.getDashboardData(req.userId);
  sendSuccess(res, data);
}));

// Volume-based partner dashboard — level + revenue-share progression driven
// by total referral TRADING VOLUME (read-only; reuses the same commission
// numbers as /dashboard). Powers the redesigned partner UI.
router.get('/volume-dashboard', asyncHandler(async (req, res) => {
  const data = await partnerService.getVolumeDashboard(req.userId);
  sendSuccess(res, data);
}));

router.get('/referrals', asyncHandler(async (req, res) => {
  const data = await partnerService.getReferrals(req.userId, { limit: Number(req.query.limit) || 100 });
  sendSuccess(res, data);
}));

router.get('/commissions', asyncHandler(async (req, res) => {
  const data = await partnerService.getCommissionHistory(req.userId, {
    limit: Number(req.query.limit) || 100,
    sourceType: req.query.sourceType,
  });
  sendSuccess(res, data);
}));

router.get('/settings', asyncHandler(async (req, res) => {
  const settings = await partnerService.getSettings();
  // Strip nothing — these are public-facing values the form needs.
  sendSuccess(res, settings);
}));

module.exports = router;
