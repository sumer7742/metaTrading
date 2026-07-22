/**
 * Subscription Wallet controller — APIs that the FE talks to for the
 * standalone subscription wallet UX (balance card, deposit, history,
 * auto-renew toggle, renew).
 *
 * Trading wallet endpoints live in walletController.js and are
 * untouched.
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { applyDateRange } = require('../utils/dateRange');
const subscriptionWalletService = require('../services/subscriptionWalletService');
const subscriptionService = require('../services/subscriptionService');
const walletService = require('../services/walletService');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { WALLET_TX_TYPE } = require('../config/constants');
const { Plan, Subscription } = require('../models/Subscription');
const { SubscriptionTransaction } = require('../models/SubscriptionWallet');
const { Deposit, Withdrawal } = require('../models/index');
const User = require('../models/User');

/* ── User-facing ────────────────────────────────────────────────── */

// GET /subscription-wallet
const getWallet = asyncHandler(async (req, res) => {
  const wallet = await subscriptionWalletService.getOrCreate(req.userId);
  sendSuccess(res, {
    _id: wallet._id,
    userId: wallet.userId,
    walletType: wallet.walletType,
    balance: wallet.balance,
    currency: wallet.currency,
    autoRenew: wallet.autoRenew,
    gracePeriodDays: wallet.gracePeriodDays,
    lowBalanceThreshold: wallet.lowBalanceThreshold,
    isLowBalance: subscriptionWalletService.isLowBalance(wallet),
    updatedAt: wallet.updatedAt,
  });
});

// POST /subscription-wallet/deposit  { amount, sourceAccountId?, paymentMethod?, paymentRef? }
//
// Default flow (paymentMethod omitted or 'trading_wallet'):
//   - Debits the user's REAL trading account wallet for `amount`
//   - Credits the Subscription Wallet for the same amount
//   - Both moves are logged: a WalletLedger row on the trading side
//     and a SubscriptionTransaction on the subscription side
//
// `paymentRef` path: external payment-gateway webhook scenario.
// `paymentMethod: 'manual'`: admin-style credit that does NOT pull from
// the trading wallet (used internally / by ops scripts).
const deposit = asyncHandler(async (req, res) => {
  const { amount, sourceAccountId, paymentMethod, paymentRef, note } = req.body;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError('amount must be a positive number', 400);
  }
  const amtStr = String(n);

  // External / manual paths skip the trading-wallet debit.
  if (paymentMethod === 'manual' || paymentRef) {
    const { wallet, tx } = await subscriptionWalletService.credit({
      userId: req.userId,
      amount: amtStr,
      reason: 'DEPOSIT',
      paymentMethod: paymentMethod || 'gateway',
      paymentRef,
      note: note || 'Subscription wallet top-up',
    });
    return sendSuccess(res, { wallet, transaction: tx }, 201);
  }

  // ── Trading-wallet → Subscription-wallet transfer ────────────────
  // Pick the source account: caller-supplied or the user's primary
  // (oldest) REAL trading account.
  let account;
  if (sourceAccountId) {
    account = await TradingAccount.findOne({
      _id: sourceAccountId,
      userId: req.userId,
      isActive: true,
    });
    if (!account) throw new AppError('Source account not found', 404, 'ACCOUNT_NOT_FOUND');
  } else {
    // Pick the user's primary live trading account — anything that
    // isn't a practice/demo bucket. Tier codes (STANDARD / PRO /
    // FREE / etc) are all "real" for billing purposes.
    account = await TradingAccount.findOne({
      userId: req.userId,
      accountType: { $nin: ['DEMO', 'VIRTUAL'] },
      isActive: true,
    }).sort({ createdAt: 1 });
    if (!account) {
      throw new AppError(
        'You need a real trading account to fund the Subscription Wallet.',
        400,
        'NO_REAL_ACCOUNT'
      );
    }
  }

  const ccy = account.baseCurrency || 'USD';

  // Debit the trading wallet FIRST. If balance is short, INSUFFICIENT_FUNDS
  // is thrown and the subscription wallet stays untouched.
  let ledger;
  try {
    ledger = await walletService.debit({
      userId:        req.userId,
      accountId:     account._id,
      currency:      ccy,
      amount:        amtStr,
      type:          WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'subscription_wallet_topup',
      note:          note || `Transfer to Subscription Wallet`,
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_FUNDS') {
      // Snapshot the available balance so the FE can show "you have $X".
      const w = await Wallet.findOne({
        userId: req.userId,
        accountId: account._id,
        currency: ccy,
      }).lean();
      const available = w?.balance || '0';
      throw new AppError(
        `Insufficient balance in account ${account.accountNumber} (${ccy} ${available}). Top up your trading wallet first.`,
        402,
        'INSUFFICIENT_TRADING_BALANCE',
        { accountId: account._id, accountNumber: account.accountNumber, available, needed: amtStr, currency: ccy }
      );
    }
    throw err;
  }

  // Trading debit succeeded — credit the Subscription Wallet. If THIS
  // fails for some reason, refund the trading wallet so the user
  // isn't left short.
  try {
    const { wallet, tx } = await subscriptionWalletService.credit({
      userId:        req.userId,
      amount:        amtStr,
      reason:        'DEPOSIT',
      paymentMethod: 'trading_wallet',
      paymentRef:    String(ledger._id),
      note:          note || `From trading account ${account.accountNumber}`,
    });
    return sendSuccess(res, {
      wallet,
      transaction: tx,
      source: {
        accountId:     account._id,
        accountNumber: account.accountNumber,
        currency:      ccy,
        ledgerId:      ledger._id,
      },
    }, 201);
  } catch (creditErr) {
    // Best-effort refund. Use the proper credit path on the trading
    // wallet so the ledger stays balanced.
    try {
      await walletService.credit({
        userId:        req.userId,
        accountId:     account._id,
        currency:      ccy,
        amount:        amtStr,
        type:          WALLET_TX_TYPE.ADJUSTMENT,
        referenceType: 'subscription_wallet_topup_refund',
        note:          'Refund: subscription wallet credit failed',
      });
    } catch (refundErr) {
      console.error('[subscriptionWallet.deposit] CRITICAL: refund failed', refundErr.message);
    }
    throw creditErr;
  }
});

