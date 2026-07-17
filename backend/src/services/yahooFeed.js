/**
 * yahooFeed.js — FREE live-price feed for Indian instruments via Yahoo Finance.
 * No API key. The zero-cost alternative to the paid Dhan Data API: since this is
 * a B-book (we never route real orders), we only need market DATA, not trading.
 *
 * Coverage:
 *   NSE / BSE equity      → real LTP           (RELIANCE.NS, TCS.NS, …)
 *   Index F&O underlying  → real index LTP     (NIFTY→^NSEI, BANKNIFTY→^NSEBANK)
 *   Futures               → underlying spot    (proxy — B-book approximation)
 *   Options               → intrinsic value    (max(spot−strike,0) etc, floored);
 *                            NO time value — Yahoo has no NSE option premiums, so
 *                            this only verifies the plumbing, not real pricing.
 *
 * Strategy: fetch each UNIQUE underlying spot once per cycle from Yahoo's public
 * v8 chart endpoint (no crumb needed — just a browser User-Agent), then derive
 * every instrument's price from that spot. Session-gated to NSE hours.
 *
 * Enabled when:  INDIAN_FEED=yahoo,  OR  (no Dhan creds AND INDIAN_FEED!=dhan).
 *
 * Env:
 *   INDIAN_FEED=yahoo|dhan      force a provider (default: auto)
 *   YAHOO_POLL_MS=5000
 *   YAHOO_MAX_SYMBOLS=300       safety cap on unique Yahoo requests / cycle
 *   YAHOO_CONCURRENCY=5
 */
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

const POLL_MS = Number(process.env.YAHOO_POLL_MS) || 5000;
const TIMEOUT_MS = Number(process.env.YAHOO_TIMEOUT_MS) || 7000;
const MAX = Number(process.env.YAHOO_MAX_SYMBOLS) || 300;
const CONC = Number(process.env.YAHOO_CONCURRENCY) || 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Underlying → Yahoo index ticker. Unknown underlyings fall back to `<U>.NS`.
const INDEX_YH = {
  NIFTY: '^NSEI', 'NIFTY 50': '^NSEI', NIFTY50: '^NSEI',
  BANKNIFTY: '^NSEBANK', 'NIFTY BANK': '^NSEBANK',
  FINNIFTY: '^CNXFIN', 'NIFTY FIN SERVICE': '^CNXFIN',
  MIDCPNIFTY: '^NSEMDCP50',
  SENSEX: '^BSESN',
};

let broadcaster = null;
let active = false;
let _timer = null;
let _warnedCap = false;

const setBroadcaster = (b) => { broadcaster = b; };

function _enabled() {
  const f = (process.env.INDIAN_FEED || '').toLowerCase();
  if (f === 'yahoo') return true;
  if (f === 'dhan' || f === 'upstox') return false;
  return !(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN); // auto
}

// Yahoo spot ticker for an instrument's underlying (null if underivable).
function spotSymbol(inst) {
  if (inst.segment === 'EQ') return `${inst.symbol}${inst.exchange === 'BSE' ? '.BO' : '.NS'}`;
  const u = String(inst.underlying || '').toUpperCase();
  if (!u) return null;
  return INDEX_YH[u] || `${u}.NS`;
}

// Derive an instrument's price from its underlying spot.
function priceFor(inst, spot) {
  if (spot == null) return null;
  if (inst.segment === 'OPT') {
    const k = Number(inst.strike) || 0;
    const intr = inst.optionType === 'PE' ? Math.max(0, k - spot) : Math.max(0, spot - k);
    return Math.max(intr, Number(inst.tickSize) || 0.05); // floor so OTM stays tradeable
  }
  return spot; // EQ + FUT(proxy)
}

async function _yahooQuote(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json();
    const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!m) return null;
    const px = m.regularMarketPrice != null ? m.regularMarketPrice : m.previousClose;
    return px != null ? Number(px) : null;
  } catch (_) {
    return null;
  } finally { clearTimeout(t); }
}

// Bounded-concurrency map.
async function _mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  });
  await Promise.all(workers);
  return out;
}

async function _publishTick(inst, ltp) {
  const price = Number(ltp).toFixed(inst.pricePrecision || 2);
  await Instrument.updateOne({ _id: inst._id }, { $set: { lastPrice: price, lastPriceUpdatedAt: new Date() } });
  try { await updateCandlesForTrade({ symbol: inst.symbol, price, quantity: '0', ts: Date.now() }); } catch (_) { /* */ }
  if (broadcaster) broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: price, ts: Date.now(), source: 'YAHOO' });
}

