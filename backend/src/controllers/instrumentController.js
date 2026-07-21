const Instrument = require('../models/Instrument');
const Candle = require('../models/Candle');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { getCandles } = require('../services/candleService');
const matchingEngine = require('../matching-engine/MatchingEngine');
const externalFeed = require('../services/externalFeedService');
const { D } = require('../utils/decimal');

// Options are accessed through the dedicated option-chain endpoint, never the
// bulk catalog — thousands of contracts would flood every consumer (Explore,
// search, watchlists, the instrument strip) and slow the whole app. Callers that
// genuinely want options pass ?segment=OPT (or ?includeOptions=true).
const _excludeOptions = (req, filter) => {
  if (req.query.segment) filter.segment = String(req.query.segment).toUpperCase();
  else if (String(req.query.includeOptions) !== 'true') filter.segment = { $ne: 'OPT' };
};

const list = asyncHandler(async (req, res) => {
  // Admin management view can request inactive instruments too (to see + re-enable
  // a disabled symbol). The public trader list never passes this flag, so it stays
  // active-only everywhere else.
  const filter = req.query.includeInactive === 'true' ? {} : { isActive: true };
  if (req.query.category) filter.category = req.query.category;
  _excludeOptions(req, filter);
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
  _excludeOptions(req, filter);
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
    .limit(symbols.length * 3) // enough to capture the latest TWO sessions per symbol
    .lean();
  const dayBySymbol = new Map();      // latest 1d candle (current / most-recent session)
  const prevDayBySymbol = new Map();  // the session BEFORE it — baseline for daily % change
  for (const c of dayCandles) {
    if (!dayBySymbol.has(c.symbol)) dayBySymbol.set(c.symbol, c);
    else if (!prevDayBySymbol.has(c.symbol)) prevDayBySymbol.set(c.symbol, c);
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
    // Final fallback for non-crypto (forex / stocks / indices / commodities):
    // derive a REAL daily % from the 1d candles already loaded — last price vs
    // the PREVIOUS session's close (the standard daily change), or today's open
    // when only one session exists. No external call; uses in-hand data. Only
    // fills the cases the branches above left null, so crypto/hourly are intact.
    if (change24h == null && Number(inst.lastPrice) > 0) {
      const prevDay = prevDayBySymbol.get(inst.symbol);
      const today = dayBySymbol.get(inst.symbol);
      let base = 0;
      if (prevDay && Number(prevDay.close) > 0) base = Number(prevDay.close);
      else if (today && Number(today.open) > 0) base = Number(today.open);
      if (base > 0) change24h = ((Number(inst.lastPrice) - base) / base) * 100;
    }

    const volume24h = extTicker && Number.isFinite(extTicker.volume24h)
      ? String(extTicker.volume24h)
      : (inst.volume24h || null);

    return {
      symbol: inst.symbol,
      name: inst.name,
      category: inst.category,
      logoUrl: inst.logoUrl || null,
      // exchange drives NSE/BSE session gating + ₹ display on the client.
      exchange: inst.exchange || null,
      segment: inst.segment || null,
      // Futures/options: lot + expiry for lot-based qty UI + expiry countdown.
      lotSize: inst.lotSize || null,
      expiryDate: inst.expiryDate || null,
      underlying: inst.underlying || null,
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

// Global instrument search. Prioritises equities / futures / forex / crypto;
// options are returned ONLY when the query is option-like (carries a strike
// number or CE/PE) so a normal search isn't drowned by thousands of contracts.
const search = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return sendSuccess(res, []);
  const limit = Math.min(Number(req.query.limit) || 25, 50);
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const sel = 'symbol name category exchange segment lastPrice quoteCurrency lotSize underlying expiryDate strike optionType logoUrl';

  const base = await Instrument.find({ isActive: true, segment: { $ne: 'OPT' }, $or: [{ symbol: rx }, { name: rx }] })
    .select(sel).limit(limit).lean();

  const optionLike = /\d{3,}/.test(q) || /(^|[^A-Z])(CE|PE)([^A-Z]|$)/i.test(q);
  let opts = [];
  if (optionLike && base.length < limit) {
    opts = await Instrument.find({ isActive: true, segment: 'OPT', symbol: rx })
      .select(sel).limit(limit - base.length).lean();
  }
  sendSuccess(res, [...base, ...opts]);
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

// Real fundamentals (market cap, P/E, EPS, 52-week range, etc.) via the
// free Yahoo Finance feed. Cached in-memory for 5 min per symbol so a page
// load doesn't hammer Yahoo. Returns whatever Yahoo yields — fields Yahoo
// can't provide come back null (the client shows "—" rather than a fake).
const _fundCache = new Map(); // symbol → { at, data }
const fundamentals = asyncHandler(async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const cached = _fundCache.get(sym);
  if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) {
    return sendSuccess(res, cached.data);
  }
  const inst = await Instrument.findOne({ symbol: sym }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  let data = { yahooSymbol: null };
  try {
    const yahooFeed = require('../services/yahooFeed');
    data = (await yahooFeed.getFundamentals(inst)) || data;
  } catch (_) { /* return whatever we have */ }
  _fundCache.set(sym, { at: Date.now(), data });
  sendSuccess(res, data);
});

// Real stock news via Yahoo Finance search. Cached 5 min per symbol.
const _newsCache = new Map();
const news = asyncHandler(async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const cached = _newsCache.get(sym);
  if (cached && (Date.now() - cached.at) < 5 * 60 * 1000) return sendSuccess(res, cached.data);
  const inst = await Instrument.findOne({ symbol: sym }).lean();
  if (!inst) throw new AppError('Instrument not found', 404);
  let data = [];
  try {
    const yahooFeed = require('../services/yahooFeed');
    data = (await yahooFeed.getNews(inst)) || [];
  } catch (_) { /* empty */ }
  _newsCache.set(sym, { at: Date.now(), data });
  sendSuccess(res, data);
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

// Admin: import Indian instruments from the OFFICIAL Dhan sync (full exchange
// metadata) on demand — the panel-friendly alternative to the CLI scripts.
//   EQUITY / FUTURES / OPTIONS  → specific symbols via Dhan scrip master
//   MCX                         → MCX commodity futures (near-expiry set)
//   INDICES                     → NIFTY/BANKNIFTY/… spot tiles
const syncIndian = asyncHandler(async (req, res) => {
  const type = String(req.body.type || 'EQUITY').toUpperCase();
  const symbols = String(req.body.symbols || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (type === 'MCX') {
    return sendSuccess(res, { type, ...(await require('../services/mcxSync').syncMcxFutures()) });
  }
  if (type === 'INDICES') {
    return sendSuccess(res, { type, ...(await require('../services/indianIndices').ensureIndianIndices()) });
  }
  if (!['EQUITY', 'FUTURES', 'OPTIONS'].includes(type)) {
    throw new AppError('type must be EQUITY, FUTURES, OPTIONS, MCX, or INDICES', 400);
  }
  if (!symbols.length) throw new AppError('symbols required (comma-separated, e.g. RELIANCE,TCS)', 400);
  if (symbols.length > 25) throw new AppError('Max 25 symbols per import — split into batches.', 400);
  const { importDhanInstruments } = require('../services/dhanImport');
  return sendSuccess(res, { type, ...(await importDhanInstruments({ kind: type, symbols })) });
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

// Bulk set routingOverride on many instruments at once.
const VALID_ROUTING = ['INHERIT', 'INTERNAL_MATCHING', 'A_BOOK', 'B_BOOK', 'HYBRID'];
const bulkRouting = asyncHandler(async (req, res) => {
  const { symbols, routingOverride } = req.body || {};
  if (!Array.isArray(symbols) || !symbols.length) throw new AppError('symbols[] required', 400);
  if (!VALID_ROUTING.includes(routingOverride)) throw new AppError('Invalid routingOverride', 400);
  const up = symbols.map((s) => String(s).toUpperCase());
  const r = await Instrument.updateMany({ symbol: { $in: up } }, { $set: { routingOverride } });
  sendSuccess(res, { matched: r.matchedCount ?? r.n ?? 0, modified: r.modifiedCount ?? r.nModified ?? 0, routingOverride });
});

// Option chain for an underlying: strikes × CE/PE for one expiry (nearest by
// default), plus the list of available expiries and the underlying spot.
const optionChain = asyncHandler(async (req, res) => {
  const underlying = String(req.query.underlying || '').toUpperCase();
  if (!underlying) throw new AppError('underlying required', 400);

  // Pull the fields the validator needs (token + tick + tick-age).
  const all = await Instrument.find({ segment: 'OPT', underlying, isActive: true })
    .select('symbol strike optionType expiryDate lastPrice lastPriceUpdatedAt lotSize instrumentToken tickSize').lean();

  const expiries = [...new Set(all.map((o) => (o.expiryDate ? new Date(o.expiryDate).toISOString() : null)).filter(Boolean))].sort();

  let expiry = req.query.expiry ? new Date(req.query.expiry).toISOString() : null;
  if (!expiry) {
    const now = Date.now();
    expiry = expiries.find((e) => new Date(e).getTime() >= now) || expiries[0] || null;
  }

  // Futures on the same underlying — shown alongside, and the FORWARD used to
  // price options (intrinsic = max(F−K,0)). Prefer the SAME-expiry future so
  // there's no basis mismatch; else fall back to the nearest + flag it.
  const futures = await Instrument.find({ segment: 'FUT', underlying, isActive: true })
    .select('symbol expiryDate lastPrice lotSize lastPriceUpdatedAt').sort({ expiryDate: 1 }).lean();
  const futForExpiry = futures.find((f) => f.expiryDate && new Date(f.expiryDate).toISOString() === expiry);
  const refFut = futForExpiry || futures[0] || null;
  let ref = refFut && Number(refFut.lastPrice) > 0 ? Number(refFut.lastPrice) : 0;
  if (!ref) {
    const spotDoc = await Instrument.findOne({ symbol: underlying }).select('lastPrice').lean();
    if (spotDoc && Number(spotDoc.lastPrice) > 0) ref = Number(spotDoc.lastPrice);
  }
  const expiryBasisWarning = !!(refFut && !futForExpiry); // ref future has a DIFFERENT expiry

  const { buildChain } = require('../services/optionChain');
  const expMs = expiry ? new Date(expiry).getTime() : null;
  const { rows, atm, integrity } = buildChain({ options: all, expiryIso: expiry, ref, refExpiryMs: expMs });

  // Data-integrity log (symbol/strike/expiry/token/LTP/IV/Δ/Θ for a few legs).
  if (integrity.invalidLegs || integrity.ceMonotonicityViolations || integrity.peMonotonicityViolations) {
    console.warn(`[optchain] ${underlying} exp=${(expiry || '').slice(0, 10)} ref=${ref} atm=${atm} | invalid=${integrity.invalidLegs} stale=${integrity.staleLegs} ceViol=${integrity.ceMonotonicityViolations} peViol=${integrity.peMonotonicityViolations}${expiryBasisWarning ? ' BASIS-MISMATCH' : ''}`);
    for (const r of rows.filter((x) => (x.ce && !x.ce.valid) || (x.pe && !x.pe.valid)).slice(0, 5)) {
      const bad = (r.ce && !r.ce.valid && r.ce) || (r.pe && !r.pe.valid && r.pe);
      if (bad) console.warn(`  [optchain] ${bad.symbol} K=${r.strike} tok=${bad.token} ltp=${bad.ltp} reason=${bad.reason} age=${bad.ageSec}s iv=${bad.iv} Δ=${bad.delta} Θ=${bad.theta}`);
    }
  }

  sendSuccess(res, {
    underlying, expiry, expiries,
    spot: ref ? String(ref) : null, atm, rows, futures, integrity, expiryBasisWarning,
    lastUpdated: new Date().toISOString(),
  });
});

// ── Economic calendar (Forex Factory / faireconomy — FREE, no API key) ──────
// Fetched server-side (avoids browser CORS + one shared cache for all clients),
// normalised to the exact shape the client's economicCalendar util renders, and
// cached ~1h (events don't change intra-hour). On failure we keep the last good
// cache (or empty) so the client falls back to its deterministic static schedule.
let _calCache = { at: 0, data: null };
const CAL_TTL_MS = 60 * 60 * 1000;
const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_lastweek.json',
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
];
const CCY_TO_COUNTRY = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CHF: 'CH', CAD: 'CA', AUD: 'AU', NZD: 'NZ', CNY: 'CN', INR: 'IN' };
const _calImpact = (s) => {
  const v = String(s || '').toLowerCase();
  if (v.includes('high')) return 'high';
  if (v.includes('medium') || v.includes('moderate')) return 'medium';
  if (v.includes('holiday')) return 'lowest';
  return 'low';
};
const _calNum = (s) => {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
async function _fetchFFCalendar() {
  const out = [];
  const seen = new Set();
  for (const url of FF_URLS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (TradePro calendar)' } });
      if (!res.ok) continue;
      const rows = await res.json();
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const currency = String(r.country || r.currency || '').toUpperCase();
        const dateStr = r.date || r.datetime;
        if (!currency || !dateStr) continue;
        const d = new Date(dateStr);
        if (Number.isNaN(d.getTime())) continue;
        const id = `${currency}-${r.title}-${d.toISOString()}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          date: d.toISOString(),
          country: CCY_TO_COUNTRY[currency] || currency,
          currency,
          impact: _calImpact(r.impact),
          event: String(r.title || 'Event'),
          period: '',
          unit: '',
          previous: _calNum(r.previous),
          consensus: null,
          forecast: _calNum(r.forecast),
          actual: _calNum(r.actual),
          previousLabel: r.previous || '—',
          consensusLabel: '—',
          forecastLabel: r.forecast || '—',
          actualLabel: r.actual || null,
          code: currency,
        });
      }
    } catch (_) { /* skip this window, keep others */ }
  }
  return out;
}
const economicCalendar = asyncHandler(async (req, res) => {
  const now = Date.now();
  if (!_calCache.data || now - _calCache.at > CAL_TTL_MS) {
    const data = await _fetchFFCalendar();
    if (data.length) _calCache = { at: now, data };            // only cache a good pull
    else if (!_calCache.data) _calCache = { at: now, data: [] }; // failed + nothing cached → don't hammer
  }
  sendSuccess(res, _calCache.data || []);
});

module.exports = { list, watchlist, getOne, search, volumeUsage, candles, orderbook, fundamentals, news, create, update, remove, bulkRouting, optionChain, syncIndian, economicCalendar };
