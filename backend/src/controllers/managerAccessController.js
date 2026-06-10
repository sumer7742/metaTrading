/**
 * Manager Access Control controller — Super Admin (and delegated Admin)
 * endpoints for the permission matrix, per-manager toggles, the master login
 * switch, and the admin-delegation setting. Mounted under /api/admin.
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const svc = require('../services/managerAccessService');
const systemSettings = require('../services/systemSettings.service');
const { ROLES } = require('../config/constants');

const meta = asyncHandler(async (req, res) => sendSuccess(res, await svc.meta(req.user)));

const matrix = asyncHandler(async (req, res) => sendSuccess(res, await svc.matrix(req.user)));

const setPermissions = asyncHandler(async (req, res) => {
  const patch = req.body.permissions && typeof req.body.permissions === 'object' ? req.body.permissions : req.body;
  sendSuccess(res, await svc.setPermissions(req.user, req.params.id, patch, req.ip));
});

const setAccess = asyncHandler(async (req, res) =>
  sendSuccess(res, await svc.setAccess(req.user, req.params.id, !!req.body.enabled, req.ip)));

// Toggle "Allow Admin To Manage Manager Permissions" — Super Admin only.
const setDelegation = asyncHandler(async (req, res) => {
  if (req.user.role !== ROLES.SUPER_ADMIN) throw new AppError('Super Admin only', 403, 'FORBIDDEN');
  await systemSettings.setSetting('manager.allowAdminManagePerms', !!req.body.enabled, req.userId);
  sendSuccess(res, { allowAdminManagePerms: !!req.body.enabled });
});

module.exports = { meta, matrix, setPermissions, setAccess, setDelegation };
