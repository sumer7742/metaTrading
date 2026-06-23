/**
 * cleanup-options.js — one-off DB migration to collapse the bloated option
 * universe (~6k contracts) down to a small near-expiry chain per underlying.
 *
 *   docker compose exec backend node scripts/cleanup-options.js            # apply
 *   docker compose exec -e DRY_RUN=true backend node scripts/cleanup-options.js   # preview, no writes
 *   docker compose exec -e RESTORE=true backend node scripts/cleanup-options.js   # rollback: re-activate ALL options
 *
 * SAFETY:
 *   - Only flips Instrument.isActive — NEVER deletes anything.
 *   - Touches ONLY options (segment:'OPT'). Equities, futures, forex, crypto,
 *     and every order / position / trade / wallet are left completely untouched.
 *   - Fully reversible via RESTORE.
 *
 * KEEP rule (shared with the live sync, services/optionUniverse.js):
 *   underlying in DHAN_SYNC_FNO  +  one of the N nearest non-expired expiries
 *   +  strike within ±DHAN_OPT_STRIKE_PCT% of the underlying's ATM price.
 * Everything else (far expiries, expired, disallowed underlyings) is deactivated.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Instrument = require('../src/models/Instrument');
const { isUnderlyingAllowed, nearestExpiries, strikeInWindow } = require('../src/services/optionUniverse');

async function refPrice(under) {
  const fut = await Instrument.findOne({ underlying: under, segment: 'FUT' })
    .sort({ expiryDate: 1 }).select('lastPrice').lean();
  if (fut && Number(fut.lastPrice) > 0) return Number(fut.lastPrice);
  const eq = await Instrument.findOne({ symbol: under, segment: 'EQ' }).select('lastPrice').lean();
  if (eq && Number(eq.lastPrice) > 0) return Number(eq.lastPrice);
  return null;
}

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI'); process.exit(1); }
  await mongoose.connect(URI);

  const totalOpt = await Instrument.countDocuments({ segment: 'OPT' });
  const activeBefore = await Instrument.countDocuments({ segment: 'OPT', isActive: true });

  if (process.env.RESTORE === 'true') {
    const r = await Instrument.updateMany({ segment: 'OPT', isActive: false }, { $set: { isActive: true } });
    console.log(`[cleanup] RESTORE — re-activated ${r.modifiedCount} options (all ${totalOpt} now active).`);
    await mongoose.disconnect();
    return;
  }

  const dry = process.env.DRY_RUN === 'true';
  const now = Date.now();

  // Decide the keep-set from the CURRENTLY ACTIVE options (DB-only, no CSV).
  const active = await Instrument.find({ segment: 'OPT', isActive: true })
    .select('symbol underlying expiryDate strike').lean();

  const byUnder = new Map();
  for (const o of active) {
    const u = String(o.underlying || '').toUpperCase();
    if (!byUnder.has(u)) byUnder.set(u, []);
    byUnder.get(u).push(o);
  }

  const keep = new Set();
  const perUnder = [];
  for (const [under, rows] of byUnder) {
    if (!isUnderlyingAllowed(under)) { perUnder.push([under || '(none)', rows.length, 0, 'not in DHAN_SYNC_FNO']); continue; }
    const keepExp = nearestExpiries(rows.map((o) => (o.expiryDate ? new Date(o.expiryDate).getTime() : NaN)), now);
    const ref = await refPrice(under);
    let kept = 0;
    for (const o of rows) {
      const ts = o.expiryDate ? new Date(o.expiryDate).getTime() : NaN;
      if (keepExp.has(ts) && strikeInWindow(o.strike, ref)) { keep.add(o.symbol); kept += 1; }
    }
    perUnder.push([under, rows.length, kept, ref ? `ref ₹${ref} ±${process.env.DHAN_OPT_STRIKE_PCT ?? 12}%` : 'all strikes (no ref)']);
  }

  const toDeactivate = active.filter((o) => !keep.has(o.symbol)).map((o) => o.symbol);

  console.log('── Option universe cleanup ──');
  console.log(`  total options in DB : ${totalOpt}`);
  console.log(`  active before       : ${activeBefore}`);
  console.log(`  keep (near-expiry)  : ${keep.size}`);
  console.log(`  to deactivate       : ${toDeactivate.length}`);
  for (const [u, n, k, note] of perUnder.sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(u).padEnd(12)} active ${String(n).padStart(5)} → keep ${String(k).padStart(4)}   (${note})`);
  }

  if (dry) {
    console.log('\n  DRY_RUN — no changes written. Re-run without DRY_RUN to apply.');
  } else if (toDeactivate.length) {
    let mod = 0;
    for (let i = 0; i < toDeactivate.length; i += 5000) {
      const r = await Instrument.updateMany(
        { segment: 'OPT', symbol: { $in: toDeactivate.slice(i, i + 5000) } },
        { $set: { isActive: false } },
      );
      mod += r.modifiedCount || 0;
    }
    console.log(`\n  ✓ Deactivated ${mod} options. Active options now: ${keep.size}.`);
    console.log('  Rollback any time: RESTORE=true node scripts/cleanup-options.js');
  } else {
    console.log('\n  Nothing to deactivate — already clean.');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