/**
 * POST /subscription-wallet/manual-deposit
 *
 * User submits a manual deposit request (UPI / Bank / Crypto / Skrill /
 * Neteller / etc). Goes through the same admin-verification workflow
 * as a regular trading-wallet deposit, but on confirm the funds land
 * in the Subscription Wallet (routed by Deposit.targetWallet === 'subscription'
 * inside the admin confirmDeposit flow).
 *
 * Body: { amount, currency, method, txReference, senderName,
 *         senderUpiId, senderBankAccount, screenshot, screenshotMimeType, note }
 */
const manualDeposit = asyncHandler(async (req, res) => {
  const {
    amount,
    currency = 'USD',
    method,
    txReference,
    senderName,
    senderUpiId,
    senderBankAccount,
    screenshot,
    screenshotMimeType,
    note,
  } = req.body;

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new AppError('amount must be a positive number', 400);
  }
  if (!method) throw new AppError('Payment method is required', 400);
  if (!txReference || !String(txReference).trim()) {
    throw new AppError('Transaction reference is required', 400);
  }
  if (!screenshot) {
    throw new AppError('Payment proof screenshot is required', 400);
  }

  // Base wallet balance is USD. For non-USD deposits, admin reconciles
  // the converted amount manually at verification time — the FE pre-
  // computes the displayed USD value when submitting.
  const baseAmount = amt;
  const fxRateUsed = 1;

  const dep = await Deposit.create({
    userId: req.userId,
    targetWallet: 'subscription',
    accountId: undefined, // not bound to a trading account
    currency: String(currency).toUpperCase(),
    amount: String(amt),
    baseCurrency: 'USD',
    baseAmount: String(baseAmount.toFixed(2)),
    fxRateUsed,
    method,
    txReference: String(txReference).trim(),
    senderName,
    senderUpiId,
    senderBankAccount,
    screenshot,
    screenshotMimeType,
    note: note || 'Subscription wallet top-up',
    status: 'PENDING',
  });

  sendSuccess(res, {
    depositId: dep._id,
    status: dep.status,
    amount: dep.amount,
    currency: dep.currency,
    method: dep.method,
  }, 201);
});

