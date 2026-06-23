/**
 * upstoxFeed.js — FREE real-time-ish live prices for Indian instruments via the
 * Upstox Market-Quote API. Upstox does NOT charge for market data (unlike Dhan's
 * paid Data API), so this gives real exchange prices for ₹0 — at the cost of a
 * DAILY access token (Upstox tokens expire ~03:30 IST every day; regenerate &
 * update UPSTOX_ACCESS_TOKEN, then restart / it picks up on next poll).
 *
 * Coverage (mirrors yahooFeed):
 *   NSE/BSE equity      → real LTP via instrument key  NSE_EQ|<ISIN>
 *   Index underlyings   → real LTP                     NSE_INDEX|Nifty 50 …
 *   Futures             → underlying-spot proxy
 *   Options             → intrinsic value (floored)
 * (Real F&O contract prices need Upstox's own instrument tokens — a separate
 *  master-file mapping — so derivatives use the spot-proxy for now.)
 *
 * Equity keys use the ISIN imported from Dhan's scrip master (Instrument.isin),
 * so run the importer/sync once after adding ISIN before enabling this feed.
 *
 * Enabled when INDIAN_FEED=upstox.
 *
 * Env:
 *   INDIAN_FEED=upstox
 *   UPSTOX_ACCESS_TOKEN=...     (daily OAuth token)
 *   UPSTOX_POLL_MS=1500
 */
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

const BASE = 'https://api.upstox.com';
const POLL_MS = Number(process.env.UPSTOX_POLL_MS) || 1500;
const TIMEOUT_MS = Number(process.env.UPSTOX_TIMEOUT_MS) || 7000;
const CHUNK = 500; // Upstox LTP accepts up to ~500 instrument keys / request

// Underlying → Upstox index instrument_key.
const INDEX_UP = {
  NIFTY: 'NSE_INDEX|Nifty 50', 'NIFTY 50': 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank', 'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service', 'NIFTY FIN SERVICE': 'NSE_INDEX|Nifty Fin Service',
  MIDCPNIFTY: 'NSE_INDEX|Nifty Midcap 50',
  SENSEX: 'BSE_INDEX|SENSEX',
};

let broadcaster = null;
let active = false;
let _timer = null;

const setBroadcaster = (b) => { broadcaster = b; };

function _enabled() {
  return (process.env.INDIAN_FEED || '').toLowerCase() === 'upstox';
}
const _tokenPresent = () => !!process.env.UPSTOX_ACCESS_TOKEN;

// Upstox instrument key for an instrument's underlying spot.
function spotKeyFor(inst, isinBySym) {
  if (inst.segment === 'EQ') {
    if (!inst.isin) return null;
    return `${inst.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ'}|${inst.isin}`;
  }
  const u = String(inst.underlying || '').toUpperCase();
  if (!u) return null;
  if (INDEX_UP[u]) return INDEX_UP[u];
  const isin = isinBySym && isinBySym.get(u); // stock-derivative underlying
  return isin ? `NSE_EQ|${isin}` : null;
}

// Derive an instrument's price from its underlying spot (same rules as yahooFeed).
function priceFor(inst, spot) {
  if (spot == null) return null;
  if (inst.segment === 'OPT') {
    const k = Number(inst.strike) || 0;
    const intr = inst.optionType === 'PE' ? Math.max(0, k - spot) : Math.max(0, spot - k);
    return Math.max(intr, Number(inst.tickSize) || 0.05);
  }
  return spot; // EQ + FUT(proxy) + index
}

// Fetch LTP for a list of instrument keys → Map(key → price).
async function _ltp(keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const url = `${BASE}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(chunk.join(','))}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`, Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (res.status === 401) throw new Error('401 — UPSTOX_ACCESS_TOKEN expired/invalid (regenerate daily token)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const data = (j && j.data) || {};
      for (const v of Object.values(data)) {
        const k = v && v.instrument_token;            // echoes the key we sent
        const px = v && (v.last_price != null ? v.last_price : v.ltp);
        if (k && px != null) out.set(k, Number(px));
      }
    } finally { clearTimeout(t); }
  }
  return out;
}

