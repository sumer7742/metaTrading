/**
 * verify-indian-live.js — one-shot health check for the Indian (Dhan) live stack.
 * Run inside the backend container so it inherits MONGODB_URI + DHAN_* env:
 *
 *   docker compose exec backend node scripts/verify-indian-live.js
 *
 * Checks, in order:
 *   1. DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN present
 *   2. NSE / NFO session right now (IST) — is the market actually open?
 *   3. Imported instrument counts (DHAN-sourced, with tokens) by exchange/segment
 *   4. Live Dhan LTP API call for a few sample tokens (validates the keys end-to-end)
 *   5. DB lastPrice freshness (how stale is the cached price the app serves?)
 *
 * Read-only. Exits non-zero if a hard prerequisite is missing (no creds / no
 * instruments / API rejects the keys) so it doubles as a CI/smoke gate.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Instrument = require('../src/models/Instrument');
const { getSession } = require('../src/services/marketHours');

const BASE = 'https://api.dhan.co';
const SEG = { NSE: 'NSE_EQ', BSE: 'BSE_EQ', NFO: 'NSE_FNO', BFO: 'BSE_FNO', MCX: 'MCX_COMM' };
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

function ageStr(d) {
  if (!d) return bad('never');
  const sec = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 90) return ok(`${sec}s ago`);
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return bad(`${Math.round(sec / 3600)}h ago`);
}

async function dhanLtp(seg, ids) {
  const res = await fetch(`${BASE}/v2/marketfeed/ltp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'access-token': process.env.DHAN_ACCESS_TOKEN,
      'client-id': process.env.DHAN_CLIENT_ID,
    },
    body: JSON.stringify({ [seg]: ids.map(Number) }),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { /* keep raw */ }
  return { status: res.status, json, raw: text };
}

