/**
 * seed-nfo-options.js — populate NIFTY/BANKNIFTY (etc.) option chains from the
 * REAL Dhan scrip master (the broker instrument master), scoped to the CURRENT +
 * NEXT expiry only. Replaces the old synthetic-strike seeder.
 *
 *   docker compose exec backend node scripts/seed-nfo-options.js
 *   SEED_UNDERLYINGS=NIFTY,BANKNIFTY,FINNIFTY  DHAN_OPT_EXPIRIES=2  node scripts/seed-nfo-options.js
 *   KEEP_FAR=true node scripts/seed-nfo-options.js   # don't deactivate far/old expiries
 *
 * Guarantees (per requirements):
 *   • all strikes for current + next expiry only (DHAN_OPT_EXPIRIES, default 2)
 *   • BOTH CE and PE inserted
 *   • instrumentToken / expiryDate / strike / optionType always present (rows
 *     missing any are skipped + counted)
 *   • idempotent upsert by symbol (re-running won't duplicate; re-activates too)
 *   • far/expired expiries for these underlyings are deactivated (unless KEEP_FAR)
 *   • per-underlying + total insert/update logging
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { nearestExpiries } = require('../src/services/optionUniverse');

const CSV_URL = process.env.DHAN_SCRIP_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const UNDERLYINGS = (process.env.SEED_UNDERLYINGS || 'NIFTY,BANKNIFTY')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else if (ch === '"') q = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

(async () => {
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI)'); process.exit(1); }
  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  console.log(`[seed-opt] fetching Dhan scrip master … (underlyings: ${UNDERLYINGS.join(', ')})`);
  const res = await fetch(CSV_URL);
  if (!res.ok) { console.error(`[seed-opt] fetch failed: HTTP ${res.status}`); process.exit(1); }
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  console.log(`[seed-opt] rows: ${lines.length.toLocaleString()}`);

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...n) => { for (const x of n) { const i = header.indexOf(x); if (i >= 0) return i; } return -1; };
  const C = {
    exch: col('EXCH_ID'), sid: col('SECURITY_ID'), isin: col('ISIN'), inst: col('INSTRUMENT'),
    lot: col('LOT_SIZE'), exp: col('SM_EXPIRY_DATE'), strike: col('STRIKE_PRICE'), opt: col('OPTION_TYPE'),
    tick: col('TICK_SIZE'), custom: col('DISPLAY_NAME'), under: col('UNDERLYING_SYMBOL'),
    upperLimit: col('SM_UPPER_LIMIT'), lowerLimit: col('SM_LOWER_LIMIT'), freezeQty: col('SM_FREEZE_QTY'),
  };
  if (C.exch < 0 || C.sid < 0 || C.inst < 0 || C.under < 0 || C.exp < 0 || C.strike < 0 || C.opt < 0) {
    console.error('[seed-opt] essential option columns missing in scrip master:', C); process.exit(1);
  }
  const get = (a, i) => (i >= 0 && i < a.length ? String(a[i] || '').trim() : '');
  const band = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? String(x) : null; };

  // 1) Collect option rows for the requested underlyings.
  const wanted = new Set(UNDERLYINGS);
  const rowsByUnder = new Map(UNDERLYINGS.map((u) => [u, []]));
  let scanned = 0; let skippedNoType = 0;
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    if (get(r, C.exch).toUpperCase() !== 'NSE') continue;
    const inst = get(r, C.inst).toUpperCase();
    if (inst !== 'OPTIDX' && inst !== 'OPTSTK') continue;
    const under = get(r, C.under).toUpperCase();
    if (!wanted.has(under)) continue;
    scanned += 1;
    const ot = get(r, C.opt).toUpperCase();
    const optType = (ot === 'CE' || ot === 'CALL') ? 'CE' : ((ot === 'PE' || ot === 'PUT') ? 'PE' : null);
    if (!optType) { skippedNoType += 1; continue; }
    const ds = get(r, C.exp);
    const d = ds ? new Date(ds) : null;
    if (!d || isNaN(d.getTime())) continue;
    const strikeVal = Number(get(r, C.strike));
    if (!Number.isFinite(strikeVal) || strikeVal <= 0) continue;
    rowsByUnder.get(under).push({
      under, optType, expDate: d, strikeVal,
      sid: get(r, C.sid), isin: get(r, C.isin) || null,
      tick: Number(get(r, C.tick)) || 0.05, lot: get(r, C.lot) || '1',
      custom: get(r, C.custom),
      upperCircuit: band(get(r, C.upperLimit)), lowerCircuit: band(get(r, C.lowerLimit)), freezeQty: band(get(r, C.freezeQty)),
      category: inst === 'OPTIDX' ? 'INDEX' : 'STOCK',
    });
  }
  console.log(`[seed-opt] scanned ${scanned} option rows (skipped ${skippedNoType} with no CE/PE type)`);

  // 2) Per underlying: keep CURRENT + NEXT expiry only; build idempotent upserts.
  const now = Date.now();
  const ops = [];
  const keptSymbolsByUnder = new Map();
  let ce = 0; let pe = 0; let missingField = 0;
  for (const under of UNDERLYINGS) {
    const rows = rowsByUnder.get(under) || [];
    const keepExp = nearestExpiries(rows.map((o) => o.expDate.getTime()), now); // current + next
    const seen = new Set(); // dedup by symbol
    const kept = [];
    let expiriesKept = new Set();
    for (const o of rows) {
      const ts = o.expDate.getTime();
      if (!keepExp.has(ts)) continue;
      const tag = `${MON[o.expDate.getUTCMonth()]}${String(o.expDate.getUTCFullYear()).slice(2)}`;
      const symbol = `${under}${tag}${o.strikeVal}${o.optType}`.replace(/\s+/g, '');
      // Validation: every contract must carry these.
      if (!o.sid || !o.expDate || !(o.strikeVal > 0) || !o.optType) { missingField += 1; continue; }
      if (seen.has(symbol)) continue; // duplicate guard
      seen.add(symbol);
      kept.push(symbol);
      expiriesKept.add(tag);
      if (o.optType === 'CE') ce += 1; else pe += 1;
      ops.push({ updateOne: {
        filter: { symbol },
        update: {
          $set: {
            symbol, name: o.custom || symbol, category: o.category,
            exchange: 'NFO', segment: 'OPT', externalProvider: 'DHAN',
            instrumentToken: o.sid, isin: o.isin,
            tickSize: String(o.tick), lotSize: String(o.lot),
            upperCircuit: o.upperCircuit, lowerCircuit: o.lowerCircuit, freezeQty: o.freezeQty,
            pricePrecision: 2, quantityPrecision: 0, minOrderSize: String(o.lot),
            isActive: true, expiryDate: o.expDate, underlying: under,
            strike: String(o.strikeVal), optionType: o.optType,
          },
          $setOnInsert: { baseCurrency: under, quoteCurrency: 'INR' },
        },
        upsert: true,
      } });
    }
    keptSymbolsByUnder.set(under, kept);
    console.log(`[seed-opt]   ${under.padEnd(10)} kept ${String(kept.length).padStart(4)} contracts across ${expiriesKept.size} expiry(${[...expiriesKept].join(',') || '-'})`);
  }

  if (missingField) console.warn(`[seed-opt] ⚠ skipped ${missingField} rows missing token/expiry/strike/type`);
  if (!ops.length) { console.error('[seed-opt] nothing to seed — check underlyings / scrip master.'); await mongoose.disconnect(); process.exit(1); }

  // 3) Idempotent bulk upsert.
  let upserted = 0; let modified = 0;
  for (let k = 0; k < ops.length; k += 2000) {
    const w = await Instrument.bulkWrite(ops.slice(k, k + 2000), { ordered: false });
    upserted += w.upsertedCount || 0; modified += w.modifiedCount || 0;
  }

  // 4) Deactivate far/old expiries for these underlyings (current+next only).
  let deactivated = 0;
  if (process.env.KEEP_FAR !== 'true') {
    for (const under of UNDERLYINGS) {
      const keep = keptSymbolsByUnder.get(under) || [];
      const d = await Instrument.updateMany(
        { segment: 'OPT', underlying: under, isActive: true, symbol: { $nin: keep } },
        { $set: { isActive: false } },
      );
      deactivated += d.modifiedCount || 0;
    }
  }

  // 5) Validation summary.
  const activeNow = await Instrument.countDocuments({ segment: 'OPT', underlying: { $in: UNDERLYINGS }, isActive: true });
  const missingTok = await Instrument.countDocuments({ segment: 'OPT', underlying: { $in: UNDERLYINGS }, isActive: true, instrumentToken: null });
  console.log('── seed-opt summary ──');
  console.log(`  upserted ${upserted}, modified ${modified}, deactivated(far) ${deactivated}`);
  console.log(`  CE ${ce} / PE ${pe} built  |  active options now: ${activeNow}`);
  console.log(`  validation: ${missingTok === 0 ? 'OK — all active options have instrumentToken' : `⚠ ${missingTok} active options missing instrumentToken`}`);
  console.log('  (Live premiums come from the Upstox feed once mapped: scripts/map-upstox-fno.js)');

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error('[seed-opt] failed:', e.stack || e.message); process.exit(1); });
