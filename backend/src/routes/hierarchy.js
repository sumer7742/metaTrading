const express = require('express');
const c = require('../controllers/hierarchyController');
const { authenticate, allowPermission, requireManagerPermission, requireHierarchy } = require('../middleware/auth');

const router = express.Router();

// Every hierarchy route requires auth + the feature flag (404 when off).
// Note: this router is NOT behind the legacy requireAdmin (which forces
// 2FA + ADMIN/SUPER_ADMIN only) so MANAGERs can use their scoped reads.
router.use(authenticate, requireHierarchy);

// ── Admin management — SuperAdmin only ──────────────────────────────
router.get('/admins',        allowPermission('hierarchy.admin.manage'), c.listAdmins);
// Configurable platform-wide admin cap (read + set). Declared before the
// '/admins/:id' delete so the literal path isn't shadowed.
router.get('/admins/cap',    allowPermission('hierarchy.admin.manage'), c.getAdminCap);
router.put('/admins/cap',    allowPermission('hierarchy.superadmin'),   c.setAdminCap);
router.post('/admins',       allowPermission('hierarchy.admin.manage'), c.createAdmin);
router.delete('/admins/:id', allowPermission('hierarchy.admin.manage'), c.deactivateAdmin);

// Optional "preferred intake" manager — all new signups route here until full.
// Readable by admins; only the SuperAdmin may set/clear it.
router.get('/preferred-manager', allowPermission('hierarchy.manager.manage'), c.getPreferredManager);
router.put('/preferred-manager', allowPermission('hierarchy.superadmin'),     c.setPreferredManager);

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

// ── SuperAdmin: capacity-validated transfers ────────────────────────
router.post('/transfer-user',    allowPermission('hierarchy.superadmin'), c.transferUser);
router.post('/bulk-transfer',    allowPermission('hierarchy.superadmin'), c.bulkTransfer);
router.post('/transfer-manager', allowPermission('hierarchy.superadmin'), c.transferManager);

// ── SuperAdmin: auto-created staff account control ──────────────────
router.get('/auto-created',                allowPermission('hierarchy.superadmin'), c.listAutoCreated);
// Name / email / password edits are shared with Admins: SuperAdmin can edit
// ANY admin/manager, an Admin can edit ONLY their own managers. The fine-grained
// tree check is enforced in hierarchyService (assertCanManageStaff).
router.patch('/staff/:id',                 allowPermission('hierarchy.manager.manage'), c.renameStaff);
router.patch('/staff/:id/email',           allowPermission('hierarchy.manager.manage'), c.changeStaffEmail);
router.post('/staff/:id/reset-password',   allowPermission('hierarchy.manager.manage'), c.resetStaffPassword);
router.post('/staff/:id/login',            allowPermission('hierarchy.superadmin'), c.setLoginEnabled);
router.post('/staff/:id/claim',            allowPermission('hierarchy.superadmin'), c.claimStaff);

// ── Scoped reads — SuperAdmin + Admin + Manager ─────────────────────
router.get('/unassigned', allowPermission('hierarchy.view'), c.unassigned);
// Managers additionally need the USER_MANAGEMENT module permission (Manager
// Access Control). Admin/Super bypass inside requireManagerPermission.
router.get('/users',      allowPermission('hierarchy.view'), requireManagerPermission('USER_MANAGEMENT'), c.users);
router.get('/workload',   allowPermission('hierarchy.view'), c.workload);
router.get('/tree',       allowPermission('hierarchy.view'), c.tree);

// ── Hierarchical limits — SUPER ADMIN ONLY ──────────────────────────
// Only the Super Admin can view or edit the Max Managers / Max Users
// quotas. limitService.assertCanManage re-checks the role server-side.
router.get('/limits/:id', allowPermission('hierarchy.superadmin'), c.getLimits);
router.put('/limits/:id', allowPermission('hierarchy.superadmin'), c.setLimits);

module.exports = router;