async function _pollOnce() {
  const insts = await Instrument.find({
    exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO'] }, isActive: true,
  }).select('_id symbol exchange segment underlying strike optionType pricePrecision tickSize').lean();
  if (!insts.length) return;

  // Map each instrument → its underlying spot symbol; collect the unique set.
  const symFor = new Map();
  const uniq = new Set();
  for (const i of insts) {
    const s = spotSymbol(i);
    symFor.set(String(i._id), s);
    if (s) uniq.add(s);
  }

  // Indices first, then equities; cap to protect against rate-limit/ban.
  let list = [...uniq];
  if (list.length > MAX) {
    const idx = list.filter((s) => s.startsWith('^'));
    const rest = list.filter((s) => !s.startsWith('^'));
    list = [...idx, ...rest].slice(0, MAX);
    if (!_warnedCap) { console.warn(`[Yahoo] ${uniq.size} symbols > cap ${MAX}; polling first ${MAX}. Raise YAHOO_MAX_SYMBOLS or curate instruments.`); _warnedCap = true; }
  }

  const prices = await _mapPool(list, CONC, async (s) => [s, await _yahooQuote(s)]);
  const spotMap = new Map(prices);

  let wrote = 0;
  for (const i of insts) {
    const s = symFor.get(String(i._id));
    const px = priceFor(i, s ? spotMap.get(s) : null);
    if (px == null) continue;
    await _publishTick(i, px); wrote += 1;
  }
  if (wrote) { try { require('./feedOrchestrator').recordTick('YAHOO'); } catch (_) {} }
}

// Global instruments (any asset class) that opt into the FREE Yahoo feed via
// externalProvider='YAHOO' + externalFeedSymbol=<Yahoo ticker>. Examples:
//   stock AAPL · index ^GSPC/^NSEI · forex EURUSD=X · gold GC=F · crypto BTC-USD
// NOT NSE-gated — each ticker's own market decides freshness (Yahoo returns the
// last close outside hours). This is what makes "add from the admin form → live
// price, no API key" work for global forex/stocks/indices/commodities/crypto.
// Returns how many such instruments exist so the loop can idle-back-off.
async function _pollGlobalYahoo() {
  const insts = await Instrument.find({
    externalProvider: 'YAHOO', externalFeedSymbol: { $exists: true, $ne: null }, isActive: true,
  }).select('_id symbol externalFeedSymbol pricePrecision').lean();
  if (!insts.length) return 0;
  const uniq = [...new Set(insts.map((i) => String(i.externalFeedSymbol).trim()).filter(Boolean))].slice(0, MAX);
  const prices = new Map(await _mapPool(uniq, CONC, async (s) => [s, await _yahooQuote(s)]));
  let wrote = 0;
  for (const i of insts) {
    const px = prices.get(String(i.externalFeedSymbol).trim());
    if (px == null) continue;
    await _publishTick(i, px); wrote += 1;   // spot instruments → price is the LTP as-is
  }
  if (wrote) { try { require('./feedOrchestrator').recordTick('YAHOO'); } catch (_) {} }
  return insts.length;
}

async function _loop() {
  if (!active) return;
  // 1) Global YAHOO-provider instruments — always polled (own market decides freshness).
  let globalN = 0;
  try { globalN = await _pollGlobalYahoo(); }
  catch (e) { console.error('[Yahoo] global poll error:', e.message); }

  // 2) Indian instruments — only when Yahoo is the ACTIVE Indian provider AND
  //    NSE is open (unchanged behaviour; off in prod where INDIAN_FEED=upstox).
  let indianOpen = false;
  if (_enabled()) {
    try { indianOpen = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { indianOpen = true; }
    if (indianOpen) {
      try {
        await _pollOnce();
        try { require('./feedOrchestrator').recordConnection('YAHOO', true); } catch (_) {}
      } catch (e) {
        console.error('[Yahoo] poll error:', e.message);
        try { require('./feedOrchestrator').recordError('YAHOO', e); } catch (_) {}
      }
    }
  }
  // Fast cadence while something is live to poll; idle-back-off otherwise.
  _timer = setTimeout(_loop, (globalN || indianOpen) ? POLL_MS : 60000);
}

const start = () => {
  if (active) return;
  active = true;
  console.log(`[Yahoo] FREE feed started (poll ${POLL_MS}ms, no API key) — global via externalProvider=YAHOO; Indian NSE-gated when active.`);
  _loop().catch((e) => console.error('[Yahoo] start error:', e.message));
};

const stop = () => { active = false; if (_timer) { clearTimeout(_timer); _timer = null; } };

// ─── Fundamentals (real, on-demand) ──────────────────────────────────
// Two sources, both free:
//   1. v8 chart `meta` — reliable, no auth: 52-week hi/lo, prev close,
//      day hi/lo, volume, currency.
//   2. v10 quoteSummary — needs a cookie+crumb: market cap, P/E, EPS,
//      P/B, book value, ROE, dividend yield. Best-effort; if Yahoo blocks
//      the crumb the caller still gets the reliable chart fields.
const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
let _crumbCache = { cookie: null, crumb: null, at: 0 };

function _yahooSymbol(inst) {
  if (!inst) return null;
  if (inst.segment === 'EQ') return `${inst.symbol}${inst.exchange === 'BSE' ? '.BO' : '.NS'}`;
  return spotSymbol(inst) || null;
}

async function _fetchJson(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; } finally { clearTimeout(t); }
}

