/**
 * Wipe candles for instruments that switched feeds, then re-seed synthetic
 * history aligned with the *current* lastPrice. Real-feed updates continue
 * adding new candles on top.
 *
 * Run: node src/utils/resetCandles.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const Candle = require('../models/Candle');

const TIMEFRAMES = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const NUM_CANDLES = 200;
const SYMBOLS = ['BTCUSD', 'ETHUSD', 'EURUSD', 'GBPUSD', 'XAUUSD'];

const VOLATILITY_BY_CATEGORY = {
  CRYPTO: 0.005,
  FOREX: 0.0005,
  COMMODITY: 0.002,
  STOCK: 0.003,
  INDEX: 0.002,
};

const generateWalk = (basePrice, count, tfMs, volatility) => {
  const bars = [];
  let price = basePrice;
  const now = Date.now();
  const endTime = Math.floor(now / tfMs) * tfMs;

  for (let i = count - 1; i >= 0; i--) {
    const openTime = endTime - i * tfMs;
    const closeTime = openTime + tfMs;
    const drift = (Math.random() - 0.5) * volatility * price;
    const open = price;
    const close = +(price + drift).toFixed(8);
    const high = +(Math.max(open, close) + Math.random() * volatility * price * 0.5).toFixed(8);
    const low = +(Math.min(open, close) - Math.random() * volatility * price * 0.5).toFixed(8);
    const volume = +(Math.random() * 100).toFixed(4);
    bars.push({ openTime, closeTime, open, high, low, close, volume });
    price = close;
  }
  return bars;
};

(async () => {
  await connectDB();
  console.log('--- Reset candles for switched-feed instruments ---\n');

  for (const symbol of SYMBOLS) {
    const inst = await Instrument.findOne({ symbol }).lean();
    if (!inst) { console.log(`${symbol}: instrument missing — skipped`); continue; }

    const basePrice = Number(inst.lastPrice);
    if (!basePrice || isNaN(basePrice)) {
      console.log(`${symbol}: lastPrice is not a number (${inst.lastPrice}) — skipped`);
      continue;
    }

    const deleted = await Candle.deleteMany({ symbol });
    console.log(`${symbol}: deleted ${deleted.deletedCount} candles (basePrice=${basePrice})`);

    const volatility = VOLATILITY_BY_CATEGORY[inst.category] ?? 0.005;
    let totalInserted = 0;

    for (const [tf, ms] of Object.entries(TIMEFRAMES)) {
      const bars = generateWalk(basePrice, NUM_CANDLES, ms, volatility);
      // Drop the current bucket — live feed owns it and could collide with our insert.
      const currentBucket = Math.floor(Date.now() / ms) * ms;
      const ops = bars
        .filter((b) => b.openTime < currentBucket)
        .map((b) => ({
          updateOne: {
            filter: { symbol, timeframe: tf, openTime: new Date(b.openTime) },
            update: {
              $setOnInsert: {
                symbol,
                timeframe: tf,
                openTime: new Date(b.openTime),
                closeTime: new Date(b.closeTime),
                open: String(b.open),
                high: String(b.high),
                low: String(b.low),
                close: String(b.close),
                volume: String(b.volume),
              },
            },
            upsert: true,
          },
        }));
      if (ops.length) {
        const res = await Candle.bulkWrite(ops, { ordered: false });
        totalInserted += res.upsertedCount || 0;
      }
    }
    console.log(`  → seeded ${totalInserted} new candles across ${Object.keys(TIMEFRAMES).length} timeframes`);
  }

  console.log('\nDone. Refresh the browser to see clean charts.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
