/**
 * Manager Access Control service — Super-Admin (and optionally delegated
 * Admin) management of per-manager module permissions + the per-manager
 * master login switch. Every change is written to the AuditLog.
 */
const User = require('../models/User');
const { AuditLog } = require('../models');
const systemSettings = require('./systemSettings.service');
const { ROLES } = require('../config/constants');
const { AppError } = require('../utils/errors');
const { MANAGER_PERMISSIONS, PERMISSION_KEYS, effectivePermissions } = require('../config/managerPermissions');
const { effectiveAdminPermissions } = require('../config/adminPermissions');

// An admin can only delegate to a manager what the admin themselves has.
// Maps each manager-permission key → the admin permission it requires:
//   string   → admin must have that admin-module granted
//   null     → Super-Admin-only module (never delegatable by an admin)
//   (absent) → benign utility, always delegatable
const MANAGER_PERM_ADMIN_REQ = {
  DASHBOARD: 'DASHBOARD',
  USER_MANAGEMENT: 'USERS',
  DEPOSITS: 'DEPOSITS',
  WITHDRAWALS: 'WITHDRAWALS',
  ORDERS_MANAGEMENT: 'ORDERS', // admin must have the Orders module to delegate it
  PORTFOLIO: null,            // /portfolio is Super-Admin-only — admins never have it
  WALLET_MANAGEMENT: 'WALLETS',
  REPORTS: 'REPORTS',
  AUDIT_LOGS: 'AUDIT_LOGS',
  SUPPORT_TICKETS: 'SUPPORT_CHATS',
  REFERRAL_MANAGEMENT: 'PARTNERS',
  FINANCE_ACCESS: null,       // /finance is Super-Admin + finance-staff only — admins never have it
  SETTINGS: 'SETTINGS',
};

// Which manager-permission keys the actor is allowed to grant.
//   SUPER_ADMIN → all. ADMIN → only modules the admin themselves has
//   (super-only keys excluded).
function delegatableKeys(actor) {
  if (actor.role === ROLES.SUPER_ADMIN) return new Set(PERMISSION_KEYS);
  const adminEff = effectiveAdminPermissions(actor.adminPermissions);
  return new Set(PERMISSION_KEYS.filter((k) => {
    const req = MANAGER_PERM_ADMIN_REQ[k];
    if (req === null) return false;       // super-only
    if (req === undefined) return true;   // benign / always allowed
    return adminEff[req] === true;        // admin must hold the module
  }));
}

const allowAdminManage = async () => (await systemSettings.getSetting('manager.allowAdminManagePerms')) === true;

// Can `actor` edit `manager`'s access?
//   SUPER_ADMIN → any manager
//   ADMIN       → only managers under them, AND only if delegation is ON
async function canEdit(actor, manager) {
  if (manager.role !== ROLES.MANAGER) return false;
  if (actor.role === ROLES.SUPER_ADMIN) return true;
  if (actor.role === ROLES.ADMIN) {
    return (await allowAdminManage()) && String(manager.adminId || '') === String(actor._id);
  }
  return false;
}

function shape(manager, staffName) {
  return {
    _id: String(manager._id),
    name: [manager.firstName, manager.lastName].filter(Boolean).join(' ') || manager.email,
    email: manager.email,
    adminId: manager.adminId ? String(manager.adminId) : null,
    adminName: manager.adminId ? (staffName.get(String(manager.adminId)) || '—') : '—',
    accessEnabled: manager.managerAccessEnabled !== false,
    isActive: manager.isActive !== false,
    permissions: effectivePermissions(manager.managerPermissions),
  };
}

// Matrix: every manager the actor may see (super → all; admin → own), each
// with their resolved permission map + admin + status.
async function matrix(actor) {
  const filter = { role: ROLES.MANAGER };
  if (actor.role === ROLES.ADMIN) filter.adminId = actor._id;
  const managers = await User.find(filter)
    .select('_id firstName lastName email adminId managerAccessEnabled isActive managerPermissions')
    .sort({ createdAt: 1 }).lean();
  const adminIds = [...new Set(managers.map((m) => m.adminId && String(m.adminId)).filter(Boolean))];
  const admins = adminIds.length ? await User.find({ _id: { $in: adminIds } }).select('firstName lastName email').lean() : [];
  const staffName = new Map(admins.map((a) => [String(a._id), [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email]));
  return managers.map((m) => shape(m, staffName));
}

async function _loadEditable(actor, managerId) {
  const manager = await User.findById(managerId);
  if (!manager) throw new AppError('Manager not found', 404);
  if (!(await canEdit(actor, manager))) throw new AppError('Not allowed to manage this manager', 403, 'FORBIDDEN');
  return manager;
}

// Apply a permission patch ({ KEY: bool, ... }); audits each actual change.
async function setPermissions(actor, managerId, patch, ip) {
  const manager = await _loadEditable(actor, managerId);
  const before = effectivePermissions(manager.managerPermissions);
  if (!manager.managerPermissions) manager.managerPermissions = new Map();

  const allowed = delegatableKeys(actor); // admin can't grant what they lack
  const changes = [];
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!PERMISSION_KEYS.includes(key)) continue;
    if (!allowed.has(key)) continue; // silently skip non-delegatable keys
    const next = !!raw;
    if (before[key] !== next) changes.push({ key, from: before[key], to: next });
    manager.managerPermissions.set(key, next);
  }
  await manager.save();

  for (const ch of changes) {
    AuditLog.create({
      actorId: actor._id, actorRole: actor.role,
      action: 'MANAGER_PERMISSION_CHANGE', targetType: 'USER', targetId: String(manager._id),
      metadata: { managerEmail: manager.email, permission: ch.key, oldValue: ch.from, newValue: ch.to },
      ip,
    }).catch(() => {});
  }
  return effectivePermissions(manager.managerPermissions);
}

// Master login switch.
async function setAccess(actor, managerId, enabled, ip) {
  const manager = await _loadEditable(actor, managerId);
  const before = manager.managerAccessEnabled !== false;
  manager.managerAccessEnabled = !!enabled;
  await manager.save();
  AuditLog.create({
    actorId: actor._id, actorRole: actor.role,
    action: 'MANAGER_ACCESS_TOGGLE', targetType: 'USER', targetId: String(manager._id),
    metadata: { managerEmail: manager.email, oldValue: before, newValue: !!enabled },
    ip,
  }).catch(() => {});
  return { accessEnabled: !!enabled };
}

async function meta(actor) {
  // Admins only see/grant modules they themselves have; Super Admin sees all.
  const allowed = delegatableKeys(actor);
  return {
    permissions: MANAGER_PERMISSIONS.filter((p) => allowed.has(p.key)),
    allowAdminManagePerms: await allowAdminManage(),
    canEditSetting: actor.role === ROLES.SUPER_ADMIN,
  };
}

module.exports = { canEdit, matrix, setPermissions, setAccess, meta, allowAdminManage };
