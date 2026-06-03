const TradingAccount = require('../models/TradingAccount');
const Order = require('../models/Order');
const Position = require('../models/Position');
const Trade = require('../models/Trade');
const Instrument = require('../models/Instrument');
const { Wallet } = require('../models/Wallet');
const { Notification } = require('../models/index');
const { sendSuccess, asyncHandler } = require('../utils/errors');
const { ACCOUNT_TYPES } = require('../config/constants');
const { add } = require('../utils/decimal');

// Resolve which account _ids a dashboard filter applies to. Supports the
// special sentinels used by the Portfolio account dropdown:
//   ''          → all of the user's accounts
//   'ALL_REAL'  → every REAL account
//   'ALL_DEMO'  → every DEMO / VIRTUAL (practice) account
//   <accountId> → that single account
const DEMO_TYPES = [ACCOUNT_TYPES.DEMO, ACCOUNT_TYPES.VIRTUAL];
const isDemo = (a) => DEMO_TYPES.includes(a.accountType);
function resolveAccountIds(accounts, accountId) {
  if (accountId === 'ALL_REAL') {
    // "Real" = any non-practice account (STANDARD / PRO / REAL / …).
    return accounts.filter((a) => !isDemo(a)).map((a) => a._id);
  }
  if (accountId === 'ALL_DEMO') {
    return accounts.filter(isDemo).map((a) => a._id);
  }
  if (accountId) {
    return accounts.filter((a) => String(a._id) === String(accountId)).map((a) => a._id);
  }
  return accounts.map((a) => a._id);
}

/**
 * Returns dashboard metrics:
 *  - liveBalance, demoBalance
 *  - account counts (live / demo)
 *  - trade counts: total, open, closed, winning, losing (for live + demo)
 *  - "today" deltas
 *  - kycStatus
 */
