/**
 * map-upstox-fno.js — stamp Upstox instrument_keys onto our F&O instruments so
 * the live feed serves REAL futures/option prices (not the spot-proxy/intrinsic).
 *
 *   docker compose exec backend node scripts/map-upstox-fno.js
 *
 * Downloads Upstox's NSE instrument master, matches by underlying|expiry|strike|
 * type, and sets Instrument.upstoxKey. Re-run whenever new F&O contracts/expiries
 * are imported (the background worker also does this daily).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { mapFnoKeys } = require('../src/services/upstoxFnoMap');

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);
  const r = await mapFnoKeys();
  console.log('[upstox-fno]', r);
  if (r.fno > 0 && r.matched === 0) {
    console.log('  ⚠ 0 matched — check expiry/strike formats or that F&O are imported.');
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