// POST /subscription-wallet/withdraw  { amount, method, + destination fields }
//
// Real Main-Wallet cash-out. The balance is DEBITED (held) up-front and a
// PENDING Withdrawal (source='SUBSCRIPTION') is created for the admin queue.
// Admin approve → payout is external, balance stays debited. Admin reject →
// the balance is refunded (see adminController.rejectWithdrawal). KYC-gated
// like trading withdrawals (AML).
const requestWithdrawal = asyncHandler(async (req, res) => {
  const n = Number(req.body.amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('amount must be a positive number', 400);
  const M = String(req.body.method || '').toUpperCase();
  if (!['UPI', 'BANK', 'CRYPTO'].includes(M)) throw new AppError('method must be UPI, BANK or CRYPTO', 400);

  // Per-method destination details (stored on the Withdrawal for the admin).
  const dest = {};
  if (M === 'UPI') {
    if (!req.body.upiId) throw new AppError('UPI ID is required', 400);
    dest.upiId = String(req.body.upiId).trim();
  } else if (M === 'BANK') {
    if (!req.body.bankAccountNumber || !req.body.bankIFSC || !req.body.bankAccountHolderName) {
      throw new AppError('Bank account number, IFSC and account holder name are required', 400);
    }
    dest.bankAccountNumber = String(req.body.bankAccountNumber).trim();
    dest.bankIFSC = String(req.body.bankIFSC).trim();
    dest.bankAccountHolderName = String(req.body.bankAccountHolderName).trim();
    if (req.body.bankName) dest.bankName = String(req.body.bankName).trim();
  } else {
    if (!req.body.cryptoAddress || !req.body.cryptoNetwork) {
      throw new AppError('Crypto address and network are required', 400);
    }
    dest.cryptoAddress = String(req.body.cryptoAddress).trim();
    dest.cryptoNetwork = String(req.body.cryptoNetwork).trim();
  }

  // KYC gate — mirror trading withdrawals.
  const user = await User.findById(req.userId).select('kycStatus').lean();
  if (!user || user.kycStatus !== 'APPROVED') {
    throw new AppError('KYC verification must be approved before withdrawing funds.', 403, 'KYC_REQUIRED');
  }

  const amtStr = String(n);

  // 1. Debit (hold) the Main Wallet first — throws 402 if balance is short.
  let walletAfter;
  try {
    const { wallet } = await subscriptionWalletService.debit({
      userId: req.userId,
      amount: amtStr,
      reason: 'WITHDRAWAL',
      note: `Withdrawal request · ${M}`,
    });
    walletAfter = wallet;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_SUBSCRIPTION_BALANCE') {
      throw new AppError(err.message, 402, 'INSUFFICIENT_BALANCE');
    }
    throw err;
  }

  // 2. Create the PENDING withdrawal. If this fails, refund the hold so the
  //    user is never left short.
  let wd;
  try {
    wd = await Withdrawal.create({
      userId: req.userId,
      source: 'SUBSCRIPTION',
      currency: walletAfter.currency || 'USD',
      amount: amtStr,
      baseCurrency: 'USD',
      baseAmount: amtStr,
      fxRateUsed: 1,
      method: M,
      ...dest,
      status: 'PENDING',
    });
  } catch (createErr) {
    try {
      await subscriptionWalletService.credit({
        userId: req.userId, amount: amtStr, reason: 'REFUND',
        note: 'Refund: withdrawal request could not be created',
      });
    } catch (refundErr) {
      console.error('[subscriptionWallet.withdraw] CRITICAL: hold refund failed', refundErr.message);
    }
    throw createErr;
  }

  sendSuccess(res, {
    withdrawalId: wd._id,
    status: wd.status,
    amount: wd.amount,
    currency: wd.currency,
    method: wd.method,
    balance: walletAfter.balance,
  }, 201);
});

// POST /subscription-wallet/auto-renew  { enabled }
const toggleAutoRenew = asyncHandler(async (req, res) => {
  const wallet = await subscriptionWalletService.setAutoRenew(req.userId, !!req.body.enabled);
  sendSuccess(res, { autoRenew: wallet.autoRenew });
});

// GET /subscription/history?limit=&type=&reason=
const history = asyncHandler(async (req, res) => {
  const items = await subscriptionWalletService.history(req.userId, {
    limit: req.query.limit,
    type: req.query.type,
    reason: req.query.reason,
  });
  sendSuccess(res, items);
});

/**
 * POST /subscription/renew  { planCode, billingCycle }
 *
 * Standalone renewal endpoint — always debits the Subscription Wallet
 * regardless of `paymentMethod`. The classic /subscriptions/subscribe
 * still supports paymentMethod='wallet' (trading wallet) for backward
 * compat with older clients, but new code should use this endpoint.
 *
 * Behaviour when balance < price:
 *   - HTTP 402 + code=INSUFFICIENT_SUBSCRIPTION_BALANCE
 *   - FE shows the recharge popup and stops the renewal until funded.
 */
