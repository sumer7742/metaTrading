/**
 * Hierarchy service — all logic for the SuperAdmin → Admin → Manager → User
 * management tree. Additive: it only reads/writes the new optional User
 * fields (role / adminId / managerId / assignedAt) + the AssignmentLog.
 * It never touches trading, wallet, or auth logic.
 *
 * Role-agnostic by design: caps + parent links come from ROLE_REGISTRY so
 * future management roles need no code change here.
 */
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const User = require('../models/User');
const AssignmentLog = require('../models/AssignmentLog');
const { ROLES } = require('../config/constants');
const { ROLE_REGISTRY } = require('../config/hierarchy');
const { AppError } = require('../utils/errors');

const DEMO_TYPES = ['DEMO', 'VIRTUAL'];
const STAFF_SELECT = '-passwordHash -twoFactorSecret -refreshTokens -twoFactorBackupCodes';

// ─── helpers ─────────────────────────────────────────────────────────
const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

function buildUserFilter({ search, status, role } = {}) {
  const f = {};
  if (role) f.role = role;
  if (status === 'active') f.isActive = true;
  else if (status === 'inactive') f.isActive = false;
  if (search) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }, { phone: rx }];
  }
  return f;
}

function sortSpec(sort) {
  // "field" asc, "-field" desc; default newest first.
  if (!sort) return { createdAt: -1 };
  const dir = sort.startsWith('-') ? -1 : 1;
  return { [sort.replace(/^-/, '')]: dir };
}

async function paginate(filter, { page = 1, limit = 50, sort } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const [items, total] = await Promise.all([
    User.find(filter).select(STAFF_SELECT).sort(sortSpec(sort)).skip((p - 1) * l).limit(l).lean(),
    User.countDocuments(filter),
  ]);
  return { items, total, page: p, limit: l };
}

// ─── role creation (generic, registry-driven) ────────────────────────
/**
 * Create or promote a management role (ADMIN, MANAGER, or any future role
 * defined in ROLE_REGISTRY). Enforces the role's cap.
 *
 * @param roleKey   e.g. ROLES.ADMIN / ROLES.MANAGER
 * @param payload   { email, password?, firstName?, lastName?, parentId? }
 *                  parentId = the admin a manager belongs to (required when
 *                  the registry entry has parentField). For a non-super
 *                  actor it's forced to the actor's own id.
 * @param actor     req.user (the creator)
 */
async function createRole(roleKey, payload = {}, actor) {
  const cfg = ROLE_REGISTRY[roleKey];
  if (!cfg) throw new AppError(`Unknown management role: ${roleKey}`, 400, 'BAD_ROLE');
  const email = String(payload.email || '').toLowerCase().trim();
  if (!email) throw new AppError('email required', 400);

  // Resolve the parent reference (e.g. a manager's adminId).
  let parentId = null;
  if (cfg.parentField) {
    if (actor.role === ROLES.SUPER_ADMIN) {
      parentId = payload.parentId || null;
      if (!parentId) throw new AppError(`parentId (${cfg.parentField}) required`, 400);
    } else {
      // A non-super creator can only create children under themselves.
      parentId = actor._id;
    }
    const parent = await User.findById(parentId).select('_id role').lean();
    if (!parent || parent.role !== cfg.parentRole) {
      throw new AppError(`Parent must be a ${cfg.parentRole}`, 400, 'BAD_PARENT');
    }
  }

  // Cap enforcement — global or scoped to the parent.
  const capFilter = { role: roleKey };
  if (cfg.capScope === 'parent' && cfg.parentField) capFilter[cfg.parentField] = parentId;
  const count = await User.countDocuments(capFilter);
  if (count >= cfg.cap) {
    throw new AppError(
      `Limit reached: at most ${cfg.cap} ${roleKey.toLowerCase()}${cfg.capScope === 'parent' ? ' per ' + cfg.parentRole.toLowerCase() : ''}.`,
      409, 'CAP_REACHED'
    );
  }

  // Promote an existing user, or create a fresh staff account.
  let user = await User.findOne({ email });
  if (user) {
    user.role = roleKey;
    if (cfg.parentField) user[cfg.parentField] = parentId;
    await user.save();
  } else {
    const password = payload.password || uuidv4().slice(0, 12);
    const passwordHash = await bcrypt.hash(password, 12);
    user = await User.create({
      email,
      passwordHash,
      firstName: payload.firstName || '',
      lastName: payload.lastName || '',
      role: roleKey,
      isEmailVerified: true,
      referralCode: uuidv4().slice(0, 8).toUpperCase(),
      ...(cfg.parentField ? { [cfg.parentField]: parentId } : {}),
    });
    user._generatedPassword = payload.password ? undefined : password; // surfaced once to the creator
  }
  return user;
}