const getDashboard = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  // ACCOUNTS + WALLETS in parallel — first round-trip kicks off both.
  const [accounts, wallets] = await Promise.all([
    TradingAccount.find({ userId, isActive: true }).lean(),
    Wallet.find({ userId }).lean(),
  ]);
  const liveAccounts = accounts.filter((a) => a.accountType === ACCOUNT_TYPES.REAL);
  const demoAccounts = accounts.filter((a) =>
    [ACCOUNT_TYPES.DEMO, ACCOUNT_TYPES.VIRTUAL].includes(a.accountType)
  );
  const liveAccountIds = liveAccounts.map((a) => a._id);
  const demoAccountIds = demoAccounts.map((a) => a._id);

  const accumByCurrency = (filterFn) => {
    const out = {};
    for (const w of wallets) {
      if (!filterFn(w)) continue;
      const cur = w.currency || 'INR';
      if (!out[cur]) out[cur] = { balance: 0, locked: 0, free: 0 };
      out[cur].balance += Number(w.balance || 0);
      out[cur].locked += Number(w.locked || 0);
      out[cur].free += Math.max(0, Number(w.balance || 0) - Number(w.locked || 0));
    }
    return out;
  };
  const liveByCurrency = accumByCurrency((w) => liveAccountIds.some((id) => id.equals(w.accountId)));
  const demoByCurrency = accumByCurrency((w) => demoAccountIds.some((id) => id.equals(w.accountId)));

  // Backwards-compat scalars: pick the primary currency (INR if present,
  // else first currency seen). Single-currency users see no behavior change.
  const primaryCurrency =
    liveByCurrency.INR ? 'INR' : Object.keys(liveByCurrency)[0] || 'INR';
  const liveBalance = liveByCurrency[primaryCurrency]?.balance || 0;
  const demoBalance = demoByCurrency[primaryCurrency]?.balance || 0;

  // OPEN POSITIONS — fetch instead of count so we can compute equity
  // (balance + unrealized PnL) using current mark prices. Parallel.
  const [openLiveDocs, openDemoDocs] = await Promise.all([
    Position.find({ accountId: { $in: liveAccountIds }, status: 'OPEN' }).lean(),
    Position.find({ accountId: { $in: demoAccountIds }, status: 'OPEN' }).lean(),
  ]);
  const openLivePositions = openLiveDocs.length;
  const openDemoPositions = openDemoDocs.length;

  // Fan out instrument lookup + closed-position queries in one round-trip.
  // The instrument lookup is needed for unrealized PnL; closed positions
  // are independent and can be fetched concurrently.
  const liveInstrumentIds = [...new Set(openLiveDocs.map((p) => String(p.instrumentId)))];
  const [liveInstruments, closedLive, closedDemo] = await Promise.all([
    liveInstrumentIds.length
      ? Instrument.find({ _id: { $in: liveInstrumentIds } })
          .select('_id lastPrice quoteCurrency')
          .lean()
      : Promise.resolve([]),
    Position.find({ accountId: { $in: liveAccountIds }, status: 'CLOSED' }).lean(),
    Position.find({ accountId: { $in: demoAccountIds }, status: 'CLOSED' }).lean(),
  ]);
  const liveInstMap = new Map(liveInstruments.map((i) => [String(i._id), i]));

  // Mark-to-market unrealized PnL across open live positions. We filter PnL
  // to only positions whose quote currency matches the wallet's primary
  // currency — mixed-currency PnL summed naively into a single number is
  // meaningless; skipping non-matching currencies is conservative and yields
  // a faithful single-currency equity value. A future FX layer can convert.
  let unrealizedPnlLive = 0;
  let unrealizedPnlSkipped = 0;
  for (const p of openLiveDocs) {
    const inst = liveInstMap.get(String(p.instrumentId));
    const quote = inst?.quoteCurrency || primaryCurrency;
    const mark = Number(inst?.lastPrice || p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    const pnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
    if (quote === primaryCurrency) {
      unrealizedPnlLive += pnl;
    } else {
      unrealizedPnlSkipped += 1;
    }
  }
  const equityLive = liveBalance + unrealizedPnlLive;

  const closedLiveToday = closedLive.filter((p) => p.closedAt && p.closedAt >= startOfToday);
  const winningLive = closedLive.filter((p) => Number(p.realizedPnl || 0) > 0);
  const losingLive = closedLive.filter((p) => Number(p.realizedPnl || 0) < 0);
  const winningLiveToday = winningLive.filter((p) => p.closedAt && p.closedAt >= startOfToday);
  const losingLiveToday = losingLive.filter((p) => p.closedAt && p.closedAt >= startOfToday);

  // Realized P&L today and lifetime — useful headline numbers.
  const realizedPnlToday = closedLiveToday.reduce((s, p) => s + Number(p.realizedPnl || 0), 0);
  const realizedPnlLifetime = closedLive.reduce((s, p) => s + Number(p.realizedPnl || 0), 0);

  // Lifetime profit / loss split — the portfolio stats block shows
  // gross winners and gross losers separately so the user sees the
  // distribution, not just the net.
  const profitLifetime = winningLive.reduce((s, p) => s + Number(p.realizedPnl || 0), 0);
  const lossLifetime   = losingLive.reduce((s, p) => s + Number(p.realizedPnl || 0), 0); // signed (negative)

  // Trading volume — notional traded across every CLOSED live trade.
  // Approximated as qty × entryPrice; close-price could be used too but
  // entry is what was committed.
  const tradingVolumeLifetime = closedLive.reduce(
    (s, p) => s + Math.abs(Number(p.quantity || 0) * Number(p.entryPrice || 0)),
    0
  );

  // Win rate ignores break-even (PnL=0) trades in the denominator so a
  // bunch of zero-PnL closes don't drag the rate to nonsense values.
  const decided = winningLive.length + losingLive.length;
  const winRate = decided ? (winningLive.length / decided) * 100 : null;

  // TOTAL TRADES (executed = filled orders) - all 5 trade-collection queries
  // run in parallel. Pre-fix these were sequential and accounted for the
  // bulk of dashboard latency on Atlas (5× round-trip vs 1× round-trip).
  const userAccountIds = accounts.map((a) => a._id);
  const [
    totalTradesLive,
    totalTradesLiveToday,
    totalTradesDemo,
    totalTradesDemoToday,
    recentTrades,
    unreadNotifications,
  ] = await Promise.all([
    Trade.countDocuments({
      $or: [{ buyAccountId: { $in: liveAccountIds } }, { sellAccountId: { $in: liveAccountIds } }],
    }),
    Trade.countDocuments({
      $or: [{ buyAccountId: { $in: liveAccountIds } }, { sellAccountId: { $in: liveAccountIds } }],
      executedAt: { $gte: startOfToday },
    }),
    Trade.countDocuments({
      $or: [{ buyAccountId: { $in: demoAccountIds } }, { sellAccountId: { $in: demoAccountIds } }],
    }),
    Trade.countDocuments({
      $or: [{ buyAccountId: { $in: demoAccountIds } }, { sellAccountId: { $in: demoAccountIds } }],
      executedAt: { $gte: startOfToday },
    }),
    // Recent activity: last 10 fills, with user-side tag for the UI.
    Trade.find({
      $or: [
        { buyAccountId: { $in: userAccountIds } },
        { sellAccountId: { $in: userAccountIds } },
      ],
    })
      .sort({ executedAt: -1 })
      .limit(10)
      .lean(),
    // Unread notification count — folded into this batch so the dashboard
    // hits Atlas with one round-trip block instead of a tail-end serial call.
    Notification.countDocuments({ userId, isRead: false }),
  ]);
  const recentActivity = recentTrades.map((t) => {
    // Defensive null-check: a malformed trade row with no buyAccountId
    // would crash id.equals(undefined) — better to default to SELL than 500.
    const userIsBuyer = !!t.buyAccountId &&
      userAccountIds.some((id) => id.equals(t.buyAccountId));
    return {
      id: String(t._id),
      symbol: t.symbol,
      side: userIsBuyer ? 'BUY' : 'SELL',
      price: t.price,
      quantity: t.quantity,
      executedAt: t.executedAt,
      routing: t.routing,
    };
  });

  sendSuccess(res, {
    user: {
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      email: req.user.email,
      kycStatus: req.user.kycStatus,
      twoFactorEnabled: req.user.twoFactorEnabled,
    },
    balance: {
      live: liveBalance.toFixed(2),
      demo: demoBalance.toFixed(2),
      // Per-currency breakdown so the UI can render "INR 23,000 + USD 15,274"
      // separately instead of summing them as a single (meaningless) figure.
      liveByCurrency,
      demoByCurrency,
      primaryCurrency,
    },
    equity: {
      live: equityLive.toFixed(2),
      unrealizedPnl: unrealizedPnlLive.toFixed(2),
      // Lightweight per-position payload so the client can recompute equity
      // tick-by-tick from the WS ticker stream, instead of waiting on the
      // 15s polling cycle. Only the fields needed for the formula:
      //   pnl = (mark - entry) * qty   (BUY)
      //   pnl = (entry - mark) * qty   (SELL)
      openPositions: openLiveDocs.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
      })),
    },
    pnl: {
      realizedToday: realizedPnlToday.toFixed(2),
      realizedLifetime: realizedPnlLifetime.toFixed(2),
      winRate: winRate != null ? Number(winRate.toFixed(1)) : null,
      // Lifetime breakdown — used by the Portfolio stats block.
      profit: profitLifetime.toFixed(2),       // sum of winning trades
      loss:   lossLifetime.toFixed(2),         // signed sum of losing trades (negative)
      netProfit: realizedPnlLifetime.toFixed(2),
      tradingVolume: tradingVolumeLifetime.toFixed(2),
    },
    accounts: {
      live: liveAccounts.length,
      demo: demoAccounts.length,
    },
    trades: {
      totalLive: totalTradesLive,
      totalLiveToday: totalTradesLiveToday,
      totalDemo: totalTradesDemo,
      totalDemoToday: totalTradesDemoToday,
      openLive: openLivePositions,
      openDemo: openDemoPositions,
      closedLive: closedLive.length,
      closedLiveToday: closedLiveToday.length,
      winningLive: winningLive.length,
      winningLiveToday: winningLiveToday.length,
      losingLive: losingLive.length,
      losingLiveToday: losingLiveToday.length,
    },
    notifications: {
      unread: unreadNotifications,
    },
    recentActivity,
  });
});

