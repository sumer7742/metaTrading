const Instrument = require('../models/Instrument');
const Candle = require('../models/Candle');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { getCandles } = require('../services/candleService');
const matchingEngine = require('../matching-engine/MatchingEngine');
const externalFeed = require('../services/externalFeedService');
const { D } = require('../utils/decimal');

const list = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.category) filter.category = req.query.category;
  const items = await Instrument.find(filter).lean();
  // Enrich with any ACTIVE leverage / fixed-volume overrides so the client
  // can show indicators and lock the volume input. Batched (no N+1).
  const instrumentOverrideService = require('../services/instrumentOverrideService');
  const enriched = await instrumentOverrideService.attachActiveOverrides(items);

  // Attach today's per-side daily-volume usage for instruments with a cap
  // enabled (single batched aggregation; the all-unlimited case costs nothing).
  const capped = enriched.filter((i) => i.dailyVolumeLimitEnabled);
  if (capped.length) {
    const volumeLimitService = require('../services/volumeLimitService');
    const usedMap = await volumeLimitService.getUsedDailyVolumeForSymbols(capped.map((i) => i.symbol));
    for (const it of enriched) {
      if (it.dailyVolumeLimitEnabled) {
        const u = usedMap.get(it.symbol) || { BUY: 0, SELL: 0 };
        it.dailyBuyUsed = u.BUY;
        it.dailySellUsed = u.SELL;
      }
    }
  }
  sendSuccess(res, enriched);
});

// Daily volume usage for a single instrument → { enabled, limit, used, remaining }.
// Per-instrument limit usage: platform DAILY cap + GLOBAL LIFETIME cap, each
// per-side { limit, used, remaining }. Both are platform-wide (all users), so
// this stays public. Backward compatible — daily fields remain at top level.
const volumeUsage = asyncHandler(async (req, res) => {
  const inst = await Instrument.findOne({ symbol: req.params.symbol.toUpperCase() }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  const [daily, lifetime] = await Promise.all([
    require('../services/volumeLimitService').getDailyVolumeUsage(inst),
    require('../services/lifetimeVolumeLimitService').getLifetimeVolumeUsage(inst),
  ]);
  sendSuccess(res, { ...daily, lifetime });
});

/**
 * Watchlist: every active instrument enriched with derived bid/ask, the
 * absolute spread, today's H/L and the 24h % change. The frontend can render
 * a market-watch table without N+1 calls.
 *
 * - bid/ask are derived from lastPrice and spreadValue/spreadType. We split
 *   the spread evenly: bid = last - half, ask = last + half.
 * - dayHigh/dayLow come from the most recent 1d candle (one query batched
 *   across symbols), falling back to the 1h candles if 1d isn't seeded.
 * - change24h compares the latest 1h candle close vs the 1h candle from
 *   ~24h ago. Approximate but cheap.
 */
const watchlist = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.category) filter.category = req.query.category;
  const items = await Instrument.find(filter).lean();
  if (!items.length) return sendSuccess(res, []);

  const symbols = items.map((i) => i.symbol);

  // One query for today's 1d candle per symbol. Mongo "find latest per group"
  // would normally need an aggregation; for a small list of symbols (<50) a
  // straight find + in-memory pick is simpler and fast enough.
  const dayCandles = await Candle.find({
    symbol: { $in: symbols },
    timeframe: '1d',
  })
    .sort({ openTime: -1 })
    .limit(symbols.length * 2) // tolerate a few duplicates from boundary buckets
    .lean();
  const dayBySymbol = new Map();
  for (const c of dayCandles) {
    if (!dayBySymbol.has(c.symbol)) dayBySymbol.set(c.symbol, c);
  }

  // For 24h % change: latest 1h close vs the 1h candle ~24h prior.
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentHourly = await Candle.find({
    symbol: { $in: symbols },
    timeframe: '1h',
    openTime: { $gte: new Date(Date.now() - 26 * 60 * 60 * 1000) },
  })
    .sort({ openTime: 1 })
    .lean();
  const hourlyBySymbol = new Map();
  for (const c of recentHourly) {
    if (!hourlyBySymbol.has(c.symbol)) hourlyBySymbol.set(c.symbol, []);
    hourlyBySymbol.get(c.symbol).push(c);
  }

  const enriched = items.map((inst) => {
    const last = D(inst.lastPrice || '0');
    let bid = last;
    let ask = last;
    if (inst.spreadValue && Number(inst.spreadValue) > 0 && Number(inst.lastPrice) > 0) {
      const half = D(inst.spreadValue).div(2);
      if (inst.spreadType === 'PERCENTAGE') {
        bid = last.times(D('1').minus(half));
        ask = last.times(D('1').plus(half));
      } else {
        bid = last.minus(half);
        ask = last.plus(half);
      }
    }
    const spread = ask.minus(bid).toString();

    // ── Prefer the exchange-side 24h ticker when available (crypto via
    // Binance). Falls back to our own candle aggregation for forex /
    // stocks / commodities, which is computed below.
    const extTicker = externalFeed.getExternalTicker(inst.symbol);

    const day = dayBySymbol.get(inst.symbol);
    let dayHigh = extTicker?.dayHigh != null && Number.isFinite(extTicker.dayHigh)
      ? String(extTicker.dayHigh)
      : (day?.high || null);
    let dayLow = extTicker?.dayLow != null && Number.isFinite(extTicker.dayLow)
      ? String(extTicker.dayLow)
      : (day?.low || null);

    // Fallback to 1h aggregation when 1d candle is missing.
    const hourly = hourlyBySymbol.get(inst.symbol) || [];
    if ((!dayHigh || !dayLow) && hourly.length) {
      let h = D(hourly[0].high);
      let l = D(hourly[0].low);
      for (const c of hourly) {
        if (D(c.high).gt(h)) h = D(c.high);
        if (D(c.low).lt(l)) l = D(c.low);
      }
      dayHigh = dayHigh || h.toString();
      dayLow = dayLow || l.toString();
    }

    let change24h = null;
    if (extTicker && Number.isFinite(extTicker.change24h)) {
      // Exchange-computed % — always preferred when present.
      change24h = extTicker.change24h;
    } else if (hourly.length >= 2 && Number(inst.lastPrice) > 0) {
      // Find the candle closest to (now - 24h) without going past it.
      let baseline = hourly[0];
      for (const c of hourly) {
        if (new Date(c.openTime) <= dayAgo) baseline = c;
        else break;
      }
      if (Number(baseline.close) > 0) {
        change24h = ((Number(inst.lastPrice) - Number(baseline.close)) / Number(baseline.close)) * 100;
      }
    }

    const volume24h = extTicker && Number.isFinite(extTicker.volume24h)
      ? String(extTicker.volume24h)
      : (inst.volume24h || null);

    return {
      symbol: inst.symbol,
      name: inst.name,
      category: inst.category,
      // Quote currency lets the client decide whether to show INR primary +
      // USD secondary (USD-quoted) vs INR-only (INR-quoted) on the watchlist.
      quoteCurrency: inst.quoteCurrency,
      pricePrecision: inst.pricePrecision,
      lastPrice: inst.lastPrice,
      bid: bid.toString(),
      ask: ask.toString(),
      spread,
      dayHigh,
      dayLow,
      change24h,
      volume24h,
    };
  });

  sendSuccess(res, enriched);
});

