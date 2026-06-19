const WebSocket = require('ws');
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');
const { backfillInstrument } = require('./binanceBackfill');

/**
 * Binance WebSocket Feed Adapter
 *
 * Connects to Binance's public WS stream and updates lastPrice on instruments
 * that have externalFeedSymbol set and externalProvider === 'BINANCE'.
 *
 * Used in HYBRID and EXTERNAL trading modes (per doc §7.7, §4.3).
 *
 * Supported streams: <symbol>@ticker (24hr ticker), <symbol>@trade
 *
 * Limitations:
 *  - Public stream only (no orderbook depth)
 *  - For production with high-volume Forex, use a paid feed provider
 *
 * To enable, set Instrument.externalProvider='BINANCE' and externalFeedSymbol='BTCUSDT' (e.g.)
 */

let ws = null;
let broadcaster = null;
let reconnectTimer = null;
let symbolMap = new Map(); // upper externalFeedSymbol -> instrument._id
let symbolReverseMap = new Map(); // upper externalFeedSymbol -> instrument.symbol (platform symbol)
let enabled = false;
// Platform symbols whose historical candles have already been seeded from
// Binance REST this process — so we backfill each symbol exactly once.
const backfilled = new Set();
// In-memory orderbook cache — keyed by platform symbol (e.g. 'BTCUSD'),
// holds the latest L2 depth snapshot from Binance so REST `/orderbook`
// can return real data even before any WS subscriber comes online.
const orderbookCache = new Map(); // platformSymbol -> { bids, asks, ts }
// 24h ticker cache — Binance's <symbol>@ticker stream emits a rich
// "24hrTicker" event with the actual exchange-computed percent change,
// day high/low, and 24h volume. Far more accurate than our internal
// candle aggregation, so we cache it and the watchlist endpoint
// reads from here as the source of truth for crypto.
const tickerCache = new Map(); // platformSymbol -> { change24h, dayHigh, dayLow, volume24h, bid, ask, ts }
// Cap each snapshot at 20 levels per side — matches Binance's smallest
// pre-aggregated stream and keeps memory bounded across many symbols.
const ORDERBOOK_DEPTH = 20;

const setBroadcaster = (b) => {
  broadcaster = b;
};

// Build a single stream list (trade + ticker + depth per symbol) used
// directly in the connection URL — far more reliable than sending a
// follow-up SUBSCRIBE message, which Binance has been observed to
// silently drop for partial-depth streams on the combined endpoint.
const _buildStreamList = () => {
  const params = [];
  for (const [extSym] of symbolMap) {
    const s = extSym.toLowerCase();
    params.push(`${s}@trade`);
    params.push(`${s}@ticker`);
    // L2 depth — top 20 levels, refreshed every 100ms. Drives the
    // Market Depth panel for every crypto instrument in real time.
    params.push(`${s}@depth20@100ms`);
  }
  return params.join('/');
};

