const User = require('../models/User');
const { Commission } = require('../models/Compliance');
const { Wallet } = require('../models/Wallet');
const walletService = require('./walletService');
const { D, mul, gt } = require('../utils/decimal');
const { WALLET_TX_TYPE } = require('../config/constants');

/**
 * Affiliate Commission Service (per doc §7.15).
 *
 * Pays commissions to up to 3 levels of referrers:
 *   L1 (direct referrer):  20% of spread/fee
 *   L2 (referrer's referrer): 5%
 *   L3:                       1%
 *
 * Default rates can be overridden per-affiliate via User.affiliateRates.
 * Commissions are credited PENDING and paid out on a schedule (daily/monthly batch).
 *
 * Called from the matching engine after each trade.
 */

const DEFAULT_RATES = { 1: '0.20', 2: '0.05', 3: '0.01' };

/**
 * Compute and create commission records for a trade.
 * @param {object} ctx
 * @param {ObjectId} ctx.tradeId
 * @param {ObjectId} ctx.userId - the trader who paid the fee/spread
 * @param {string|number} ctx.feeAmount - total spread + commission paid by the trader
 * @param {string} ctx.currency
 */
const distributeCommissions = async ({ tradeId, userId, feeAmount, currency }) => {
  if (!feeAmount || !gt(feeAmount, '0')) return [];

  // Walk up the referral chain
  let currentUserId = userId;
  const created = [];

  for (let level = 1; level <= 3; level++) {
    const user = await User.findById(currentUserId).select('referredBy affiliateRates').lean();
    if (!user || !user.referredBy) break;

    const referrer = await User.findById(user.referredBy).select('_id role isActive affiliateRates').lean();
    if (!referrer || !referrer.isActive) {
      currentUserId = user.referredBy;
      continue;
    }

    const rate = referrer.affiliateRates?.[level] || DEFAULT_RATES[level];
    const amount = mul(feeAmount, rate);

    if (gt(amount, '0')) {
      const commission = await Commission.create({
        referrerId: referrer._id,
        refereeId: userId,
        level,
        sourceType: 'SPREAD',
        sourceId: tradeId,
        currency,
        amount,
        rate,
        status: 'PENDING',
      });
      created.push(commission);
    }

    currentUserId = referrer._id;
  }

  return created;
};

/**
 * Run the daily payout batch — sweep PENDING commissions to the referrer's primary wallet.
 * Should be invoked from a cron job (e.g. once a day at 00:05 UTC).
 */
const runPayoutBatch = async () => {
  const pending = await Commission.find({ status: 'PENDING' }).limit(500);
  let paid = 0;

  for (const c of pending) {
    // Find the referrer's primary (REAL) account wallet to credit
    const TradingAccount = require('../models/TradingAccount');
    const acct = await TradingAccount.findOne({ userId: c.referrerId, accountType: 'REAL', isActive: true });
    if (!acct) continue;

    try {
      await walletService.credit({
        userId: c.referrerId,
        accountId: acct._id,
        currency: c.currency,
        amount: c.amount,
        type: WALLET_TX_TYPE.ADJUSTMENT,
        referenceType: 'commission',
        referenceId: c._id,
        note: `Affiliate commission L${c.level}`,
      });
      c.status = 'PAID';
      c.paidAt = new Date();
      await c.save();
      paid++;
    } catch (e) {
      console.error('[Affiliate] Payout failed for commission', c._id.toString(), e.message);
    }
  }
  console.log(`[Affiliate] Payout batch: ${paid}/${pending.length} commissions paid`);
  return paid;
};

/**
 * Get a referrer's earnings summary.
 */
const getReferrerSummary = async (referrerId) => {
  const all = await Commission.find({ referrerId }).lean();
  const pending = all.filter((c) => c.status === 'PENDING').reduce((s, c) => s + Number(c.amount), 0);
  const paid = all.filter((c) => c.status === 'PAID').reduce((s, c) => s + Number(c.amount), 0);
  const byLevel = { 1: 0, 2: 0, 3: 0 };
  for (const c of all) byLevel[c.level] = (byLevel[c.level] || 0) + Number(c.amount);
  const referees = await User.countDocuments({ referredBy: referrerId });
  return { pending, paid, total: pending + paid, byLevel, refereeCount: referees };
};

