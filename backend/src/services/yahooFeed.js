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

async function _loop() {
  if (!active) return;
  let open = true;
  try { open = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { /* default open */ }
  if (open) {
    try {
      await _pollOnce();
      try { require('./feedOrchestrator').recordConnection('YAHOO', true); } catch (_) {}
    } catch (e) {
      console.error('[Yahoo] poll error:', e.message);
      try { require('./feedOrchestrator').recordError('YAHOO', e); } catch (_) {}
    }
  }
  _timer = setTimeout(_loop, open ? POLL_MS : 60000);
}

const start = () => {
  if (!_enabled()) {
    console.log('[Yahoo] Indian feed handled by Dhan (or disabled) — Yahoo feed off.');
    return;
  }
  if (active) return;
  active = true;
  console.log(`[Yahoo] starting FREE Indian feed (poll ${POLL_MS}ms, NSE session-gated, no API key)`);
  _loop().catch((e) => console.error('[Yahoo] start error:', e.message));
};

const stop = () => { active = false; if (_timer) { clearTimeout(_timer); _timer = null; } };

module.exports = { start, stop, setBroadcaster, isActive: () => active, _enabled, spotSymbol, priceFor };
