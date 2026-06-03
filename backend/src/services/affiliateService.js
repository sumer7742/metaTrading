const User = require('../models/User');
const { Commission } = require('../models/Compliance');
const { Wallet } = require('../models/Wallet');
const walletService = require('./walletService');
const subscriptionWalletService = require('./subscriptionWalletService');
const bonusWalletService = require('./bonusWalletService');
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

  // L1 is now handled by the Partner program — the rate depends on the
  // referrer's tier (Bronze/Silver/Gold/Diamond) instead of a fixed 20%.
  // partnerService computes the tier %, writes the Commission row, AND
  // credits the subscription wallet immediately so the partner dashboard
  // updates in real time. L2/L3 still go through the legacy path below.
  const created = [];
  try {
    const partnerService = require('./partnerService');
    const l1 = await partnerService.distributeRevenueShare({
      tradeId,
      refereeId: userId,
      feeAmount,
      currency,
    });
    if (l1) created.push(l1);
  } catch (e) {
    console.error('[Affiliate] L1 (partner) commission error:', e.message);
  }

  // Walk up the referral chain for L2 / L3 only — L1 already handled by
  // partnerService above. Start one level up so `level=2` matches L2.
  const firstUser = await User.findById(userId).select('referredBy').lean();
  if (!firstUser || !firstUser.referredBy) return created;
  let currentUserId = firstUser.referredBy;

  for (let level = 2; level <= 3; level++) {
    const user = await User.findById(currentUserId).select('referredBy affiliateRates').lean();
    if (!user || !user.referredBy) break;

    const referrer = await User.findById(user.referredBy).select('_id role isActive partnerBlocked affiliateRates').lean();
    if (!referrer || !referrer.isActive || referrer.partnerBlocked) {
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
 * Run the daily payout batch — sweep PENDING commissions to the referrer's
 * BONUS wallet. Cron-invoked (e.g. once a day at 00:05 UTC).
 *
 * Referral/partner earnings land in the dedicated Bonus Wallet (not the
 * trading wallet) — they can be transferred to a spendable wallet but can
 * never be withdrawn directly. One wallet per user, no trading-account
 * lookup needed. The `commission:<id>` paymentRef makes each payout
 * idempotent (safe re-runs).
 */
const runPayoutBatch = async () => {
  const pending = await Commission.find({ status: 'PENDING' }).limit(500);
  let paid = 0;

  for (const c of pending) {
    try {
      await bonusWalletService.credit({
        userId: c.referrerId,
        amount: c.amount,
        reason: 'REFERRAL_COMMISSION',
        note: `Affiliate commission L${c.level}`,
        paymentRef: `commission:${c._id}`,
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
 * pays it to the user's SUBSCRIPTION wallet — bonuses go there (not the
 * trading wallet) so they can be spent on plan purchases / renewals but
 * don't inflate trading margin / equity.
 *
 * @param {object} ctx
 * @param {ObjectId} ctx.userId    — the user RECEIVING the bonus
 * @param {string|number} ctx.amount
 * @param {string} ctx.currency    — defaults to the subscription wallet currency (USD)
 * @param {string} ctx.note        — visible in the user's commission row
 * @param {ObjectId} ctx.adminId   — who triggered it (req.userId from the admin route)
 * @returns {Promise<{commission, walletTx?}>}
 */
const creditManual = async ({ userId, amount, currency, note, adminId }) => {
  if (!userId) throw new Error('userId is required');
  if (!amount || !gt(amount, '0')) throw new Error('amount must be > 0');

  const User = require('../models/User');

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

  // Subscription wallet is single-currency (USD by default). The Commission
  // row keeps the requested currency for the audit trail, but the actual
  // credit lands in the subscription wallet's currency.
  const ccy = currency || 'USD';

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

  // 2. Credit the Bonus Wallet — this is the actual money movement.
  try {
    await bonusWalletService.credit({
      userId,
      amount:      String(amount),
      reason:      'BONUS_REWARD',
      note:        note || 'Referral bonus (admin)',
      paymentRef:  `commission:${commission._id}`,
      adminUserId: adminId || null,
    });
    commission.status = 'PAID';
    commission.paidAt = new Date();
    await commission.save();
  } catch (e) {
    // Leave the commission row in PENDING state so an admin retry / cron
    // can sweep it; surface the error to the caller so they see it failed.
    throw new Error(`Wallet credit failed: ${e.message}`);
  }

  return { commission, currency: ccy };
};

module.exports = { distributeCommissions, runPayoutBatch, getReferrerSummary, creditManual, DEFAULT_RATES };
