/**
 * Partner / Referral program service.
 *
 * Sits on top of the existing affiliate code (User.referredBy chain +
 * Commission ledger) and layers tier-based compensation on it:
 *
 *   active referrals       → tier (Bronze / Silver / Gold / Diamond)
 *   tier                   → L1 revenue-share %
 *   first qualifying deposit → instant bonus to referrer
 *   per-trade fee          → tier % credited to referrer
 *
 * Everything credits the referrer's existing SubscriptionWallet so we
 * don't introduce a parallel wallet system. Each money movement also
 * writes a Commission row so the affiliate / partner dashboards can
 * render the audit trail.
 *
 * Admin-tunable knobs live in SystemSetting (see systemSettings.service
 * DEFAULTS). All percentages are stored as plain decimals (e.g. "10"
 * meaning 10%, NOT 0.10). Bonus + deposit thresholds are signed
 * decimal strings — same convention the rest of the wallet uses.
 */

const { Commission } = require('../models/Compliance');
const User = require('../models/User');
const { Deposit, Notification } = require('../models');
const systemSettings = require('./systemSettings.service');
const subscriptionWalletService = require('./subscriptionWalletService');
const { D, gt, gte, mul, add } = require('../utils/decimal');

// ─── Settings ────────────────────────────────────────────────────────
const getSettings = async () => {
  const enabled = await systemSettings.getSetting('partner.enabled');
  const bonusAmount = await systemSettings.getSetting('partner.bonusAmount');
  const minDeposit = await systemSettings.getSetting('partner.minDeposit');
  let tiers = await systemSettings.getSetting('partner.tiers');
  if (!Array.isArray(tiers)) tiers = systemSettings.DEFAULTS['partner.tiers'];
  // Defensive normalisation — admin may submit tiers as strings.
  tiers = tiers
    .map((t) => ({
      name:      String(t.name || '').toUpperCase(),
      minActive: Number(t.minActive) || 0,
      maxActive: Number(t.maxActive) || 0,
      percent:   String(t.percent || '0'),
    }))
    .sort((a, b) => a.minActive - b.minActive);
  return {
    enabled: enabled !== false,
    bonusAmount: String(bonusAmount || '0'),
    minDeposit:  String(minDeposit  || '0'),
    tiers,
  };
};

// ─── Active referral count ───────────────────────────────────────────
//
// A referee counts as ACTIVE when they have at least one deposit row
// with a CONFIRMED / COMPLETED status AND a (base-currency) amount at
// or above the admin-configured minimum. We resolve `userId` in two
// passes: first the candidate referees, then a single aggregation to
// count which of them have a qualifying deposit. Cheaper than per-user
// queries for users with many referees.
const getActiveReferrals = async (userId, { minDeposit } = {}) => {
  const settings = minDeposit ? { minDeposit } : await getSettings();
  const minAmt = settings.minDeposit;
  const referees = await User.find({ referredBy: userId }).select('_id').lean();
  if (!referees.length) return [];
  const refIds = referees.map((r) => r._id);
  // Lookup the first qualifying deposit per referee.
  const groups = await Deposit.aggregate([
    {
      $match: {
        userId: { $in: refIds },
        status: { $in: ['CONFIRMED', 'COMPLETED'] },
      },
    },
    {
      $addFields: {
        amtNum: { $toDouble: { $ifNull: ['$baseAmount', '$amount'] } },
      },
    },
    { $match: { amtNum: { $gte: Number(minAmt) || 0 } } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: '$userId',
        firstAt: { $first: '$createdAt' },
        firstAmount: { $first: '$amtNum' },
        depositCount: { $sum: 1 },
      },
    },
  ]);
  const activeMap = new Map(groups.map((g) => [String(g._id), g]));
  return referees
    .filter((r) => activeMap.has(String(r._id)))
    .map((r) => ({
      userId: String(r._id),
      ...activeMap.get(String(r._id)),
    }));
};

const getActiveReferralCount = async (userId, opts = {}) => {
  const active = await getActiveReferrals(userId, opts);
  return active.length;
};

