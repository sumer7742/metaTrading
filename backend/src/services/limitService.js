/**
 * limitService — Hierarchical limits (Super Admin → Admin → Manager → User).
 *
 * Each actor stores the limits they were GRANTED (User.hierarchyLimits).
 * Inheritance is enforced at SET time (a child limit can never exceed the
 * parent's), so enforcement at runtime simply reads the target's own limit.
 *
 * `null` everywhere = no limit (unlimited) → every pre-existing account keeps
 * working unchanged. Counts are subtree quotas for admins/managers; money /
 * leverage / position caps apply per user.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const Position = require('../models/Position');
const { Deposit, Withdrawal, AuditLog } = require('../models');
const { ROLES, POSITION_STATUS } = require('../config/constants');
const { AppError } = require('../utils/errors');

// Editable limits — ONLY the hierarchy creation/count quotas. Everything
// else (deposit / withdrawal / leverage / credit / bonus / positions /
// exposure / commissions) was intentionally removed: only the Super Admin
// controls how many managers an admin may create and how many users sit
// under an admin / manager.
//   kind: 'count' (subtree quota)
const LIMIT_DEFS = [
  { key: 'maxManagers', label: 'Max Managers', kind: 'count' }, // per admin
  { key: 'maxUsers',    label: 'Max Users',    kind: 'count' }, // under an admin / manager
];
const LIMIT_KEYS = LIMIT_DEFS.map((d) => d.key);

// Which limits apply per target role:
//   Admin   → Max Managers (they create managers) + Max Users (their tree)
//   Manager → Max Users (their own users)
const APPLIES = {
  maxManagers: [ROLES.ADMIN],
  maxUsers:    [ROLES.ADMIN, ROLES.MANAGER],
};
function appliesTo(role, key) {
  const only = APPLIES[key];
  return !only || only.includes(role);
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** The limits a user was granted (plain object, missing keys → null). */
function getLimits(user) {
  const h = (user && user.hierarchyLimits) || {};
  const out = {};
  for (const k of LIMIT_KEYS) out[k] = h[k] == null ? null : Number(h[k]);
  return out;
}

/** Coerce an incoming limits payload to {key: number|null}. */
function normalize(body = {}) {
  const out = {};
  for (const k of LIMIT_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === '' || v === undefined) out[k] = null;
    else {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new AppError(`${k} must be a non-negative number or blank`, 400, 'LIMIT_BAD_VALUE');
      out[k] = n;
    }
  }
  return out;
}

/**
 * A child limit can never exceed the parent's. If the parent has a cap on a
 * key, the child must be a number ≤ that cap (cannot be unlimited). If the
 * parent is unlimited (null) on a key, the child may set anything.
 */
function assertWithinParent(parentLimits, proposed) {
  for (const k of LIMIT_KEYS) {
    if (!(k in proposed)) continue;
    const cap = parentLimits ? parentLimits[k] : null;
    if (cap == null) continue;            // parent unlimited → anything allowed
    const val = proposed[k];
    if (val == null) {
      throw new AppError(`Cannot grant unlimited ${k}: your own limit is ${cap}`, 400, 'LIMIT_EXCEEDS_PARENT');
    }
    if (val > cap) {
      throw new AppError(`${k} ${val} exceeds your granted limit of ${cap}`, 400, 'LIMIT_EXCEEDS_PARENT');
    }
  }
}

/** Only the Super Admin may view/edit hierarchy limits. */
function assertCanManage(actor) {
  if (actor && actor.role === ROLES.SUPER_ADMIN) return;
  throw new AppError('Only the Super Admin can manage limits', 403, 'FORBIDDEN');
}

/** The cap an actor can grant downward = their OWN limits (super = unlimited). */
function parentCapsFor(actor) {
  if (!actor || actor.role === ROLES.SUPER_ADMIN) {
    const all = {}; for (const k of LIMIT_KEYS) all[k] = null; return all;
  }
  return getLimits(actor);
}

