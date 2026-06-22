/**
 * curate-indian-equity.js — trim the NSE cash-equity universe to the curated
 * liquid list (config/indianLiquidStocks.js). DB-only (no CSV fetch), fast, and
 * fully reversible — it flips isActive, never deletes.
 *
 *   docker compose exec backend node scripts/curate-indian-equity.js          # apply curation
 *   docker compose exec -e RESTORE=true backend node scripts/curate-indian-equity.js   # re-activate ALL NSE EQ
 *
 * After this, only liquid stocks show in the app + get polled by the live feed.
 * F&O (FUT/OPT) instruments are untouched.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Instrument = require('../src/models/Instrument');
const { LIQUID_NSE } = require('../src/config/indianLiquidStocks');

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);

  const totalEq = await Instrument.countDocuments({ exchange: 'NSE', segment: 'EQ' });

  if (process.env.RESTORE === 'true') {
    const r = await Instrument.updateMany({ exchange: 'NSE', segment: 'EQ', isActive: false }, { $set: { isActive: true } });
    console.log(`[curate] RESTORE — re-activated ${r.modifiedCount} of ${totalEq} NSE EQ. All stocks visible again.`);
    await mongoose.disconnect();
    return;
  }

  const keep = [...new Set(LIQUID_NSE)];
  // Which curated symbols actually exist in the DB (rest are typos / renamed / not imported).
  const present = await Instrument.find({ exchange: 'NSE', segment: 'EQ', symbol: { $in: keep } }).distinct('symbol');
  const missing = keep.filter((s) => !present.includes(s));

  const act = await Instrument.updateMany(
    { exchange: 'NSE', segment: 'EQ', symbol: { $in: present }, isActive: false },
    { $set: { isActive: true } },
  );
  const deact = await Instrument.updateMany(
    { exchange: 'NSE', segment: 'EQ', symbol: { $nin: present }, isActive: true },
    { $set: { isActive: false } },
  );

  console.log('── Curate NSE equity → liquid universe ──');
  console.log(`  curated list      : ${keep.length}`);
  console.log(`  matched in DB     : ${present.length}  (now active; ${act.modifiedCount} re-activated)`);
  console.log(`  deactivated       : ${deact.modifiedCount}  (penny/illiquid, hidden — reversible)`);
  console.log(`  NSE EQ total      : ${totalEq}  →  active now: ${present.length}`);
  if (missing.length) {
    console.log(`  ⚠ curated-but-missing (${missing.length}) — not in DB (renamed/typo/not imported), ignored:`);
    console.log(`    ${missing.join(', ')}`);
  }
  console.log('\n  To undo: RESTORE=true node scripts/curate-indian-equity.js');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
