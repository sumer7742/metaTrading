const { Plan, Subscription } = require('../models/Subscription');
const subscriptionService = require('../services/subscriptionService');
const walletService = require('../services/walletService');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { WALLET_TX_TYPE } = require('../config/constants');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');

const listPlans = asyncHandler(async (req, res) => {
  const plans = await Plan.find({ isActive: true }).sort({ sortOrder: 1, monthlyPrice: 1 }).lean();
  sendSuccess(res, plans);
});

const mySubscription = asyncHandler(async (req, res) => {
  const sub = await Subscription.findOne({ userId: req.userId }).populate('planId').lean();
  const plan = await subscriptionService.getEffectivePlan(req.userId);

  // Wallet snapshot so the FE can show "available: $X · plan costs $Y"
  // and decide if the user can afford the upgrade. Picks the primary
  // REAL trading account (oldest = primary).
  const account = await TradingAccount.findOne({
    userId: req.userId,
    accountType: 'REAL',
    isActive: true,
  }).sort({ createdAt: 1 }).lean();
  let wallet = null;
  if (account) {
    const w = await Wallet.findOne({
      userId: req.userId,
      accountId: account._id,
      currency: account.baseCurrency,
    }).lean();
    wallet = {
      accountId: account._id,
      currency:  account.baseCurrency || 'USD',
      balance:   w?.balance || '0',
      free:      w?.free    || w?.balance || '0',
    };
  }

  sendSuccess(res, { subscription: sub, effectivePlan: plan, wallet });
});

/**
 * Subscribe to a plan. Three payment paths:
 *  1. `paymentMethod: 'wallet'`  — debits the user's REAL trading wallet
 *     for the plan price; on success creates the subscription. This is
 *     the in-app / no-redirect path the FE uses today.
 *  2. `paymentRef` passed directly — accepted from a card-checkout webhook
 *     (Razorpay/Stripe call this endpoint server-to-server in prod).
 *  3. Free plan — neither needed; just creates / switches to FREE.
 *
 * Body: { planCode, billingCycle, paymentMethod?, paymentRef? }
 */
const subscribe = asyncHandler(async (req, res) => {
  const { planCode, billingCycle = 'MONTHLY', paymentRef, paymentMethod } = req.body;
  if (!planCode) throw new AppError('planCode required', 400);

  const plan = await Plan.findOne({ code: planCode.toUpperCase(), isActive: true });
  if (!plan) throw new AppError('Plan not found', 404);

  const monthlyPrice = Number(plan.monthlyPrice || 0);
  const yearlyPrice  = Number(plan.yearlyPrice  || 0);
  const price = billingCycle === 'YEARLY' ? yearlyPrice : monthlyPrice;

  let effectivePaymentRef = paymentRef || null;

  // ── Wallet-debit path ──────────────────────────────────────────────
  // Used when the user clicks "Pay from wallet" in the FE. Picks their
  // primary REAL account and debits the plan price atomically. If they
  // don't have enough, walletService throws INSUFFICIENT_FUNDS and
  // nothing is created — the user stays on their current plan.
  if (paymentMethod === 'wallet' && price > 0) {
    const account = await TradingAccount.findOne({
      userId: req.userId,
      accountType: 'REAL',
      isActive: true,
    }).sort({ createdAt: 1 });
    if (!account) {
      throw new AppError(
        'You need a real trading account to pay from your wallet. Open one first.',
        400,
        'NO_REAL_ACCOUNT'
      );
    }
    const ccy = account.baseCurrency || 'USD';
    // Plans are USD-priced; if the user's account is INR we let it
    // through 1:1 for now (FE shows the same number). Real FX wiring
    // would convert here using `useFxRate`. Acceptable for v1 since
    // most accounts on this platform use a single base currency anyway.
    const ledger = await walletService.debit({
      userId:        req.userId,
      accountId:     account._id,
      currency:      ccy,
      amount:        String(price),
      type:          WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'subscription',
      note:          `Subscription · ${plan.name} (${billingCycle.toLowerCase()})`,
    });
    effectivePaymentRef = {
      provider:      'WALLET',
      transactionId: String(ledger._id),
      amount:        String(price),
      currency:      ccy,
      paidAt:        new Date(),
    };
  } else if (price > 0 && !effectivePaymentRef) {
    // Non-wallet paid path still requires a payment reference (card webhook).
    throw new AppError(
      'Paid plans require a payment method. Pass paymentMethod: "wallet" or a paymentRef from your payment provider.',
      402,
      'PAYMENT_REQUIRED'
    );
  }

  const sub = await subscriptionService.subscribe({
    userId: req.userId,
    planCode,
    billingCycle,
    paymentRef: effectivePaymentRef,
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