// ── Usage (subtree-aware) ────────────────────────────────────────────
async function _subtreeUserIds(user) {
  if (user.role === ROLES.ADMIN) return User.find({ adminId: user._id, role: ROLES.USER }).distinct('_id');
  if (user.role === ROLES.MANAGER) return User.find({ managerId: user._id }).distinct('_id');
  return [user._id]; // a plain user: their own
}

async function getUsage(user) {
  const usage = {}; for (const k of LIMIT_KEYS) usage[k] = 0;
  if (user.role === ROLES.ADMIN) {
    usage.maxUsers = await User.countDocuments({ adminId: user._id, role: ROLES.USER });
    usage.maxManagers = await User.countDocuments({ adminId: user._id, role: ROLES.MANAGER });
  } else if (user.role === ROLES.MANAGER) {
    usage.maxUsers = await User.countDocuments({ managerId: user._id });
  }
  return usage;
}

/** Full view for the admin UI: assigned / used / remaining / parent cap. */
async function getView(targetUser, actor) {
  const limits = getLimits(targetUser);
  const usage = await getUsage(targetUser);
  const parentCaps = parentCapsFor(actor);
  const rows = LIMIT_DEFS.filter((d) => appliesTo(targetUser.role, d.key)).map((d) => {
    const assigned = limits[d.key];
    const used = usage[d.key] || 0;
    return {
      key: d.key, label: d.label, kind: d.kind,
      assigned, used,
      remaining: assigned == null ? null : Math.max(0, assigned - used),
      parentCap: parentCaps[d.key],
    };
  });
  return {
    target: { _id: targetUser._id, email: targetUser.email, role: targetUser.role, name: [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') },
    limits, usage, rows,
    updatedAt: targetUser.hierarchyLimits?.updatedAt || null,
  };
}

/** Set a target's limits (validates ≤ parent, persists, audits each change). */
async function setLimits(targetUser, body, actor, ip) {
  assertCanManage(actor, targetUser);
  const proposed = normalize(body);
  const caps = parentCapsFor(actor);
  assertWithinParent(caps, proposed);

  const before = getLimits(targetUser);
  targetUser.hierarchyLimits = targetUser.hierarchyLimits || {};
  const changed = [];
  for (const k of Object.keys(proposed)) {
    if ((before[k] ?? null) !== (proposed[k] ?? null)) changed.push({ key: k, from: before[k], to: proposed[k] });
    targetUser.hierarchyLimits[k] = proposed[k];
  }
  targetUser.hierarchyLimits.updatedAt = new Date();
  targetUser.hierarchyLimits.updatedBy = actor._id;
  targetUser.markModified('hierarchyLimits');
  await targetUser.save();

  if (changed.length) {
    try {
      await AuditLog.create({
        actorId: actor._id, actorRole: actor.role,
        action: 'HIERARCHY_LIMITS_UPDATE', targetType: 'USER', targetId: String(targetUser._id),
        metadata: { changes: changed, reason: body.reason || '', targetRole: targetUser.role, targetEmail: targetUser.email },
        ip,
      });
    } catch (_) { /* audit best-effort */ }
  }
  return getView(targetUser, actor);
}

// ── Enforcement helpers (called from the relevant action points) ─────
/** Block creating another child when the parent's count quota is full. */
async function assertCanCreateChild(parentUser, childRole) {
  if (!parentUser) return;
  const key = childRole === ROLES.MANAGER ? 'maxManagers' : 'maxUsers';
  const cap = getLimits(parentUser)[key];
  if (cap == null) return; // unlimited
  const filter = childRole === ROLES.MANAGER
    ? { adminId: parentUser._id, role: ROLES.MANAGER }
    : (parentUser.role === ROLES.ADMIN ? { adminId: parentUser._id, role: ROLES.USER } : { managerId: parentUser._id });
  const count = await User.countDocuments(filter);
  if (count >= cap) {
    throw new AppError(`Limit reached: your ${key} cap is ${cap} (currently ${count}).`, 400, 'HIERARCHY_LIMIT_REACHED');
  }
}

/** When assigning a user under a manager, honor the manager's (and their admin's) maxUsers. */
async function assertCanAddUserUnderManager(managerId) {
  const manager = await User.findById(managerId).select('hierarchyLimits adminId role').lean();
  if (!manager) return;
  const mCap = getLimits(manager).maxUsers;
  if (mCap != null) {
    const c = await User.countDocuments({ managerId });
    if (c >= mCap) throw new AppError(`Manager is at their user limit (${mCap}).`, 400, 'HIERARCHY_LIMIT_REACHED');
  }
  if (manager.adminId) {
    const admin = await User.findById(manager.adminId).select('hierarchyLimits').lean();
    const aCap = admin && getLimits(admin).maxUsers;
    if (aCap != null) {
      const c = await User.countDocuments({ adminId: manager.adminId, role: ROLES.USER });
      if (c >= aCap) throw new AppError(`Admin is at their user limit (${aCap}).`, 400, 'HIERARCHY_LIMIT_REACHED');
    }
  }
}

const _limitOf = (user, key) => {
  const v = user?.hierarchyLimits?.[key];
  return v == null ? null : Number(v);
};

/** Per-request deposit ceiling (USD). */
function assertDepositWithin(user, amountUsd) {
  const cap = _limitOf(user, 'maxDepositLimit');
  if (cap != null && Number(amountUsd) > cap) {
    throw new AppError(`Deposit exceeds your limit of ${cap} USD.`, 400, 'DEPOSIT_OVER_LIMIT');
  }
}
/** Per-request withdrawal ceiling (USD). */
function assertWithdrawalWithin(user, amountUsd) {
  const cap = _limitOf(user, 'maxWithdrawalLimit');
  if (cap != null && Number(amountUsd) > cap) {
    throw new AppError(`Withdrawal exceeds your limit of ${cap} USD.`, 400, 'WITHDRAWAL_OVER_LIMIT');
  }
}
/** Hierarchy leverage cap for a user (or null). placeOrder mins this with its cap. */
function leverageCapOf(user) { return _limitOf(user, 'maxLeverage'); }

/** Block opening beyond the user's open-position count cap. */
async function assertOpenPositionsWithin(user) {
  const cap = _limitOf(user, 'maxOpenPositions');
  if (cap == null) return;
  const open = await Position.countDocuments({ userId: user._id, status: POSITION_STATUS.OPEN });
  if (open >= cap) throw new AppError(`Open-position limit reached (${cap}).`, 400, 'MAX_OPEN_POSITIONS');
}

/** Block opening beyond the user's exposure (USD notional) cap. */
async function assertExposureWithin(user, newNotional) {
  const cap = _limitOf(user, 'maxExposure');
  if (cap == null) return;
  const rows = await Position.find({ userId: user._id, status: POSITION_STATUS.OPEN }).select('quantity entryPrice').lean();
  let exposure = 0;
  for (const p of rows) exposure += (Number(p.quantity) || 0) * (Number(p.entryPrice) || 0);
  if (exposure + (Number(newNotional) || 0) > cap) {
    throw new AppError(`Exposure limit ${cap} USD would be exceeded.`, 400, 'MAX_EXPOSURE');
  }
}

/** Block creating more trading accounts than the user's cap. */
async function assertTradingAccountWithin(user) {
  const cap = _limitOf(user, 'maxTradingAccounts');
  if (cap == null) return;
  const c = await TradingAccount.countDocuments({ userId: user._id });
  if (c >= cap) throw new AppError(`Trading-account limit reached (${cap}).`, 400, 'MAX_TRADING_ACCOUNTS');
}

module.exports = {
  LIMIT_DEFS, LIMIT_KEYS,
  getLimits, normalize, assertWithinParent, assertCanManage, parentCapsFor,
  getUsage, getView, setLimits,
  assertCanCreateChild, assertCanAddUserUnderManager,
  assertDepositWithin, assertWithdrawalWithin, leverageCapOf,
  assertOpenPositionsWithin, assertExposureWithin, assertTradingAccountWithin,
};
