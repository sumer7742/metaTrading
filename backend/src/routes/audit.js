/**
 * Audit & Compliance routes (/api/audit).
 * Gated to the Audit Manager + Super Admin. Read-only oversight plus two
 * allowed writes (flag user, submit freeze request); approving a freeze is
 * Super-Admin-only and enforced inside the controller.
 */
const express = require('express');
const c = require('../controllers/auditController');
const { authenticate, allowRoles } = require('../middleware/auth');
const { ROLES } = require('../config/constants');

const router = express.Router();
router.use(authenticate, allowRoles(ROLES.AUDIT_MANAGER, ROLES.SUPER_ADMIN));

router.get('/overview', c.overview);

// Random audits
router.get('/deposits/sample', c.randomDeposits);
router.get('/withdrawals/sample', c.randomWithdrawals);

// Risk detection
router.get('/multi-account', c.multiAccount);
router.get('/wash-trading', c.washTrading);
router.get('/pnl-anomalies', c.pnlAnomalies);
router.get('/bonus-abuse', c.bonusAbuse);

// Reviews / oversight
router.get('/kyc', c.kycReview);
router.get('/activity', c.activity);
router.get('/balance-adjustments', c.balanceAdjustments);

// User inspection + flagging
router.get('/users/:id/inspect', c.inspectUser);
router.get('/flags', c.flaggedUsers);
router.post('/users/:id/flag', c.flagUser);
router.post('/users/:id/unflag', c.unflagUser);

// Account freeze requests
router.get('/freeze-requests', c.listFreezeRequests);
router.post('/freeze-requests', c.createFreezeRequest);
router.post('/freeze-requests/:id/review', c.reviewFreezeRequest); // SUPER_ADMIN only (controller-enforced)

// Reports
router.get('/report', c.report);

module.exports = router;