/**
 * Manually credit a referral bonus to a user (admin action).
 * Creates a Commission row with sourceType='ADJUSTMENT' AND immediately
 * pays it to the user's REAL trading wallet, so the user sees the credit
 * both on the Affiliate page (commission history) and in their wallet
 * (real balance / transaction ledger).
 *
 * @param {object} ctx
 * @param {ObjectId} ctx.userId    — the user RECEIVING the bonus
 * @param {string|number} ctx.amount
 * @param {string} ctx.currency    — defaults to the user's primary account currency
 * @param {string} ctx.note        — visible in the user's commission row
 * @param {ObjectId} ctx.adminId   — who triggered it (req.userId from the admin route)
 * @returns {Promise<{commission, walletTx?}>}
 */
const creditManual = async ({ userId, amount, currency, note, adminId }) => {
  if (!userId) throw new Error('userId is required');
  if (!amount || !gt(amount, '0')) throw new Error('amount must be > 0');

  const User = require('../models/User');
  const TradingAccount = require('../models/TradingAccount');

  const user = await User.findById(userId).select('_id isActive');
  if (!user) throw new Error('User not found');
  if (user.isActive === false) throw new Error('User is blocked');

  // Affiliate bonus is for REFERRERS only AND it's gated to ONE bonus
  // per referee. After admin credits a bonus, the slot is "consumed"
  // until a new referee arrives. This prevents the admin from
  // accidentally double-paying a referrer and turns each new signup
  // into a discrete reward event.
  const refereeCount = await User.countDocuments({ referredBy: userId });
  if (refereeCount === 0) {
    throw new Error('User has not referred anyone yet — affiliate bonus is only for referrers');
  }
  const adjustmentCount = await Commission.countDocuments({
    referrerId: userId,
    sourceType: 'ADJUSTMENT',
    status: { $in: ['PENDING', 'PAID'] }, // reversed bonuses free up a slot again
  });
  if (adjustmentCount >= refereeCount) {
    throw new Error(
      `All available bonuses are already credited (${adjustmentCount}/${refereeCount}). ` +
      `Wait for a new referee to sign up.`
    );
  }

  // Pick the user's primary REAL account so the credit lands somewhere
  // real-money; if they have none, fall back to whatever active account
  // exists. We never silently credit to demo (would be misleading).
  let account = await TradingAccount.findOne({ userId, accountType: 'REAL', isActive: true });
  if (!account) account = await TradingAccount.findOne({ userId, isActive: true });
  if (!account) throw new Error('User has no active trading account to credit');

  const ccy = currency || account.baseCurrency || 'USD';

  // 1. Record the commission row first so the affiliate page can show it
  //    even if the wallet credit fails (status will be PENDING in that case).
  const commission = await Commission.create({
    referrerId: userId,        // the user RECEIVING the bonus
    refereeId:  null,          // n/a for admin-credited adjustments
    level:      0,             // 0 = manual / admin adjustment
    sourceType: 'ADJUSTMENT',
    currency:   ccy,
    amount:     String(amount),
    rate:       null,
    status:     'PENDING',
    adjustedBy: adminId || null,
    note:       note || 'Admin-credited referral bonus',
  });

  // 2. Credit the wallet immediately — this is the actual money movement.
  try {
    await walletService.credit({
      userId,
      accountId:     account._id,
      currency:      ccy,
      amount:        String(amount),
      type:          WALLET_TX_TYPE.ADJUSTMENT,
      referenceType: 'commission',
      referenceId:   commission._id,
      note:          note || 'Referral bonus (admin)',
    });
    commission.status = 'PAID';
    commission.paidAt = new Date();
    await commission.save();
  } catch (e) {
    // Leave the commission row in PENDING state so an admin retry / cron
    // can sweep it; surface the error to the caller so they see it failed.
    throw new Error(`Wallet credit failed: ${e.message}`);
  }

  return { commission, accountId: account._id, currency: ccy };
};

module.exports = { distributeCommissions, runPayoutBatch, getReferrerSummary, creditManual, DEFAULT_RATES };
