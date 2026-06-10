/**
 * Financial Department service (simplified).
 *
 *   FINANCIAL_ADMIN → DEPOSIT_MANAGER(s), WITHDRAWAL_MANAGER(s), AUDIT_MANAGER
 *
 * Managers process requests DIRECTLY (no officers). Each deposit/withdrawal
 * REQUEST is auto-distributed by WORKLOAD to the manager of that department
 * with the fewest pending requests — never tied to permanent user ownership.
 * FINANCIAL_ADMIN can reassign between managers. Audit team is read-only.
 *
 * NOTE: the persisted field is `assignedOfficerId` (kept for compatibility);
 * in this model it holds the assigned MANAGER.
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const { Deposit, Withdrawal } = require('../models');
const { ROLES, FINANCE_ROLES } = require('../config/constants');
const { AppError } = require('../utils/errors');

const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const modelFor = (kind) => (kind === 'withdrawal' ? Withdrawal : Deposit);
// The role that PROCESSES this kind of request (a manager).
const processorRoleFor = (kind) => (kind === 'withdrawal' ? ROLES.WITHDRAWAL_MANAGER : ROLES.DEPOSIT_MANAGER);

// ── Auto-distribution ─────────────────────────────────────────────────

// The least-loaded ACTIVE manager of a department (fewest PENDING assigned
// requests). Null when none configured (FINANCIAL_ADMIN/SUPER handle直接).
async function pickLeastLoadedManager(kind) {
  const Model = modelFor(kind);
  const managers = await User.find({ role: processorRoleFor(kind), isActive: true }).select('_id').lean();
  if (!managers.length) return null;
  const ids = managers.map((m) => m._id);
  const counts = await Model.aggregate([
    { $match: { assignedOfficerId: { $in: ids }, status: 'PENDING' } },
    { $group: { _id: '$assignedOfficerId', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  let best = null, bestN = Infinity;
  for (const m of managers) {
    const n = byId.get(String(m._id)) || 0;
    if (n < bestN) { best = m._id; bestN = n; }
  }
  return best;
}

// Called by the Deposit/Withdrawal post-save hook. Idempotent + race-safe.
async function autoAssign(kind, requestId) {
  const Model = modelFor(kind);
  const doc = await Model.findById(requestId).select('_id status assignedOfficerId').lean();
  if (!doc || doc.assignedOfficerId || doc.status !== 'PENDING') return null;
  const managerId = await pickLeastLoadedManager(kind);
  if (!managerId) return null;
  await Model.updateOne(
    { _id: requestId, assignedOfficerId: null, status: 'PENDING' },
    {
      $set: { assignedOfficerId: managerId, assignedAt: new Date() },
      $push: { assignmentHistory: { officerId: managerId, byId: null, at: new Date(), reason: 'auto' } },
    }
  );
  return managerId;
}

// FINANCIAL_ADMIN / SUPER_ADMIN reassign a pending request to another manager.
async function reassign(kind, requestId, newManagerId, byUser) {
  const Model = modelFor(kind);
  const doc = await Model.findById(requestId);
  if (!doc) throw new AppError('Request not found', 404);
  if (doc.status !== 'PENDING') throw new AppError('Only pending requests can be reassigned', 400);
  const mgr = await User.findOne({ _id: newManagerId, role: processorRoleFor(kind), isActive: true }).select('_id').lean();
  if (!mgr) throw new AppError(`Target must be an active ${processorRoleFor(kind)}`, 400, 'BAD_MANAGER');
  doc.assignedOfficerId = mgr._id;
  doc.assignedAt = new Date();
  doc.assignmentHistory.push({ officerId: mgr._id, byId: byUser._id, at: new Date(), reason: 'manual' });
  await doc.save();
  return doc;
}

// ── Scoping ───────────────────────────────────────────────────────────

// Mongo filter for a finance user's request queue.
//   DEPOSIT/WITHDRAWAL_MANAGER → only requests assigned to THEM
//   FINANCIAL_ADMIN / SUPER_ADMIN / AUDIT* → everything (audit = read-only)
async function queueFilter(kind, user, baseFilter = {}) {
  const f = { ...baseFilter };
  if (user.role === processorRoleFor(kind)) f.assignedOfficerId = user._id;
  return f;
}

// May this user confirm/approve/reject this specific request?
async function canAct(kind, user, requestDoc) {
  const r = user.role;
  if (r === ROLES.SUPER_ADMIN || r === ROLES.ADMIN || r === ROLES.FINANCIAL_ADMIN) return true;
  if (r === processorRoleFor(kind)) return String(requestDoc.assignedOfficerId || '') === String(user._id);
  return false; // auditors / others are read-only
}

// ── Workload (financial-admin dashboard): per-manager pending counts ──
async function workload(kind) {
  const Model = modelFor(kind);
  const managers = await User.find({ role: processorRoleFor(kind), isActive: true })
    .select('_id firstName lastName email').lean();
  const ids = managers.map((m) => m._id);
  const agg = ids.length ? await Model.aggregate([
    { $match: { assignedOfficerId: { $in: ids } } },
    { $group: {
        _id: '$assignedOfficerId',
        pending: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
        total:   { $sum: 1 },
    } },
  ]) : [];
  const byId = new Map(agg.map((a) => [String(a._id), a]));
  return managers.map((m) => {
    const a = byId.get(String(m._id)) || {};
    return {
      managerId: String(m._id),
      name: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email,
      email: m.email,
      pending: a.pending || 0,
      total: a.total || 0,
    };
  }).sort((x, y) => y.pending - x.pending);
}

// ── Staff management ─────────────────────────────────────────────────
function allowedChildRoles(actorRole) {
  switch (actorRole) {
    case ROLES.SUPER_ADMIN:
      return [ROLES.FINANCIAL_ADMIN, ROLES.DEPOSIT_MANAGER, ROLES.WITHDRAWAL_MANAGER, ROLES.AUDIT_MANAGER];
    case ROLES.FINANCIAL_ADMIN:
      return [ROLES.DEPOSIT_MANAGER, ROLES.WITHDRAWAL_MANAGER, ROLES.AUDIT_MANAGER];
    default: return [];
  }
}

// Create (or promote an existing email into) a finance staff member.
async function createStaff({ email, role, password, firstName, lastName }, actor) {
  if (!allowedChildRoles(actor.role).includes(role)) {
    throw new AppError(`You are not allowed to create a ${role}`, 403, 'FORBIDDEN');
  }
  email = String(email || '').toLowerCase().trim();
  if (!email) throw new AppError('email required', 400);
  const financeParentId = actor.role === ROLES.SUPER_ADMIN ? null : actor._id;

  let user = await User.findOne({ email });
  let tempPassword = null;
  if (user) {
    user.role = role;
    user.financeParentId = financeParentId;
    user.isActive = true;
    await user.save();
  } else {
    tempPassword = password || uuidv4().slice(0, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    user = await User.create({
      email, passwordHash, role, financeParentId,
      firstName: firstName || '', lastName: lastName || '',
      isActive: true, isEmailVerified: true,
    });
  }
  return { user, tempPassword };
}

// Who may reset whose password.
//   SUPER_ADMIN     → any finance staff
//   FINANCIAL_ADMIN → any finance staff except other FINANCIAL_ADMINs
function canResetStaff(actor, target) {
  if (!FINANCE_ROLES.ALL.includes(target.role)) return false; // finance staff only
  if (actor.role === ROLES.SUPER_ADMIN) return true;
  if (actor.role === ROLES.FINANCIAL_ADMIN) return target.role !== ROLES.FINANCIAL_ADMIN;
  return false;
}

// Reset a finance staff member's password. Blank/short `password` → a random
// temp password is generated and returned (shown once to the actor).
async function resetStaffPassword({ targetId, password }, actor) {
  const target = await User.findById(targetId);
  if (!target) throw new AppError('Staff member not found', 404);
  if (!canResetStaff(actor, target)) throw new AppError('You are not allowed to reset this account', 403, 'FORBIDDEN');
  const tempPassword = (password && String(password).length >= 6) ? String(password) : uuidv4().slice(0, 12);
  target.passwordHash = await bcrypt.hash(tempPassword, 12);
  await target.save();
  return { tempPassword, email: target.email };
}

// Finance staff visible to the actor (super / financial-admin → all).
async function listStaff(actor) {
  const FIN = ['FINANCIAL_ADMIN', 'DEPOSIT_MANAGER', 'WITHDRAWAL_MANAGER', 'AUDIT_MANAGER'];
  const filter = { role: { $in: FIN } };
  if (![ROLES.SUPER_ADMIN, ROLES.FINANCIAL_ADMIN].includes(actor.role)) {
    filter.financeParentId = actor._id;
  }
  const rows = await User.find(filter)
    .select('_id firstName lastName email role financeParentId isActive createdAt')
    .sort({ role: 1, createdAt: 1 }).lean();
  return rows.map((u) => ({
    _id: String(u._id),
    name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
    email: u.email,
    role: u.role,
    financeParentId: u.financeParentId ? String(u.financeParentId) : null,
    isActive: u.isActive,
    createdAt: u.createdAt,
  }));
}

// Financial-admin overview KPIs.
async function overview() {
  const [depPending, wdPending, depToday, wdToday, depMgrs, wdMgrs] = await Promise.all([
    Deposit.countDocuments({ status: 'PENDING' }),
    Withdrawal.countDocuments({ status: 'PENDING' }),
    Deposit.countDocuments({ status: 'CONFIRMED', confirmedAt: { $gte: startOfToday() } }),
    Withdrawal.countDocuments({ status: 'COMPLETED', approvedAt: { $gte: startOfToday() } }),
    User.countDocuments({ role: ROLES.DEPOSIT_MANAGER, isActive: true }),
    User.countDocuments({ role: ROLES.WITHDRAWAL_MANAGER, isActive: true }),
  ]);
  return {
    pendingDeposits: depPending,
    pendingWithdrawals: wdPending,
    processedDepositsToday: depToday,
    processedWithdrawalsToday: wdToday,
    depositManagers: depMgrs,
    withdrawalManagers: wdMgrs,
  };
}
function startOfToday() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

module.exports = {
  modelFor, processorRoleFor,
  pickLeastLoadedManager, autoAssign, reassign,
  queueFilter, canAct,
  workload, allowedChildRoles, createStaff, listStaff, resetStaffPassword, overview,
};
