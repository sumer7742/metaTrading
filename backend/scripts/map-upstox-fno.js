/**
 * map-upstox-fno.js — stamp Upstox instrument_keys onto our F&O instruments so
 * the live feed serves REAL futures/option prices (not the spot-proxy/intrinsic).
 *
 *   docker compose exec backend node scripts/map-upstox-fno.js
 *
 * Downloads Upstox's NSE + MCX instrument masters, matches by underlying|expiry|
 * strike|type, and sets Instrument.upstoxKey — so MCX commodity futures
 * (GOLD/SILVER/CRUDEOIL/NATURALGAS/…) get priced too. Re-run whenever new
 * F&O contracts/expiries are imported (the background worker also does this
 * daily when INDIAN_FEED=upstox).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { mapFnoKeys } = require('../src/services/upstoxFnoMap');

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);
  const r = await mapFnoKeys();
  for (const s of r.sources || []) {
    console.log(s.ok ? `  master OK: ${s.contracts} F&O contracts  (${s.url})` : `  master FAILED: ${s.error}`);
  }
  console.log(`[upstox-fno] fno=${r.fno} matched=${r.matched} missing=${r.missing} updated=${r.updated} (upstox contracts indexed: ${r.upstoxContracts})`);
  for (const [u, s] of Object.entries(r.byUnder || {})) {
    console.log(`  ${u.padEnd(12)} matched ${String(s.matched).padStart(4)} / missing ${String(s.missing).padStart(4)}`);
  }
  if (r.missSamples && r.missSamples.length) {
    console.log('  unmatched examples (our key we looked up):');
    for (const s of r.missSamples) console.log(`    ${s}`);
  }
  if (r.fno > 0 && r.matched === 0) console.log('  ⚠ 0 matched — check underlying/expiry/strike formats.');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