// ─── Tier resolution ────────────────────────────────────────────────
//
// Returns the tier matching the active-referral count. If the user has
// zero qualifying referrals they get the sentinel NONE tier (0%). If
// the user has a manual override on User.partnerLevel, we honour it.
const resolveTier = (tiers, activeCount) => {
  for (const t of tiers) {
    const within = activeCount >= t.minActive
      && (t.maxActive === 0 || activeCount <= t.maxActive);
    if (within) return t;
  }
  return { name: 'NONE', minActive: 0, maxActive: 0, percent: '0' };
};

const getPartnerLevel = async (userId, opts = {}) => {
  const settings = await getSettings();
  const user = await User.findById(userId).select('partnerLevel partnerLevelLocked partnerBlocked').lean();
  if (user?.partnerBlocked) {
    return { tier: { name: 'BLOCKED', percent: '0', minActive: 0, maxActive: 0 }, activeCount: 0, locked: false, blocked: true, settings };
  }
  const activeCount = opts.activeCount != null
    ? opts.activeCount
    : await getActiveReferralCount(userId, { minDeposit: settings.minDeposit });
  // Manual override: admin pinned a tier — honour it as long as it exists
  // in the current tiers config. Falls through to auto if the named tier
  // has been removed from settings.
  if (user?.partnerLevelLocked && user?.partnerLevel) {
    const pinned = settings.tiers.find((t) => t.name === user.partnerLevel);
    if (pinned) {
      return { tier: pinned, activeCount, locked: true, blocked: false, settings };
    }
  }
  const tier = resolveTier(settings.tiers, activeCount);
  return { tier, activeCount, locked: false, blocked: false, settings };
};

// ─── Next-level progress ─────────────────────────────────────────────
const getNextTier = (tiers, activeCount) => {
  for (const t of tiers) if (t.minActive > activeCount) return t;
  return null; // already at top tier
};

// ─── First qualifying deposit → instant bonus ───────────────────────
//
// Called from the deposit completion paths (admin confirm, Razorpay
// verify, Razorpay webhook). Idempotent: a Commission row is only
// created once per (referrer, referee) pair under sourceType
// 'DEPOSIT_BONUS'. If a row already exists we no-op.
//
// The referee's referrer is read from User.referredBy. No-op if:
//   - no referrer on the user
//   - the program is disabled
//   - the deposit is below `minDeposit`
//   - this referee already triggered a bonus (one-per-referee cap)
//   - the referrer is blocked
const handleFirstQualifyingDeposit = async ({ userId, deposit }) => {
  try {
    const settings = await getSettings();
    if (!settings.enabled) return null;
    if (!deposit) return null;

    const amt = D(deposit.baseAmount && Number(deposit.baseAmount) > 0
      ? deposit.baseAmount
      : deposit.amount || '0');
    if (!gte(amt.toString(), settings.minDeposit)) return null;

    const user = await User.findById(userId).select('referredBy').lean();
    if (!user || !user.referredBy) return null;

    const referrer = await User.findById(user.referredBy).select('_id isActive partnerBlocked').lean();
    if (!referrer || referrer.isActive === false || referrer.partnerBlocked) return null;

    // One-bonus-per-referee guard.
    const existing = await Commission.findOne({
      referrerId: referrer._id,
      refereeId: user.referredBy && userId,
      sourceType: 'DEPOSIT_BONUS',
    });
    if (existing) return existing;

    const bonus = D(settings.bonusAmount);
    if (bonus.lte(0)) return null;

    // 1. Record Commission row first so the audit trail exists even if
    //    the wallet credit fails.
    const commission = await Commission.create({
      referrerId: referrer._id,
      refereeId:  userId,
      level:      0,
      sourceType: 'DEPOSIT_BONUS',
      sourceId:   deposit._id,
      currency:   deposit.baseCurrency || 'USD',
      amount:     bonus.toString(),
      rate:       null,
      status:     'PENDING',
      note:       `Instant bonus for first qualifying deposit by referee`,
    });

    // 2. Credit the referrer's Subscription Wallet.
    try {
      await subscriptionWalletService.credit({
        userId:        referrer._id,
        amount:        bonus.toString(),
        reason:        'REFERRAL_BONUS',
        note:          'Partner program: first deposit bonus',
        paymentMethod: 'system',
        paymentRef:    `commission:${commission._id}`,
      });
      commission.status = 'PAID';
      commission.paidAt = new Date();
      await commission.save();
    } catch (e) {
      console.error('[partner] bonus wallet credit failed:', e.message);
      // Leave commission PENDING so an admin retry can sweep it.
      return commission;
    }

    // 3. Notification + WS push (best-effort).
    try {
      await Notification.create({
        userId: referrer._id,
        type: 'PARTNER_BONUS',
        title: 'Referral bonus credited',
        message: `You earned ${bonus.toString()} ${commission.currency} for a referee's first deposit.`,
        channels: ['IN_APP'],
        data: { commissionId: String(commission._id), amount: bonus.toString(), currency: commission.currency },
      });
    } catch (_) {}
    try {
      const broadcaster = require('../websocket/server');
      broadcaster.notifyUser(String(referrer._id), 'subscriptionWallet', { event: 'UPDATED' });
      broadcaster.notifyUser(String(referrer._id), 'notifications', { type: 'PARTNER_BONUS' });
    } catch (_) {}

    return commission;
  } catch (e) {
    // Never throw — we don't want a partner-bonus failure to break the
    // deposit confirmation flow that called us.
    console.error('[partner] handleFirstQualifyingDeposit error:', e.message);
    return null;
  }
};

