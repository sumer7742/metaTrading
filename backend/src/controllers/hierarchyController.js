/**
 * Hierarchy controller — thin HTTP layer over hierarchyService. Enforces
 * caller scope (admins → own tree, managers → own users only; SuperAdmin
 * unscoped) and audits every mutation via the platform AuditLog. Uses the
 * standard sendSuccess / AppError envelope — no new response shapes.
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const svc = require('../services/hierarchyService');
const { ROLES } = require('../config/constants');

// Best-effort audit — never blocks the action if logging fails.
async function audit(req, action, target, metadata = {}) {
  try {
    const { AuditLog } = require('../models');
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId,
      actorRole: req.user?.role,
      action,
      targetType: target?.type,
      targetId: target?.id != null ? String(target.id) : undefined,
      metadata,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

const ctxOf = (req) => ({ actor: req.user, ip: req.ip, reason: req.body?.reason, notes: req.body?.notes });
const listOpts = (req) => ({
  search: req.query.search, page: req.query.page, limit: req.query.limit,
  sort: req.query.sort, status: req.query.status, role: req.query.role,
  managerStatus: req.query.managerStatus, // 'all' | 'unassigned' | 'assigned' (admin pool views)
});
const isSuper = (req) => req.user.role === ROLES.SUPER_ADMIN;

/* ── Admin management (SuperAdmin only) ─────────────────────────────── */
const listAdmins = asyncHandler(async (req, res) => sendSuccess(res, await svc.listAdmins(listOpts(req))));

const createAdmin = asyncHandler(async (req, res) => {
  const user = await svc.createRole(ROLES.ADMIN, req.body, req.user);
  await audit(req, 'ADMIN_CREATED', { type: 'USER', id: user._id }, { email: user.email });
  sendSuccess(res, { user: user.toSafeJSON ? user.toSafeJSON() : user, generatedPassword: user._generatedPassword }, 201);
});

const deactivateAdmin = asyncHandler(async (req, res) => {
  const out = await svc.deactivateAdmin(req.params.id, req.query.strategy || 'toSuperPool', ctxOf(req));
  await audit(req, 'ADMIN_DEACTIVATED', { type: 'USER', id: req.params.id }, out);
  sendSuccess(res, out);
});

/* ── Manager management (SuperAdmin + Admin) ────────────────────────── */
const listManagers = asyncHandler(async (req, res) => {
  const scopeAdminId = isSuper(req) ? (req.query.adminId || null) : req.user._id;
  sendSuccess(res, await svc.listManagers(scopeAdminId, listOpts(req)));
});

const createManager = asyncHandler(async (req, res) => {
  // Admins create only under themselves; SuperAdmin must pass parentId (the admin).
  const payload = { ...req.body, parentId: isSuper(req) ? req.body.parentId : req.user._id };
  const user = await svc.createRole(ROLES.MANAGER, payload, req.user);
  await audit(req, 'MANAGER_CREATED', { type: 'USER', id: user._id }, { email: user.email, adminId: payload.parentId });
  sendSuccess(res, { user: user.toSafeJSON ? user.toSafeJSON() : user, generatedPassword: user._generatedPassword }, 201);
});

const deactivateManager = asyncHandler(async (req, res) => {
  const out = await svc.deactivateManager(req.params.id, req.query.strategy || 'toAdminPool', ctxOf(req));
  await audit(req, 'MANAGER_DEACTIVATED', { type: 'USER', id: req.params.id }, out);
  sendSuccess(res, out);
});

/* ── Assignment (SuperAdmin + Admin) ────────────────────────────────── */
const assignAdmin = asyncHandler(async (req, res) => {
  if (!isSuper(req)) throw new AppError('Only SuperAdmin can assign users to an admin', 403, 'FORBIDDEN');
  const { userId, adminId } = req.body;
  if (!userId || !adminId) throw new AppError('userId and adminId required', 400);
  const user = await svc.assignUserToAdmin(userId, adminId, ctxOf(req));
  await audit(req, 'USER_ASSIGNED_ADMIN', { type: 'USER', id: userId }, { adminId });
  sendSuccess(res, user);
});

const assignManager = asyncHandler(async (req, res) => {
  const { userId, managerId } = req.body;
  if (!userId || !managerId) throw new AppError('userId and managerId required', 400);
  const user = await svc.assignUserToManager(userId, managerId, ctxOf(req));
  await audit(req, 'USER_ASSIGNED_MANAGER', { type: 'USER', id: userId }, { managerId });
  sendSuccess(res, user);
});

