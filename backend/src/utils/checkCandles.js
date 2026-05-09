/**
 * Diagnostic: find anomalous candles (huge wicks) and price-range info.
 * Run: node src/utils/checkCandles.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Candle = require('../models/Candle');
const Instrument = require('../models/Instrument');

(async () => {
  await connectDB();
  const symbols = ['BTCUSD', 'ETHUSD', 'EURUSD', 'GBPUSD', 'XAUUSD'];

  for (const symbol of symbols) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const total = await Candle.countDocuments({ symbol, timeframe: '1m' });
    const last20 = await Candle.find({ symbol, timeframe: '1m' }).sort({ openTime: -1 }).limit(20).lean();

    if (!total) { console.log(`${symbol}: no candles`); continue; }

    let minLow = Infinity, maxHigh = -Infinity;
    for (const c of last20) {
      const lo = Number(c.low), hi = Number(c.high);
      if (lo < minLow) minLow = lo;
      if (hi > maxHigh) maxHigh = hi;
    }

    console.log(`\n=== ${symbol} ===`);
    console.log(`  total 1m candles: ${total} | currentPrice: ${inst?.lastPrice}`);
    console.log(`  last 20 candles: low=${minLow} → high=${maxHigh} (range ${(((maxHigh - minLow) / minLow) * 100).toFixed(2)}%)`);
    console.log(`  newest 5:`);
    for (const c of last20.slice(0, 5)) {
      console.log(`    ${c.openTime.toISOString()} | O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
