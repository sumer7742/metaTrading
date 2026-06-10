/**
 * Financial Department routes (/api/finance).
 *
 * Role-gated for finance staff (SUPER_ADMIN bypasses everything). Approve /
 * confirm / reject reuse the canonical adminController handlers, preceded by
 * a per-request scope check so an officer can only act on requests assigned
 * to them, a manager only on their team's, and auditors never (read-only).
 */
const express = require('express');
const c = require('../controllers/financeController');
const admin = require('../controllers/adminController');
const { authenticate, allowRoles } = require('../middleware/auth');
const finance = require('../services/financeService');
const { Deposit, Withdrawal } = require('../models');
const { AppError } = require('../utils/errors');
const { ROLES } = require('../config/constants');

const router = express.Router();

const FIN_ALL = [
  ROLES.FINANCIAL_ADMIN,
  ROLES.DEPOSIT_MANAGER, ROLES.WITHDRAWAL_MANAGER,
  ROLES.AUDIT_MANAGER, // read-only oversight (checking / fraud detection / random inspection)
];
// Managers process their department directly; FINANCIAL_ADMIN can act on any.
const ACTORS_DEP = [ROLES.FINANCIAL_ADMIN, ROLES.DEPOSIT_MANAGER];
const ACTORS_WD  = [ROLES.FINANCIAL_ADMIN, ROLES.WITHDRAWAL_MANAGER];
// Reassign between managers is a FINANCIAL_ADMIN power (+ SUPER_ADMIN bypass).
const REASSIGNERS = [ROLES.FINANCIAL_ADMIN];
// Who can create finance staff (managers): FINANCIAL_ADMIN only.
const STAFF_MGRS = [ROLES.FINANCIAL_ADMIN];

router.use(authenticate, allowRoles(...FIN_ALL));

// Per-request authorization for act-on operations (confirm/approve/reject).
const requireCanAct = (kind) => async (req, res, next) => {
  try {
    const Model = kind === 'withdrawal' ? Withdrawal : Deposit;
    const doc = await Model.findById(req.params.id).select('assignedOfficerId status').lean();
    if (!doc) return next(new AppError('Request not found', 404));
    if (!(await finance.canAct(kind, req.user, doc))) {
      return next(new AppError('This request is not assigned to you', 403, 'NOT_ASSIGNED'));
    }
    next();
  } catch (e) { next(e); }
};

// ── Financial-admin analytics ──
router.get('/overview', allowRoles(ROLES.FINANCIAL_ADMIN), c.overview);
router.get('/workload', allowRoles(ROLES.FINANCIAL_ADMIN), c.workload);
router.get('/officers', allowRoles(ROLES.FINANCIAL_ADMIN), c.officers);

// ── Staff management ──
router.get('/staff',  allowRoles(...STAFF_MGRS), c.listStaff);
router.post('/staff', allowRoles(...STAFF_MGRS), c.createStaff);
router.post('/staff/:id/reset-password', allowRoles(...STAFF_MGRS), c.resetStaffPassword);

// ── Deposit queue ──
router.get('/deposits',               allowRoles(...FIN_ALL),     c.listDeposits);
router.post('/deposits/:id/confirm',  allowRoles(...ACTORS_DEP),  requireCanAct('deposit'), admin.confirmDeposit);
router.post('/deposits/:id/reject',   allowRoles(...ACTORS_DEP),  requireCanAct('deposit'), admin.rejectDeposit);
router.post('/deposits/:id/reassign', allowRoles(...REASSIGNERS), c.reassignDeposit);

// ── Withdrawal queue ──
router.get('/withdrawals',               allowRoles(...FIN_ALL),    c.listWithdrawals);
router.post('/withdrawals/:id/approve',  allowRoles(...ACTORS_WD),  requireCanAct('withdrawal'), admin.approveWithdrawal);
router.post('/withdrawals/:id/reject',   allowRoles(...ACTORS_WD),  requireCanAct('withdrawal'), admin.rejectWithdrawal);
router.post('/withdrawals/:id/reassign', allowRoles(...REASSIGNERS), c.reassignWithdrawal);

module.exports = router;