/**
 * GET /user/dashboard/lifetime-stats?days=&accountId=
 *
 * Filterable stats block for the Portfolio page. Both filters are optional:
 *   - days       — restricts to trades closed within the last N days
 *                  (0/missing = no time filter, "lifetime")
 *   - accountId  — restricts to a single trading account
 *                  (missing = all accounts the user owns)
 *
 * Returns:
 *   { netProfit, profit, loss, unrealizedPnl,
 *     closedOrders, profitable, unprofitable,
 *     tradingVolume }
 */
const getLifetimeStats = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const daysRaw = Number(req.query.days);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(3650, Math.floor(daysRaw)) : 0;
  const accountId = req.query.accountId;

  const accounts = await TradingAccount.find({ userId, isActive: true }).select('_id accountType').lean();
  let accountIds = resolveAccountIds(accounts, accountId);
  if (!accountIds.length) {
    return sendSuccess(res, {
      netProfit: '0.00', profit: '0.00', loss: '0.00', unrealizedPnl: '0.00',
      closedOrders: 0, profitable: 0, unprofitable: 0, tradingVolume: '0.00',
    });
  }

  const closedFilter = { accountId: { $in: accountIds }, status: 'CLOSED' };
  if (days > 0) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    closedFilter.closedAt = { $gte: cutoff };
  }

  const [closed, openPositions] = await Promise.all([
    Position.find(closedFilter).lean(),
    Position.find({ accountId: { $in: accountIds }, status: 'OPEN' }).lean(),
  ]);

  // Roll up the 8 stat values.
  let profit = 0, loss = 0, tradingVolume = 0, winners = 0, losers = 0;
  for (const p of closed) {
    const pnl = Number(p.realizedPnl || 0);
    if (pnl > 0) { profit += pnl; winners += 1; }
    else if (pnl < 0) { loss += pnl; losers += 1; }
    tradingVolume += Math.abs(Number(p.quantity || 0) * Number(p.entryPrice || 0));
  }
  const netProfit = profit + loss; // loss is signed-negative

  // Unrealized P&L across open positions (entry vs current mark).
  // Cheap version — mark = lastPrice; mismatched-quote positions still
  // contribute their qty×Δ which is fine for a rolled-up portfolio number.
  const instIds = [...new Set(openPositions.map((p) => String(p.instrumentId)))];
  const insts = instIds.length
    ? await Instrument.find({ _id: { $in: instIds } }).select('_id lastPrice').lean()
    : [];
  const instMap = new Map(insts.map((i) => [String(i._id), i]));
  let unrealizedPnl = 0;
  for (const p of openPositions) {
    const inst = instMap.get(String(p.instrumentId));
    const mark = Number(inst?.lastPrice || p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    unrealizedPnl += p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
  }

  sendSuccess(res, {
    netProfit: netProfit.toFixed(2),
    profit:    profit.toFixed(2),
    loss:      loss.toFixed(2),
    unrealizedPnl: unrealizedPnl.toFixed(2),
    closedOrders: closed.length,
    profitable: winners,
    unprofitable: losers,
    tradingVolume: tradingVolume.toFixed(2),
  });
});

