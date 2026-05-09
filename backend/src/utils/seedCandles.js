/**
 * Seed sample candles + trades for ALL active instruments so the chart shows data immediately.
 * Useful for first-time setup / demo so you don't need to manually place orders to see the chart.
 *
 * Run with:
 *   npm run seed:candles
 *
 * Safe to re-run — it skips instruments that already have candle data.
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const Candle = require('../models/Candle');
const Trade = require('../models/Trade');

const TIMEFRAMES = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

const NUM_CANDLES = 200; // ~3 hours of 1m, ~16 hours of 5m, ~50 days of 1d

/**
 * Generate a simple synthetic price walk around basePrice with given volatility.
 * Returns an array of OHLC bars.
 */
const generateWalk = (basePrice, count, tfMs, volatility = 0.005) => {
  const bars = [];
  let price = basePrice;
  const now = Date.now();
  // Snap "now" to start of current 1m bucket so candles align with real time
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

const seed = async () => {
  await connectDB();
  const instruments = await Instrument.find({ isActive: true });
  console.log(`Seeding candles for ${instruments.length} instrument(s)...`);

  for (const inst of instruments) {
    const existing = await Candle.countDocuments({ symbol: inst.symbol });
    if (existing > 50) {
      console.log(`  • ${inst.symbol}: ${existing} candles already exist - skipping`);
      continue;
    }

    const basePrice = Number(inst.lastPrice) || 100;

    // Generate candles for each timeframe independently
    let totalCreated = 0;
    let lastClose = basePrice;
    for (const [tf, tfMs] of Object.entries(TIMEFRAMES)) {
      const bars = generateWalk(basePrice, NUM_CANDLES, tfMs, 0.003);
      const docs = bars.map((b) => ({
        symbol: inst.symbol,
        timeframe: tf,
        openTime: new Date(b.openTime),
        closeTime: new Date(b.closeTime),
        open: String(b.open),
        high: String(b.high),
        low: String(b.low),
        close: String(b.close),
        volume: String(b.volume),
      }));
      try {
        await Candle.insertMany(docs, { ordered: false });
        totalCreated += docs.length;
        if (tf === '1m' && docs.length) lastClose = bars[bars.length - 1].close;
      } catch (e) {
        // duplicate key errors are fine for re-runs
      }
    }

    // Update lastPrice on instrument so dashboards / order forms have something realistic
    inst.lastPrice = String(lastClose);
    inst.lastPriceUpdatedAt = new Date();
    await inst.save();

    console.log(`  ✓ ${inst.symbol}: created ${totalCreated} candles, last price ${lastClose}`);
  }

  console.log('\n✓ Candle seed complete. Refresh the chart to see data.');
  process.exit(0);
};

seed().catch((e) => {
  console.error('Seed candles error:', e);
  process.exit(1);
});
