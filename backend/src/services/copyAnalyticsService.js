/**
 * Copy-trading ANALYTICS service — 100% read-only.
 *
 * Computes the rich trader-profile dashboard metrics (ROI by period, win
 * rate, profit factor, drawdown, Sharpe, equity curve, follower analytics,
 * open positions, paginated trade history) purely from EXISTING data:
 *   • Position history (the trader's own closed/open positions)
 *   • CopyRelation / CopyTrade / TraderProfile (copy metadata)
 *
 * It NEVER writes anything and NEVER touches order execution, wallet, margin,
 * commission, or copy-synchronisation logic. Safe to call from new endpoints
 * without affecting the live copy engine.
 */
const mongoose = require('mongoose');
const Position = require('../models/Position');
const CopyRelation = require('../models/CopyRelation');
const CopyTrade = require('../models/CopyTrade');
const TraderProfile = require('../models/TraderProfile');
const User = require('../models/User');
const Instrument = require('../models/Instrument');
const { POSITION_STATUS } = require('../config/constants');

const oid = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RISK_BADGE_SCORE = { LOW: 3, MEDIUM: 5, HIGH: 8 };

// Heuristic 1–10 risk score from drawdown + leverage + win rate. Used only
// for display; never feeds execution.
function deriveRiskScore({ maxDrawdownPct, avgLeverage, winRate, hasTrades, riskBadge }) {
  if (!hasTrades) return RISK_BADGE_SCORE[riskBadge] || 5;
  let r = 1;
  r += Math.min(4, maxDrawdownPct / 12.5);   // 50% DD → +4
  r += Math.min(3, avgLeverage / 40);        // 120x → +3
  r += Math.min(2, (100 - winRate) / 40);    // low win rate → up to +2
  return Math.max(1, Math.min(10, Math.round(r)));
}
const riskTier = (score) => (score <= 3 ? 'LOW' : score <= 6 ? 'MEDIUM' : 'HIGH');

function tradingStyle(avgDurationMs) {
  if (!avgDurationMs) return 'Day Trader';
  const h = avgDurationMs / 3_600_000;
  if (h < 1) return 'Scalper';
  if (h < 24) return 'Day Trader';
  if (h < 24 * 7) return 'Swing Trader';
  return 'Long Term';
}

