/**
 * Bonus Wallet controller — APIs for the standalone Bonus Wallet UX
 * (balance + earnings summary, history) and the admin tooling
 * (credit / debit / logs / balances list / export).
 *
 * There is intentionally NO deposit and NO withdrawal endpoint: the
 * Bonus Wallet is funded automatically by referral/partner earnings and
 * by internal transfers IN (handled by walletController.internalTransfer
 * via the 'bonus' sentinel). Funds leave only via internal transfer OUT.
 */
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const bonusWalletService = require('../services/bonusWalletService');
const walletService = require('../services/walletService');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { WALLET_TX_TYPE } = require('../config/constants');
const { Deposit, Withdrawal } = require('../models/index');
const { BonusWallet, BonusTransaction } = require('../models/BonusWallet');
const User = require('../models/User');

/* ── User-facing ────────────────────────────────────────────────── */

// GET /bonus-wallet
const getWallet = asyncHandler(async (req, res) => {
  const wallet = await bonusWalletService.getOrCreate(req.userId);
  const summary = await bonusWalletService.summary(req.userId);
  sendSuccess(res, {
    _id: wallet._id,
    userId: wallet.userId,
    walletType: wallet.walletType,
    balance: wallet.balance,
    currency: wallet.currency,
    autoRenew: wallet.autoRenew,
    gracePeriodDays: wallet.gracePeriodDays,
    lowBalanceThreshold: wallet.lowBalanceThreshold,
    isLowBalance: bonusWalletService.isLowBalance(wallet),
    updatedAt: wallet.updatedAt,
    ...summary,
  });
});

