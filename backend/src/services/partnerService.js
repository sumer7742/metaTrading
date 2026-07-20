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

const mongoose = require('mongoose');
const { Commission } = require('../models/Compliance');
const User = require('../models/User');
const Trade = require('../models/Trade');
const { Deposit, Notification } = require('../models');
const systemSettings = require('./systemSettings.service');
const subscriptionWalletService = require('./subscriptionWalletService');
const bonusWalletService = require('./bonusWalletService');
const { D, gt, gte, mul, add } = require('../utils/decimal');

// ─── Settings ────────────────────────────────────────────────────────
const getSettings = async () => {
  const enabled = await systemSettings.getSetting('partner.enabled');
  const bonusAmount = await systemSettings.getSetting('partner.bonusAmount');
  const minDeposit = await systemSettings.getSetting('partner.minDeposit');
  const bonusCurrency = await systemSettings.getSetting('partner.bonusCurrency');
  return {
    enabled: enabled !== false,
    bonusAmount: String(bonusAmount || '0'),
    minDeposit:  String(minDeposit  || '0'),
    bonusCurrency: String(bonusCurrency || 'USD').toUpperCase(),
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

// ─── Monthly volume-based tier engine ────────────────────────────────
//
// Partner tier + commission % are determined SOLELY by the PREVIOUS
// calendar month's referral trading volume. On the 1st of each month the
// tier is recomputed and then stays fixed for the whole current month.
//
// Persistence: the computed tier is snapshotted onto the User
// (partnerTier/partnerTierPercent/partnerTierMonth/partnerPrevMonthVolume).
// A monthly cron (backgroundWorker) refreshes every partner, and reads
// lazily self-heal — if the stored snapshot is for an older month it is
// recomputed on demand, so the engine is correct even if the cron missed.

const monthKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

// Calendar-month boundaries around `now`. prev = last month, cur = this
// month start, next = next month start. Half-open ranges [start, end).
const monthBounds = (now = new Date()) => ({
  prevStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
  curStart:  new Date(now.getFullYear(), now.getMonth(),     1),
  nextStart: new Date(now.getFullYear(), now.getMonth() + 1, 1),
});

// Total executed trading volume (USD notional = price × quantity) for a set
// of referees within [start, end). Each referee's participation as buyer OR
// seller counts toward their volume, so we sum both legs they're on.
const referralVolumeBetween = async (refIds, start, end) => {
  if (!refIds || !refIds.length) return 0;
  try {
    // One-side (opening) volume that CLOSED (earned commission) in the window.
    // Each close-trade can have up to 3 Commission rows (L1/L2/L3) carrying the
    // SAME `volume`, so we dedupe by sourceId (the closing trade) to count it
    // once, then sum.
    const rows = await Commission.aggregate([
      { $match: {
          refereeId: { $in: refIds },
          sourceType: { $in: ['TRADE_FEE', 'SPREAD'] },
          createdAt: { $gte: start, $lt: end },
          sourceId: { $ne: null },
      } },
      { $addFields: { volNum: { $toDouble: { $ifNull: ['$volume', '0'] } } } },
      { $group: { _id: { referee: '$refereeId', src: '$sourceId' }, vol: { $first: '$volNum' } } },
      { $group: { _id: null, vol: { $sum: '$vol' } } },
    ]);
    return rows[0]?.vol || 0;
  } catch (e) {
    console.error('[partner] referralVolumeBetween failed:', e.message);
    return 0;
  }
};

// Recompute the tier from the PREVIOUS month's volume and persist the
// snapshot. Returns the resolved tier descriptor.
const recomputeTier = async (userId, { tiers, now = new Date() } = {}) => {
  tiers = tiers || await getVolumeTiers();
  const { prevStart, curStart } = monthBounds(now);
  const refIds = await User.find({ referredBy: userId }).distinct('_id');
  const prevVol = await referralVolumeBetween(refIds, prevStart, curStart);
  const tier = resolveVolumeTier(prevVol, tiers);
  const month = monthKeyOf(now);
  await User.updateOne({ _id: userId }, { $set: {
    partnerTier:            tier.name,
    partnerTierPercent:     Number(tier.percent) || 0,
    partnerTierMonth:       month,
    partnerPrevMonthVolume: Math.round(prevVol),
  } });
  return { name: tier.name, percent: Number(tier.percent) || 0, locked: false, blocked: false, prevMonthVolume: prevVol, month, tiers };
};

// The partner's EFFECTIVE tier for the current month. Honours manual lock
// + block first, otherwise uses the fresh monthly snapshot (recomputing if
// the snapshot is stale or `force` is set).
const getEffectiveTier = async (userId, opts = {}) => {
  const tiers = await getVolumeTiers();
  const user = opts.user || await User.findById(userId)
    .select('partnerBlocked partnerLevelLocked partnerLevel partnerTier partnerTierPercent partnerTierMonth partnerPrevMonthVolume')
    .lean();
  if (!user) {
    const base = tiers[0] || { name: 'BRONZE', percent: 0 };
    return { name: base.name, percent: Number(base.percent) || 0, locked: false, blocked: false, prevMonthVolume: 0, tiers };
  }
  if (user.partnerBlocked) {
    return { name: 'BLOCKED', percent: 0, locked: false, blocked: true, prevMonthVolume: Number(user.partnerPrevMonthVolume) || 0, tiers };
  }
  // Manual override: admin pinned a tier — honour it as long as it still
  // exists in the configured volume tiers.
  if (user.partnerLevelLocked && user.partnerLevel) {
    const pinned = tiers.find((t) => t.name === String(user.partnerLevel).toUpperCase());
    if (pinned) {
      return { name: pinned.name, percent: Number(pinned.percent) || 0, locked: true, blocked: false, prevMonthVolume: Number(user.partnerPrevMonthVolume) || 0, tiers };
    }
  }
  // Fresh snapshot for the current month → use it. Otherwise recompute.
  const curMonth = monthKeyOf(new Date());
  if (!opts.force && user.partnerTierMonth === curMonth && user.partnerTier) {
    const pct = tiers.find((t) => t.name === user.partnerTier);
    return {
      name: user.partnerTier,
      percent: pct ? (Number(pct.percent) || 0) : (Number(user.partnerTierPercent) || 0),
      locked: false, blocked: false,
      prevMonthVolume: Number(user.partnerPrevMonthVolume) || 0,
      month: curMonth, tiers,
    };
  }
  return recomputeTier(userId, { tiers });
};

// Recalculate ALL partners' tiers (monthly cron entry point). Returns the
// number of partners processed. Honours lock/block via getEffectiveTier.
const recalcAllPartnerTiers = async () => {
  const partnerIds = await User.distinct('referredBy', { referredBy: { $ne: null } });
  let n = 0;
  for (const id of partnerIds) {
    try { await getEffectiveTier(id, { force: true }); n++; }
    catch (e) { console.error('[partner] tier recalc failed for', String(id), e.message); }
  }
  return n;
};

// Next tier above the partner's previous-month volume (or null at top).
const getNextVolumeTierFor = (tiers, prevMonthVolume) => nextVolumeTier(prevMonthVolume, tiers);

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

    // One-bonus-per-referee guard (fast path). The unique partial index on
    // (refereeId, sourceType=DEPOSIT_BONUS) is the authoritative, DB-level
    // guarantee — this findOne just avoids a wasted insert in the common case.
    const existing = await Commission.findOne({
      refereeId: userId,
      sourceType: 'DEPOSIT_BONUS',
    });
    if (existing) return existing;

    const bonus = D(settings.bonusAmount);
    if (bonus.lte(0)) return null;
    const bonusCurrency = settings.bonusCurrency || deposit.baseCurrency || 'USD';

    // 1. Record the Commission row FIRST so the audit trail exists even if
    //    the wallet credit fails — and so the unique index is the lock that
    //    prevents a duplicate payout under concurrent deposit confirmations.
    //    A racing second insert hits E11000; we treat it as "already paid"
    //    and never credit twice.
    let commission;
    try {
      commission = await Commission.create({
        referrerId: referrer._id,
        refereeId:  userId,
        level:      0,
        sourceType: 'DEPOSIT_BONUS',
        sourceId:   deposit._id,
        currency:   bonusCurrency,
        amount:     bonus.toString(),
        rate:       null,
        status:     'PENDING',
        note:       `First-deposit referral bonus`,
      });
    } catch (e) {
      if (e && e.code === 11000) {
        return Commission.findOne({ refereeId: userId, sourceType: 'DEPOSIT_BONUS' });
      }
      throw e;
    }

    // 2. Credit the referrer's Bonus Wallet.
    try {
      await bonusWalletService.credit({
        userId:     referrer._id,
        amount:     bonus.toString(),
        reason:     'PARTNER_COMMISSION',
        note:       `Partner program: first-deposit referral bonus (${bonusCurrency})`,
        paymentRef: `commission:${commission._id}`,
      });
      commission.status = 'PAID';
      commission.paidAt = new Date();
      await commission.save();

      // Full audit trail for the payout (in addition to the Commission row).
      try {
        const { AuditLog } = require('../models');
        await AuditLog.create({
          actorId:    referrer._id,       // beneficiary; SYSTEM-initiated credit
          actorRole:  'SYSTEM',
          action:     'PARTNER_FIRST_DEPOSIT_BONUS',
          targetType: 'COMMISSION',
          targetId:   String(commission._id),
          metadata: {
            referrerId: String(referrer._id),
            refereeId:  String(userId),
            depositId:  String(deposit._id),
            amount:     bonus.toString(),
            currency:   bonusCurrency,
            minDeposit: settings.minDeposit,
          },
        });
      } catch (e) { console.error('[partner] first-deposit bonus audit log failed:', e.message); }
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
      broadcaster.notifyUser(String(referrer._id), 'bonusWallet', { event: 'UPDATED' });
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
const distributeRevenueShare = async ({ tradeId, refereeId, feeAmount, currency, positionId = null, volume = '0' }) => {
  try {
    if (!feeAmount || !gt(feeAmount, '0')) return null;
    const settings = await getSettings();
    if (!settings.enabled) return null;

    const referee = await User.findById(refereeId).select('referredBy').lean();
    if (!referee || !referee.referredBy) return null;

    const referrer = await User.findById(referee.referredBy).select('_id isActive partnerBlocked').lean();
    if (!referrer || referrer.isActive === false || referrer.partnerBlocked) return null;

    // Tier + % come from the partner's MONTHLY tier (driven by previous-
    // month referral volume), fixed for the current calendar month.
    const lvl = await getEffectiveTier(referrer._id);
    const pct = D(lvl.percent || '0');
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
      positionId,
      volume,
      currency:   currency || 'USD',
      amount:     amount.toString(),
      rate:       pct.toString(),
      status:     'PENDING',
      note:       `Tier ${lvl.name} revenue share`,
    });

    // Pay immediately. (We could batch via cron, but immediate gives the
    // referrer a live-updating dashboard which matches the spec's
    // "Today's earnings / Real-time" feel.)
    try {
      await bonusWalletService.credit({
        userId:     referrer._id,
        amount:     amount.toString(),
        reason:     'REVENUE_SHARE',
        note:       `Revenue share · tier ${lvl.name} · ${pct.toString()}%`,
        paymentRef: `commission:${commission._id}`,
      });
      commission.status = 'PAID';
      commission.paidAt = new Date();
      await commission.save();
      try {
        const broadcaster = require('../websocket/server');
        broadcaster.notifyUser(String(referrer._id), 'bonusWallet', { event: 'UPDATED' });
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
  const lvl = await getEffectiveTier(userId);

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

  // Available balance = the user's current Bonus Wallet balance
  // (where all referral/partner earnings now land). Fetch it cheaply.
  let availableBalance = '0';
  let walletCurrency = 'USD';
  try {
    const wallet = await bonusWalletService.getOrCreate(userId);
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
      bonusCurrency: settings.bonusCurrency,
    },
    level: {
      name:        lvl.name,
      percent:     lvl.percent,
      locked:      lvl.locked,
      blocked:     lvl.blocked,
      prevMonthVolume: Math.round(lvl.prevMonthVolume || 0),
      activeCount: active.length,
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

// ─── Volume-based partner tiers ──────────────────────────────────────
//
// A SEPARATE, read-only progression model layered on top of the existing
// count-based commission engine: partner level + revenue-share % are driven
// by the TOTAL TRADING VOLUME generated by a user's referrals (not the
// referral count). This powers the redesigned partner dashboard without
// touching the live payout logic in distributeRevenueShare() — money still
// moves exactly as before; this only changes how progression is *presented*.
//
// Thresholds are fixed per product spec (USD notional). Kept here as the
// single source of truth so the API and UI never drift.
const VOLUME_TIERS = [
  { name: 'BRONZE',   minVolume: 0,          percent: 10 },
  { name: 'SILVER',   minVolume: 100000,     percent: 15 },
  { name: 'GOLD',     minVolume: 500000,     percent: 20 },
  { name: 'PLATINUM', minVolume: 2000000,    percent: 25 },
  { name: 'ELITE',    minVolume: 10000000,   percent: 30 },
];

const resolveVolumeTier = (totalVolume, tiers = VOLUME_TIERS) => {
  let current = tiers[0] || VOLUME_TIERS[0];
  for (const t of tiers) if (totalVolume >= t.minVolume) current = t;
  return current;
};
const nextVolumeTier = (totalVolume, tiers = VOLUME_TIERS) => {
  for (const t of tiers) if (t.minVolume > totalVolume) return t;
  return null; // already at the top tier
};

// Admin-configurable volume tiers (falls back to the built-in defaults).
// Normalised to numeric minVolume/percent and sorted ascending so the
// resolver and the dashboard never have to trust raw stored shapes.
const getVolumeTiers = async () => {
  let tiers = await systemSettings.getSetting('partner.volumeTiers');
  if (!Array.isArray(tiers) || !tiers.length) {
    tiers = systemSettings.DEFAULTS['partner.volumeTiers'] || VOLUME_TIERS;
  }
  return tiers
    .map((t) => ({
      name: String(t.name || '').toUpperCase(),
      minVolume: Number(t.minVolume) || 0,
      percent: Number(t.percent) || 0,
    }))
    .sort((a, b) => a.minVolume - b.minVolume);
};

const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Aggregate one side (buy or sell) of the Trade collection for a set of
// referees: notional volume (price × quantity) per user + per calendar
// month, all in one pass via $facet.
async function volumeForSide(field, refIds, startOfMonth, sinceMonth) {
  return Trade.aggregate([
    { $match: { [field]: { $in: refIds } } },
    { $addFields: { vol: { $multiply: [{ $toDouble: '$price' }, { $toDouble: '$quantity' }] } } },
    {
      $facet: {
        byUser: [
          {
            $group: {
              _id: `$${field}`,
              volume:  { $sum: '$vol' },
              monthly: { $sum: { $cond: [{ $gte: ['$executedAt', startOfMonth] }, '$vol', 0] } },
              trades:  { $sum: 1 },
              lastAt:  { $max: '$executedAt' },
            },
          },
        ],
        byMonth: [
          { $match: { executedAt: { $gte: sinceMonth } } },
          {
            $group: {
              _id: { y: { $year: '$executedAt' }, m: { $month: '$executedAt' } },
              volume: { $sum: '$vol' },
            },
          },
        ],
      },
    },
  ]);
}

// ─── Volume-based dashboard payload ──────────────────────────────────
//
// Returns the full data structure the redesigned partner dashboard needs.
// Reuses getDashboardData() for the (unchanged) commission/earnings numbers
// and referral code, then layers real referral trading-volume aggregates and
// volume-tier progression on top. Defensive throughout: if the trade
// aggregation fails or there are no referees, volume fields fall back to 0 so
// the endpoint never breaks the page.
const getVolumeDashboard = async (userId) => {
  const base = await getDashboardData(userId);

  const referees = await User.find({ referredBy: userId })
    .select('_id firstName lastName email createdAt')
    .lean();
  const refIds = referees.map((r) => r._id);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const sinceMonth   = new Date(now.getFullYear(), now.getMonth() - 5, 1); // 6-month window

  // ── One-side volume model (IB commission-on-close) ──────────────────
  // Volume is counted ONCE per position (the opening side). A position's
  // one-side volume splits into:
  //   • Commissioned  — the closed portion (has earned commission), from the
  //     Commission ledger's `volume` field (entryPrice × closedQty).
  //   • Pending       — the still-open portion (entryPrice × open qty), from
  //     the live Position collection; not yet commissioned.
  let totalVolume = 0;          // total one-side volume = pending + commissioned
  let pendingVolumeTot = 0;
  let commissionedVolumeTot = 0;
  let monthlyVolume = 0;        // commissioned volume this calendar month
  const volByUser  = new Map(); // userId -> { volume, pending, commissioned, lastAt }
  const volByMonth = new Map(); // 'YYYY-MM' -> commissioned volume
  const commByUser = new Map(); // userId -> total commission amount
  const commByMonth = new Map();

  if (refIds.length) {
    // Commissioned (closed) one-side volume + commission earned, per referee.
    // For THIS partner each (referee, close-trade) produces exactly one row
    // (their own level), so summing `volume` never double-counts.
    try {
      const rows = await Commission.aggregate([
        { $match: { referrerId: oid(userId), refereeId: { $in: refIds }, sourceType: { $in: ['TRADE_FEE', 'SPREAD'] } } },
        { $addFields: { volNum: { $toDouble: { $ifNull: ['$volume', '0'] } }, amtNum: { $toDouble: '$amount' } } },
        { $facet: {
          byUser:  [{ $group: { _id: '$refereeId', vol: { $sum: '$volNum' }, comm: { $sum: '$amtNum' }, lastAt: { $max: '$createdAt' } } }],
          byMonth: [
            { $match: { createdAt: { $gte: sinceMonth } } },
            { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, vol: { $sum: '$volNum' } } },
          ],
          monthVol: [
            { $match: { createdAt: { $gte: startOfMonth } } },
            { $group: { _id: null, vol: { $sum: '$volNum' } } },
          ],
        } },
      ]);
      const f = rows[0] || {};
      for (const g of f.byUser || []) {
        const k = String(g._id);
        const prev = volByUser.get(k) || { volume: 0, pending: 0, commissioned: 0, lastAt: null };
        prev.commissioned = g.vol || 0;
        prev.volume += g.vol || 0;
        prev.lastAt = g.lastAt || prev.lastAt;
        volByUser.set(k, prev);
        commByUser.set(k, g.comm || 0);
        commissionedVolumeTot += g.vol || 0;
      }
      for (const r of f.byMonth || []) volByMonth.set(`${r._id.y}-${String(r._id.m).padStart(2, '0')}`, r.vol || 0);
      monthlyVolume = f.monthVol?.[0]?.vol || 0;
    } catch (e) { console.error('[partner] commissioned-volume agg failed:', e.message); }

    // Pending (still-open) one-side volume per referee = entryPrice × open qty.
    // DEMO / VIRTUAL accounts are excluded — fake-money trades never count.
    try {
      const Position = require('../models/Position');
      const TradingAccount = require('../models/TradingAccount');
      const demoAccts = await TradingAccount.find({ userId: { $in: refIds }, accountType: { $in: ['DEMO', 'VIRTUAL'] } }).select('_id').lean();
      const demoIds = demoAccts.map((a) => a._id);
      const pend = await Position.aggregate([
        { $match: { userId: { $in: refIds }, status: 'OPEN', ...(demoIds.length ? { accountId: { $nin: demoIds } } : {}) } },
        { $addFields: { vol: { $multiply: [{ $toDouble: '$entryPrice' }, { $toDouble: '$quantity' }] } } },
        { $group: { _id: '$userId', vol: { $sum: '$vol' }, lastAt: { $max: '$openedAt' } } },
      ]);
      for (const g of pend) {
        const k = String(g._id);
        const prev = volByUser.get(k) || { volume: 0, pending: 0, commissioned: 0, lastAt: null };
        prev.pending = g.vol || 0;
        prev.volume += g.vol || 0;
        if (g.lastAt && (!prev.lastAt || g.lastAt > prev.lastAt)) prev.lastAt = g.lastAt;
        volByUser.set(k, prev);
        pendingVolumeTot += g.vol || 0;
      }
    } catch (e) { console.error('[partner] pending-volume agg failed:', e.message); }

    totalVolume = pendingVolumeTot + commissionedVolumeTot;
  }

  try {
    const cm = await Commission.aggregate([
      { $match: { referrerId: oid(userId), createdAt: { $gte: sinceMonth } } },
      { $addFields: { amtNum: { $toDouble: '$amount' } } },
      { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, total: { $sum: '$amtNum' } } },
    ]);
    for (const r of cm) commByMonth.set(`${r._id.y}-${String(r._id.m).padStart(2, '0')}`, r.total);
  } catch (e) { console.error('[partner] commission month agg failed:', e.message); }

  // 6-month series for the growth / earnings charts (gaps filled with 0).
  const monthlySeries = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlySeries.push({
      key,
      label: MONTH_LABELS[d.getMonth()],
      volume: Math.round(volByMonth.get(key) || 0),
      commission: Number(round2(commByMonth.get(key) || 0)),
    });
  }

  // Per-referral performance, ranked by trading volume (no count ranking).
  const referralPerformance = referees
    .map((r) => {
      const v = volByUser.get(String(r._id)) || { volume: 0, pending: 0, commissioned: 0, lastAt: null };
      return {
        id: String(r._id),
        name: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email,
        email: r.email,
        volume: Math.round(v.volume),               // one-side = pending + commissioned
        pendingVolume: Math.round(v.pending || 0),
        commissionedVolume: Math.round(v.commissioned || 0),
        commission: Number(round2(commByUser.get(String(r._id)) || 0)),
        lastActivityAt: v.lastAt || null,
        joinedAt: r.createdAt,
        status: v.volume > 0 ? 'ACTIVE' : 'INACTIVE',
      };
    })
    .sort((a, b) => b.volume - a.volume);

  const activeTraders = referralPerformance.filter((r) => r.volume > 0).length;

  // ── Tier is driven by the PREVIOUS calendar month's referral volume ──
  // (computed + snapshotted by getEffectiveTier, surfaced via base.level).
  // The CURRENT month's volume is tracked separately and only counts toward
  // NEXT month's tier. Progression below is measured against prev-month vol.
  const volumeTiers = await getVolumeTiers();
  const prevMonthVolume = Math.round(base.level.prevMonthVolume || 0);
  const currentMonthVolume = Math.round(monthlyVolume);
  const current = volumeTiers.find((t) => t.name === base.level.name)
    || { name: base.level.name, percent: base.level.percent, minVolume: 0 };
  const next = nextVolumeTier(prevMonthVolume, volumeTiers);
  const bandStart = current.minVolume || 0;
  const bandEnd = next ? next.minVolume : (current.minVolume || 0);
  const progressPercent = next
    ? Math.min(100, Math.max(0, ((prevMonthVolume - bandStart) / (bandEnd - bandStart)) * 100))
    : 100;

  return {
    enabled: base.settings.enabled,
    // ── First-deposit referral bonus (campaign config for the dashboard card) ──
    firstDepositBonus: {
      enabled: base.settings.enabled,
      amount: base.settings.bonusAmount,
      minDeposit: base.settings.minDeposit,
      currency: base.settings.bonusCurrency || 'USD',
    },
    // ── Level + progression (PREVIOUS-MONTH volume-driven, fixed for month) ──
    partnerLevel: base.level.name,
    revenueSharePercent: base.level.percent,
    tierLocked: !!base.level.locked,
    tierBlocked: !!base.level.blocked,
    previousMonthVolume: prevMonthVolume,   // determines the current month's tier
    currentMonthVolume,                     // tracking only → next month's tier
    totalReferralVolume: Math.round(totalVolume),
    // ── One-side volume breakdown (IB commission-on-close model) ──
    totalOneSideVolume: Math.round(totalVolume),          // pending + commissioned
    pendingVolume: Math.round(pendingVolumeTot),          // still-open positions
    commissionedVolume: Math.round(commissionedVolumeTot),// closed → commission earned
    monthlyVolume: currentMonthVolume,      // alias kept for backward-compat
    nextLevel: next ? { name: next.name, percent: next.percent, minVolume: next.minVolume } : null,
    nextLevelVolume: next ? next.minVolume : null,
    volumeToNextLevel: next ? Math.max(0, Math.round(next.minVolume - prevMonthVolume)) : 0,
    progressPercent: Number(progressPercent.toFixed(2)),
    tiers: volumeTiers,
    // ── Headline stats ──
    activeTraders,
    totalReferrals: base.stats.totalReferrals,
    // ── Commission overview (reused, unchanged engine) ──
    totalCommissionEarned: base.stats.lifetimeEarnings,
    revenueShareEarned: base.stats.totalRevenueShare,
    totalBonus: base.stats.totalBonus,
    pendingCommission: base.stats.pendingCommission,
    paidCommission: base.stats.paidCommission,
    monthlyCommission: base.stats.monthlyEarnings,
    todayCommission: base.stats.todayEarnings,
    availableBalance: base.stats.availableBalance,
    walletCurrency: base.stats.walletCurrency,
    // ── Referral identity ──
    referralCode: base.user.referralCode,
    // ── Detail collections ──
    referralPerformance,
    monthlySeries,
  };
};

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
  // Monthly volume-based tier engine
  getEffectiveTier,
  recomputeTier,
  recalcAllPartnerTiers,
  referralVolumeBetween,
  getNextVolumeTierFor,
  handleFirstQualifyingDeposit,
  distributeRevenueShare,
  getDashboardData,
  getVolumeDashboard,
  getVolumeTiers,
  getReferrals,
  getCommissionHistory,
  VOLUME_TIERS,
};
