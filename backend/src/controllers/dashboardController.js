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

module.exports = { getDashboard };