// Bounded-concurrency map (keeps candle writes from running all-at-once).
async function _mapPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}

async function _pollOnce() {
  const insts = await Instrument.find({
    exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO'] }, isActive: true,
  }).select('_id symbol exchange segment underlying strike optionType isin pricePrecision tickSize lastPrice').lean();
  if (!insts.length) return;

  const isinBySym = new Map();
  for (const i of insts) if (i.segment === 'EQ' && i.isin) isinBySym.set(i.symbol, i.isin);

  const keyFor = new Map();
  const uniq = new Set();
  for (const i of insts) {
    const k = spotKeyFor(i, isinBySym);
    keyFor.set(String(i._id), k);
    if (k) uniq.add(k);
  }
  if (!uniq.size) return;

  const priceByKey = await _ltp([...uniq]);

  // Only touch instruments whose price actually CHANGED — bulk-write the price
  // updates (one op, not ~6k sequential writes), then candle + broadcast for the
  // changed ones. Most options' intrinsic is stable → skipped → cycle stays fast.
  const now = new Date();
  const bulk = [];
  const changed = [];
  for (const i of insts) {
    const k = keyFor.get(String(i._id));
    const px = priceFor(i, k ? priceByKey.get(k) : null);
    if (px == null) continue;
    const priceStr = Number(px).toFixed(i.pricePrecision || 2);
    if (priceStr === String(i.lastPrice)) continue; // unchanged — skip
    bulk.push({ updateOne: { filter: { _id: i._id }, update: { $set: { lastPrice: priceStr, lastPriceUpdatedAt: now } } } });
    changed.push([i, priceStr]);
  }
  if (!bulk.length) return;
  for (let b = 0; b < bulk.length; b += 1000) await Instrument.bulkWrite(bulk.slice(b, b + 1000), { ordered: false });
  // Candle writes are the per-cycle bottleneck (one DB upsert each) — run them
  // with bounded concurrency instead of sequentially so the cycle stays snappy.
  await _mapPool(changed, 12, async ([i, priceStr]) => {
    // Skip candle aggregation for OPTIONS — there are thousands, their intrinsic
    // barely moves, and their charts are rarely viewed. Writing candles for all of
    // them (×8 timeframes, each with a gap-backfill) is what overloads a small box.
    // They still get lastPrice (bulk-written above) + a live ticker broadcast.
    if (i.segment !== 'OPT') {
      try { await updateCandlesForTrade({ symbol: i.symbol, price: priceStr, quantity: '0', ts: Date.now() }); } catch (_) { /* */ }
    }
    if (broadcaster) broadcaster.publish(`ticker:${i.symbol}`, { lastPrice: priceStr, ts: Date.now(), source: 'UPSTOX' });
  });
  try { require('./feedOrchestrator').recordTick('UPSTOX'); } catch (_) {}
}

async function _loop() {
  if (!active) return;
  let open = true;
  try { open = require('./marketHours').isExchangeOpen('NSE'); } catch (_) { /* default open */ }
  if (open) {
    try {
      await _pollOnce();
      try { require('./feedOrchestrator').recordConnection('UPSTOX', true); } catch (_) {}
    } catch (e) {
      console.error('[Upstox] poll error:', e.message);
      try { require('./feedOrchestrator').recordError('UPSTOX', e); } catch (_) {}
    }
  }
  _timer = setTimeout(_loop, open ? POLL_MS : 60000);
}

const start = () => {
  if (!_enabled()) return; // only when INDIAN_FEED=upstox
  if (!_tokenPresent()) {
    console.log('[Upstox] INDIAN_FEED=upstox but no UPSTOX_ACCESS_TOKEN — Indian feed disabled (set the daily token).');
    return;
  }
  if (active) return;
  active = true;
  console.log(`[Upstox] starting FREE real-time Indian feed (poll ${POLL_MS}ms, NSE session-gated)`);
  _loop().catch((e) => console.error('[Upstox] start error:', e.message));
};

const stop = () => { active = false; if (_timer) { clearTimeout(_timer); _timer = null; } };

module.exports = { start, stop, setBroadcaster, isActive: () => active, _enabled, spotKeyFor, priceFor };
