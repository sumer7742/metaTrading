/**
 * binanceBackfill — seed REAL historical candles for a Binance-fed instrument.
 *
 * The live feed (externalFeedService) only aggregates candles from trades it
 * sees GOING FORWARD, so a freshly-added instrument has an empty chart until
 * ticks slowly accumulate. This module fetches actual historical klines from
 * Binance's public REST API and upserts them into the Candle collection, so the
 * chart is populated with real history the moment the instrument goes live.
 *
 * Idempotent: upserts by the Candle unique key (symbol, timeframe, openTime),
 * so re-running just refreshes existing buckets — safe to call repeatedly.
 *
 * Binance kline row format:
 *   [ openTime, open, high, low, close, volume, closeTime, ...ignored ]
 * Binance interval strings match our timeframe keys 1:1 (1m,5m,…,1w).
 */
const Candle = require('../models/Candle');
const { TF_MS } = require('./candleService');

const BINANCE_REST = process.env.BINANCE_REST_URL || 'https://api.binance.com';
// Per-timeframe history depth (Binance caps at 1000/req). 1m gets fewer
// buckets-worth of wall-clock than 1d, but 1000 is plenty for the chart's
// default 500-candle window on every timeframe.
const DEFAULT_LIMIT = 1000;

async function _fetchKlines(extSymbol, interval, limit) {
  const url = `${BINANCE_REST}/api/v3/klines?symbol=${encodeURIComponent(extSymbol)}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

/**
 * Backfill historical candles for one instrument across all timeframes.
 * @param {string} platformSymbol  our instrument symbol (e.g. 'SOLUSDT' or 'SOLUSD')
 * @param {string} extSymbol       the Binance pair (e.g. 'SOLUSDT')
 * @param {object} [opts]
 * @param {number} [opts.limit]    candles per timeframe (max 1000)
 * @param {string[]} [opts.timeframes]
 * @returns {Promise<number>} total candles upserted
 */
async function backfillInstrument(platformSymbol, extSymbol, { limit = DEFAULT_LIMIT, timeframes } = {}) {
  if (!extSymbol) { console.warn(`[Backfill] ${platformSymbol}: no Binance symbol — skipping`); return 0; }
  const tfs = timeframes || Object.keys(TF_MS);
  let total = 0;

  for (const tf of tfs) {
    if (!TF_MS[tf]) continue; // Binance interval string == our tf key
    let klines;
    try {
      klines = await _fetchKlines(extSymbol, tf, Math.min(limit, 1000));
    } catch (e) {
      console.error(`[Backfill] ${platformSymbol} ${tf}: fetch failed — ${e.message}`);
      continue;
    }
    if (!Array.isArray(klines) || klines.length === 0) continue;

    const ops = klines.map((k) => {
      const openTime = new Date(k[0]);
      const closeTime = new Date(k[6]);
      return {
        updateOne: {
          filter: { symbol: platformSymbol, timeframe: tf, openTime },
          update: {
            $set: {
              symbol: platformSymbol,
              timeframe: tf,
              openTime,
              closeTime,
              open: String(k[1]),
              high: String(k[2]),
              low: String(k[3]),
              close: String(k[4]),
              volume: String(k[5]),
            },
          },
          upsert: true,
        },
      };
    });

    try {
      await Candle.bulkWrite(ops, { ordered: false });
      total += ops.length;
      console.log(`[Backfill] ${platformSymbol} ${tf}: ${ops.length} candles`);
    } catch (e) {
      // Duplicate-key races are expected if the live feed wrote the same
      // bucket concurrently — harmless.
      if (e.code !== 11000) console.error(`[Backfill] ${platformSymbol} ${tf}: write failed — ${e.message}`);
    }
  }

  console.log(`[Backfill] ${platformSymbol}: done — ${total} candle upserts from Binance ${extSymbol}`);
  return total;
}

module.exports = { backfillInstrument };