// ─── Per-trade fee → tier % to referrer ─────────────────────────────
//
// Called from the matching engine (alongside affiliateService's L2/L3
// chain). Computes the L1 percentage from the referrer's current tier
// (not a fixed rate). Returns the created Commission row or null.
const distributeRevenueShare = async ({ tradeId, refereeId, feeAmount, currency }) => {
  try {
    if (!feeAmount || !gt(feeAmount, '0')) return null;
    const settings = await getSettings();
    if (!settings.enabled) return null;

    const referee = await User.findById(refereeId).select('referredBy').lean();
    if (!referee || !referee.referredBy) return null;

    const referrer = await User.findById(referee.referredBy).select('_id isActive partnerBlocked').lean();
    if (!referrer || referrer.isActive === false || referrer.partnerBlocked) return null;

    const lvl = await getPartnerLevel(referrer._id);
    const pct = D(lvl.tier?.percent || '0');
    if (pct.lte(0)) return null;
    // percent stored as plain decimal (10 → 10%), divide by 100 here.
    const amount = D(feeAmount).mul(pct).div(100);
    if (amount.lte(0)) return null;

    const commission = await Commission.create({
      referrerId: referrer._id,
      refereeId,
      level:      1,
      sourceType: 'TRADE_FEE',
      sourceId:   tradeId,
      currency:   currency || 'USD',
      amount:     amount.toString(),
      rate:       pct.toString(),
      status:     'PENDING',
      note:       `Tier ${lvl.tier.name} revenue share`,
    });

    // Pay immediately. (We could batch via cron, but immediate gives the
    // referrer a live-updating dashboard which matches the spec's
    // "Today's earnings / Real-time" feel.)
    try {
      await subscriptionWalletService.credit({
        userId:        referrer._id,
        amount:        amount.toString(),
        reason:        'REFERRAL_BONUS',
        note:          `Revenue share · tier ${lvl.tier.name} · ${pct.toString()}%`,
        paymentMethod: 'system',
        paymentRef:    `commission:${commission._id}`,
      });
      commission.status = 'PAID';
      commission.paidAt = new Date();
      await commission.save();
      try {
        const broadcaster = require('../websocket/server');
        broadcaster.notifyUser(String(referrer._id), 'subscriptionWallet', { event: 'UPDATED' });
      } catch (_) {}
    } catch (e) {
      console.error('[partner] revenue-share wallet credit failed:', e.message);
    }

    return commission;
  } catch (e) {
    console.error('[partner] distributeRevenueShare error:', e.message);
    return null;
  }
};

