/**
 * Finnhub WebSocket Feed Adapter
 *
 * Real-time forex/crypto/stock prices via Finnhub WS.
 * FREE tier: 30 symbols, sub-second updates, Indian users allowed.
 *
 * Setup:
 *   1. Sign up free: https://finnhub.io/
 *   2. Get API key from dashboard
 *   3. Set FINNHUB_API_KEY in .env
 *
 * For each instrument:
 *   externalProvider: 'FINNHUB'
 *   externalFeedSymbol:
 *     'OANDA:EUR_USD' (forex via OANDA aggregator)
 *     'BINANCE:BTCUSDT' (crypto)
 *     'AAPL' (stocks)
 */

const WebSocket = require('ws');
const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 30 * 1000;

let ws = null;
let broadcaster = null;
let reconnectTimer = null;
let _lastErrLog = 0; // throttle repetitive WS error logs (e.g. 429 rate-limit floods)
let pingTimer = null;
let symbolMap = new Map();
let active = false;

const setBroadcaster = (b) => { broadcaster = b; };

const _refreshSymbolMap = async () => {
  const instruments = await Instrument.find({
    externalProvider: 'FINNHUB',
    externalFeedSymbol: { $exists: true, $ne: null },
    isActive: true,
  }).select('_id symbol externalFeedSymbol pricePrecision').lean();

  symbolMap.clear();
  for (const inst of instruments) {
    symbolMap.set(inst.externalFeedSymbol, {
      _id: inst._id,
      symbol: inst.symbol,
      precision: inst.pricePrecision || 5,
    });
  }
  return Array.from(symbolMap.keys());
};

const _handleMessage = async (rawData) => {
  let msg;
  try { msg = JSON.parse(rawData.toString()); }
  catch (e) { return; }

  if (msg.type === 'ping') {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (msg.type !== 'trade' || !Array.isArray(msg.data)) return;

  const latest = new Map();
  for (const t of msg.data) {
    if (t.s && t.p) latest.set(t.s, t);
  }

  for (const [finnhubSymbol, trade] of latest) {
    const mapping = symbolMap.get(finnhubSymbol);
    if (!mapping) continue;

    try { require('./feedOrchestrator').recordTick('FINNHUB'); } catch (_) {}

    const formattedPrice = Number(trade.p).toFixed(mapping.precision);

    await Instrument.updateOne(
      { _id: mapping._id },
      { $set: { lastPrice: formattedPrice, lastPriceUpdatedAt: new Date() } }
    );

    try {
      await updateCandlesForTrade({
        symbol: mapping.symbol,
        price: formattedPrice,
        quantity: '0',
        ts: trade.t || Date.now(),
      });
    } catch (e) { /* ignore */ }

    if (broadcaster) {
      broadcaster.publish(`ticker:${mapping.symbol}`, {
        lastPrice: formattedPrice,
        ts: trade.t || Date.now(),
        source: 'FINNHUB',
      });
    }
  }
};

const _connect = async () => {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) return;

  const symbols = await _refreshSymbolMap();
  if (symbols.length === 0) {
    console.log('[Finnhub] No instruments configured for FINNHUB — sleeping 30s');
    // Clear any prior pending reconnect first to avoid a leaked timer when
    // start()/stop()/start() interleaves with the empty-symbol path.
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; _connect(); }, 30000);
    return;
  }

  const url = `wss://ws.finnhub.io?token=${apiKey}`;
  console.log(`[Finnhub] Connecting (${symbols.length} symbols)...`);

  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[Finnhub] ✓ Connected — streaming real-time prices');
    active = true;
    try { require('./feedOrchestrator').recordConnection('FINNHUB', true); } catch (_) {}
    for (const sym of symbols) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
    }
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);
  });

  ws.on('message', _handleMessage);

  ws.on('error', (err) => {
    // Throttle — Finnhub 429 (rate-limit) can fire repeatedly and flood the log.
    const now = Date.now();
    if (now - _lastErrLog > 60000) {
      _lastErrLog = now;
      const hint = /429/.test(err.message || '') ? ' (provider rate-limit; further errors muted 60s)' : '';
      console.error('[Finnhub] WS error:', err.message, hint);
    }
    try { require('./feedOrchestrator').recordError('FINNHUB', err); } catch (_) {}
  });

  ws.on('close', () => {
    console.log('[Finnhub] WS closed — reconnecting in 5s');
    active = false;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    try { require('./feedOrchestrator').recordConnection('FINNHUB', false); } catch (_) {}
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; _connect(); }, RECONNECT_DELAY_MS);
    }
  });
};

const start = () => {
  if (!process.env.FINNHUB_API_KEY) {
    console.log('[Finnhub] No FINNHUB_API_KEY — disabled. Sign up free: https://finnhub.io/');
    return;
  }
  _connect().catch((e) => console.error('[Finnhub] start error:', e.message));
};

const stop = () => {
  if (ws) ws.close();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  active = false;
};

module.exports = { start, stop, setBroadcaster, isActive: () => active };
