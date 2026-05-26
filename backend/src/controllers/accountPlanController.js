/**
 * AccountPlan controller — public list + full admin CRUD, reorder,
 * status toggle, and per-plan user analytics. Every write path calls
 * `accountPlansService.invalidate()` so the in-memory cache picks up
 * the change immediately (no waiting for the TTL).
 */
const AccountPlan = require('../models/AccountPlan');
const TradingAccount = require('../models/TradingAccount');
const accountPlansService = require('../services/accountPlansService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

// ── Public ──────────────────────────────────────────────────────────

const listPublic = asyncHandler(async (req, res) => {
  const plans = await accountPlansService.getActiveCached();
  sendSuccess(res, plans);
});

// ── Admin ───────────────────────────────────────────────────────────

const adminList = asyncHandler(async (req, res) => {
  const plans = await accountPlansService.getAllCached();
  sendSuccess(res, plans);
});

const adminCreate = asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!body.code || !body.name) throw new AppError('code and name are required', 400);
  body.code = String(body.code).toUpperCase().trim();
  const exists = await AccountPlan.findOne({ code: body.code });
  if (exists) throw new AppError(`Plan code "${body.code}" already exists`, 409, 'DUPLICATE_CODE');
  const plan = await AccountPlan.create(body);
  accountPlansService.invalidate();
  sendSuccess(res, plan, 201);
});

const adminUpdate = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const body = { ...req.body };
  // Don't allow code mutation post-create — too many downstream refs
  // (TradingAccount.accountType, order audit trails, etc.).
  delete body.code;
  const plan = await AccountPlan.findByIdAndUpdate(id, body, { new: true });
  if (!plan) throw new AppError('Plan not found', 404);
  accountPlansService.invalidate();
  sendSuccess(res, plan);
});

/**
 * Hard-delete refused when any TradingAccount still uses this plan
 * code. Admin should disable (status toggle) and migrate users first.
 */
const adminDelete = asyncHandler(async (req, res) => {
  const plan = await AccountPlan.findById(req.params.id);
  if (!plan) throw new AppError('Plan not found', 404);
  const inUse = await TradingAccount.countDocuments({ accountType: plan.code });
  if (inUse > 0) {
    throw new AppError(
      `Cannot delete: ${inUse} account(s) still on this plan. Disable it instead, or migrate users first.`,
      409,
      'PLAN_IN_USE'
    );
  }
  await AccountPlan.deleteOne({ _id: plan._id });
  accountPlansService.invalidate();
  sendSuccess(res, { deleted: true, id: String(plan._id) });
});

const adminToggleStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') throw new AppError('isActive must be boolean', 400);
  const plan = await AccountPlan.findByIdAndUpdate(req.params.id, { isActive }, { new: true });
  if (!plan) throw new AppError('Plan not found', 404);
  accountPlansService.invalidate();
  sendSuccess(res, plan);
});

/**
 * Bulk reorder. Body: { order: [planId1, planId2, ...] } — each plan's
 * sortOrder becomes its index in the array. Admin drag-drop UI calls
 * this after a reorder gesture.
 */
const adminReorder = asyncHandler(async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order) || order.length === 0) {
    throw new AppError('order[] required', 400);
  }
  const ops = order.map((id, idx) => ({
    updateOne: { filter: { _id: id }, update: { $set: { sortOrder: idx + 1 } } },
  }));
  await AccountPlan.bulkWrite(ops);
  accountPlansService.invalidate();
  const plans = await accountPlansService.getAllCached();
  sendSuccess(res, plans);
});

/**
 * Per-plan analytics — number of accounts on each tier. Used by the
 * admin overview strip to show "X accounts on STANDARD, Y on PRO…".
 */
const adminAnalytics = asyncHandler(async (req, res) => {
  const plans = await accountPlansService.getAllCached();
  const counts = await TradingAccount.aggregate([
    { $group: { _id: '$accountType', n: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
  ]);
  const byCode = Object.fromEntries(counts.map((c) => [c._id, c]));
  const out = plans.map((p) => {
    const c = byCode[p.code] || { n: 0, active: 0 };
    return {
      _id: p._id,
      code: p.code,
      name: p.name,
      isActive: p.isActive,
      totalAccounts: c.n,
      activeAccounts: c.active,
    };
  });
  sendSuccess(res, out);
});

module.exports = {
  listPublic,
  adminList,
  adminCreate,
  adminUpdate,
  adminDelete,
  adminToggleStatus,
  adminReorder,
  adminAnalytics,
};
