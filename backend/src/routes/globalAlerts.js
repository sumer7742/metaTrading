/**
 * Global Alert Popup routes — mounted at /api/alerts.
 *
 *   • User endpoints (any authenticated user): pending list + acknowledge.
 *   • Admin endpoints (Super Admin / Admin): full management. Admins must have
 *     the ALERTS module granted by the Super Admin (Admin Access Control);
 *     Admins are scoped to their own subtree inside the controller.
 */
const express = require('express');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../utils/errors');
const { ROLES } = require('../config/constants');
const { effectiveAdminPermissions } = require('../config/adminPermissions');
const c = require('../controllers/globalAlertController');

const router = express.Router();

router.use(authenticate);

/* ── User-facing (every authenticated user) ── */
router.get('/pending', c.pending);
router.post('/:id/acknowledge', c.acknowledge);

/* ── Admin gate ── */
const adminGate = (req, res, next) => {
  const role = req.user && req.user.role;
  if (![ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(role)) {
    return next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
  }
  if (role === ROLES.ADMIN) {
    const perms = effectiveAdminPermissions(req.user.adminPermissions);
    if (!perms.ALERTS) {
      return next(new AppError('Global Alerts is disabled for your account by the Super Admin.', 403, 'MODULE_FORBIDDEN'));
    }
  }
  next();
};

/* ── Admin-facing management ── */
router.get('/admin', adminGate, c.adminList);
router.post('/admin', adminGate, c.adminCreate);
// Send a bell notification to targeted users (persisted + live WS).
router.post('/admin/notify', adminGate, c.adminNotify);
router.get('/admin/:id', adminGate, c.adminGet);
router.put('/admin/:id', adminGate, c.adminUpdate);
router.patch('/admin/:id/active', adminGate, c.adminSetActive);
router.delete('/admin/:id', adminGate, c.adminDelete);
router.get('/admin/:id/stats', adminGate, c.adminStats);

module.exports = router;
