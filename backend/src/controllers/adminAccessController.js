/**
 * Admin Access Control — Super-Admin management of per-admin module
 * permissions. Admins have no fixed access; the Super Admin grants/revokes
 * each module here. Every change is written to the AuditLog. Super-Admin only.
 */
const User = require('../models/User');
const { AuditLog } = require('../models');
const { ROLES } = require('../config/constants');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { ADMIN_PERMISSIONS, PERMISSION_KEYS, effectiveAdminPermissions } = require('../config/adminPermissions');

const requireSuper = (req) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) throw new AppError('Super Admin only', 403, 'FORBIDDEN');
};

// Catalog for the UI (so it never hard-codes the module list).
const meta = asyncHandler(async (req, res) => {
  requireSuper(req);
  sendSuccess(res, { permissions: ADMIN_PERMISSIONS });
});

// Every admin + their resolved permission map + status.
const matrix = asyncHandler(async (req, res) => {
  requireSuper(req);
  const admins = await User.find({ role: ROLES.ADMIN })
    .select('_id firstName lastName email isActive adminPermissions createdAt')
    .sort({ createdAt: 1 }).lean();
  sendSuccess(res, admins.map((a) => ({
    _id: String(a._id),
    name: [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email,
    email: a.email,
    isActive: a.isActive !== false,
    permissions: effectiveAdminPermissions(a.adminPermissions),
  })));
});

// Apply a permission patch ({ KEY: bool, ... }) to one admin; audits changes.
const setPermissions = asyncHandler(async (req, res) => {
  requireSuper(req);
  const admin = await User.findById(req.params.id);
  if (!admin || admin.role !== ROLES.ADMIN) throw new AppError('Admin not found', 404);
  const before = effectiveAdminPermissions(admin.adminPermissions);
  if (!admin.adminPermissions) admin.adminPermissions = new Map();

  const changes = [];
  for (const [key, raw] of Object.entries(req.body?.permissions || req.body || {})) {
    if (!PERMISSION_KEYS.includes(key)) continue;
    const next = !!raw;
    if (before[key] !== next) changes.push({ key, from: before[key], to: next });
    admin.adminPermissions.set(key, next);
  }
  await admin.save();

  for (const ch of changes) {
    AuditLog.create({
      actorId: req.user._id, actorRole: req.user.role,
      action: 'ADMIN_PERMISSION_CHANGE', targetType: 'USER', targetId: String(admin._id),
      metadata: { adminEmail: admin.email, permission: ch.key, oldValue: ch.from, newValue: ch.to },
      ip: req.ip,
    }).catch(() => {});
  }
  sendSuccess(res, { permissions: effectiveAdminPermissions(admin.adminPermissions) });
});

module.exports = { meta, matrix, setPermissions };