// ─── Dashboard data ──────────────────────────────────────────────────
const getDashboardData = async (userId) => {
  const settings = await getSettings();
  const active = await getActiveReferrals(userId, { minDeposit: settings.minDeposit });
  const lvl = await getPartnerLevel(userId, { activeCount: active.length });
  const nextTier = getNextTier(settings.tiers, active.length);

  // Aggregates over commissions where this user is the referrer.
  const now = new Date();
  const startOfToday  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth  = new Date(now.getFullYear(), now.getMonth(), 1);

  const rollup = await Commission.aggregate([
    { $match: { referrerId: require('mongoose').Types.ObjectId.createFromHexString(String(userId)) } },
    { $addFields: { amtNum: { $toDouble: '$amount' } } },
    {
      $group: {
        _id: null,
        lifetime:  { $sum: '$amtNum' },
        pending:   { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, '$amtNum', 0] } },
        paid:      { $sum: { $cond: [{ $eq: ['$status', 'PAID']    }, '$amtNum', 0] } },
        bonusSum:  { $sum: { $cond: [{ $eq: ['$sourceType', 'DEPOSIT_BONUS'] }, '$amtNum', 0] } },
        revShareSum: { $sum: { $cond: [{ $in: ['$sourceType', ['TRADE_FEE','SPREAD']] }, '$amtNum', 0] } },
        today:     { $sum: { $cond: [{ $gte: ['$createdAt', startOfToday] }, '$amtNum', 0] } },
        monthly:   { $sum: { $cond: [{ $gte: ['$createdAt', startOfMonth] }, '$amtNum', 0] } },
      },
    },
  ]);
  const tot = rollup[0] || { lifetime: 0, pending: 0, paid: 0, bonusSum: 0, revShareSum: 0, today: 0, monthly: 0 };

  const totalReferrals  = await User.countDocuments({ referredBy: userId });
  const user = await User.findById(userId).select('referralCode firstName lastName partnerLevel partnerLevelLocked partnerBlocked').lean();

  // Available balance = the user's current Subscription Wallet balance
  // (where all partner earnings land). Fetch it cheaply.
  let availableBalance = '0';
  let walletCurrency = 'USD';
  try {
    const wallet = await subscriptionWalletService.getOrCreate(userId);
    availableBalance = wallet?.balance || '0';
    walletCurrency = wallet?.currency || 'USD';
  } catch (_) {}

  return {
    user: {
      _id: String(userId),
      referralCode: user?.referralCode || null,
      name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || null,
    },
    settings: {
      enabled: settings.enabled,
      bonusAmount: settings.bonusAmount,
      minDeposit:  settings.minDeposit,
      tiers: settings.tiers,
    },
    level: {
      name:        lvl.tier.name,
      percent:     lvl.tier.percent,
      minActive:   lvl.tier.minActive,
      maxActive:   lvl.tier.maxActive,
      locked:      lvl.locked,
      blocked:     lvl.blocked,
      activeCount: active.length,
      nextTier:    nextTier
        ? {
            name: nextTier.name,
            percent: nextTier.percent,
            minActive: nextTier.minActive,
            remainingToUpgrade: Math.max(0, nextTier.minActive - active.length),
          }
        : null,
    },
    stats: {
      totalReferrals,
      activeReferrals: active.length,
      conversionRate:  totalReferrals > 0 ? (active.length / totalReferrals) : 0,
      lifetimeEarnings: round2(tot.lifetime),
      pendingCommission: round2(tot.pending),
      paidCommission:    round2(tot.paid),
      totalBonus:        round2(tot.bonusSum),
      totalRevenueShare: round2(tot.revShareSum),
      todayEarnings:     round2(tot.today),
      monthlyEarnings:   round2(tot.monthly),
      availableBalance:  String(availableBalance),
      walletCurrency,
    },
  };
};

function round2(n) { return Number(n || 0).toFixed(2); }

