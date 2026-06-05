/**
 * Admin CRUD for scheduled instrument leverage / volume overrides.
 * All routes are mounted under /admin and gated by requireAdmin.
 */
const { sendSuccess, asyncHandler } = require('../utils/errors');
const svc = require('../services/instrumentOverrideService');

const actorOf = (req) => ({
  actorId: req.userId,
  actorRole: req.user?.role || 'ADMIN',
  actorName: req.user ? ([req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email) : '',
  ip: req.ip,
});

// ── Leverage overrides ──
const listLeverage   = asyncHandler(async (req, res) => sendSuccess(res, await svc.listLeverageOverrides(req.params.symbol)));
const createLeverage = asyncHandler(async (req, res) => sendSuccess(res, await svc.createLeverageOverride({ symbol: req.params.symbol, ...req.body }, actorOf(req)), 201));
const updateLeverage = asyncHandler(async (req, res) => sendSuccess(res, await svc.updateLeverageOverride(req.params.id, req.body, actorOf(req))));
const deleteLeverage = asyncHandler(async (req, res) => sendSuccess(res, await svc.deleteLeverageOverride(req.params.id, actorOf(req))));

// ── Volume overrides (optional schedule) ──
const listVolume   = asyncHandler(async (req, res) => sendSuccess(res, await svc.listVolumeOverrides(req.params.symbol)));
const createVolume = asyncHandler(async (req, res) => sendSuccess(res, await svc.createVolumeOverride({ symbol: req.params.symbol, ...req.body }, actorOf(req)), 201));
const updateVolume = asyncHandler(async (req, res) => sendSuccess(res, await svc.updateVolumeOverride(req.params.id, req.body, actorOf(req))));
const deleteVolume = asyncHandler(async (req, res) => sendSuccess(res, await svc.deleteVolumeOverride(req.params.id, actorOf(req))));

module.exports = {
  listLeverage, createLeverage, updateLeverage, deleteLeverage,
  listVolume, createVolume, updateVolume, deleteVolume,
};