function isoWeekKey(d) {
  // ISO week label "YYYY-Www" — good enough for bucketing.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Full analytics payload for a trader's profile dashboard.
 * @param {string} userId   the trader (master) user id
 */
async function getTraderAnalytics(userId) {
  const [profile, user] = await Promise.all([
    TraderProfile.findOne({ userId: oid(userId) }).lean(),
    User.findById(userId).select('firstName lastName email createdAt isEmailVerified kycStatus country').lean(),
  ]);

  const initialEquity = num(profile?.initialEquity) || 1000;

  // Closed positions = the trader's realized track record (read-only).
  const closed = await Position.find({ userId: oid(userId), status: POSITION_STATUS.CLOSED })
    .select('symbol side realizedPnl openedAt closedAt leverage stopLoss')
    .sort({ closedAt: 1 })
    .limit(3000)
    .lean();

  let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, slCount = 0;
  let cum = 0, peak = initialEquity, maxDD = 0, ddSum = 0, ddCount = 0;
  let streakSign = 0, curStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  const durations = [], leverages = [], equityCurve = [];
  const byDay = new Map(), byMonth = new Map(), byWeek = new Map();
  const tradeReturns = [];

  for (const p of closed) {
    const pnl = num(p.realizedPnl);
    cum += pnl;
    tradeReturns.push(pnl);

    if (pnl > 0) {
      wins++; grossProfit += pnl;
      curStreak = streakSign === 1 ? curStreak + 1 : 1; streakSign = 1;
      maxWinStreak = Math.max(maxWinStreak, curStreak);
    } else if (pnl < 0) {
      losses++; grossLoss += Math.abs(pnl);
      curStreak = streakSign === -1 ? curStreak + 1 : 1; streakSign = -1;
      maxLossStreak = Math.max(maxLossStreak, curStreak);
    }

    if (p.openedAt && p.closedAt) durations.push(new Date(p.closedAt) - new Date(p.openedAt));
    if (p.leverage) leverages.push(num(p.leverage));
    if (p.stopLoss && num(p.stopLoss) > 0) slCount++;

    const eq = initialEquity + cum;
    equityCurve.push({ t: p.closedAt, equity: round2(eq) });
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (peak - eq) / peak : 0;
    if (dd > 0) { ddSum += dd; ddCount++; }
    maxDD = Math.max(maxDD, dd);

    const d = new Date(p.closedAt);
    const dayKey = d.toISOString().slice(0, 10);
    byDay.set(dayKey, (byDay.get(dayKey) || 0) + pnl);
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + pnl);
    const weekKey = isoWeekKey(d);
    byWeek.set(weekKey, (byWeek.get(weekKey) || 0) + pnl);
  }

  const totalTrades = closed.length;
  const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const totalPnL = cum;
  const avgWin = wins ? grossProfit / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const avgDurationMs = durations.length ? mean(durations) : 0;
  const avgLeverage = leverages.length ? mean(leverages) : 0;
  const slUsagePct = totalTrades ? (slCount / totalTrades) * 100 : 0;
  const maxDrawdownPct = maxDD * 100;
  const avgDrawdownPct = ddCount ? (ddSum / ddCount) * 100 : 0;
  const maxDrawdownAbs = maxDD * peak;
  const recoveryFactor = maxDrawdownAbs > 0 ? totalPnL / maxDrawdownAbs : (totalPnL > 0 ? 999 : 0);

  // Sharpe from daily returns (annualised, 252 trading days).
  const dailyReturns = [...byDay.values()].map((p) => p / initialEquity);
  const sd = stdev(dailyReturns);
  const sharpe = dailyReturns.length >= 2 && sd > 0 ? (mean(dailyReturns) / sd) * Math.sqrt(252) : 0;

  // ROI by trailing window (denominator = initial equity).
  const now = Date.now();
  const pnlSince = (ms) => closed.reduce((s, p) => (new Date(p.closedAt).getTime() >= now - ms ? s + num(p.realizedPnl) : s), 0);
  const totalROI = (totalPnL / initialEquity) * 100;
  const dailyROI = (pnlSince(86_400_000) / initialEquity) * 100;
  const weeklyROI = (pnlSince(7 * 86_400_000) / initialEquity) * 100;
  const monthlyROI = (pnlSince(30 * 86_400_000) / initialEquity) * 100;

  const riskScore = deriveRiskScore({ maxDrawdownPct, avgLeverage, winRate, hasTrades: totalTrades > 0, riskBadge: profile?.riskBadge });

  // ── chart series ──
  const monthlySeries = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now - 0); d.setMonth(d.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    monthlySeries.push({ label: MONTHS[d.getMonth()], value: round2(byMonth.get(key) || 0) });
  }
  const weeklyEntries = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-12);
  const weeklySeries = weeklyEntries.map(([k, v]) => ({ label: k.slice(5), value: round2(v) }));

  // Profit distribution — bucket per-trade PnL.
  const distribution = buildDistribution(tradeReturns);

  // ── follower analytics ──
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [followersTotal, activeFollowers, newThisMonth, copiedTrades, activeRels] = await Promise.all([
    CopyRelation.countDocuments({ masterId: oid(userId), status: { $ne: 'STOPPED' } }),
    CopyRelation.countDocuments({ masterId: oid(userId), status: 'ACTIVE' }),
    CopyRelation.countDocuments({ masterId: oid(userId), createdAt: { $gte: startOfMonth } }),
    CopyTrade.countDocuments({ masterId: oid(userId) }),
    CopyRelation.find({ masterId: oid(userId), status: 'ACTIVE' }).select('investment runningPnl').lean(),
  ]);
  let aum = 0, roiSum = 0, roiN = 0;
  for (const r of activeRels) {
    const inv = num(r.investment);
    aum += inv;
    if (inv > 0) { roiSum += (num(r.runningPnl) / inv) * 100; roiN++; }
  }

  // ── master earnings (performance fee) — read-only rollup (USD) ──
  const copyEarnings = require('./copyEarningsService');
  const [earnings, performanceFeePercent] = await Promise.all([
    copyEarnings.getMasterEarnings(userId),
    copyEarnings.resolveFeePercent(userId),
  ]);

  return {
    trader: {
      userId: String(userId),
      displayName: profile?.displayName || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader',
      avatarUrl: profile?.avatarUrl || '',
      bio: profile?.bio || '',
      riskBadge: profile?.riskBadge || riskTier(riskScore),
      isPublic: !!profile?.isPublic,
      verified: user?.kycStatus === 'APPROVED',
      joinedAt: profile?.createdAt || user?.createdAt || null,
      country: user?.country || null,
      tradingStyle: tradingStyle(avgDurationMs),
      activeStatus: equityCurve.length ? (now - new Date(closed[closed.length - 1].closedAt).getTime() < 7 * 86_400_000) : false,
      riskScore,
      followers: followersTotal,
      aum: round2(aum),
      performanceFeePercent,
    },
    performance: {
      totalTrades, wins, losses,
      winRate: round2(winRate),
      totalPnL: round2(totalPnL),
      totalROI: round2(totalROI),
      monthlyROI: round2(monthlyROI),
      weeklyROI: round2(weeklyROI),
      dailyROI: round2(dailyROI),
      avgWin: round2(avgWin),
      avgLoss: round2(avgLoss),
      profitFactor: round2(profitFactor),
      avgDurationMs: Math.round(avgDurationMs),
    },
    risk: {
      riskScore,
      riskTier: riskTier(riskScore),
      maxDrawdownPct: round2(maxDrawdownPct),
      avgDrawdownPct: round2(avgDrawdownPct),
      sharpe: round2(sharpe),
      recoveryFactor: round2(recoveryFactor),
      avgLeverage: round2(avgLeverage),
      slUsagePct: round2(slUsagePct),
      maxWinStreak,
      maxLossStreak,
    },
    charts: {
      equityCurve, // [{ t, equity }] full (capped 3000) — client filters by range
      monthly: monthlySeries,
      weekly: weeklySeries,
      distribution,
    },
    followers: {
      total: followersTotal,
      active: activeFollowers,
      newThisMonth,
      aum: round2(aum),
      avgFollowerRoi: round2(roiN ? roiSum / roiN : 0),
      copiedTrades,
      generatedCommission: round2(earnings.total), // performance-fee earnings (USD)
    },
    // Master Trader Earnings — performance-fee metrics for the dashboard.
    earnings: {
      total: earnings.total,            // lifetime copy earnings (USD)
      today: earnings.today,            // earned today (USD)
      month: earnings.month,            // earned this month (USD)
      count: earnings.count,            // number of fee events
      avgFeePercent: earnings.avgFeePercent,
      performanceFeePercent,            // this master's effective fee %
    },
    initialEquity,
  };
}