// ─── Referral / referee list ────────────────────────────────────────
const getReferrals = async (userId, { limit = 100 } = {}) => {
  const settings = await getSettings();
  const referees = await User.find({ referredBy: userId })
    .select('_id firstName lastName email createdAt isActive referralCode')
    .sort({ createdAt: -1 })
    .limit(Math.min(500, Math.max(1, Number(limit) || 100)))
    .lean();
  if (!referees.length) return [];
  const ids = referees.map((r) => r._id);

  // Pull first qualifying deposit per referee + total revenue share earned from them.
  const depGroups = await Deposit.aggregate([
    { $match: { userId: { $in: ids }, status: { $in: ['CONFIRMED', 'COMPLETED'] } } },
    { $addFields: { amtNum: { $toDouble: { $ifNull: ['$baseAmount', '$amount'] } } } },
    { $sort: { createdAt: 1 } },
    { $group: {
        _id: '$userId',
        firstAt:    { $first: '$createdAt' },
        firstAmount:{ $first: '$amtNum' },
        depositCount: { $sum: 1 },
        totalDeposited: { $sum: '$amtNum' },
    } },
  ]);
  const depByUser = new Map(depGroups.map((g) => [String(g._id), g]));

  const commGroups = await Commission.aggregate([
    { $match: { referrerId: require('mongoose').Types.ObjectId.createFromHexString(String(userId)), refereeId: { $in: ids } } },
    { $addFields: { amtNum: { $toDouble: '$amount' } } },
    { $group: {
        _id: '$refereeId',
        totalCommission: { $sum: '$amtNum' },
        bonusEarned:     { $sum: { $cond: [{ $eq: ['$sourceType', 'DEPOSIT_BONUS'] }, '$amtNum', 0] } },
        revShareEarned:  { $sum: { $cond: [{ $in: ['$sourceType', ['TRADE_FEE','SPREAD']] }, '$amtNum', 0] } },
    } },
  ]);
  const commByUser = new Map(commGroups.map((g) => [String(g._id), g]));

  const minDep = Number(settings.minDeposit || 0);
  return referees.map((r) => {
    const dep  = depByUser.get(String(r._id));
    const comm = commByUser.get(String(r._id));
    const isActive = !!(dep && dep.firstAmount >= minDep);
    return {
      _id:        String(r._id),
      name:       [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email,
      email:      r.email,
      referralCode: r.referralCode || null,
      registeredAt: r.createdAt,
      isActive,
      firstDepositAt:  dep?.firstAt || null,
      firstDepositAmount: dep ? round2(dep.firstAmount) : '0',
      totalDeposited:  dep ? round2(dep.totalDeposited) : '0',
      depositCount:    dep?.depositCount || 0,
      commissionEarned: comm ? round2(comm.totalCommission) : '0',
      bonusEarned:      comm ? round2(comm.bonusEarned)     : '0',
      revShareEarned:   comm ? round2(comm.revShareEarned)  : '0',
    };
  });
};

// ─── Commission / transaction history ───────────────────────────────
const getCommissionHistory = async (userId, { limit = 100, sourceType } = {}) => {
  const q = { referrerId: userId };
  if (sourceType) q.sourceType = sourceType;
  const rows = await Commission.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(500, Math.max(1, Number(limit) || 100)))
    .lean();
  if (!rows.length) return [];
  // Attach referee name for display.
  const refIds = [...new Set(rows.map((r) => String(r.refereeId)).filter(Boolean))];
  const users = refIds.length
    ? await User.find({ _id: { $in: refIds } }).select('_id firstName lastName email').lean()
    : [];
  const nameById = new Map(users.map((u) => [String(u._id),
    [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
  ]));
  return rows.map((r) => ({
    _id:        String(r._id),
    createdAt:  r.createdAt,
    paidAt:     r.paidAt || null,
    sourceType: r.sourceType,
    sourceId:   r.sourceId ? String(r.sourceId) : null,
    refereeId:  r.refereeId ? String(r.refereeId) : null,
    refereeName: r.refereeId ? (nameById.get(String(r.refereeId)) || '—') : null,
    currency:   r.currency,
    amount:     r.amount,
    rate:       r.rate,
    status:     r.status,
    level:      r.level,
    note:       r.note || null,
  }));
};

module.exports = {
  getSettings,
  getActiveReferrals,
  getActiveReferralCount,
  resolveTier,
  getPartnerLevel,
  getNextTier,
  handleFirstQualifyingDeposit,
  distributeRevenueShare,
  getDashboardData,
  getReferrals,
  getCommissionHistory,
};
