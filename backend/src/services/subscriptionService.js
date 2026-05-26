const { Plan, Subscription } = require('../models/Subscription');

/**
 * Resolve a user's effective plan.
 * - If no subscription record: returns the FREE plan
 * - If expired/cancelled: returns FREE
 * - If ACTIVE/TRIAL: returns the subscribed plan
 *
 * Cached briefly to avoid hitting DB on every order.
 */
const planCache = new Map(); // userId -> { plan, expiresAt }
const CACHE_TTL_MS = 30 * 1000;

const getEffectivePlan = async (userId) => {
  const cached = planCache.get(String(userId));
  if (cached && cached.expiresAt > Date.now()) return cached.plan;

  const sub = await Subscription.findOne({ userId }).lean();
  let plan = null;

  if (sub && (sub.status === 'ACTIVE' || sub.status === 'TRIAL')) {
    if (!sub.expiresAt || sub.expiresAt > new Date()) {
      plan = await Plan.findById(sub.planId).lean();
    }
  }

  if (!plan) {
    plan = await Plan.findOne({ code: 'FREE', isActive: true }).lean();
  }

  // Failsafe — if even FREE plan isn't seeded, return a hardcoded default
  if (!plan) {
    plan = {
      code: 'FREE',
      name: 'Free',
      limits: { maxAccounts: 2, maxLeverageOverride: null, withdrawalDailyLimit: null },
      features: { feeDiscountPercent: '0', apiAccess: false, prioritySupport: false, copyTradingEnabled: false, affiliateBonus: '0' },
    };
  }

  planCache.set(String(userId), { plan, expiresAt: Date.now() + CACHE_TTL_MS });
  return plan;
};

const invalidateCache = (userId) => planCache.delete(String(userId));

/**
 * Check if user can create another account based on their plan.
 */
const canCreateAccount = async (userId) => {
  const TradingAccount = require('../models/TradingAccount');
  const plan = await getEffectivePlan(userId);
  const count = await TradingAccount.countDocuments({ userId, isActive: true });
  const rawMax = plan.limits?.maxAccounts;
  // null / negative = unlimited (POSTPAID). 0 stays as 0 (blocked).
  const unlimited = rawMax == null || rawMax < 0;
  const max = unlimited ? Infinity : rawMax;
  return {
    allowed: unlimited || count < max,
    current: count,
    max: unlimited ? null : max,
    planCode: plan.code,
  };
};

/**
 * Apply fee discount based on user's plan.
 * @returns adjusted fee amount as string-decimal
 */
const applyFeeDiscount = async (userId, originalFee) => {
  const plan = await getEffectivePlan(userId);
  const discount = Number(plan.features?.feeDiscountPercent || 0);
  if (discount <= 0) return originalFee;
  const adjusted = Number(originalFee) * (1 - discount);
  return adjusted.toFixed(8);
};

/**
 * Subscribe a user to a plan. In a real flow, this would be called after
 * payment provider confirms; here we accept a paymentRef field for that link.
 */
const subscribe = async ({ userId, planCode, billingCycle = 'MONTHLY', paymentRef }) => {
  const plan = await Plan.findOne({ code: planCode.toUpperCase(), isActive: true });
  if (!plan) throw new Error(`Plan ${planCode} not found`);

  let expiresAt = null;
  if (billingCycle === 'MONTHLY') expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  else if (billingCycle === 'YEARLY') expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // Capture the previous plan so leverage audit row can show
  // "BASIC → VIP" in the history.
  const prevSub = await Subscription.findOne({ userId }).lean();
  const beforePlanCode = prevSub?.planCode || 'FREE';

  const update = {
    planId: plan._id,
    planCode: plan.code,
    status: 'ACTIVE',
    billingCycle,
    startedAt: new Date(),
    expiresAt,
    cancelledAt: null,
    autoRenew: true,
    ...(paymentRef && { lastPayment: paymentRef }),
  };

  const sub = await Subscription.findOneAndUpdate({ userId }, update, { upsert: true, new: true });
  invalidateCache(userId);

  // Plan change can shift the user's effective leverage (if they have
  // no admin override). Notify the leverage service so it can record
  // the transition AND push the new cap to the user's open WS sessions.
  if (beforePlanCode !== plan.code) {
    try {
      const leverageService = require('./leverageService');
      await leverageService.onPlanChange({
        userId,
        beforePlanCode,
        afterPlanCode: plan.code,
      });
      const fresh = await leverageService.getEffective(userId);
      try {
        const wsServer = require('../websocket/server');
        wsServer.notifyUser(userId, 'leverage', fresh);
      } catch (_) { /* WS optional */ }
    } catch (_) { /* leverage hook is non-fatal — sub still succeeds */ }

    // Apply maxAccounts cap — suspends excess accounts on downgrade,
    // lifts previously-suspended ones on upgrade. Non-fatal: if it
    // fails the subscription itself still stands and ops can re-run
    // enforcement manually.
    try {
      const planEnforcement = require('./planEnforcementService');
      const result = await planEnforcement.enforce(userId, plan, 'Plan change');
      if (result.suspended || result.lifted) {
        console.log(
          `[subscriptions] enforce userId=${userId} plan=${plan.code} suspended=${result.suspended} lifted=${result.lifted}`
        );
      }
      try {
        const wsServer = require('../websocket/server');
        wsServer.notifyUser(userId, 'accounts', { event: 'PLAN_ENFORCED', ...result });
      } catch (_) { /* WS optional */ }
    } catch (e) {
      console.error('[subscriptions] enforce failed:', e.message);
    }
  }

  return sub;
};

const cancel = async ({ userId, reason }) => {
  const sub = await Subscription.findOne({ userId });
  if (!sub) throw new Error('No active subscription');
  sub.status = 'CANCELLED';
  sub.cancelledAt = new Date();
  sub.cancelReason = reason || 'User cancelled';
  sub.autoRenew = false;
  await sub.save();
  invalidateCache(userId);
  return sub;
};

module.exports = { getEffectivePlan, canCreateAccount, applyFeeDiscount, subscribe, cancel, invalidateCache };