// ─── assignment ──────────────────────────────────────────────────────
async function _logAssignment(action, before, after, ctx) {
  await AssignmentLog.create({
    userId: after._id,
    action,
    fromAdminId: before.adminId || null,
    toAdminId: after.adminId || null,
    fromManagerId: before.managerId || null,
    toManagerId: after.managerId || null,
    reason: ctx.reason || '',
    notes: ctx.notes || '',
    actorId: ctx.actor?._id,
    actorRole: ctx.actor?.role,
    ip: ctx.ip,
  });
}

/** Assign a user directly to an admin (clears any manager — must be re-set under that admin). */
async function assignUserToAdmin(userId, adminId, ctx = {}) {
  const [user, admin] = await Promise.all([
    User.findById(userId),
    User.findById(adminId).select('_id role').lean(),
  ]);
  if (!user) throw new AppError('User not found', 404);
  if (user.role !== ROLES.USER) throw new AppError('Only regular users can be assigned', 400, 'NOT_A_USER');
  if (!admin || admin.role !== ROLES.ADMIN) throw new AppError('Target is not an admin', 400, 'BAD_ADMIN');

  const before = { adminId: user.adminId, managerId: user.managerId };
  const wasAssigned = !!user.adminId;
  user.adminId = admin._id;
  user.managerId = null; // changing admin detaches the old manager
  user.assignedAt = new Date();
  await user.save();
  await _logAssignment(wasAssigned ? 'REASSIGN' : 'ASSIGN', before, user, ctx);
  return user;
}

/** Assign a user to a manager; the user's adminId is derived from the manager's admin. */
async function assignUserToManager(userId, managerId, ctx = {}) {
  const [user, manager] = await Promise.all([
    User.findById(userId),
    User.findById(managerId).select('_id role adminId').lean(),
  ]);
  if (!user) throw new AppError('User not found', 404);
  if (user.role !== ROLES.USER) throw new AppError('Only regular users can be assigned', 400, 'NOT_A_USER');
  if (!manager || manager.role !== ROLES.MANAGER) throw new AppError('Target is not a manager', 400, 'BAD_MANAGER');

  // Scope check: a non-super actor must own the manager's admin tree.
  if (ctx.actor && ctx.actor.role === ROLES.ADMIN && String(manager.adminId) !== String(ctx.actor._id)) {
    throw new AppError('That manager is not in your team', 403, 'OUT_OF_SCOPE');
  }

  const before = { adminId: user.adminId, managerId: user.managerId };
  const wasAssigned = !!user.managerId || !!user.adminId;
  user.managerId = manager._id;
  user.adminId = manager.adminId || user.adminId; // ownership stays consistent (manager ∈ admin)
  user.assignedAt = new Date();
  await user.save();
  await _logAssignment(wasAssigned ? 'REASSIGN' : 'ASSIGN', before, user, ctx);
  return user;
}

/** Reassign = same as assign-to-manager but always logged as REASSIGN. */
async function reassign(userId, managerId, ctx = {}) {
  return assignUserToManager(userId, managerId, { ...ctx, _forceReassign: true });
}

async function unassign(userId, ctx = {}) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  const before = { adminId: user.adminId, managerId: user.managerId };
  user.adminId = null;
  user.managerId = null;
  user.assignedAt = null;
  await user.save();
  await _logAssignment('UNASSIGN', before, user, ctx);
  return user;
}