const getOne = asyncHandler(async (req, res) => {
  const inst = await Instrument.findOne({ symbol: req.params.symbol.toUpperCase() }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  sendSuccess(res, inst);
});

const candles = asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const { timeframe = '1m', limit = 500 } = req.query;
  const data = await getCandles(symbol.toUpperCase(), timeframe, Number(limit));
  // Reverse to chronological for charts
  sendSuccess(res, data.reverse());
});

const orderbook = asyncHandler(async (req, res) => {
  const { symbol } = req.params;
  const sym = symbol.toUpperCase();
  const depth = Number(req.query.depth || 25);
  // 1. Prefer the cached external L2 book (Binance for crypto). This is
  //    what a real trader expects when they ask for "market depth".
  const ext = externalFeed.getExternalOrderbook(sym);
  if (ext && (ext.bids?.length || ext.asks?.length)) {
    const trimmed = {
      symbol: ext.symbol,
      bids: ext.bids.slice(0, depth),
      asks: ext.asks.slice(0, depth),
      ts: ext.ts,
      source: ext.source,
    };
    return sendSuccess(res, trimmed);
  }
  // 2. Fallback to the internal matching engine snapshot (user-placed
  //    limit orders, mostly empty for crypto pairs).
  const snap = matchingEngine.getSnapshot(sym, depth);
  sendSuccess(res, snap);
});

// Admin CRUD
const validateBBook = (data) => {
  // CRITICAL: doc requirement (§4.1) - B-book MUST be disabled in Internal-Only mode
  if (data.bBookEnabled === true && data.mode === 'INTERNAL') {
    throw new AppError('B-book cannot be enabled when mode is INTERNAL (doc §4.1)', 400, 'INVALID_BBOOK_MODE');
  }
};

