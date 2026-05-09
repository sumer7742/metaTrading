const { Plan, Subscription } = require('../models/Subscription');
const subscriptionService = require('../services/subscriptionService');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

const listPlans = asyncHandler(async (req, res) => {
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean();
  sendSuccess(res, plans);
});

const mySubscription = asyncHandler(async (req, res) => {
  const sub = await Subscription.findOne({ userId: req.userId }).populate('planId').lean();
  const plan = await subscriptionService.getEffectivePlan(req.userId);
  sendSuccess(res, { subscription: sub, effectivePlan: plan });
});

/**
 * Subscribe to a plan. For paid plans, in production this should be called
 * AFTER successful payment from Razorpay/Stripe webhook. For demo, we accept
 * a paymentRef directly so users can test the flow.
 *
 * Body: { planCode, billingCycle, paymentRef? }
 */
const subscribe = asyncHandler(async (req, res) => {
  const { planCode, billingCycle = 'MONTHLY', paymentRef } = req.body;
  if (!planCode) throw new AppError('planCode required', 400);

  const plan = await Plan.findOne({ code: planCode.toUpperCase(), isActive: true });
  if (!plan) throw new AppError('Plan not found', 404);

  // For paid plans, require a payment reference
  const monthlyPrice = Number(plan.monthlyPrice || 0);
  if (monthlyPrice > 0 && !paymentRef) {
    // In production: redirect user to payment provider here.
    // For dev / demo, we let admin enable plans manually via admin endpoint.
    throw new AppError('Paid plans require payment confirmation. Use the admin/grant endpoint for testing.', 402, 'PAYMENT_REQUIRED');
  }

  const sub = await subscriptionService.subscribe({
    userId: req.userId,
    planCode,
    billingCycle,
    paymentRef,
  });
  sendSuccess(res, sub, 201);
});

const cancel = asyncHandler(async (req, res) => {
  const sub = await subscriptionService.cancel({
    userId: req.userId,
    reason: req.body.reason,
  });
  sendSuccess(res, sub);
});

// =================== Admin ===================

const adminListPlans = asyncHandler(async (req, res) => {
  const plans = await Plan.find().sort({ sortOrder: 1 }).lean();
  sendSuccess(res, plans);
});

const adminCreatePlan = asyncHandler(async (req, res) => {
  const plan = await Plan.create(req.body);
  sendSuccess(res, plan, 201);
});

const adminUpdatePlan = asyncHandler(async (req, res) => {
  const plan = await Plan.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!plan) throw new AppError('Plan not found', 404);
  sendSuccess(res, plan);
});

/**
 * Admin manually grants a subscription (skips payment). Used for VIP comps,
 * dispute resolution, or initial demo setup.
 */
const adminGrant = asyncHandler(async (req, res) => {
  const { userId, planCode, billingCycle = 'MONTHLY' } = req.body;
  if (!userId || !planCode) throw new AppError('userId and planCode required', 400);
  const sub = await subscriptionService.subscribe({
    userId,
    planCode,
    billingCycle,
    paymentRef: { provider: 'MANUAL', transactionId: 'admin-grant', amount: '0', paidAt: new Date() },
  });
  sendSuccess(res, sub);
});

module.exports = {
  listPlans,
  mySubscription,
  subscribe,
  cancel,
  adminListPlans,
  adminCreatePlan,
  adminUpdatePlan,
  adminGrant,
};