/** Bulk assign many users to an admin or a manager. Returns per-id results. */
async function bulkAssign(userIds = [], { adminId, managerId } = {}, ctx = {}) {
  const results = [];
  for (const id of userIds) {
    try {
      if (managerId) await assignUserToManager(id, managerId, ctx);
      else if (adminId) await assignUserToAdmin(id, adminId, ctx);
      else throw new AppError('adminId or managerId required', 400);
      results.push({ userId: id, ok: true });
    } catch (e) {
      results.push({ userId: id, ok: false, error: e.message });
    }
  }
  return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// ─── soft deactivation (no orphans) ──────────────────────────────────
/**
 * Deactivate a manager. strategy:
 *   'keep'              — leave users on this (now-inactive) manager
 *   'toAdminPool'       — detach users to their admin (managerId=null, keep adminId)
 *   'reassign:<id>'     — move users to another manager under the same admin
 */
async function deactivateManager(managerId, strategy = 'toAdminPool', ctx = {}) {
  const manager = await User.findById(managerId);
  if (!manager || manager.role !== ROLES.MANAGER) throw new AppError('Manager not found', 404);
  const users = await User.find({ managerId: manager._id });

  if (strategy.startsWith('reassign:')) {
    const targetId = strategy.split(':')[1];
    const target = await User.findById(targetId).select('_id role adminId').lean();
    if (!target || target.role !== ROLES.MANAGER || String(target.adminId) !== String(manager.adminId)) {
      throw new AppError('Reassign target must be a manager under the same admin', 400, 'BAD_TARGET');
    }
    for (const u of users) await assignUserToManager(u._id, targetId, { ...ctx, reason: ctx.reason || 'Manager deactivated' });
  } else if (strategy === 'toAdminPool') {
    for (const u of users) {
      const before = { adminId: u.adminId, managerId: u.managerId };
      u.managerId = null; // stays under the admin, no manager
      await u.save();
      await _logAssignment('REASSIGN', before, u, { ...ctx, reason: ctx.reason || 'Manager deactivated → admin pool' });
    }
  } // 'keep' → leave as-is

  manager.isActive = false;
  manager.role = ROLES.USER; // demote staff account
  manager.managerId = null;
  await manager.save();
  return { managerId, affectedUsers: users.length, strategy };
}

/**
 * Deactivate an admin. strategy:
 *   'reassignManagers:<id>' — move this admin's managers (and their users) to another admin
 *   'toSuperPool'           — detach managers + users to the SuperAdmin pool (adminId=null)
 */
async function deactivateAdmin(adminId, strategy = 'toSuperPool', ctx = {}) {
  const admin = await User.findById(adminId);
  if (!admin || admin.role !== ROLES.ADMIN) throw new AppError('Admin not found', 404);
  const managers = await User.find({ role: ROLES.MANAGER, adminId: admin._id });
  const usersUnderAdmin = await User.find({ adminId: admin._id, role: ROLES.USER });

  if (strategy.startsWith('reassignManagers:')) {
    const targetId = strategy.split(':')[1];
    const target = await User.findById(targetId).select('_id role').lean();
    if (!target || target.role !== ROLES.ADMIN) throw new AppError('Reassign target must be an admin', 400, 'BAD_TARGET');
    await User.updateMany({ role: ROLES.MANAGER, adminId: admin._id }, { $set: { adminId: target._id } });
    await User.updateMany({ adminId: admin._id, role: ROLES.USER }, { $set: { adminId: target._id } });
  } else { // toSuperPool
    for (const u of usersUnderAdmin) {
      const before = { adminId: u.adminId, managerId: u.managerId };
      u.adminId = null; u.managerId = null; u.assignedAt = null;
      await u.save();
      await _logAssignment('UNASSIGN', before, u, { ...ctx, reason: ctx.reason || 'Admin deactivated → super pool' });
    }
    await User.updateMany({ role: ROLES.MANAGER, adminId: admin._id }, { $set: { adminId: null } });
  }

  admin.isActive = false;
  admin.role = ROLES.USER;
  admin.adminId = null;
  await admin.save();
  return { adminId, managers: managers.length, users: usersUnderAdmin.length, strategy };
}

// ─── lists (server-side pagination + search/sort/filter) ─────────────
function listAdmins(opts = {}) {
  return paginate({ ...buildUserFilter({ ...opts, role: ROLES.ADMIN }) }, opts);
}
function listManagers(scopeAdminId, opts = {}) {
  const f = buildUserFilter({ ...opts, role: ROLES.MANAGER });
  if (scopeAdminId) f.adminId = oid(scopeAdminId);
  return paginate(f, opts);
}
function listUnassigned(opts = {}) {
  return paginate({ ...buildUserFilter({ ...opts, role: ROLES.USER }), adminId: null, managerId: null }, opts);
}
function listUsersForAdmin(adminId, opts = {}) {
  // All users owned by this admin. Optional managerStatus narrows to the
  // admin's "pool" (no manager yet) or those already under a manager —
  // ownership is ALWAYS based on adminId only (never createdBy/ownerId/etc).
  const f = { ...buildUserFilter({ ...opts, role: ROLES.USER }), adminId: oid(adminId) };
  if (opts.managerStatus === 'unassigned') f.managerId = null;
  else if (opts.managerStatus === 'assigned') f.managerId = { $ne: null };
  return paginate(f, opts);
}
function listUsersForManager(managerId, opts = {}) {
  return paginate({ ...buildUserFilter({ ...opts, role: ROLES.USER }), managerId: oid(managerId) }, opts);
}

// ─── workload analytics (single aggregation, scales) ─────────────────
const COUNT_STAGE = {
  totalUsers:      { $sum: 1 },
  activeUsers:     { $sum: { $cond: ['$isActive', 1, 0] } },
  verifiedUsers:   { $sum: { $cond: [{ $eq: ['$kycStatus', 'APPROVED'] }, 1, 0] } },
  pendingKycUsers: { $sum: { $cond: [{ $eq: ['$kycStatus', 'PENDING'] }, 1, 0] } },
};

async function workload(scope = {}) {
  // Per-admin rollup.
  const adminAgg = await User.aggregate([
    { $match: { role: ROLES.USER, adminId: { $ne: null }, ...(scope.adminId ? { adminId: oid(scope.adminId) } : {}) } },
    { $group: { _id: '$adminId', ...COUNT_STAGE } },
  ]);
  const managerAgg = await User.aggregate([
    { $match: { role: ROLES.USER, managerId: { $ne: null }, ...(scope.managerId ? { managerId: oid(scope.managerId) } : scope.adminId ? { adminId: oid(scope.adminId) } : {}) } },
    { $group: { _id: '$managerId', ...COUNT_STAGE } },
  ]);
  const mgrCounts = await User.aggregate([
    { $match: { role: ROLES.MANAGER, ...(scope.adminId ? { adminId: oid(scope.adminId) } : {}) } },
    { $group: { _id: '$adminId', managerCount: { $sum: 1 } } },
  ]);
  const mgrCountBy = new Map(mgrCounts.map((m) => [String(m._id), m.managerCount]));

  // Attach staff identities.
  const adminIds = adminAgg.map((a) => a._id).concat([...mgrCountBy.keys()].map(oid));
  const mgrIds = managerAgg.map((m) => m._id);
  const staff = await User.find({ _id: { $in: [...adminIds, ...mgrIds] } }).select('firstName lastName email role').lean();
  const staffBy = new Map(staff.map((s) => [String(s._id), s]));
  const cap = (role) => (ROLE_REGISTRY[role] ? ROLE_REGISTRY[role].userCapacity : 0);
  const ident = (id) => { const s = staffBy.get(String(id)); return s ? { id: String(id), name: [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email, email: s.email } : { id: String(id) }; };

  const adminById = new Map(adminAgg.map((a) => [String(a._id), a]));
  const allAdminIds = new Set([...adminById.keys(), ...mgrCountBy.keys()]);
  const admins = [...allAdminIds].map((id) => {
    const a = adminById.get(id) || {};
    return { ...ident(id), totalUsers: a.totalUsers || 0, activeUsers: a.activeUsers || 0, verifiedUsers: a.verifiedUsers || 0, pendingKycUsers: a.pendingKycUsers || 0, managerCount: mgrCountBy.get(id) || 0, userCapacity: cap(ROLES.ADMIN) };
  });
  const managers = managerAgg.map((m) => ({ ...ident(m._id), totalUsers: m.totalUsers, activeUsers: m.activeUsers, verifiedUsers: m.verifiedUsers, pendingKycUsers: m.pendingKycUsers, userCapacity: cap(ROLES.MANAGER) }));
  return { admins, managers };
}

// ─── hierarchy tree (grouped, no N+1) ────────────────────────────────
async function tree(scope = {}) {
  const admins = await User.find(scope.adminId ? { _id: oid(scope.adminId) } : { role: ROLES.ADMIN })
    .select('firstName lastName email role').lean();
  const adminIds = admins.map((a) => a._id);
  const managers = await User.find({ role: ROLES.MANAGER, ...(adminIds.length ? { adminId: { $in: adminIds } } : {}) })
    .select('firstName lastName email adminId').lean();

  // user counts per admin + per manager (one aggregation each).
  const byAdmin = new Map((await User.aggregate([
    { $match: { role: ROLES.USER, adminId: { $ne: null } } },
    { $group: { _id: '$adminId', n: { $sum: 1 } } },
  ])).map((r) => [String(r._id), r.n]));
  const byManager = new Map((await User.aggregate([
    { $match: { role: ROLES.USER, managerId: { $ne: null } } },
    { $group: { _id: '$managerId', n: { $sum: 1 } } },
  ])).map((r) => [String(r._id), r.n]));
  const unassignedCount = await User.countDocuments({ role: ROLES.USER, adminId: null, managerId: null });

  const name = (s) => [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email;
  const mgrsByAdmin = {};
  for (const m of managers) {
    (mgrsByAdmin[String(m.adminId)] ||= []).push({ id: String(m._id), name: name(m), role: 'MANAGER', userCount: byManager.get(String(m._id)) || 0 });
  }
  return {
    root: 'SUPER_ADMIN',
    unassignedUsers: unassignedCount,
    admins: admins.map((a) => ({
      id: String(a._id), name: name(a), role: 'ADMIN', userCount: byAdmin.get(String(a._id)) || 0,
      managers: mgrsByAdmin[String(a._id)] || [],
    })),
  };
}

module.exports = {
  createRole,
  assignUserToAdmin, assignUserToManager, reassign, unassign, bulkAssign,
  deactivateManager, deactivateAdmin,
  listAdmins, listManagers, listUnassigned, listUsersForAdmin, listUsersForManager,
  workload, tree,
};