// Enforce that exactly ONE commission method is active: the field for the
// inactive type is forced to '0' so an instrument can never charge both a
// flat fee AND a percentage. Mutates `body` in place.
const normalizeCommission = (body, current = {}) => {
  if (!body || typeof body !== 'object') return;
  const type = String(body.commissionType ?? current.commissionType ?? 'PERCENTAGE').toUpperCase();
  if (type !== 'FIXED' && type !== 'PERCENTAGE') return;
  body.commissionType = type;
  if (type === 'FIXED') body.commissionPercent = '0';
  else body.commissionPerTrade = '0';
};

const create = asyncHandler(async (req, res) => {
  validateBBook(req.body);
  normalizeCommission(req.body);
  const inst = await Instrument.create(req.body);
  sendSuccess(res, inst, 201);
});

const update = asyncHandler(async (req, res) => {
  // Check final state against current record
  const current = await Instrument.findOne({ symbol: req.params.symbol.toUpperCase() });
  if (!current) throw new AppError('Instrument not found', 404);
  const finalMode = req.body.mode ?? current.mode;
  const finalBBook = req.body.bBookEnabled ?? current.bBookEnabled;
  validateBBook({ mode: finalMode, bBookEnabled: finalBBook });
  normalizeCommission(req.body, current);

  // B-book disable transition handler (doc §9.4)
  // If bBookEnabled is going from true -> false, take action on existing B-book positions
  // based on the configured bBookDisableMode.
  const bBookDisableTransition = current.bBookEnabled === true && finalBBook === false;

  const inst = await Instrument.findOneAndUpdate(
    { symbol: req.params.symbol.toUpperCase() },
    req.body,
    { new: true }
  );

  if (bBookDisableTransition) {
    const mode = inst.bBookDisableMode || 'LET_RUN';
    const Position = require('../models/Position');
    const Trade = require('../models/Trade');
    const Order = require('../models/Order');
    const matchingEngine = require('../matching-engine/MatchingEngine');

    // Find users with open positions whose latest trade for this symbol was B-book.
    // (Simpler heuristic: any open position on this symbol where any related trade was B_BOOK.)
    const openPositions = await Position.find({ symbol: inst.symbol, status: 'OPEN' });
    const affected = [];
    for (const pos of openPositions) {
      const recentBBookTrade = await Trade.findOne({
        symbol: inst.symbol,
        $or: [{ buyAccountId: pos.accountId }, { sellAccountId: pos.accountId }],
        routing: 'B_BOOK',
      }).sort({ executedAt: -1 });
      if (recentBBookTrade) affected.push(pos);
    }

    if (mode === 'CLOSE_ALL') {
      // Force-close all affected positions at last price. Each close is
      // routed through orderRouter so an A-book account's close still
      // flows to the LP rather than executing internally.
      const orderRouter = require('../services/orderRouter.service');
      for (const pos of affected) {
        const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
        const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
        const closingOrder = await Order.create({
          userId: pos.userId,
          accountId: pos.accountId,
          instrumentId: pos.instrumentId,
          symbol: pos.symbol,
          side: oppositeSide,
          positionSide: sourcePositionSide,
          type: 'MARKET',
          quantity: pos.quantity,
          leverage: pos.leverage,
          status: 'PENDING',
          closeOnly: true,
          reduceOnly: true,
        });
        try {
          await orderRouter.routeOrder({ order: closingOrder, userId: pos.userId });
        } catch (e) {
          console.error('[BBookDisable] close failed:', e.message);
        }
      }
      console.log(`[BBookDisable] ${inst.symbol}: CLOSE_ALL closed ${affected.length} positions`);
    } else if (mode === 'HEDGE_EXTERNAL') {
      // TODO: open offsetting positions on external broker (requires liquidity provider integration).
      // For now log the intent and leave positions running.
      console.warn(`[BBookDisable] ${inst.symbol}: HEDGE_EXTERNAL not yet implemented (${affected.length} positions need hedging). Falling back to LET_RUN.`);
    }
    // 'LET_RUN' = no action; positions remain open until user closes naturally.
  }

  sendSuccess(res, inst);
});

const remove = asyncHandler(async (req, res) => {
  const inst = await Instrument.findOneAndUpdate(
    { symbol: req.params.symbol.toUpperCase() },
    { isActive: false },
    { new: true }
  );
  if (!inst) throw new AppError('Instrument not found', 404);
  sendSuccess(res, inst);
});

module.exports = { list, watchlist, getOne, volumeUsage, candles, orderbook, create, update, remove };
