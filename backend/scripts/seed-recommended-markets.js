/**
 * seed-recommended-markets.js — one-time convenience seed for the admin-managed
 * Recommended Markets (the top ticker strip + "Recommended" selector tab).
 *
 * Idempotent: only seeds symbols that exist as ACTIVE instruments, preserves the
 * given order, and won't duplicate or reorder an already-populated list (pass
 * FORCE=true to overwrite the order). After this the admin can fully manage the
 * set from Admin → Recommended Markets — nothing here is hard-coded downstream.
 *
 *   docker compose exec backend node scripts/seed-recommended-markets.js
 *   SYMBOLS=BTCUSD,ETHUSD,EURUSD node scripts/seed-recommended-markets.js
 *   FORCE=true node scripts/seed-recommended-markets.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Instrument = require('../src/models/Instrument');
const RecommendedMarket = require('../src/models/RecommendedMarket');

const DEFAULT = ['BTCUSD', 'ETHUSD', 'EURUSD', 'GBPUSD', 'XAUUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD'];

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);

  const wanted = (process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : DEFAULT)
    .map((s) => s.trim().toUpperCase()).filter(Boolean);
  const force = String(process.env.FORCE).toLowerCase() === 'true';

  const existingCount = await RecommendedMarket.countDocuments();
  if (existingCount > 0 && !force) {
    console.log(`[recommended] ${existingCount} already configured — skipping (pass FORCE=true to overwrite order).`);
    await mongoose.disconnect();
    return;
  }

  // Keep only symbols that actually exist as active instruments.
  const live = await Instrument.find({ symbol: { $in: wanted }, isActive: true }).select('symbol').lean();
  const liveSet = new Set(live.map((i) => i.symbol));
  const seed = wanted.filter((s) => liveSet.has(s));
  const skipped = wanted.filter((s) => !liveSet.has(s));

  if (force) await RecommendedMarket.deleteMany({});

  let order = 0;
  for (const symbol of seed) {
    await RecommendedMarket.findOneAndUpdate(
      { symbol },
      { $set: { symbol, sortOrder: order, isActive: true } },
      { upsert: true, new: true },
    );
    order += 1;
  }

  console.log(`[recommended] seeded ${seed.length}: ${seed.join(', ') || '(none)'}`);
  if (skipped.length) console.log(`[recommended] skipped (no active instrument): ${skipped.join(', ')}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