const renew = asyncHandler(async (req, res) => {
  const { planCode, billingCycle = 'MONTHLY' } = req.body;
  if (!planCode) throw new AppError('planCode required', 400);

  const plan = await Plan.findOne({ code: String(planCode).toUpperCase(), isActive: true });
  if (!plan) throw new AppError('Plan not found', 404);

  const price = String(billingCycle === 'YEARLY' ? plan.yearlyPrice : plan.monthlyPrice);
  const priceNum = Number(price);

  // Free / Post-Paid don't move money on activation.
  if (priceNum > 0) {
    const bonusWalletService = require('../services/bonusWalletService');
    let tx;
    try {
      ({ tx } = await bonusWalletService.debit({
        userId: req.userId,
        amount: price,
        reason: 'RENEWAL',
        note: `${plan.name} · ${billingCycle.toLowerCase()} renewal`,
      }));
    } catch (err) {
      if (err.code === 'INSUFFICIENT_BONUS_BALANCE') {
        throw new AppError(err.message, 402, 'INSUFFICIENT_SUBSCRIPTION_BALANCE');
      }
      throw err;
    }

    const sub = await subscriptionService.subscribe({
      userId: req.userId,
      planCode: plan.code,
      billingCycle,
      paymentRef: {
        provider: 'BONUS_WALLET',
        transactionId: String(tx._id),
        amount: price,
        currency: tx.currency,
        paidAt: new Date(),
      },
    });
    return sendSuccess(res, { subscription: sub, transaction: tx }, 201);
  }

  const sub = await subscriptionService.subscribe({
    userId: req.userId,
    planCode: plan.code,
    billingCycle,
  });
  sendSuccess(res, { subscription: sub }, 201);
});

/* ── Admin ──────────────────────────────────────────────────────── */

// POST /subscription-wallet/admin/credit  { userId, amount, note? }
const adminCredit = asyncHandler(async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount) throw new AppError('userId and amount required', 400);
  const { wallet, tx } = await subscriptionWalletService.credit({
    userId,
    amount: String(amount),
    reason: 'ADMIN_CREDIT',
    note: note || 'Admin manual credit',
    adminUserId: req.userId,
  });
  sendSuccess(res, { wallet, transaction: tx });
});

// POST /subscription-wallet/admin/debit  { userId, amount, note? }
const adminDebit = asyncHandler(async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount) throw new AppError('userId and amount required', 400);
  const { wallet, tx } = await subscriptionWalletService.debit({
    userId,
    amount: String(amount),
    reason: 'ADMIN_DEBIT',
    note: note || 'Admin manual debit',
    adminUserId: req.userId,
  });
  sendSuccess(res, { wallet, transaction: tx });
});

// PATCH /subscription-wallet/admin/:userId/auto-renew  { enabled }
const adminSetAutoRenew = asyncHandler(async (req, res) => {
  const wallet = await subscriptionWalletService.setAutoRenew(
    req.params.userId,
    !!req.body.enabled
  );
  sendSuccess(res, { userId: wallet.userId, autoRenew: wallet.autoRenew });
});

// PATCH /subscription-wallet/admin/:userId/grace-period  { days }
const adminSetGracePeriod = asyncHandler(async (req, res) => {
  const days = Number(req.body.days);
  if (!Number.isFinite(days) || days < 0) throw new AppError('days must be >= 0', 400);
  const wallet = await subscriptionWalletService.getOrCreate(req.params.userId);
  wallet.gracePeriodDays = Math.floor(days);
  await wallet.save();
  sendSuccess(res, { userId: wallet.userId, gracePeriodDays: wallet.gracePeriodDays });
});

// GET /subscription-wallet/admin/logs?userId=&from=&to=&page=&limit=
//
// The "subscription payment logs" admin view — paginated transaction
// history across all users (or filtered to one).
const adminLogs = asyncHandler(async (req, res) => {
  const { userId, from, to, page = '1', limit = '50' } = req.query;
  const q = {};
  if (userId) q.userId = userId;
  // Inclusive of the whole `to` day (fixes From==To returning nothing).
  applyDateRange(q, 'createdAt', from, to);
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const [items, total] = await Promise.all([
    SubscriptionTransaction.find(q)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    SubscriptionTransaction.countDocuments(q),
  ]);
  sendSuccess(res, { items, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } });
});

module.exports = {
  getWallet,
  deposit,
  manualDeposit,
  requestWithdrawal,
  toggleAutoRenew,
  history,
  renew,
  adminCredit,
  adminDebit,
  adminSetAutoRenew,
  adminSetGracePeriod,
  adminLogs,
};
