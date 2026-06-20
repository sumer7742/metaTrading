/**
 * seed-nfo-sample.js — add sample index FUTURES with NO network, for testing
 * Phase 2 (lot trading + expiry square-off) when the Angel scrip master is
 * unreachable.
 *
 *   node scripts/seed-nfo-sample.js                 # this month's expiry
 *   FUT_EXPIRY=2026-06-25 node scripts/seed-nfo-sample.js   # explicit expiry (15:30 IST)
 *
 * ⚠️ TEST DATA. Real futures need authoritative token + lotSize + expiry from
 * the broker scrip master (scripts/import-angel-instruments.js IMPORT_FUTURES).
 * These carry NO feed token (externalProvider unset) — price is static seed so
 * B-book trades fill; for live prices use the real import. Lot sizes/expiry
 * change each series — verify before trusting.
 */
require('dotenv').config();
const mongoose = require('mongoose');

// Last Thursday of a given month (NIFTY monthly convention), 15:30 IST (10:00 UTC).
function lastThursday(year, month /* 0-11 */) {
  const d = new Date(Date.UTC(year, month + 1, 0, 10, 0, 0)); // last day of month
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function defaultExpiry() {
  const now = new Date();
  let e = lastThursday(now.getUTCFullYear(), now.getUTCMonth());
  if (e.getTime() < now.getTime()) e = lastThursday(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return e;
}

const expiry = process.env.FUT_EXPIRY ? new Date(`${process.env.FUT_EXPIRY}T10:00:00Z`) : defaultExpiry();
const tag = expiry.toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', '').toUpperCase(); // e.g. JUN26

// [underlying, lotSize, seedPrice]
const FUT = [
  ['NIFTY', '75', '24000'],
  ['BANKNIFTY', '35', '52000'],
  ['FINNIFTY', '65', '26000'],
];

(async () => {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI)'); process.exit(1); }
  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  const ops = FUT.map(([under, lot, px]) => {
    const symbol = `${under}${tag}FUT`;
    return {
      updateOne: {
        filter: { symbol },
        update: {
          $set: {
            symbol, name: `${under} Fut ${tag}`,
            category: 'INDEX', exchange: 'NFO', segment: 'FUT',
            underlying: under, expiryDate: expiry,
            lastPrice: px, lastPriceUpdatedAt: new Date(),
            tickSize: '0.05', lotSize: lot,
            pricePrecision: 2, quantityPrecision: 0, minOrderSize: lot,
            isActive: true,
          },
          $setOnInsert: { baseCurrency: under, quoteCurrency: 'INR' },
        },
        upsert: true,
      },
    };
  });

  const r = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[seed-nfo] ✓ ${FUT.length} futures (expiry ${expiry.toISOString()}) — upserted=${r.upsertedCount || 0} modified=${r.modifiedCount || 0}`);
  FUT.forEach(([u, l]) => console.log(`   ${u}${tag}FUT  lot=${l}`));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
