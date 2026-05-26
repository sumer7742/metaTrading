const { Plan, Subscription } = require('../models/Subscription');
const subscriptionService = require('../services/subscriptionService');
const subscriptionWalletService = require('../services/subscriptionWalletService');
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

  // Surface BOTH the Subscription Wallet (the authoritative source for
  // plan charges) AND the primary trading wallet snapshot (kept for
  // back-compat with older FE bundles that still read `wallet`).
  const subWallet = await subscriptionWalletService.getOrCreate(req.userId);

  // "Real" for billing = anything that isn't a practice/demo bucket.
  const account = await TradingAccount.findOne({
    userId: req.userId,
    accountType: { $nin: ['DEMO', 'VIRTUAL'] },
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

  sendSuccess(res, {
    subscription: sub,
    effectivePlan: plan,
    wallet,
    subscriptionWallet: {
      _id: subWallet._id,
      balance: subWallet.balance,
      currency: subWallet.currency,
      autoRenew: subWallet.autoRenew,
      gracePeriodDays: subWallet.gracePeriodDays,
      lowBalanceThreshold: subWallet.lowBalanceThreshold,
      isLowBalance: subscriptionWalletService.isLowBalance(subWallet),
    },
  });
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

  // ── Subscription Wallet debit (default + only in-app path) ─────────
  // Plan charges are isolated to the Subscription Wallet. Trading
  // wallets are NEVER touched. Older `paymentMethod === 'wallet'`
  // calls are silently redirected here so the FE doesn't break.
  const wantsWalletDebit =
    paymentMethod === 'wallet' ||
    paymentMethod === 'subscription_wallet' ||
    (!paymentMethod && !effectivePaymentRef && price > 0);

  if (wantsWalletDebit && price > 0) {
    try {
      const { tx } = await subscriptionWalletService.debit({
        userId: req.userId,
        amount: String(price),
        reason: 'SUBSCRIPTION_CHARGE',
        planCode: plan.code,
        billingCycle,
        note: `Subscription · ${plan.name} (${billingCycle.toLowerCase()})`,
      });
      effectivePaymentRef = {
        provider:      'SUB_WALLET',
        transactionId: String(tx._id),
        amount:        String(price),
        currency:      tx.currency,
        paidAt:        new Date(),
      };
    } catch (err) {
      // Surface a structured 402 so the FE can pop the recharge modal.
      if (err.code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') {
        const snap = await subscriptionWalletService.canAfford(req.userId, String(price));
        throw new AppError(
          err.message,
          402,
          'INSUFFICIENT_SUBSCRIPTION_BALANCE',
          { balance: snap.balance, needed: snap.needed, shortfall: snap.shortfall, currency: snap.currency }
        );
      }
      throw err;
    }
  } else if (price > 0 && !effectivePaymentRef) {
    throw new AppError(
      'Paid plans require a payment method. Use the Subscription Wallet or pass a paymentRef from your payment provider.',
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
