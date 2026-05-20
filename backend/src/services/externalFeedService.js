const WebSocket = require('ws');
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

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

const _buildSubscribeMessage = () => {
  const params = [];
  for (const [extSym] of symbolMap) {
    params.push(`${extSym.toLowerCase()}@trade`);
    params.push(`${extSym.toLowerCase()}@ticker`);
    // L2 depth — top 20 levels, refreshed every 100ms. Drives the
    // Market Depth panel for every crypto instrument in real time.
    params.push(`${extSym.toLowerCase()}@depth20@100ms`);
  }
  return JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 });
};

const _connect = () => {
  // Use the COMBINED stream endpoint (`/stream` not `/ws`) so every
  // payload is wrapped with `{ stream, data }`. The raw endpoint omits
  // the symbol on partial-depth streams which breaks attribution when
  // multiple symbols are subscribed.
  const url = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/stream';
  console.log(`[ExternalFeed] Connecting to ${url}...`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[ExternalFeed] Connected to Binance');
    if (symbolMap.size) {
      ws.send(_buildSubscribeMessage());
      console.log(`[ExternalFeed] Subscribed to ${symbolMap.size} symbols`);
    }
  });

  ws.on('message', async (raw) => {
    try {
      const wrapper = JSON.parse(raw.toString());

      // SUBSCRIBE / UNSUBSCRIBE acknowledgements: { result: null, id: 1 }
      if (wrapper.result !== undefined) return;

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
    console.log('[ExternalFeed] No instruments configured for BINANCE provider - feed disabled.');
    console.log('[ExternalFeed] To enable: PUT /api/instruments/<symbol> with externalProvider="BINANCE" and externalFeedSymbol="BTCUSDT"');
    return;
  }
  enabled = true;
  _connect();

  // Re-check symbol mapping every 60s in case admin adds new external instruments
  setInterval(async () => {
    const before = symbolMap.size;
    await _refreshSymbolMap();
    if (symbolMap.size !== before && ws && ws.readyState === WebSocket.OPEN) {
      console.log(`[ExternalFeed] Symbol map changed (${before} -> ${symbolMap.size}), re-subscribing`);
      ws.send(_buildSubscribeMessage());
    }
  }, 60000);
};

const stop = () => {
  enabled = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
};

module.exports = { start, stop, setBroadcaster, getExternalOrderbook, getExternalTicker };
