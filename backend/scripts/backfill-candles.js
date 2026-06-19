/**
 * backfill-candles.js — seed real historical candles from Binance for an
 * instrument, so its chart has data immediately (the live feed only builds
 * candles going forward).
 *
 * Usage (from backend/, or inside the backend container):
 *   node scripts/backfill-candles.js SOLUSDT
 *   node scripts/backfill-candles.js SOLUSD SOLUSDT        # platformSymbol extSymbol
 *   node scripts/backfill-candles.js SOLUSDT SOLUSDT 1000  # + limit per timeframe
 *
 *   docker compose exec backend node scripts/backfill-candles.js SOLUSDT
 *
 * Idempotent — safe to re-run; it upserts by (symbol, timeframe, openTime).
 */
const mongoose = require('mongoose');
const Instrument = require('../src/models/Instrument');
const { backfillInstrument } = require('../src/services/binanceBackfill');

(async () => {
  const platformSymbol = (process.argv[2] || '').toUpperCase();
  if (!platformSymbol) {
    console.error('Usage: node scripts/backfill-candles.js <SYMBOL> [extSymbol] [limit]');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  // Resolve the Binance pair: explicit arg → instrument's externalFeedSymbol → symbol.
  const inst = await Instrument.findOne({ symbol: platformSymbol }).lean();
  if (!inst) console.warn(`[Backfill] No instrument named ${platformSymbol} in DB — continuing anyway.`);
  const extSymbol = (process.argv[3] || inst?.externalFeedSymbol || platformSymbol).toUpperCase();
  const limit = Number(process.argv[4]) || 1000;

  console.log(`Backfilling ${platformSymbol} from Binance ${extSymbol} (limit ${limit}/timeframe)...\n`);
  const n = await backfillInstrument(platformSymbol, extSymbol, { limit });
  console.log(`\n✅ Done — ${n} candle upserts. Hard-refresh the chart to see history.`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