(async () => {
  let hardFail = false;

  // 1) Credentials ---------------------------------------------------------
  console.log('\n── 1. Dhan credentials ──');
  const hasId = !!process.env.DHAN_CLIENT_ID;
  const hasTok = !!process.env.DHAN_ACCESS_TOKEN;
  console.log(`  DHAN_CLIENT_ID    : ${hasId ? ok('set') : bad('MISSING')}`);
  console.log(`  DHAN_ACCESS_TOKEN : ${hasTok ? ok(`set (${process.env.DHAN_ACCESS_TOKEN.length} chars)`) : bad('MISSING')}`);
  if (!hasId || !hasTok) {
    console.log(bad('\n  → Live feed is DISABLED without both. Set them in backend/.env and restart.'));
    hardFail = true;
  }

  // 2) Session -------------------------------------------------------------
  console.log('\n── 2. Market session (IST now) ──');
  for (const ex of ['NSE', 'NFO']) {
    const s = getSession(ex, new Date());
    const tag = s.isOpen ? ok('OPEN') : dim(`closed (${s.reason})`);
    console.log(`  ${ex.padEnd(4)} ${tag}   ${dim(`${s.opensAt}–${s.closesAt} ${s.tz || ''}`)}`);
  }
  console.log(dim('  (Prices only tick while OPEN. Outside hours the feed sleeps; cached LTP shown.)'));

  // DB-dependent checks ----------------------------------------------------
  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.log(bad('\nNo MONGODB_URI — cannot check instruments.')); process.exit(1); }
  await mongoose.connect(URI);

  // 3) Instrument inventory ------------------------------------------------
  console.log('\n── 3. Imported Indian instruments (DHAN, with token) ──');
  const rows = await Instrument.aggregate([
    { $match: { externalProvider: 'DHAN', instrumentToken: { $ne: null } } },
    { $group: { _id: { exchange: '$exchange', segment: '$segment' }, n: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
    { $sort: { _id: 1 } },
  ]);
  if (!rows.length) {
    console.log(bad('  No DHAN instruments found. Run the importer:'));
    console.log(dim('    docker compose exec backend node scripts/import-dhan-instruments.js          # NSE equity'));
    console.log(dim('    IMPORT_FUTURES=true docker compose exec ... ; IMPORT_OPTIONS=true IMPORT_SYMBOLS=NIFTY ...'));
    hardFail = true;
  } else {
    let total = 0;
    for (const r of rows) {
      total += r.n;
      console.log(`  ${(r._id.exchange || '?').padEnd(4)} ${(r._id.segment || '?').padEnd(9)} ${String(r.n).padStart(5)}  ${dim(`(${r.active} active)`)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(14)} ${ok(String(total).padStart(5))}`);
  }

  // 4) Live API probe ------------------------------------------------------
  console.log('\n── 4. Live Dhan LTP probe (validates keys end-to-end) ──');
  if (hasId && hasTok) {
    const samples = await Instrument.find({ externalProvider: 'DHAN', instrumentToken: { $ne: null }, isActive: true })
      .select('symbol instrumentToken exchange lastPrice lastPriceUpdatedAt').sort({ exchange: 1 }).limit(40).lean();
    // pick up to 5 NSE_EQ + 3 NSE_FNO
    const eq = samples.filter((i) => SEG[i.exchange] === 'NSE_EQ').slice(0, 5);
    const fno = samples.filter((i) => SEG[i.exchange] === 'NSE_FNO').slice(0, 3);
    const probe = [...eq, ...fno];
    if (!probe.length) {
      console.log(dim('  (no instruments to probe)'));
    } else {
      const bySeg = {};
      for (const i of probe) (bySeg[SEG[i.exchange]] = bySeg[SEG[i.exchange]] || []).push(i);
      for (const seg of Object.keys(bySeg)) {
        const ids = bySeg[seg].map((i) => i.instrumentToken);
        try {
          const { status, json, raw } = await dhanLtp(seg, ids);
          if (status !== 200) {
            console.log(bad(`  ${seg}: HTTP ${status} — keys rejected or rate-limited`));
            console.log(dim(`    ${(raw || '').slice(0, 200)}`));
            hardFail = true;
            continue;
          }
          const data = (json && json.data && json.data[seg]) || {};
          for (const i of bySeg[seg]) {
            const q = data[String(i.instrumentToken)];
            const px = q && (q.last_price != null ? q.last_price : q.ltp);
            const live = px != null ? ok(`₹${px}`) : bad('no quote');
            console.log(`  ${i.symbol.padEnd(22)} ${seg.padEnd(8)} live=${live}  ${dim(`db=₹${i.lastPrice ?? '—'} ${ageStr(i.lastPriceUpdatedAt)}`)}`);
          }
        } catch (e) {
          console.log(bad(`  ${seg}: request failed — ${e.message}`));
          hardFail = true;
        }
      }
    }
  } else {
    console.log(dim('  skipped (no creds)'));
  }

  // 5) Freshness summary ---------------------------------------------------
  console.log('\n── 5. Cached-price freshness (newest DHAN tick in DB) ──');
  const newest = await Instrument.findOne({ externalProvider: 'DHAN', lastPriceUpdatedAt: { $ne: null } })
    .select('symbol lastPrice lastPriceUpdatedAt').sort({ lastPriceUpdatedAt: -1 }).lean();
  if (newest) {
    console.log(`  ${newest.symbol} ₹${newest.lastPrice}  last updated ${ageStr(newest.lastPriceUpdatedAt)}`);
    console.log(dim('  During market hours this should read seconds ago. If minutes/hours → feed not running (check backend logs for "[Dhan]").'));
  } else {
    console.log(dim('  No DHAN price ever written yet (feed has not ticked — normal before first open with keys set).'));
  }

  console.log(`\n${hardFail ? bad('RESULT: issues found — see red lines above.') : ok('RESULT: all core checks passed.')}\n`);
  await mongoose.disconnect();
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error(bad(`verify failed: ${e.stack || e.message}`)); process.exit(1); });
