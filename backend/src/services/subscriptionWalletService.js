/**
 * Subscription Wallet service — all funds movement for plan purchases.
 * Strictly isolated from the trading wallet so an admin "deposit to
 * subscription" never touches deposit/bonus/trading balances and vice
 * versa.
 *
 * All arithmetic goes through utils/decimal so we don't get IEEE float
 * drift on USD amounts.
 */
const { SubscriptionWallet, SubscriptionTransaction } = require('../models/SubscriptionWallet');
const { add, sub, gte, gt, D } = require('../utils/decimal');
const { AppError } = require('../utils/errors');

const DEFAULT_CURRENCY = 'USD';

/**
 * Get or create the user's subscription wallet. Single wallet per user.
 * Currency defaults to USD; if you ever need multi-currency support, the
 * schema can stay one-doc-per-user with `balances: { USD: '0', INR: '0' }`
 * but for v1 we keep it simple.
 */
async function getOrCreate(userId) {
  let wallet = await SubscriptionWallet.findOne({ userId });
  if (!wallet) {
    wallet = await SubscriptionWallet.create({
      userId,
      walletType: 'subscription',
      balance: '0',
      currency: DEFAULT_CURRENCY,
    });
  }
  return wallet;
}

/**
 * Credit the wallet (user top-up, admin credit, or refund). Always
 * succeeds — returns the new balance.
 *
 * @param opts.userId
 * @param opts.amount         string-decimal, positive
 * @param opts.reason         'DEPOSIT' | 'ADMIN_CREDIT' | 'REFUND'
 * @param opts.note
 * @param opts.paymentMethod  optional
 * @param opts.paymentRef     optional
 * @param opts.adminUserId    optional — stamps the admin who acted
 */
async function credit(opts) {
  const { userId, amount, reason = 'DEPOSIT' } = opts;
  if (!gt(amount, '0')) throw new AppError('Amount must be positive', 400);

  const wallet = await getOrCreate(userId);
  wallet.balance = add(wallet.balance, amount);
  await wallet.save();

  const tx = await SubscriptionTransaction.create({
    userId,
    walletId: wallet._id,
    transactionType: reason === 'REFUND' ? 'REFUND' : 'CREDIT',
    reason,
    status: 'SUCCESS',
    amount: String(amount),
    currency: wallet.currency,
    balanceAfter: wallet.balance,
    note: opts.note,
    paymentMethod: opts.paymentMethod,
    paymentRef: opts.paymentRef,
    adminUserId: opts.adminUserId,
    planCode: opts.planCode,
    billingCycle: opts.billingCycle,
  });

  return { wallet, tx };
}

/**
 * Debit the wallet for a subscription charge. Throws INSUFFICIENT_FUNDS
 * (HTTP 402) if balance < amount — the controller decides what to do
 * (return a recharge prompt or fail the renewal).
 *
 * @param opts.userId
 * @param opts.amount
 * @param opts.reason          'SUBSCRIPTION_CHARGE' | 'RENEWAL' | 'ADMIN_DEBIT'
 * @param opts.planCode
 * @param opts.billingCycle
 * @param opts.note
 * @param opts.adminUserId     optional
 */
async function debit(opts) {
  const { userId, amount, reason = 'SUBSCRIPTION_CHARGE' } = opts;
  if (!gt(amount, '0')) throw new AppError('Amount must be positive', 400);

  const wallet = await getOrCreate(userId);
  if (!gte(wallet.balance, amount)) {
    throw new AppError(
      `Subscription wallet balance ${wallet.currency} ${wallet.balance} is below required ${wallet.currency} ${amount}. Please top up.`,
      402,
      'INSUFFICIENT_SUBSCRIPTION_BALANCE'
    );
  }

  wallet.balance = sub(wallet.balance, amount);
  await wallet.save();

  const tx = await SubscriptionTransaction.create({
    userId,
    walletId: wallet._id,
    transactionType: 'DEBIT',
    reason,
    status: 'SUCCESS',
    amount: String(amount),
    currency: wallet.currency,
    balanceAfter: wallet.balance,
    note: opts.note,
    planCode: opts.planCode,
    billingCycle: opts.billingCycle,
    paymentMethod: 'wallet',
    adminUserId: opts.adminUserId,
  });

  return { wallet, tx };
}

/**
 * Check affordability without moving funds. Useful for "Pay" button gates.
 */
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

/**
 * User-facing transaction history (most-recent-first).
 */
async function history(userId, { limit = 50, type, reason } = {}) {
  const q = { userId };
  if (type) q.transactionType = type;
  if (reason) q.reason = reason;
  return SubscriptionTransaction.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(500, Math.max(1, Number(limit) || 50)))
    .lean();
}

/**
 * Toggle auto-renew on the wallet. Renewal sweeps look at this flag
 * before debiting on plan expiry.
 */
async function setAutoRenew(userId, autoRenew) {
  const wallet = await getOrCreate(userId);
  wallet.autoRenew = !!autoRenew;
  await wallet.save();
  return wallet;
}

/**
 * Returns true when balance is at or below the lowBalanceThreshold —
 * the FE uses this to flash the low-balance warning.
 */
function isLowBalance(wallet) {
  if (!wallet) return false;
  return gte(wallet.lowBalanceThreshold || '0', wallet.balance || '0');
}

module.exports = {
  getOrCreate,
  credit,
  debit,
  canAfford,
  history,
  setAutoRenew,
  isLowBalance,
};
