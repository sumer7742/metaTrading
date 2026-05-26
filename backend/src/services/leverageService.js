/**
 * Leverage management — the single source of truth for the cap that
 * applies to a user's trading.
 *
 * Precedence (highest → lowest):
 *   1. User.customLeverage          (admin override)
 *   2. Plan.limits.defaultLeverage  (their subscription tier)
 *   3. SYSTEM_FALLBACK              (100)
 *
 * Trading engine (`OrderForm` on FE, order placement on BE) MUST call
 * `getEffective()` and clamp the user's chosen leverage to it.
 */

const User = require('../models/User');
const LeverageLog = require('../models/LeverageLog');
const subscriptionService = require('./subscriptionService');

// ── Constraints ──────────────────────────────────────────────────────
// Platform-wide rule: leverage range is 1:1 → 1:Unlimited. SYSTEM_MAX
// encodes "unlimited" as a very large finite integer so margin math
// (notional / leverage) stays positive and finite at every level.
// 999_999 is well above any practical leverage and still fits in
// safe JS integer arithmetic without losing precision.
const SYSTEM_MIN = 1;
const SYSTEM_MAX = 999999;
const SYSTEM_FALLBACK = 100;

const _clamp = (n) => Math.max(SYSTEM_MIN, Math.min(SYSTEM_MAX, Math.round(Number(n))));

/**
 * Resolve a user's leverage state. Returns a structured object that the
 * FE renders directly (no further math needed).
 *
 * @returns {Promise<{
 *   effectiveLeverage: number,
 *   customLeverage: number|null,
 *   planDefault: number,
 *   planCode: string,
 *   planName: string,
 *   source: string,           // 'admin' | <planCode>
 *   sourceLabel: string,      // human label e.g. "Admin Override", "VIP Plan"
 *   isOverridden: boolean,
 *   overrideMeta: { by, at, reason, expiresAt } | null,
 * }>}
 */
const getEffective = async (userId, opts = {}) => {
  const user = await User.findById(userId)
    .select('customLeverage leverageOverride isActive')
    .lean();
  if (!user) throw new Error('User not found');

  // DEMO / VIRTUAL accounts always run at 1:Unlimited — practice money
  // is not subject to plan caps or admin overrides. Caller passes
  // `{ accountType: 'DEMO' }` (or 'VIRTUAL') to bypass the normal
  // precedence chain. Audit-log writes still go through setOverride()
  // so admin actions remain visible — they just don't apply at runtime.
  if (opts.accountType === 'DEMO' || opts.accountType === 'VIRTUAL') {
    return {
      effectiveLeverage: SYSTEM_MAX,
      customLeverage:    null,
      planDefault:       SYSTEM_MAX,
      planCode:          'DEMO',
      planName:          'Demo',
      source:            'DEMO',
      sourceLabel:       'Demo account · unlimited',
      isOverridden:      false,
      overrideMeta:      null,
      systemMin:         SYSTEM_MIN,
      systemMax:         SYSTEM_MAX,
      isDemo:            true,
    };
  }

  const plan = await subscriptionService.getEffectivePlan(userId);
  const planDefault = Number(plan?.limits?.defaultLeverage) || SYSTEM_FALLBACK;

  // Honor temporary expiry — if leverageOverride.expiresAt is in the
  // past, treat the override as inactive (still in DB; service-level
  // garbage collection can prune it later).
  const expiresAt = user.leverageOverride?.expiresAt
    ? new Date(user.leverageOverride.expiresAt).getTime()
    : null;
  const hasActiveOverride =
    user.customLeverage != null && (!expiresAt || expiresAt > Date.now());

  const effective = hasActiveOverride ? _clamp(user.customLeverage) : _clamp(planDefault);

  return {
    effectiveLeverage: effective,
    customLeverage:    hasActiveOverride ? Number(user.customLeverage) : null,
    planDefault,
    planCode:          plan?.code || 'FREE',
    planName:          plan?.name || 'Free',
    source:            hasActiveOverride ? 'admin' : (plan?.code || 'FREE'),
    sourceLabel:       hasActiveOverride ? 'Admin Override' : `${plan?.name || 'Free'} Plan`,
    isOverridden:      hasActiveOverride,
    overrideMeta:      hasActiveOverride ? user.leverageOverride : null,
    systemMin:         SYSTEM_MIN,
    systemMax:         SYSTEM_MAX,
  };
};

/**
 * Set / update the admin override for a user.
 *
 * @param {object} ctx
 * @param {ObjectId} ctx.userId   — the user receiving the override
 * @param {number}   ctx.value    — new custom leverage (1..1000)
 * @param {ObjectId} ctx.adminId  — admin performing the change
 * @param {string}  [ctx.reason]  — free-text reason for the audit log
 * @param {Date}    [ctx.expiresAt] — optional auto-revert date
 * @param {string}  [ctx.batchId] — bulk-update correlation id
 */
