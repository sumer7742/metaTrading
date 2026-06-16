/**
 * Admin Orders Management routes — institutional dealing desk.
 *
 * Mounted at /api/order-management. Unlike /api/admin (which blocks managers
 * via requireAdmin), this router admits MANAGER too, then gates by role:
 *   • SUPER_ADMIN → full access
 *   • ADMIN       → full access, but only if the Super Admin granted the
 *                   ORDERS module (Admin Access Control)
 *   • MANAGER     → view + modify SL/TP only (scoped to their own users in
 *                   the controller); destructive actions return 403
 *
 * Read endpoints are open to all three roles; the controller enforces the
 * per-action manage gate (requireManage) and per-manager scope.
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { ROLES } = require('../config/constants');
const { effectiveAdminPermissions } = require('../config/adminPermissions');
const c = require('../controllers/adminOrdersController');

const router = express.Router();

router.use(authenticate);

// Role gate — only Super Admin / Admin / Manager may use this module.
router.use((req, res, next) => {
  const role = req.user && req.user.role;
  if (![ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER].includes(role)) {
    return next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
  }
  // Admins must have the ORDERS module enabled by the Super Admin.
  if (role === ROLES.ADMIN) {
    const perms = effectiveAdminPermissions(req.user.adminPermissions);
    if (!perms.ORDERS) {
      return next(new AppError('Orders Management is disabled for your account by the Super Admin.', 403, 'MODULE_FORBIDDEN'));
    }
  }
  next();
});

/* ── Reads (all three roles; manager auto-scoped to own users) ── */
router.get('/account-types', c.accountTypes);   // distinct types actually in use
router.get('/summary', c.summary);
router.get('/open', c.openOrders);
router.get('/pending', c.pendingOrders);
router.get('/closed', c.closedOrders);
router.get('/risk', c.risk);
router.get('/detail/:kind/:id', c.detail);

/* ── Position actions ── */
router.post('/positions/:id/modify', c.modifySLTP);   // SL/TP — managers allowed
router.post('/positions/:id/close', c.forceClose);    // manage only
router.post('/positions/:id/book', c.transferBook);   // manage only
router.post('/positions/:id/comment', c.addComment);  // manage only

/* ── Pending-order actions (manage only) ── */
router.post('/orders/:id/cancel', c.cancelPending);
router.post('/orders/:id/execute', c.forceExecute);
router.post('/orders/:id/modify', c.modifyPending);

/* ── Bulk (manage only) ── */
router.post('/bulk', c.bulk);

module.exports = router;
