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
const { ROLE_REGISTRY, AUTO } = require('../config/hierarchy');
const { AppError } = require('../utils/errors');

const STAFF_ROLES = [ROLES.ADMIN, ROLES.MANAGER];

const DEMO_TYPES = ['DEMO', 'VIRTUAL'];
const STAFF_SELECT = '-passwordHash -twoFactorSecret -refreshTokens -twoFactorBackupCodes';

// ─── helpers ─────────────────────────────────────────────────────────
const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

function buildUserFilter({ search, status, role, autoCreated } = {}) {
  const f = {};
  if (role) f.role = role;
  if (status === 'active') f.isActive = true;
  else if (status === 'inactive') f.isActive = false;
  if (autoCreated === true || autoCreated === 'true') f.autoCreated = true;
  else if (autoCreated === false || autoCreated === 'false') f.autoCreated = false;
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
      // Auto-provisioned staff start locked out of login until claimed.
      autoCreated: !!payload.autoCreated,
      loginEnabled: payload.loginEnabled !== undefined ? !!payload.loginEnabled : true,
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

// ─── system audit (staff lifecycle → platform AuditLog) ──────────────
// Movement events (assign/reassign/transfer) already write the user-centric
// AssignmentLog; this records staff lifecycle events (auto-create, credential
// change, login toggle, claim, manager transfer) to the platform AuditLog so
// there's one complete history. Best-effort — never blocks the action.
async function systemAudit(action, targetId, metadata = {}, ctx = {}) {
  try {
    const { AuditLog } = require('../models');
    if (!AuditLog) return;
    await AuditLog.create({
      actorId:   ctx.actor?._id || targetId, // SYSTEM events fall back to the target
      actorRole: ctx.actor?.role || 'SYSTEM',
      action,
      targetType: 'USER',
      targetId:  String(targetId),
      metadata,
      ip: ctx.ip,
    });
  } catch (_) { /* non-fatal */ }
}

// ─── capacity helpers ────────────────────────────────────────────────
const managerCap = () => AUTO.maxUsersPerManager;
const adminMgrCap = () => ROLE_REGISTRY[ROLES.MANAGER].cap;   // managers per admin (10)
const adminCap   = () => ROLE_REGISTRY[ROLES.ADMIN].cap;      // admins platform-wide (4)

/** Count USERs currently held by a manager. */
function managerUserCount(managerId) {
  return User.countDocuments({ role: ROLES.USER, managerId: oid(managerId) });
}

/** Least-loaded ACTIVE manager that still has room (< maxUsersPerManager). */
async function pickManagerWithCapacity({ adminId } = {}) {
  const f = { role: ROLES.MANAGER, isActive: true };
  if (adminId) f.adminId = oid(adminId);
  const managers = await User.find(f).select('_id adminId').lean();
  if (!managers.length) return null;
  const ids = managers.map((m) => m._id);
  const counts = await User.aggregate([
    { $match: { role: ROLES.USER, managerId: { $in: ids } } },
    { $group: { _id: '$managerId', n: { $sum: 1 } } },
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
  const cap = managerCap();
  let best = null; let bestN = Infinity;
  for (const m of managers) {
    const n = countBy.get(String(m._id)) || 0;
    if (n < cap && n < bestN) { best = m; bestN = n; }
  }
  return best ? { manager: best, count: bestN } : null;
}

/** An ACTIVE admin that can still take another manager (< managers-per-admin cap). */
async function pickAdminWithManagerSlot() {
  const admins = await User.find({ role: ROLES.ADMIN, isActive: true }).select('_id').lean();
  if (!admins.length) return null;
  const ids = admins.map((a) => a._id);
  const counts = await User.aggregate([
    { $match: { role: ROLES.MANAGER, adminId: { $in: ids } } },
    { $group: { _id: '$adminId', n: { $sum: 1 } } },
  ]);
  const countBy = new Map(counts.map((c) => [String(c._id), c.n]));
  const cap = adminMgrCap();
  let best = null; let bestN = Infinity;
  for (const a of admins) {
    const n = countBy.get(String(a._id)) || 0;
    if (n < cap && n < bestN) { best = a; bestN = n; }
  }
  return best || null;
}

// ─── auto-provisioning (the scalable core) ───────────────────────────
const SUPER_ACTOR = { role: ROLES.SUPER_ADMIN }; // synthetic actor so createRole honors parentId

async function createAutoManager(adminId, ctx = {}) {
  const manager = await createRole(ROLES.MANAGER, {
    parentId: adminId,
    email: `auto.manager.${uuidv4().slice(0, 8)}@system.local`,
    firstName: 'Auto', lastName: 'Manager',
    autoCreated: true, loginEnabled: false,
  }, SUPER_ACTOR);
  await systemAudit('MANAGER_AUTO_CREATED', manager._id, { adminId: String(adminId) }, ctx);
  return manager;
}

async function createAutoAdmin(ctx = {}) {
  const admin = await createRole(ROLES.ADMIN, {
    email: `auto.admin.${uuidv4().slice(0, 8)}@system.local`,
    firstName: 'Auto', lastName: 'Admin',
    autoCreated: true, loginEnabled: false,
  }, SUPER_ACTOR);
  await systemAudit('ADMIN_AUTO_CREATED', admin._id, {}, ctx);
  return admin;
}

/**
 * Place a freshly-registered USER into the hierarchy, auto-scaling as needed:
 *   1. assign to the least-loaded manager that has room;
 *   2. else create a manager under an admin that has a free manager slot;
 *   3. else (all managers full, every admin at the manager cap) create a new
 *      admin (within the admin cap) + its first manager, then assign.
 * If the whole platform is at its configured ceiling the user is left
 * Unassigned (a SuperAdmin can raise caps / place them manually). Best-effort:
 * never throws into the registration flow.
 */
async function autoAssignNewUser(user, ctx = {}) {
  try {
    if (!user || user.role !== ROLES.USER) return null;
    if (user.managerId || user.adminId) return user; // already placed

    // 1 — existing manager with room.
    const pick = await pickManagerWithCapacity();
    if (pick) return assignUserToManager(user._id, pick.manager._id, { ...ctx, reason: 'auto-assignment' });

    // 2 — an admin that can take a new manager.
    let admin = await pickAdminWithManagerSlot();

    // 3 — no admin has a free manager slot → create a new admin (within cap).
    if (!admin) {
      const adminCount = await User.countDocuments({ role: ROLES.ADMIN });
      if (adminCount < adminCap()) admin = await createAutoAdmin(ctx);
    }

    if (admin) {
      const manager = await createAutoManager(admin._id, ctx);
      return assignUserToManager(user._id, manager._id, { ...ctx, reason: 'auto-assignment (auto-created manager)' });
    }

    // 4 — platform at capacity. Leave unassigned; surfaced for ops.
    console.warn(`[hierarchy] auto-assign: platform at capacity — user ${user._id} left unassigned`);
    return null;
  } catch (e) {
    console.error('[hierarchy] autoAssignNewUser failed:', e.message);
    return null;
  }
}

// ─── capacity-validated transfers (SuperAdmin) ───────────────────────
async function assertManagerCapacity(managerId, incoming = 1) {
  const cap = managerCap();
  const current = await managerUserCount(managerId);
  if (current + incoming > cap) {
    throw new AppError(`Manager is at capacity (${current}/${cap}); cannot accept ${incoming} more user(s).`, 409, 'MANAGER_FULL');
  }
}

/** Transfer a single user to another manager (capacity-checked) or admin pool. */
async function transferUser(userId, { adminId, managerId } = {}, ctx = {}) {
  if (managerId) {
    const already = await User.exists({ _id: oid(userId), managerId: oid(managerId) });
    if (!already) await assertManagerCapacity(managerId, 1);
    return assignUserToManager(userId, managerId, { ...ctx, reason: ctx.reason || 'SuperAdmin transfer' });
  }
  if (adminId) return assignUserToAdmin(userId, adminId, { ...ctx, reason: ctx.reason || 'SuperAdmin transfer' });
  throw new AppError('adminId or managerId required', 400);
}

/** Move many users to a manager (whole-batch capacity check) or an admin pool. */
async function bulkTransfer(userIds = [], { adminId, managerId } = {}, ctx = {}) {
  if (!Array.isArray(userIds) || !userIds.length) throw new AppError('userIds[] required', 400);
  if (managerId) {
    const ids = userIds.map(oid);
    const already = await User.countDocuments({ role: ROLES.USER, managerId: oid(managerId), _id: { $in: ids } });
    await assertManagerCapacity(managerId, Math.max(0, userIds.length - already));
    const results = [];
    for (const id of userIds) {
      try { await assignUserToManager(id, managerId, { ...ctx, reason: ctx.reason || 'SuperAdmin bulk transfer' }); results.push({ userId: id, ok: true }); }
      catch (e) { results.push({ userId: id, ok: false, error: e.message }); }
    }
    return { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }
  if (adminId) return bulkAssign(userIds, { adminId }, ctx); // admin pool — no per-manager cap
  throw new AppError('adminId or managerId required', 400);
}

/**
 * Move an ENTIRE manager (and all the users under them) to another admin.
 * Updates manager.adminId + every child user's adminId in one consistent
 * operation. Validates the target admin still has a manager slot.
 */
async function transferManager(managerId, targetAdminId, ctx = {}) {
  const manager = await User.findById(managerId);
  if (!manager || manager.role !== ROLES.MANAGER) throw new AppError('Manager not found', 404);
  const target = await User.findById(targetAdminId).select('_id role').lean();
  if (!target || target.role !== ROLES.ADMIN) throw new AppError('Target is not an admin', 400, 'BAD_ADMIN');
  if (String(manager.adminId) === String(target._id)) return { managerId, movedUsers: 0, note: 'already under target admin' };

  const targetMgrCount = await User.countDocuments({ role: ROLES.MANAGER, adminId: target._id });
  if (targetMgrCount >= adminMgrCap()) {
    throw new AppError(`Target admin already has the maximum ${adminMgrCap()} managers.`, 409, 'ADMIN_MANAGER_CAP');
  }

  const fromAdminId = manager.adminId || null;
  manager.adminId = target._id;
  await manager.save();
  // Keep every child user's ownership consistent (manager moves → users move).
  const res = await User.updateMany({ role: ROLES.USER, managerId: manager._id }, { $set: { adminId: target._id } });
  const movedUsers = res.modifiedCount ?? res.nModified ?? 0;

  await AssignmentLog.create({
    userId: manager._id, action: 'MANAGER_TRANSFER',
    fromAdminId, toAdminId: target._id, fromManagerId: null, toManagerId: null,
    reason: ctx.reason || 'Manager transferred to another admin',
    actorId: ctx.actor?._id, actorRole: ctx.actor?.role, ip: ctx.ip,
  });
  await systemAudit('MANAGER_TRANSFERRED', manager._id, { fromAdminId: String(fromAdminId || ''), toAdminId: String(target._id), movedUsers }, ctx);
  return { managerId, fromAdminId, toAdminId: target._id, movedUsers };
}

// ─── staff account control (SuperAdmin) ──────────────────────────────
async function getStaffOrThrow(id) {
  const u = await User.findById(id);
  if (!u || !STAFF_ROLES.includes(u.role)) throw new AppError('Staff account not found', 404, 'NOT_STAFF');
  return u;
}

async function renameStaff(id, { firstName, lastName } = {}, ctx = {}) {
  const u = await getStaffOrThrow(id);
  if (firstName !== undefined) u.firstName = String(firstName);
  if (lastName !== undefined) u.lastName = String(lastName);
  await u.save();
  await systemAudit('STAFF_RENAMED', u._id, { firstName: u.firstName, lastName: u.lastName }, ctx);
  return u;
}

async function changeStaffEmail(id, email, ctx = {}) {
  const u = await getStaffOrThrow(id);
  const e = String(email || '').toLowerCase().trim();
  if (!e) throw new AppError('email required', 400);
  const taken = await User.findOne({ email: e, _id: { $ne: u._id } }).select('_id').lean();
  if (taken) throw new AppError('Email already in use', 409, 'EMAIL_TAKEN');
  const from = u.email;
  u.email = e;
  await u.save();
  await systemAudit('STAFF_EMAIL_CHANGED', u._id, { from, to: e }, ctx);
  return u;
}

async function resetStaffPassword(id, newPassword, ctx = {}) {
  const u = await getStaffOrThrow(id);
  const pwd = newPassword || uuidv4().slice(0, 12);
  u.passwordHash = await bcrypt.hash(pwd, 12);
  u.refreshTokens = []; // revoke all sessions
  await u.save();
  await systemAudit('STAFF_PASSWORD_RESET', u._id, {}, ctx);
  return { user: u, generatedPassword: newPassword ? undefined : pwd };
}

async function setLoginEnabled(id, enabled, ctx = {}) {
  const u = await getStaffOrThrow(id);
  u.loginEnabled = !!enabled;
  if (!enabled) u.refreshTokens = []; // disabling kills active sessions
  await u.save();
  await systemAudit(enabled ? 'STAFF_LOGIN_ENABLED' : 'STAFF_LOGIN_DISABLED', u._id, {}, ctx);
  return u;
}

/**
 * Convert an auto-created account into a real operational one: optionally set
 * a real email/name/password, enable login, and stamp who claimed it & when.
 */
async function claimAutoCreated(id, { email, password, firstName, lastName, loginEnabled = true } = {}, ctx = {}) {
  const u = await getStaffOrThrow(id);
  if (!u.autoCreated) throw new AppError('Account is already a claimed/real account', 400, 'NOT_AUTO');
  if (email) {
    const e = String(email).toLowerCase().trim();
    const taken = await User.findOne({ email: e, _id: { $ne: u._id } }).select('_id').lean();
    if (taken) throw new AppError('Email already in use', 409, 'EMAIL_TAKEN');
    u.email = e;
  }
  if (firstName !== undefined) u.firstName = String(firstName);
  if (lastName !== undefined) u.lastName = String(lastName);
  let generatedPassword;
  if (password) { u.passwordHash = await bcrypt.hash(password, 12); }
  else { generatedPassword = uuidv4().slice(0, 12); u.passwordHash = await bcrypt.hash(generatedPassword, 12); }
  u.autoCreated = false;
  u.loginEnabled = loginEnabled !== false;
  u.claimedAt = new Date();
  u.claimedBy = String(ctx.actor?.email || ctx.actor?._id || 'SUPER_ADMIN');
  u.refreshTokens = [];
  await u.save();
  await systemAudit('STAFF_CLAIMED', u._id, { email: u.email, loginEnabled: u.loginEnabled }, ctx);
  return { user: u, generatedPassword };
}

/** List auto-created staff (admins + managers) for the SuperAdmin console. */
function listAutoCreated(opts = {}) {
  const f = {
    ...buildUserFilter({ ...opts, autoCreated: true }),
    role: opts.role && STAFF_ROLES.includes(opts.role) ? opts.role : { $in: STAFF_ROLES },
  };
  return paginate(f, opts);
}

module.exports = {
  createRole,
  assignUserToAdmin, assignUserToManager, reassign, unassign, bulkAssign,
  deactivateManager, deactivateAdmin,
  listAdmins, listManagers, listUnassigned, listUsersForAdmin, listUsersForManager,
  workload, tree,
  // auto-scaling + transfers + staff account control
  autoAssignNewUser, createAutoManager, createAutoAdmin,
  transferUser, bulkTransfer, transferManager,
  renameStaff, changeStaffEmail, resetStaffPassword, setLoginEnabled, claimAutoCreated,
  listAutoCreated,
};