// POST /bonus-wallet/withdraw  { amount, method, + destination fields }
//
// Real Bonus-Wallet cash-out. Balance is DEBITED (held) up-front and a PENDING
// Withdrawal (source='BONUS') is created for the admin queue. Admin approve →
// external payout, balance stays debited. Admin reject → balance refunded
// (see adminController.rejectWithdrawal). KYC-gated like every withdrawal.
const requestWithdrawal = asyncHandler(async (req, res) => {
  const n = Number(req.body.amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('amount must be a positive number', 400);
  const M = String(req.body.method || '').toUpperCase();
  if (!['UPI', 'BANK', 'CRYPTO'].includes(M)) throw new AppError('method must be UPI, BANK or CRYPTO', 400);

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

  const user = await User.findById(req.userId).select('kycStatus').lean();
  if (!user || user.kycStatus !== 'APPROVED') {
    throw new AppError('KYC verification must be approved before withdrawing funds.', 403, 'KYC_REQUIRED');
  }

  const amtStr = String(n);

  // 1. Debit (hold) the Bonus Wallet — throws 402 if balance is short.
  let walletAfter;
  try {
    const { wallet } = await bonusWalletService.debit({
      userId: req.userId,
      amount: amtStr,
      reason: 'WITHDRAWAL',
      note: `Withdrawal request · ${M}`,
    });
    walletAfter = wallet;
  } catch (err) {
    if (err.code === 'INSUFFICIENT_BONUS_BALANCE') {
      throw new AppError(err.message, 402, 'INSUFFICIENT_BALANCE');
    }
    throw err;
  }

  // 2. Create PENDING withdrawal; refund the hold if the record can't be made.
  let wd;
  try {
    wd = await Withdrawal.create({
      userId: req.userId,
      source: 'BONUS',
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
      await bonusWalletService.credit({
        userId: req.userId, amount: amtStr, reason: 'REFUND',
        note: 'Refund: withdrawal request could not be created',
      });
    } catch (refundErr) {
      console.error('[bonusWallet.withdraw] CRITICAL: hold refund failed', refundErr.message);
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

// POST /bonus-wallet/auto-renew  { enabled }
const toggleAutoRenew = asyncHandler(async (req, res) => {
  const wallet = await bonusWalletService.setAutoRenew(req.userId, !!req.body.enabled);
  sendSuccess(res, { autoRenew: wallet.autoRenew });
});

// GET /bonus-wallet/summary
const getSummary = asyncHandler(async (req, res) => {
  sendSuccess(res, await bonusWalletService.summary(req.userId));
});

// GET /bonus-wallet/history?limit=&type=&reason=
const history = asyncHandler(async (req, res) => {
  const items = await bonusWalletService.history(req.userId, {
    limit: req.query.limit,
    type: req.query.type,
    reason: req.query.reason,
  });
  sendSuccess(res, items);
});

// POST /bonus-wallet/deposit  { amount, sourceAccountId? }
//
// Instant "Add Funds" from a trading account: debits the trading wallet
// and credits the Bonus Wallet in one step (mirrors the Main Wallet's
// instant deposit). Manual/external methods go through manualDeposit.
const deposit = asyncHandler(async (req, res) => {
  const { amount, sourceAccountId, note } = req.body;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('amount must be a positive number', 400);
  const amtStr = String(n);

  // Resolve the source account: caller-supplied or the user's primary
  // (oldest) real trading account.
  let account;
  if (sourceAccountId) {
    account = await TradingAccount.findOne({ _id: sourceAccountId, userId: req.userId, isActive: true });
    if (!account) throw new AppError('Source account not found', 404, 'ACCOUNT_NOT_FOUND');
  } else {
    account = await TradingAccount.findOne({
      userId: req.userId,
      accountType: { $nin: ['DEMO', 'VIRTUAL'] },
      isActive: true,
    }).sort({ createdAt: 1 });
    if (!account) throw new AppError('You need a real trading account to fund the Bonus Wallet.', 400, 'NO_REAL_ACCOUNT');
  }
  const ccy = account.baseCurrency || 'USD';

  // Debit trading wallet first. If short, INSUFFICIENT and bonus untouched.
  let ledger;
  try {
    ledger = await walletService.debit({
      userId: req.userId,
      accountId: account._id,
      currency: ccy,
      amount: amtStr,
      type: WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'bonus_wallet_topup',
      note: note || 'Transfer to Bonus Wallet',
    });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_FUNDS') {
      const w = await Wallet.findOne({ userId: req.userId, accountId: account._id, currency: ccy }).lean();
      throw new AppError(
        `Insufficient balance in account ${account.accountNumber} (${ccy} ${w?.balance || '0'}). Top up your trading wallet first.`,
        402, 'INSUFFICIENT_TRADING_BALANCE',
        { accountId: account._id, accountNumber: account.accountNumber, available: w?.balance || '0', needed: amtStr, currency: ccy }
      );
    }
    throw err;
  }

  // Credit the Bonus Wallet — refund the trading wallet if it fails.
  try {
    const { wallet, tx } = await bonusWalletService.credit({
      userId: req.userId,
      amount: amtStr,
      reason: 'DEPOSIT',
      paymentRef: `topup:${ledger._id}`,
      sourceWallet: `trading:${account._id}`,
      note: note || `From trading account ${account.accountNumber}`,
    });
    return sendSuccess(res, { wallet, transaction: tx, source: { accountId: account._id, accountNumber: account.accountNumber, currency: ccy, ledgerId: ledger._id } }, 201);
  } catch (creditErr) {
    try {
      await walletService.credit({
        userId: req.userId,
        accountId: account._id,
        currency: ccy,
        amount: amtStr,
        type: WALLET_TX_TYPE.ADJUSTMENT,
        referenceType: 'bonus_wallet_topup_refund',
        note: 'Refund: bonus wallet credit failed',
      });
    } catch (refundErr) {
      console.error('[bonusWallet.deposit] CRITICAL: refund failed', refundErr.message);
    }
    throw creditErr;
  }
});

// POST /bonus-wallet/manual-deposit
// External deposit (UPI/Bank/Crypto/Skrill/Neteller) → creates a PENDING
// Deposit with targetWallet:'bonus'. Admin verification credits the Bonus
// Wallet (adminController.confirmDeposit routes by targetWallet).
const manualDeposit = asyncHandler(async (req, res) => {
  const {
    amount, currency = 'USD', method, txReference,
    senderName, senderUpiId, senderBankAccount, screenshot, screenshotMimeType, note,
  } = req.body;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new AppError('amount must be a positive number', 400);
  if (!method) throw new AppError('Payment method is required', 400);
  if (!txReference || !String(txReference).trim()) throw new AppError('Transaction reference is required', 400);
  if (!screenshot) throw new AppError('Payment proof screenshot is required', 400);

  const dep = await Deposit.create({
    userId: req.userId,
    targetWallet: 'bonus',
    accountId: undefined,
    currency: String(currency).toUpperCase(),
    amount: String(amt),
    baseCurrency: 'USD',
    baseAmount: String(amt.toFixed(2)),
    fxRateUsed: 1,
    method,
    txReference: String(txReference).trim(),
    senderName,
    senderUpiId,
    senderBankAccount,
    screenshot,
    screenshotMimeType,
    note: note || 'Bonus wallet top-up',
    status: 'PENDING',
  });

  sendSuccess(res, { depositId: dep._id, status: dep.status, amount: dep.amount, currency: dep.currency, method: dep.method }, 201);
});

/* ── Admin ──────────────────────────────────────────────────────── */

// POST /bonus-wallet/admin/credit  { userId, amount, note? }
const adminCredit = asyncHandler(async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount) throw new AppError('userId and amount required', 400);
  const { wallet, tx } = await bonusWalletService.credit({
    userId,
    amount: String(amount),
    reason: 'ADMIN_CREDIT',
    note: note || 'Admin manual credit',
    adminUserId: req.userId,
  });
  await _audit(req, 'BONUS_WALLET_CREDIT', wallet._id, { userId, amount: String(amount), note });
  sendSuccess(res, { wallet, transaction: tx });
});

// POST /bonus-wallet/admin/debit  { userId, amount, note? }
const adminDebit = asyncHandler(async (req, res) => {
  const { userId, amount, note } = req.body;
  if (!userId || !amount) throw new AppError('userId and amount required', 400);
  const { wallet, tx } = await bonusWalletService.debit({
    userId,
    amount: String(amount),
    reason: 'ADMIN_DEBIT',
    note: note || 'Admin manual debit',
    adminUserId: req.userId,
  });
  await _audit(req, 'BONUS_WALLET_DEBIT', wallet._id, { userId, amount: String(amount), note });
  sendSuccess(res, { wallet, transaction: tx });
});

// GET /bonus-wallet/admin/balances?search=&page=&limit=
// Paginated list of users' bonus-wallet balances (admin overview).
const adminBalances = asyncHandler(async (req, res) => {
  const { page = '1', limit = '50' } = req.query;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const [wallets, total] = await Promise.all([
    BonusWallet.find({})
      .sort({ updatedAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate('userId', 'email firstName lastName')
      .lean(),
    BonusWallet.countDocuments({}),
  ]);
  sendSuccess(res, { items: wallets, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } });
});

// GET /bonus-wallet/admin/logs?userId=&reason=&from=&to=&page=&limit=
// Paginated transaction history across all users (filterable by referral/
// partner reason). Used for both the admin log view and CSV export.
const adminLogs = asyncHandler(async (req, res) => {
  const { userId, reason, from, to, page = '1', limit = '50' } = req.query;
  const q = {};
  if (userId) q.userId = userId;
  if (reason) q.reason = reason;
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(1000, Math.max(1, parseInt(limit, 10) || 50));
  const [items, total] = await Promise.all([
    BonusTransaction.find(q)
      .sort({ createdAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .populate('userId', 'email firstName lastName')
      .lean(),
    BonusTransaction.countDocuments(q),
  ]);
  sendSuccess(res, { items, pagination: { page: p, limit: l, total, pages: Math.ceil(total / l) } });
});

// Best-effort audit log — never blocks the wallet op if logging fails.
async function _audit(req, action, targetId, metadata) {
  try {
    const { AuditLog } = require('../models');
    if (!AuditLog) return;
    await AuditLog.create({
      actorId: req.userId,
      actorRole: req.user?.role,
      action,
      targetType: 'BONUS_WALLET',
      targetId: String(targetId),
      metadata,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  } catch (_) { /* non-fatal */ }
}

module.exports = { getWallet, getSummary, history, requestWithdrawal, toggleAutoRenew, deposit, manualDeposit, adminCredit, adminDebit, adminBalances, adminLogs };
