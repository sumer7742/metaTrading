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
let enabled = false;

const setBroadcaster = (b) => {
  broadcaster = b;
};

const _buildSubscribeMessage = () => {
  const params = [];
  for (const [extSym] of symbolMap) {
    params.push(`${extSym.toLowerCase()}@trade`);
    params.push(`${extSym.toLowerCase()}@ticker`);
  }
  return JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 });
};

const _connect = () => {
  const url = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws';
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
      const msg = JSON.parse(raw.toString());
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
  for (const inst of instruments) {
    if (inst.externalFeedSymbol) newMap.set(inst.externalFeedSymbol.toUpperCase(), inst._id);
  }
  symbolMap = newMap;
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

module.exports = { start, stop, setBroadcaster };
