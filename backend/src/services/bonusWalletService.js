/**
 * Bonus Wallet service — all funds movement for the referral/partner
 * Bonus Wallet. Strictly isolated from trading + subscription wallets.
 *
 * Mirrors subscriptionWalletService so the rest of the platform (transfer
 * routing, admin tooling, FE history) follows the exact same conventions.
 * All arithmetic goes through utils/decimal (no IEEE float drift).
 *
 * Credits are IDEMPOTENT when a `paymentRef` is supplied: a duplicate ref
 * (retry, double-fire from the matching engine, etc.) is a safe no-op,
 * which satisfies the "prevent duplicate transactions" requirement.
 */
const { BonusWallet, BonusTransaction } = require('../models/BonusWallet');
const { add, sub, gte, gt } = require('../utils/decimal');
const { AppError } = require('../utils/errors');

const DEFAULT_CURRENCY = 'USD';

// Reasons that represent EARNINGS (vs. transfers / admin moves). Used by
// the summary rollup so the dashboard can show per-source totals.
const EARNING_REASONS = ['REFERRAL_COMMISSION', 'PARTNER_COMMISSION', 'REVENUE_SHARE', 'BONUS_REWARD'];

async function getOrCreate(userId) {
  let wallet = await BonusWallet.findOne({ userId });
  if (!wallet) {
    wallet = await BonusWallet.create({ userId, walletType: 'bonus', balance: '0', currency: DEFAULT_CURRENCY });
  }
  return wallet;
}

function _isDuplicateKeyError(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

/**
 * Credit the bonus wallet. Used by referral/partner earning hooks,
 * transfer-in, and admin credit.
 *
 * @param opts.userId
 * @param opts.amount       string-decimal, positive
 * @param opts.reason       REFERRAL_COMMISSION | PARTNER_COMMISSION | REVENUE_SHARE | BONUS_REWARD | TRANSFER_IN | ADMIN_CREDIT
 * @param opts.note
 * @param opts.paymentRef   optional idempotency key
 * @param opts.sourceWallet optional (for transfers)
 * @param opts.adminUserId  optional
 * @returns {Promise<{wallet, tx, duplicate?:boolean}>}
 */
async function credit(opts) {
  const { userId, amount, reason = 'BONUS_REWARD', paymentRef } = opts;
  if (!gt(amount, '0')) throw new AppError('Amount must be positive', 400);

  // Idempotency pre-check — cheap fast-path before mutating the balance.
  if (paymentRef) {
    const existing = await BonusTransaction.findOne({ paymentRef }).lean();
    if (existing) {
      const wallet = await getOrCreate(userId);
      return { wallet, tx: existing, duplicate: true };
    }
  }

  const wallet = await getOrCreate(userId);

  // Write the ledger row FIRST so the unique paymentRef index is the
  // authoritative dedupe gate. If a concurrent call already inserted it,
  // we bail before touching the balance (no double credit).
  let tx;
  try {
    tx = await BonusTransaction.create({
      userId,
      walletId: wallet._id,
      transactionType: 'CREDIT',
      reason,
      status: 'SUCCESS',
      amount: String(amount),
      currency: wallet.currency,
      balanceAfter: add(wallet.balance, amount), // provisional; corrected below
      note: opts.note,
      paymentRef,
      sourceWallet: opts.sourceWallet,
      adminUserId: opts.adminUserId,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err) && paymentRef) {
      const existing = await BonusTransaction.findOne({ paymentRef }).lean();
      return { wallet, tx: existing, duplicate: true };
    }
    throw err;
  }

  wallet.balance = add(wallet.balance, amount);
  await wallet.save();
  if (tx.balanceAfter !== wallet.balance) { tx.balanceAfter = wallet.balance; await tx.save(); }

  return { wallet, tx };
}

/**
 * Debit the bonus wallet (transfer-out, admin debit). Throws
 * INSUFFICIENT_BONUS_BALANCE (HTTP 402) if balance < amount. Never used
 * for withdrawals — the bonus wallet has no withdrawal path.
 */
async function debit(opts) {
  const { userId, amount, reason = 'TRANSFER_OUT', paymentRef } = opts;
  if (!gt(amount, '0')) throw new AppError('Amount must be positive', 400);

  const wallet = await getOrCreate(userId);
  if (!gte(wallet.balance, amount)) {
    throw new AppError(
      `Bonus wallet balance ${wallet.currency} ${wallet.balance} is below required ${wallet.currency} ${amount}.`,
      402,
      'INSUFFICIENT_BONUS_BALANCE'
    );
  }

  wallet.balance = sub(wallet.balance, amount);
  await wallet.save();

  const tx = await BonusTransaction.create({
    userId,
    walletId: wallet._id,
    transactionType: 'DEBIT',
    reason,
    status: 'SUCCESS',
    amount: String(amount),
    currency: wallet.currency,
    balanceAfter: wallet.balance,
    note: opts.note,
    paymentRef,
    sourceWallet: opts.sourceWallet,
    adminUserId: opts.adminUserId,
  });

  return { wallet, tx };
}

/** Affordability check without moving funds. */
async function canAfford(userId, amount) {
  const wallet = await getOrCreate(userId);
  return {
    canPay: gte(wallet.balance, amount),
    balance: wallet.balance,
    needed: String(amount),
    shortfall: gte(wallet.balance, amount) ? '0' : sub(amount, wallet.balance),
    currency: wallet.currency,
  };
}

/** User-facing transaction history (most-recent-first). */
async function history(userId, { limit = 50, type, reason } = {}) {
  const q = { userId };
  if (type) q.transactionType = type;
  if (reason) q.reason = reason;
  return BonusTransaction.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(500, Math.max(1, Number(limit) || 50)))
    .lean();
}

/**
 * Earnings summary for the dashboard card — current balance plus lifetime
 * totals broken down by earning source.
 */
async function summary(userId) {
  const wallet = await getOrCreate(userId);
  const mongoose = require('mongoose');
  const rows = await BonusTransaction.aggregate([
    { $match: { userId: mongoose.Types.ObjectId.createFromHexString(String(userId)), transactionType: 'CREDIT' } },
    { $addFields: { amtNum: { $toDouble: '$amount' } } },
    { $group: { _id: '$reason', total: { $sum: '$amtNum' } } },
  ]);
  const byReason = {};
  for (const r of rows) byReason[r._id] = Number(r.total || 0);
  const round2 = (n) => Number(n || 0).toFixed(2);
  return {
    balance: wallet.balance,
    currency: wallet.currency,
    totalReferralEarnings: round2(byReason.REFERRAL_COMMISSION),
    totalPartnerEarnings: round2(byReason.PARTNER_COMMISSION),
    totalRevenueShare: round2(byReason.REVENUE_SHARE),
    totalBonusRewards: round2(byReason.BONUS_REWARD),
    totalEarnings: round2(EARNING_REASONS.reduce((s, k) => s + (byReason[k] || 0), 0)),
  };
}

/** Toggle auto-renew on the wallet (subscription renewals read this). */
async function setAutoRenew(userId, autoRenew) {
  const wallet = await getOrCreate(userId);
  wallet.autoRenew = !!autoRenew;
  await wallet.save();
  return wallet;
}

/** True when balance is at/below lowBalanceThreshold — drives the FE warning. */
function isLowBalance(wallet) {
  if (!wallet) return false;
  return gte(wallet.lowBalanceThreshold || '0', wallet.balance || '0');
}

module.exports = { getOrCreate, credit, debit, canAfford, history, summary, setAutoRenew, isLowBalance, EARNING_REASONS };
