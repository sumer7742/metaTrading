/**
 * seed-nfo-options.js — sample NIFTY option chain (CE/PE) + NIFTY spot, NO
 * network. For testing Phase 3 (option buying, chain UI, intrinsic expiry
 * settlement) when the Angel scrip master is unreachable.
 *
 *   node scripts/seed-nfo-options.js
 *   FUT_EXPIRY=2026-06-25 SPOT=24000 node scripts/seed-nfo-options.js
 *
 * ⚠️ TEST DATA — strikes/premiums are synthetic (intrinsic + flat time value),
 * no live feed token. Real chains come from the broker scrip master.
 */
require('dotenv').config();
const mongoose = require('mongoose');

function lastThursday(y, m) {
  const d = new Date(Date.UTC(y, m + 1, 0, 10, 0, 0));
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function defaultExpiry() {
  const now = new Date();
  let e = lastThursday(now.getUTCFullYear(), now.getUTCMonth());
  if (e.getTime() < now.getTime()) e = lastThursday(now.getUTCFullYear(), now.getUTCMonth() + 1);
  return e;
}

const UNDER = 'NIFTY';
const LOT = '75';
const SPOT = Number(process.env.SPOT) || 24000;
const STEP = 200;
const N_EACH = 5; // strikes each side of ATM
const TIME_VALUE = 120; // flat synthetic time value
const expiry = process.env.FUT_EXPIRY ? new Date(`${process.env.FUT_EXPIRY}T10:00:00Z`) : defaultExpiry();
const tag = expiry.toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', '').toUpperCase();

(async () => {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI)'); process.exit(1); }
  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  const atm = Math.round(SPOT / STEP) * STEP;
  const strikes = [];
  for (let i = -N_EACH; i <= N_EACH; i++) strikes.push(atm + i * STEP);

  const ops = [];
  // Underlying spot (index) — needed for ATM + intrinsic settlement.
  ops.push({ updateOne: {
    filter: { symbol: UNDER },
    update: {
      $set: {
        symbol: UNDER, name: 'NIFTY 50', category: 'INDEX', exchange: 'NSE', segment: 'EQ',
        lastPrice: String(SPOT), lastPriceUpdatedAt: new Date(),
        tickSize: '0.05', pricePrecision: 2, quantityPrecision: 0, minOrderSize: '1', isActive: true,
      },
      $setOnInsert: { baseCurrency: UNDER, quoteCurrency: 'INR' },
    }, upsert: true,
  } });

  for (const K of strikes) {
    for (const ot of ['CE', 'PE']) {
      const intrinsic = ot === 'CE' ? Math.max(SPOT - K, 0) : Math.max(K - SPOT, 0);
      const premium = (intrinsic + TIME_VALUE).toFixed(2);
      const symbol = `${UNDER}${tag}${K}${ot}`;
      ops.push({ updateOne: {
        filter: { symbol },
        update: {
          $set: {
            symbol, name: `${UNDER} ${K} ${ot} ${tag}`,
            category: 'INDEX', exchange: 'NFO', segment: 'OPT',
            underlying: UNDER, strike: String(K), optionType: ot, expiryDate: expiry,
            lastPrice: premium, lastPriceUpdatedAt: new Date(),
            tickSize: '0.05', lotSize: LOT, pricePrecision: 2, quantityPrecision: 0, minOrderSize: LOT,
            isActive: true,
          },
          $setOnInsert: { baseCurrency: UNDER, quoteCurrency: 'INR' },
        }, upsert: true,
      } });
    }
  }

  const r = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[seed-opt] ✓ ${UNDER} spot + ${strikes.length * 2} options (${tag}, ATM ${atm}) — upserted=${r.upsertedCount || 0} modified=${r.modifiedCount || 0}`);
  console.log(`[seed-opt] strikes: ${strikes.join(', ')}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