/**
 * GET /user/dashboard/monthly-series?accountId=&range=1d|1w|1m|3m|1y|all&months=13
 *
 * Adaptive time-series rollup for the Portfolio chart. The `range` param
 * picks the right bucket granularity (hourly / daily / weekly / monthly)
 * so the chart always renders a comfortable 7-36 data points regardless
 * of horizon:
 *   1d  → 24 hourly  buckets
 *   1w  → 7 daily    buckets
 *   1m  → 30 daily   buckets
 *   3m  → 13 weekly  buckets
 *   1y  → 13 monthly buckets (default — also the legacy `months` flow)
 *   all → 36 monthly buckets
 *
 * Each bucket carries: netProfit, profit, loss, closedOrders,
 * tradingVolume, equity (running cumulative netProfit).
 */
const RANGE_CONFIG = {
  '1d':  { grain: 'hour',  count: 24 },
  '1w':  { grain: 'day',   count: 7 },
  '1m':  { grain: 'day',   count: 30 },
  '3m':  { grain: 'week',  count: 13 },
  '1y':  { grain: 'month', count: 13 },
  'all': { grain: 'month', count: 36 },
};

const _bucketKey = (d, grain) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (grain === 'hour')  return `${yyyy}-${mm}-${dd}T${String(d.getHours()).padStart(2, '0')}`;
  if (grain === 'day')   return `${yyyy}-${mm}-${dd}`;
  if (grain === 'week') {
    // ISO week: Monday-anchored week start.
    const mon = new Date(d);
    mon.setHours(0, 0, 0, 0);
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    return `${mon.getFullYear()}-W${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
  }
  return `${yyyy}-${mm}`;
};

const _labelFor = (d, grain) => {
  if (grain === 'hour')  return `${String(d.getHours()).padStart(2, '0')}:00`;
  if (grain === 'day')   return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  if (grain === 'week') {
    const mon = new Date(d);
    mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    return mon.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleString('en-US', { month: 'short' });
};

const _stepBack = (d, grain, i) => {
  const c = new Date(d);
  if (grain === 'hour')  c.setHours(c.getHours() - i, 0, 0, 0);
  else if (grain === 'day')   { c.setHours(0, 0, 0, 0); c.setDate(c.getDate() - i); }
  else if (grain === 'week')  { c.setHours(0, 0, 0, 0); c.setDate(c.getDate() - ((c.getDay() + 6) % 7) - 7 * i); }
  else                        c.setMonth(c.getMonth() - i, 1);
  return c;
};

const getMonthlySeries = asyncHandler(async (req, res) => {
  const userId = req.userId;
  const range = String(req.query.range || '').toLowerCase();
  const cfg = RANGE_CONFIG[range] || null;

  // Legacy `months` param keeps backward-compat with earlier FE bundles.
  let grain, count;
  if (cfg) { grain = cfg.grain; count = cfg.count; }
  else {
    grain = 'month';
    const monthsRaw = Number(req.query.months);
    count = Number.isFinite(monthsRaw) && monthsRaw > 0 ? Math.min(36, Math.floor(monthsRaw)) : 13;
  }

  const accountId = req.query.accountId;
  const accounts = await TradingAccount.find({ userId, isActive: true }).select('_id accountType').lean();
  let accountIds = resolveAccountIds(accounts, accountId);

  if (!accountIds.length) {
    return sendSuccess(res, { grain, buckets: [] });
  }

  const now = new Date();
  const buckets = [];
  const idxByKey = {};
  for (let i = count - 1; i >= 0; i--) {
    const d = _stepBack(now, grain, i);
    const key = _bucketKey(d, grain);
    idxByKey[key] = buckets.length;
    buckets.push({
      key,
      label: _labelFor(d, grain),
      tsStart: d.getTime(),
      netProfit: 0, profit: 0, loss: 0,
      closedOrders: 0, tradingVolume: 0,
      equity: 0,
    });
  }

  const oldest = new Date(buckets[0].tsStart);
  const closed = await Position.find({
    accountId: { $in: accountIds },
    status: 'CLOSED',
    closedAt: { $gte: oldest },
  }).lean();

  for (const p of closed) {
    if (!p.closedAt) continue;
    const key = _bucketKey(new Date(p.closedAt), grain);
    const idx = idxByKey[key];
    if (idx == null) continue;
    const b = buckets[idx];
    const pnl = Number(p.realizedPnl || 0);
    if (pnl > 0) b.profit += pnl;
    else if (pnl < 0) b.loss += pnl;
    b.netProfit += pnl;
    b.closedOrders += 1;
    b.tradingVolume += Math.abs(Number(p.quantity || 0) * Number(p.entryPrice || 0));
  }

  // Running cumulative net profit → "equity" proxy.
  let cum = 0;
  for (const b of buckets) {
    cum += b.netProfit;
    b.equity        = Number(cum.toFixed(2));
    b.netProfit     = Number(b.netProfit.toFixed(2));
    b.profit        = Number(b.profit.toFixed(2));
    b.loss          = Number(b.loss.toFixed(2));
    b.tradingVolume = Number(b.tradingVolume.toFixed(2));
  }

  sendSuccess(res, { grain, range: range || 'monthly', buckets });
});

module.exports = { getDashboard, getLifetimeStats, getMonthlySeries };
