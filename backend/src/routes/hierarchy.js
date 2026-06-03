const express = require('express');
const c = require('../controllers/hierarchyController');
const { authenticate, allowPermission, requireHierarchy } = require('../middleware/auth');

const router = express.Router();

// Every hierarchy route requires auth + the feature flag (404 when off).
// Note: this router is NOT behind the legacy requireAdmin (which forces
// 2FA + ADMIN/SUPER_ADMIN only) so MANAGERs can use their scoped reads.
router.use(authenticate, requireHierarchy);

// ── Admin management — SuperAdmin only ──────────────────────────────
router.get('/admins',        allowPermission('hierarchy.admin.manage'), c.listAdmins);
router.post('/admins',       allowPermission('hierarchy.admin.manage'), c.createAdmin);
router.delete('/admins/:id', allowPermission('hierarchy.admin.manage'), c.deactivateAdmin);

// ── Manager management — SuperAdmin + Admin (admins scoped to own) ───
router.get('/managers',        allowPermission('hierarchy.manager.manage'), c.listManagers);
router.post('/managers',       allowPermission('hierarchy.manager.manage'), c.createManager);
router.delete('/managers/:id', allowPermission('hierarchy.manager.manage'), c.deactivateManager);

// ── Assignment — SuperAdmin + Admin ─────────────────────────────────
router.post('/assign/admin',   allowPermission('hierarchy.assign'), c.assignAdmin);
router.post('/assign/manager', allowPermission('hierarchy.assign'), c.assignManager);
router.post('/reassign',       allowPermission('hierarchy.assign'), c.reassign);
router.post('/unassign',       allowPermission('hierarchy.assign'), c.unassign);
router.post('/bulk',           allowPermission('hierarchy.assign'), c.bulkAssign);

// ── Scoped reads — SuperAdmin + Admin + Manager ─────────────────────
router.get('/unassigned', allowPermission('hierarchy.view'), c.unassigned);
router.get('/users',      allowPermission('hierarchy.view'), c.users);
router.get('/workload',   allowPermission('hierarchy.view'), c.workload);
router.get('/tree',       allowPermission('hierarchy.view'), c.tree);

module.exports = router;