const setOverride = async ({ userId, value, adminId, reason, expiresAt, batchId }) => {
  const lev = _clamp(value);
  if (!Number.isFinite(lev)) throw new Error('leverage must be a finite number');

  const user = await User.findById(userId).select('customLeverage leverageOverride isActive');
  if (!user) throw new Error('User not found');
  if (user.isActive === false) {
    throw new Error('User is blocked — cannot modify leverage');
  }

  // Capture BEFORE state for the audit row.
  const before = await getEffective(userId);

  user.customLeverage = lev;
  user.leverageOverride = {
    by:        adminId || null,
    at:        new Date(),
    reason:    reason || null,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  };
  await user.save();

  // AFTER state.
  const after = await getEffective(userId);

  await LeverageLog.create({
    userId,
    changedBy: adminId || null,
    action:    'SET_OVERRIDE',
    from: {
      effective:      before.effectiveLeverage,
      customLeverage: before.customLeverage,
      planDefault:    before.planDefault,
      source:         before.source,
    },
    to: {
      effective:      after.effectiveLeverage,
      customLeverage: after.customLeverage,
      planDefault:    after.planDefault,
      source:         after.source,
    },
    reason: reason || null,
    batchId: batchId || null,
  });

  return after;
};

/**
 * Remove the admin override → user reverts to their plan's default.
 */
const clearOverride = async ({ userId, adminId, reason }) => {
  const user = await User.findById(userId).select('customLeverage leverageOverride');
  if (!user) throw new Error('User not found');

  const before = await getEffective(userId);

  user.customLeverage = null;
  user.leverageOverride = { by: null, at: null, reason: null, expiresAt: null };
  await user.save();

  const after = await getEffective(userId);

  await LeverageLog.create({
    userId,
    changedBy: adminId || null,
    action:    'CLEAR_OVERRIDE',
    from: {
      effective:      before.effectiveLeverage,
      customLeverage: before.customLeverage,
      planDefault:    before.planDefault,
      source:         before.source,
    },
    to: {
      effective:      after.effectiveLeverage,
      customLeverage: after.customLeverage,
      planDefault:    after.planDefault,
      source:         after.source,
    },
    reason: reason || null,
  });

  return after;
};

/**
 * Bulk-update many users to the same override.
 * Logs a batch ID so admin can see all rows from the same operation.
 */
const bulkSetOverride = async ({ userIds, value, adminId, reason }) => {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new Error('userIds must be a non-empty array');
  }
  const batchId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const results = [];
  for (const id of userIds) {
    try {
      const next = await setOverride({ userId: id, value, adminId, reason, batchId });
      results.push({ userId: id, ok: true, effective: next.effectiveLeverage });
    } catch (e) {
      results.push({ userId: id, ok: false, error: e.message });
    }
  }
  return { batchId, results, succeeded: results.filter((r) => r.ok).length };
};

/**
 * Read recent audit-log rows for a user. Newest first.
 */
const getHistory = async (userId, { limit = 100 } = {}) => {
  return LeverageLog.find({ userId })
    .populate('changedBy', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

/**
 * Hook called by subscriptionService.subscribe() when the user's plan
 * changes. If the user has no override, their effective leverage shifts
 * automatically to the new plan's default — but we still log it as a
 * PLAN_CHANGE row so the audit trail shows why their cap moved.
 */
const onPlanChange = async ({ userId, beforePlanCode, afterPlanCode }) => {
  const user = await User.findById(userId).select('customLeverage');
  // If the user has an admin override, the effective leverage stays put
  // (override beats plan default). No history row needed.
  if (user?.customLeverage != null) return;

  const after = await getEffective(userId);
  await LeverageLog.create({
    userId,
    changedBy: null,
    action:    'PLAN_CHANGE',
    from: {
      effective:      null,
      customLeverage: null,
      planDefault:    null,
      source:         beforePlanCode || null,
    },
    to: {
      effective:      after.effectiveLeverage,
      customLeverage: after.customLeverage,
      planDefault:    after.planDefault,
      source:         after.source,
    },
    reason: `Plan changed: ${beforePlanCode || '—'} → ${afterPlanCode || '—'}`,
  });
};

module.exports = {
  getEffective,
  setOverride,
  clearOverride,
  bulkSetOverride,
  getHistory,
  onPlanChange,
  SYSTEM_MIN,
  SYSTEM_MAX,
  SYSTEM_FALLBACK,
};