function buildDistribution(returns) {
  if (!returns.length) return [];
  const buckets = [
    { label: '< -100', min: -Infinity, max: -100, count: 0 },
    { label: '-100…-50', min: -100, max: -50, count: 0 },
    { label: '-50…0', min: -50, max: 0, count: 0 },
    { label: '0…50', min: 0, max: 50, count: 0 },
    { label: '50…100', min: 50, max: 100, count: 0 },
    { label: '> 100', min: 100, max: Infinity, count: 0 },
  ];
  for (const r of returns) {
    const b = buckets.find((x) => r >= x.min && r < x.max) || buckets[buckets.length - 1];
    b.count++;
  }
  return buckets.map((b) => ({ bucket: b.label, count: b.count, positive: b.min >= 0 }));
}

/** Live-ish open positions for a trader (read-only; current price from instrument cache). */
async function getTraderOpenPositions(userId) {
  const pos = await Position.find({ userId: oid(userId), status: { $in: [POSITION_STATUS.OPEN, POSITION_STATUS.CLOSING] } })
    .select('symbol side positionSide quantity entryPrice unrealizedPnl leverage openedAt stopLoss takeProfit')
    .sort({ openedAt: -1 })
    .limit(200)
    .lean();
  const symbols = [...new Set(pos.map((p) => p.symbol))];
  const insts = symbols.length
    ? await Instrument.find({ symbol: { $in: symbols } }).select('symbol lastPrice pricePrecision').lean()
    : [];
  const bySym = new Map(insts.map((i) => [i.symbol, i]));
  return pos.map((p) => {
    const inst = bySym.get(p.symbol);
    return {
      _id: String(p._id),
      symbol: p.symbol,
      side: p.side,
      positionSide: p.positionSide,
      quantity: p.quantity,
      entryPrice: p.entryPrice,
      currentPrice: inst?.lastPrice || p.entryPrice,
      unrealizedPnl: p.unrealizedPnl,
      leverage: p.leverage,
      stopLoss: p.stopLoss || null,
      takeProfit: p.takeProfit || null,
      openedAt: p.openedAt,
      pricePrecision: inst?.pricePrecision || 2,
    };
  });
}

function periodRange(period, from, to) {
  const now = new Date();
  if (period === 'today') return { $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) };
  if (period === 'week') return { $gte: new Date(now.getTime() - 7 * 86_400_000) };
  if (period === 'month') return { $gte: new Date(now.getFullYear(), now.getMonth(), 1) };
  if (period === 'custom' && (from || to)) {
    const r = {};
    if (from) r.$gte = new Date(from);
    if (to) r.$lte = new Date(to);
    return r;
  }
  return null;
}

/** Paginated closed-trade history for a trader (read-only). */
async function getTraderHistory(userId, { period = 'all', page = 1, limit = 20, from, to } = {}) {
  const q = { userId: oid(userId), status: POSITION_STATUS.CLOSED };
  const range = periodRange(period, from, to);
  if (range) q.closedAt = range;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const [items, total] = await Promise.all([
    Position.find(q)
      .select('symbol side entryPrice closePrice realizedPnl openedAt closedAt leverage closeReason')
      .sort({ closedAt: -1 })
      .skip((p - 1) * l)
      .limit(l)
      .lean(),
    Position.countDocuments(q),
  ]);
  return {
    items: items.map((x) => ({
      _id: String(x._id),
      symbol: x.symbol,
      side: x.side,
      entryPrice: x.entryPrice,
      exitPrice: x.closePrice || null,
      realizedPnl: x.realizedPnl,
      openedAt: x.openedAt,
      closedAt: x.closedAt,
      durationMs: x.openedAt && x.closedAt ? new Date(x.closedAt) - new Date(x.openedAt) : null,
      leverage: x.leverage,
      closeReason: x.closeReason || null,
    })),
    total,
    page: p,
    limit: l,
    pages: Math.ceil(total / l),
  };
}

module.exports = { getTraderAnalytics, getTraderOpenPositions, getTraderHistory };
