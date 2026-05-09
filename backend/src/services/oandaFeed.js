/**
 * OANDA Practice Streaming Feed Adapter
 *
 * OANDA offers a FREE practice (demo) API with REAL-TIME streaming forex prices.
 * No paid plan needed — perfect for MVP/beta forex platforms.
 *
 * vs Twelve Data:
 *   - OANDA practice: FREE, real-time streaming (sub-second updates)
 *   - Twelve Data free: 30s polling delay
 *   - Twelve Data paid: $29/month for real-time
 *
 * Setup (FREE, ~5 min):
 *   1. Sign up at https://www.oanda.com/demo-account/login
 *   2. Once logged in, generate API token: My Services > Manage API Access
 *   3. Note your account ID from the dashboard
 *   4. Set in .env:
 *        OANDA_API_KEY=your_token_here
 *        OANDA_ACCOUNT_ID=your_account_id
 *        OANDA_ENVIRONMENT=practice  (or 'live' if you upgrade)
 *
 * For each instrument, set:
 *   externalProvider: 'OANDA'
 *   externalFeedSymbol: 'EUR_USD' (note underscore, not slash)
 *
 * Coverage:
 *   - Forex pairs: EUR_USD, GBP_USD, USD_JPY, AUD_USD, NZD_USD, etc.
 *   - Commodities: XAU_USD (gold), XAG_USD (silver), BCO_USD (Brent oil)
 *   - Indices: SPX500_USD, NAS100_USD
 *
 * Production note:
 *   For real money launch, upgrade to OANDA live account (free; deposit
 *   not required for streaming). Practice account prices match live within
 *   sub-pip but should not be used for executed trades on regulated platforms.
 */

const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

let broadcaster = null;
let abortController = null;
let active = false;
let reconnectTimer = null;
let symbolMap = new Map(); // OANDA symbol (EUR_USD) -> instrument._id

const setBroadcaster = (b) => { broadcaster = b; };

const getApiUrl = () => {
  const env = process.env.OANDA_ENVIRONMENT || 'practice';
  return env === 'live'
    ? 'https://stream-fxtrade.oanda.com'
    : 'https://stream-fxpractice.oanda.com';
};

/**
 * Build the streaming URL for a list of OANDA instrument symbols.
 * Format: GET /v3/accounts/{accountId}/pricing/stream?instruments=EUR_USD,GBP_USD
 * Returns text/event-stream-like NDJSON (newline-delimited JSON).
 */
const _buildStreamUrl = (symbols, accountId) => {
  const params = new URLSearchParams({ instruments: symbols.join(',') });
  return `${getApiUrl()}/v3/accounts/${accountId}/pricing/stream?${params}`;
};

/**
 * Stream prices from OANDA. Uses fetch + ReadableStream to consume NDJSON.
 * On disconnect, auto-reconnects after 5 seconds.
 */
const _stream = async () => {
  const apiKey = process.env.OANDA_API_KEY;
  const accountId = process.env.OANDA_ACCOUNT_ID;
  if (!apiKey || !accountId) return;

  // Refresh symbol mapping
  const instruments = await Instrument.find({
    externalProvider: 'OANDA',
    externalFeedSymbol: { $exists: true, $ne: null },
    isActive: true,
  }).select('_id symbol externalFeedSymbol pricePrecision').lean();

  if (instruments.length === 0) {
    console.log('[OANDA] No instruments configured for OANDA — sleeping');
    reconnectTimer = setTimeout(_stream, 30000);
    return;
  }

  symbolMap.clear();
  for (const inst of instruments) {
    symbolMap.set(inst.externalFeedSymbol, { _id: inst._id, symbol: inst.symbol, precision: inst.pricePrecision });
  }

  const symbols = Array.from(symbolMap.keys());
  const url = _buildStreamUrl(symbols, accountId);

  abortController = new AbortController();
  console.log(`[OANDA] Connecting to stream for ${symbols.join(', ')}...`);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Datetime-Format': 'UNIX',
      },
      signal: abortController.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    console.log('[OANDA] ✓ Connected — streaming real-time forex prices');
    active = true;
    try { require('./feedOrchestrator').recordConnection('OANDA', true); } catch (_) {}

    // Read NDJSON stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        try {
          const msg = JSON.parse(line);
          if (msg.type === 'PRICE') await _handlePriceTick(msg);
          // Heartbeat (type === 'HEARTBEAT') — keep-alive, ignore
        } catch (e) { /* malformed line, skip */ }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error('[OANDA] stream error:', e.message);
    // Notify orchestrator
    try { require('./feedOrchestrator').recordError('OANDA', e); } catch (_) {}
  } finally {
    active = false;
    try { require('./feedOrchestrator').recordConnection('OANDA', false); } catch (_) {}
    // Reconnect after 5 sec
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        _stream();
      }, 5000);
    }
  }
};

/**
 * Handle a single PRICE tick from OANDA.
 * Format: { type:'PRICE', instrument:'EUR_USD', bids:[{price:'1.08745'}], asks:[{price:'1.08755'}], time:... }
 */
const _handlePriceTick = async (msg) => {
  const mapping = symbolMap.get(msg.instrument);
  if (!mapping) return;

  const bid = msg.bids?.[0]?.price;
  const ask = msg.asks?.[0]?.price;
  if (!bid || !ask) return;

  // Notify orchestrator that OANDA is alive and ticking
  try {
    require('./feedOrchestrator').recordTick('OANDA');
  } catch (e) { /* ignore */ }

  // Mid price
  const mid = ((Number(bid) + Number(ask)) / 2).toFixed(mapping.precision || 5);

  // Update DB (avoid full save() to skip overhead per tick)
  await Instrument.updateOne(
    { _id: mapping._id },
    { $set: { lastPrice: mid, lastPriceUpdatedAt: new Date() } }
  );

  // Aggregate into candles
  try {
    await updateCandlesForTrade({
      symbol: mapping.symbol,
      price: mid,
      quantity: '0',
      ts: Date.now(),
    });
  } catch (e) { /* ignore */ }

  // Broadcast ticker over WebSocket
  if (broadcaster) {
    broadcaster.publish(`ticker:${mapping.symbol}`, {
      lastPrice: mid,
      bid: String(bid),
      ask: String(ask),
      ts: Date.now(),
      source: 'OANDA',
    });
  }
};

const start = () => {
  if (!process.env.OANDA_API_KEY || !process.env.OANDA_ACCOUNT_ID) {
    console.log('[OANDA] No OANDA credentials — forex streaming disabled. Sign up free at https://www.oanda.com/demo-account/');
    return;
  }
  _stream().catch((e) => console.error('[OANDA] start error:', e.message));
};

const stop = () => {
  if (abortController) abortController.abort();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  active = false;
};

module.exports = { start, stop, setBroadcaster, isActive: () => active };