const _connect = () => {
  // Combined stream endpoint (`/stream`) with all subscriptions baked
  // into the URL query string (`?streams=...`). Each payload arrives
  // wrapped as `{ stream, data }`. Binance allows up to 1024 streams
  // per connection — 13 symbols × 3 streams = 39 streams, well under.
  const base = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/stream';
  const streams = _buildStreamList();
  const url = streams ? `${base}?streams=${streams}` : base;
  console.log(`[ExternalFeed] Connecting to combined stream (${symbolMap.size} symbols, ${streams.split('/').length} streams)`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[ExternalFeed] ✓ Connected to Binance combined stream');
    if (symbolMap.size) {
      const symbols = [...symbolMap.keys()].join(', ');
      console.log(`[ExternalFeed] ✓ Streams active for ${symbolMap.size} symbols: ${symbols}`);
      console.log('[ExternalFeed]   @trade · @ticker · @depth20@100ms per symbol (subscribed via URL)');
      console.log('[ExternalFeed]   Expecting first depth/ticker messages within 1-2 seconds...');
    } else {
      console.log('[ExternalFeed] ⚠ No symbols subscribed — set externalProvider=BINANCE on instruments');
    }
  });

  // One-shot trace flags — log the FIRST occurrence of each message
  // type so the operator can verify the WS handshake worked end-to-end.
  let _loggedFirstAny = false;
  let _loggedFirstDepth = false;
  let _loggedFirstTicker = false;

  ws.on('message', async (raw) => {
    try {
      const wrapper = JSON.parse(raw.toString());

      if (!_loggedFirstAny) {
        _loggedFirstAny = true;
        console.log('[ExternalFeed] ✓ First message received from Binance:', JSON.stringify(wrapper).slice(0, 200));
      }

      // SUBSCRIBE / UNSUBSCRIBE acknowledgements: { result: null, id: 1 }
      if (wrapper.result !== undefined) {
        console.log('[ExternalFeed] ✓ SUBSCRIBE ack:', JSON.stringify(wrapper));
        return;
      }
      if (wrapper.stream?.includes('depth') && !_loggedFirstDepth) {
        _loggedFirstDepth = true;
        console.log(`[ExternalFeed] ✓ First DEPTH stream message: ${wrapper.stream}`);
      }
      if (wrapper.stream?.includes('ticker') && !_loggedFirstTicker) {
        _loggedFirstTicker = true;
        console.log(`[ExternalFeed] ✓ First TICKER stream message: ${wrapper.stream}`);
      }

      // Combined-stream payloads are wrapped: { stream, data }.
      // Older raw-stream payloads come through directly without wrapping.
      const stream = wrapper.stream || null;
      const msg = wrapper.data || wrapper;

      // ── Depth event (partial book stream <symbol>@depth20@100ms) ────
      // Combined-stream payload:
      //   { stream: 'btcusdt@depth20@100ms',
      //     data: { lastUpdateId, bids: [[price, qty], ...], asks: [...] } }
      if (Array.isArray(msg.bids) && Array.isArray(msg.asks)) {
        // Attribute to a symbol via the `stream` field (always present
        // on the combined endpoint). Fallback for single-symbol setups.
        let extSym = null;
        if (stream) extSym = stream.split('@')[0].toUpperCase();
        if (!extSym && symbolMap.size === 1) extSym = [...symbolMap.keys()][0];
        if (!extSym) return; // ambiguous — skip
        const platformSymbol = symbolReverseMap.get(extSym);
        if (!platformSymbol) return;

        const cleanLevel = ([p, q]) => ({
          price: Number(p),
          quantity: String(q),
          count: 1, // Binance pre-aggregates by price; count = single aggregate
        });
        const snap = {
          symbol: platformSymbol,
          bids: msg.bids.slice(0, ORDERBOOK_DEPTH).map(cleanLevel).filter((l) => Number.isFinite(l.price)),
          asks: msg.asks.slice(0, ORDERBOOK_DEPTH).map(cleanLevel).filter((l) => Number.isFinite(l.price)),
          ts: Date.now(),
          source: 'BINANCE',
        };
        const isFirst = !orderbookCache.has(platformSymbol);
        orderbookCache.set(platformSymbol, snap);
        if (broadcaster) {
          broadcaster.publish(`orderbook:${platformSymbol}`, snap);
        }
        if (isFirst) {
          console.log(`[ExternalFeed] First depth received for ${platformSymbol} (${snap.bids.length} bids / ${snap.asks.length} asks)`);
        }
        return;
      }

      // ── 24hr ticker event ──────────────────────────────────────────
      // Binance pushes a rich rolling-window stat every ~1s:
      //   { e: '24hrTicker', s: 'BTCUSDT', P: '2.45' (percent change),
      //     h: '78500' (24h high), l: '76000' (low),
      //     v: '12345.67' (base vol), q: '923.4M' (quote vol),
      //     b: '77540' (best bid), a: '77545' (best ask), c: 'last close', ... }
      // We cache + push these so the Movers panel + watchlist endpoint
      // have real exchange-side numbers instead of relying on our own
      // candle aggregation.
      if (msg.e === '24hrTicker' && msg.s) {
        const extSym = msg.s.toUpperCase();
        const platformSymbol = symbolReverseMap.get(extSym);
        if (!platformSymbol) return;
        const enriched = {
          change24h: Number(msg.P),
          dayHigh:   Number(msg.h),
          dayLow:    Number(msg.l),
          volume24h: Number(msg.v),
          bid:       Number(msg.b),
          ask:       Number(msg.a),
          ts:        msg.E || Date.now(),
        };
        const isFirst = !tickerCache.has(platformSymbol);
        tickerCache.set(platformSymbol, enriched);
        if (broadcaster) {
          // Augment ticker:<symbol> broadcasts with 24h enrichment so
          // the frontend can update Movers / Performance live without
          // refetching the watchlist endpoint.
          broadcaster.publish(`ticker:${platformSymbol}`, {
            lastPrice: msg.c,
            change24h: enriched.change24h,
            dayHigh:   enriched.dayHigh,
            dayLow:    enriched.dayLow,
            volume24h: enriched.volume24h,
            bid:       enriched.bid,
            ask:       enriched.ask,
            ts:        enriched.ts,
            source:    'BINANCE_TICKER',
          });
        }
        if (isFirst) {
          console.log(`[ExternalFeed] First 24h ticker for ${platformSymbol}: ${enriched.change24h.toFixed(2)}% (${enriched.dayLow} → ${enriched.dayHigh})`);
        }
        return;
      }

      // Trade event: { e: 'trade', s: 'BTCUSDT', p: '67234.50', q: '0.001', T: 1234567890 }
      if (msg.e === 'trade' && msg.s) {
        const instrumentId = symbolMap.get(msg.s.toUpperCase());
        if (!instrumentId) return;

        const inst = await Instrument.findById(instrumentId);
        if (!inst) return;

        inst.lastPrice = msg.p;
        inst.lastPriceUpdatedAt = new Date(msg.T || Date.now());
        await inst.save();

        // Aggregate into candles
        await updateCandlesForTrade({
          symbol: inst.symbol,
          price: msg.p,
          quantity: msg.q,
          ts: msg.T || Date.now(),
        });

        // Broadcast ticker + trade tape
        if (broadcaster) {
          broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: msg.p, ts: msg.T || Date.now() });
          broadcaster.publish(`trades:${inst.symbol}`, {
            symbol: inst.symbol,
            price: msg.p,
            quantity: msg.q,
            ts: msg.T || Date.now(),
            source: 'EXTERNAL',
          });
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('close', () => {
    if (!enabled) return;
    console.log('[ExternalFeed] Disconnected, reconnecting in 5s...');
    reconnectTimer = setTimeout(_connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('[ExternalFeed] Error:', err.message);
    if (ws) ws.close();
  });
};

const _refreshSymbolMap = async () => {
  // Find all instruments configured to use Binance
  const instruments = await Instrument.find({
    externalProvider: 'BINANCE',
    externalFeedSymbol: { $exists: true, $ne: null },
    isActive: true,
  }).lean();

  const newMap = new Map();
  const newReverse = new Map();
  for (const inst of instruments) {
    if (inst.externalFeedSymbol) {
      const ext = inst.externalFeedSymbol.toUpperCase();
      newMap.set(ext, inst._id);
      newReverse.set(ext, inst.symbol);
    }
  }
  symbolMap = newMap;
  symbolReverseMap = newReverse;
};

// Seed historical candles (once per symbol per process) for every mapped
// Binance instrument so a freshly-added symbol's chart is populated with real
// history immediately, instead of waiting for live ticks to build it. Runs in
// the background — never blocks the feed connection.
const _backfillNew = () => {
  for (const [extSym, platformSymbol] of symbolReverseMap) {
    if (backfilled.has(platformSymbol)) continue;
    backfilled.add(platformSymbol);
    backfillInstrument(platformSymbol, extSym).catch((e) =>
      console.error(`[ExternalFeed] Backfill ${platformSymbol} failed: ${e.message}`));
  }
};

/**
 * Latest cached orderbook for a platform symbol (e.g. 'BTCUSD').
 * Returns `null` if no Binance depth has been received yet for the
 * symbol, or the symbol isn't on the Binance feed at all.
 */
const getExternalOrderbook = (platformSymbol) => {
  if (!platformSymbol) return null;
  return orderbookCache.get(platformSymbol.toUpperCase()) || null;
};

/**
 * Latest cached 24h ticker stats for a platform symbol.
 * Returns { change24h, dayHigh, dayLow, volume24h, bid, ask, ts } or null.
 */
const getExternalTicker = (platformSymbol) => {
  if (!platformSymbol) return null;
  return tickerCache.get(platformSymbol.toUpperCase()) || null;
};

const start = async () => {
  await _refreshSymbolMap();
  if (symbolMap.size === 0) {
    console.log('[ExternalFeed] No instruments configured for BINANCE provider yet.');
    console.log('[ExternalFeed] Will keep scanning every 60s — add an instrument with');
    console.log('[ExternalFeed]   externalProvider="BINANCE", externalFeedSymbol="BTCUSDT", isActive=true');
    console.log('[ExternalFeed]   and the feed starts automatically (no restart needed).');
  } else {
    enabled = true;
    _connect();
    _backfillNew(); // seed history for symbols present at boot
  }

  // Re-check symbol mapping every 60s in case admin adds/removes external
  // instruments at runtime. This runs even when NO Binance instruments existed
  // at boot, so adding the FIRST one starts the feed without a restart.
  // URL-based subs can't be modified on a live connection, so we tear down +
  // reconnect when the list changes — picks up new symbols + drops removed ones.
  setInterval(async () => {
    const before = symbolMap.size;
    await _refreshSymbolMap();
    if (symbolMap.size === before) return;
    console.log(`[ExternalFeed] Symbol map changed (${before} -> ${symbolMap.size})`);
    if (!enabled && symbolMap.size > 0) {
      // First Binance instrument added at runtime — start the feed now.
      enabled = true;
      _connect();
    } else if (ws) {
      // Already running — reconnect to apply the new stream list.
      console.log('[ExternalFeed] Reconnecting to apply new stream list...');
      try { ws.close(); } catch (_) { /* will auto-reconnect via on('close') */ }
    }
    _backfillNew(); // seed history for any newly-added symbols
  }, 60000);
};

const stop = () => {
  enabled = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
};

module.exports = { start, stop, setBroadcaster, getExternalOrderbook, getExternalTicker };