async function _getCrumb() {
  // Cache the cookie+crumb for 10 min — it's valid across symbols.
  if (_crumbCache.crumb && (Date.now() - _crumbCache.at) < 10 * 60 * 1000) return _crumbCache;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const c = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, signal: ctl.signal }).catch(() => null);
    const cookie = c && c.headers.get('set-cookie');
    if (!cookie) return { cookie: null, crumb: null };
    const cookieVal = cookie.split(';')[0];
    const r = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookieVal }, signal: ctl.signal }).catch(() => null);
    const crumb = r && r.ok ? (await r.text()).trim() : null;
    if (crumb && crumb.length && !crumb.includes('<')) {
      _crumbCache = { cookie: cookieVal, crumb, at: Date.now() };
      return _crumbCache;
    }
    return { cookie: cookieVal, crumb: null };
  } catch (_) { return { cookie: null, crumb: null }; } finally { clearTimeout(t); }
}

async function getFundamentals(inst) {
  const ySym = _yahooSymbol(inst);
  if (!ySym) return null;
  const out = { yahooSymbol: ySym };

  // 1) Reliable chart meta (no auth).
  const chart = await _fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=1y`);
  const m = chart && chart.chart && chart.chart.result && chart.chart.result[0] && chart.chart.result[0].meta;
  if (m) {
    out.currency = m.currency || null;
    out.lastPrice = _num(m.regularMarketPrice);
    out.prevClose = _num(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose);
    out.dayHigh = _num(m.regularMarketDayHigh);
    out.dayLow = _num(m.regularMarketDayLow);
    out.week52High = _num(m.fiftyTwoWeekHigh);
    out.week52Low = _num(m.fiftyTwoWeekLow);
    out.volume = _num(m.regularMarketVolume);
  }

  // 2) Best-effort quoteSummary (cookie+crumb) for the fundamentals card.
  try {
    const { cookie, crumb } = await _getCrumb();
    if (crumb && cookie) {
      const mods = 'summaryDetail,defaultKeyStatistics,financialData,price,earnings,calendarEvents';
      const j = await _fetchJson(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ySym)}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`,
        { Cookie: cookie }
      );
      const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
      if (r) {
        const sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, pr = r.price || {};
        const raw = (o, k) => (o && o[k] && typeof o[k] === 'object' ? o[k].raw : o && o[k]);
        out.marketCap = _num(raw(pr, 'marketCap') ?? raw(sd, 'marketCap'));
        out.peRatio = _num(raw(sd, 'trailingPE') ?? raw(ks, 'trailingPE'));
        out.eps = _num(raw(ks, 'trailingEps'));
        out.pbRatio = _num(raw(ks, 'priceToBook'));
        out.bookValue = _num(raw(ks, 'bookValue'));
        out.roe = _num(raw(fd, 'returnOnEquity'));
        out.debtToEquity = _num(raw(fd, 'debtToEquity'));
        out.dividendYield = _num(raw(sd, 'dividendYield') ?? raw(sd, 'trailingAnnualDividendYield'));
        out.revenueGrowth = _num(raw(fd, 'revenueGrowth'));
        out.earningsGrowth = _num(raw(fd, 'earningsGrowth'));
        // Quarterly + yearly revenue/profit for the financials chart.
        const er = r.earnings || {};
        const fc = er.financialsChart || {};
        const mapFC = (arr) => (Array.isArray(arr) ? arr : []).map((q) => ({
          label: q && q.date != null ? String(q.date) : '',
          revenue: _num(raw(q, 'revenue')),
          profit: _num(raw(q, 'earnings')),
        })).filter((q) => q.revenue != null || q.profit != null);
        out.finQuarterly = mapFC(fc.quarterly);
        out.finYearly = mapFC(fc.yearly);
        // Upcoming events (earnings / dividend). Yahoo timestamps = seconds.
        const ce = r.calendarEvents || {};
        const ts = (v) => (v != null ? new Date(_num(v) * 1000).toISOString() : null);
        out.earningsDate = ts(ce.earnings && ce.earnings.earningsDate && ce.earnings.earningsDate[0] && raw(ce.earnings.earningsDate[0], 'raw'));
        out.exDividendDate = ts(raw(ce, 'exDividendDate'));
        out.dividendDate = ts(raw(ce, 'dividendDate'));
      }
    }
  } catch (_) { /* keep chart fields */ }

  return out;
}

// Real stock news via Yahoo's public search endpoint (no crumb needed).
async function getNews(inst) {
  const ySym = _yahooSymbol(inst) || (inst && inst.symbol);
  if (!ySym) return [];
  const j = await _fetchJson(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ySym)}&newsCount=10&quotesCount=0&enableFuzzyQuery=false`);
  const news = (j && Array.isArray(j.news)) ? j.news : [];
  return news.map((n) => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    thumbnail: (n.thumbnail && n.thumbnail.resolutions && n.thumbnail.resolutions[0] && n.thumbnail.resolutions[0].url) || null,
  })).filter((n) => n.title && n.link);
}

module.exports = { start, stop, setBroadcaster, isActive: () => active, _enabled, spotSymbol, priceFor, getFundamentals, getNews };
