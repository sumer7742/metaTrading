/**
 * Twelve Data Forex Feed Adapter
 *
 * Provides real-time forex/commodity prices for instruments where:
 *   externalProvider === 'TWELVE_DATA'
 *   externalFeedSymbol is set (e.g. 'EUR/USD', 'GBP/USD', 'XAU/USD')
 *
 * Twelve Data offers:
 *   - Free tier: 800 API calls/day, 8 per minute (sufficient for 50-100 active users)
 *   - Paid plans from $29/month (50,000+ calls/day, websocket access)
 *   - Coverage: Forex (170+ pairs), Commodities, Indices, Stocks, ETFs
 *
 * Setup:
 *   1. Sign up free at https://twelvedata.com/
 *   2. Get API key from dashboard
 *   3. Set in .env: TWELVE_DATA_API_KEY=your_key_here
 *   4. Configure instruments in admin panel:
 *        externalProvider: 'TWELVE_DATA'
 *        externalFeedSymbol: 'EUR/USD' (use the slash format)
 *
 * Limitations:
 *   - Free tier: 1-2 second poll interval (websocket needs paid plan)
 *   - 8 calls/min limit means ~6 instruments max on free tier with 5sec polling
 *   - For production with many users / many pairs, upgrade to paid plan or use
 *     OANDA Practice / FXCM API instead
 */

const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

let broadcaster = null;
let pollInterval = null;
let enabled = false;

const POLL_INTERVAL_MS = 30000; // 30s — keeps us under 8/min free tier (3 symbols = 6/min)
const API_BASE = 'https://api.twelvedata.com';

const setBroadcaster = (b) => { broadcaster = b; };

/**
 * Fetch real-time price for a single symbol from Twelve Data REST API.
 * Returns price as a string-decimal, or null on error.
 */
const fetchPrice = async (symbol, apiKey) => {
  try {
    const url = `${API_BASE}/price?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
      console.warn(`[TwelveData] HTTP ${res.status} for ${symbol}`);
      return null;
    }
    const data = await res.json();
    if (data.code && data.code !== 200) {
      console.warn(`[TwelveData] API error for ${symbol}: ${data.message || JSON.stringify(data)}`);
      return null;
    }
    if (data.price) return String(data.price);
    return null;
  } catch (e) {
    console.error(`[TwelveData] fetch error for ${symbol}:`, e.message);
    return null;
  }
};

/**
 * Update lastPrice on all matching instruments + broadcast over WebSocket.
 */
const _tickAll = async () => {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) return;

  // Find all instruments configured for Twelve Data
  const instruments = await Instrument.find({
    externalProvider: 'TWELVE_DATA',
    externalFeedSymbol: { $exists: true, $ne: null },
    isActive: true,
  }).select('_id symbol externalFeedSymbol pricePrecision').lean();

  if (instruments.length === 0) return;

  // Fetch each in parallel (rate-limited by free tier — keep under 8/min)
  const results = await Promise.all(
    instruments.map(async (inst) => {
      const price = await fetchPrice(inst.externalFeedSymbol, apiKey);
      return { inst, price };
    })
  );

  for (const { inst, price } of results) {
    if (!price) {
      try { require('./feedOrchestrator').recordError('TWELVE_DATA', new Error('null price')); } catch (_) {}
      continue;
    }
    // Notify orchestrator that Twelve Data is healthy
    try { require('./feedOrchestrator').recordTick('TWELVE_DATA'); } catch (_) {}

    const formattedPrice = Number(price).toFixed(inst.pricePrecision || 5);

    // Update DB
    await Instrument.updateOne(
      { _id: inst._id },
      { $set: { lastPrice: formattedPrice, lastPriceUpdatedAt: new Date() } }
    );

    // Aggregate into candles
    try {
      await updateCandlesForTrade({
        symbol: inst.symbol,
        price: formattedPrice,
        quantity: '0',
        ts: Date.now(),
      });
    } catch (e) { /* ignore */ }

    // Broadcast ticker
    if (broadcaster) {
      broadcaster.publish(`ticker:${inst.symbol}`, {
        lastPrice: formattedPrice,
        ts: Date.now(),
        source: 'TWELVE_DATA',
      });
    }
  }
};

const start = () => {
  if (!process.env.TWELVE_DATA_API_KEY) {
    console.log('[TwelveData] No TWELVE_DATA_API_KEY — forex feed disabled. Sign up free at https://twelvedata.com/');
    return;
  }

  // Safety: never run synthetic-pricing-prone path in production without explicit consent
  if (process.env.NODE_ENV === 'production' && !process.env.TWELVE_DATA_API_KEY) {
    console.warn('[TwelveData] Production mode but no API key set');
    return;
  }

  enabled = true;
  console.log(`[TwelveData] Forex feed started (polling every ${POLL_INTERVAL_MS / 1000}s)`);

  // Initial tick + interval
  _tickAll().catch((e) => console.error('[TwelveData] initial tick error:', e.message));
  pollInterval = setInterval(() => {
    _tickAll().catch((e) => console.error('[TwelveData] tick error:', e.message));
  }, POLL_INTERVAL_MS);
};

const stop = () => {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
  enabled = false;
};

module.exports = { start, stop, setBroadcaster };