const reassign = asyncHandler(async (req, res) => {
  const { userId, managerId } = req.body;
  if (!userId || !managerId) throw new AppError('userId and managerId required', 400);
  const user = await svc.reassign(userId, managerId, ctxOf(req));
  await audit(req, 'USER_REASSIGNED', { type: 'USER', id: userId }, { managerId });
  sendSuccess(res, user);
});

const unassign = asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!userId) throw new AppError('userId required', 400);
  const user = await svc.unassign(userId, ctxOf(req));
  await audit(req, 'USER_UNASSIGNED', { type: 'USER', id: userId });
  sendSuccess(res, user);
});

const bulkAssign = asyncHandler(async (req, res) => {
  const { userIds, adminId, managerId } = req.body;
  if (!Array.isArray(userIds) || !userIds.length) throw new AppError('userIds[] required', 400);
  if (adminId && !isSuper(req)) throw new AppError('Only SuperAdmin can bulk-assign to an admin', 403, 'FORBIDDEN');
  const out = await svc.bulkAssign(userIds, { adminId, managerId }, ctxOf(req));
  await audit(req, 'USER_BULK_ASSIGNED', { type: 'USER', id: 'bulk' }, { count: userIds.length, adminId, managerId, ok: out.ok, failed: out.failed });
  sendSuccess(res, out);
});

/* ── Scoped reads (SuperAdmin + Admin + Manager) ────────────────────── */
const unassigned = asyncHandler(async (req, res) => {
  if (req.user.role === ROLES.MANAGER) throw new AppError('Insufficient permissions', 403, 'FORBIDDEN');
  sendSuccess(res, await svc.listUnassigned(listOpts(req)));
});

const users = asyncHandler(async (req, res) => {
  const opts = listOpts(req);
  let result, scope;
  if (req.user.role === ROLES.MANAGER) {
    scope = { managerId: String(req.user._id) };
    result = await svc.listUsersForManager(req.user._id, opts);
  } else if (req.user.role === ROLES.ADMIN) {
    if (req.query.managerId) {
      scope = { managerId: req.query.managerId };
      result = await svc.listUsersForManager(req.query.managerId, opts);
    } else {
      // Admin's own users (ownership = adminId only). This is the list the
      // "Assign Users → Manager" screen needs — independent of manager status.
      scope = { adminId: String(req.user._id), managerStatus: opts.managerStatus || 'all' };
      result = await svc.listUsersForAdmin(req.user._id, opts);
    }
  } else {
    // SuperAdmin — honor explicit filters.
    if (req.query.managerId) {
      scope = { managerId: req.query.managerId };
      result = await svc.listUsersForManager(req.query.managerId, opts);
    } else if (req.query.adminId) {
      scope = { adminId: req.query.adminId, managerStatus: opts.managerStatus || 'all' };
      result = await svc.listUsersForAdmin(req.query.adminId, opts);
    } else {
      scope = { unassigned: true };
      result = await svc.listUnassigned(opts);
    }
  }
  // Debug aid (requirement #5) — on by default; set HIERARCHY_DEBUG=false to silence.
  if (process.env.HIERARCHY_DEBUG !== 'false') {
    console.log(`[hierarchy.users] actor=${req.user._id} role=${req.user.role} scope=${JSON.stringify(scope)} returned=${result.items.length}/${result.total}`);
  }
  sendSuccess(res, result);
});

const workload = asyncHandler(async (req, res) => {
  const scope = req.user.role === ROLES.MANAGER ? { managerId: req.user._id }
    : req.user.role === ROLES.ADMIN ? { adminId: req.user._id }
    : { adminId: req.query.adminId, managerId: req.query.managerId };
  sendSuccess(res, await svc.workload(scope));
});

const tree = asyncHandler(async (req, res) => {
  const scope = req.user.role === ROLES.ADMIN ? { adminId: req.user._id }
    : isSuper(req) ? { adminId: req.query.adminId } : {};
  sendSuccess(res, await svc.tree(scope));
});

module.exports = {
  listAdmins, createAdmin, deactivateAdmin,
  listManagers, createManager, deactivateManager,
  assignAdmin, assignManager, reassign, unassign, bulkAssign,
  unassigned, users, workload, tree,
};
