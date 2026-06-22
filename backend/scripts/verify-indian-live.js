/**
 * verify-indian-live.js — one-shot health check for the Indian live-price stack.
 * Auto-detects the active feed (Yahoo free, or Dhan paid). Run inside the backend
 * container so it inherits MONGODB_URI + feed env:
 *
 *   docker compose exec backend node scripts/verify-indian-live.js
 *
 * Checks, in order:
 *   1. Active feed provider + its credentials
 *   2. NSE / NFO session right now (IST) — is the market actually open?
 *   3. Imported instrument counts by exchange/segment
 *   4. Live API probe for a few sample instruments (validates the feed end-to-end)
 *   5. DB lastPrice freshness (how stale is the cached price the app serves?)
 *
 * Read-only. Exits non-zero if a hard prerequisite fails so it doubles as a smoke gate.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Instrument = require('../src/models/Instrument');
const { getSession } = require('../src/services/marketHours');
const yahooFeed = require('../src/services/yahooFeed');

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;

const FEED = (process.env.INDIAN_FEED || '').toLowerCase()
  || (process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN ? 'dhan' : 'yahoo');
const DHAN_SEG = { NSE: 'NSE_EQ', BSE: 'BSE_EQ', NFO: 'NSE_FNO', BFO: 'BSE_FNO', MCX: 'MCX_COMM' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function ageStr(d) {
  if (!d) return bad('never');
  const sec = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 90) return ok(`${sec}s ago`);
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return bad(`${Math.round(sec / 3600)}h ago`);
}

async function dhanLtp(seg, ids) {
  const res = await fetch('https://api.dhan.co/v2/marketfeed/ltp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json',
      'access-token': process.env.DHAN_ACCESS_TOKEN, 'client-id': process.env.DHAN_CLIENT_ID,
    },
    body: JSON.stringify({ [seg]: ids.map(Number) }),
  });
  const raw = await res.text();
  let json = {}; try { json = raw ? JSON.parse(raw) : {}; } catch (_) { /* */ }
  return { status: res.status, json, raw };
}

async function yahooLtp(sym) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return { status: res.status, px: null };
  const j = await res.json();
  const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  return { status: 200, px: m ? (m.regularMarketPrice != null ? m.regularMarketPrice : m.previousClose) : null };
}

(async () => {
  let hardFail = false;

  // 1) Feed + credentials --------------------------------------------------
  console.log(`\n── 1. Active feed: ${ok(FEED.toUpperCase())} ──`);
  if (FEED === 'dhan') {
    const hasId = !!process.env.DHAN_CLIENT_ID; const hasTok = !!process.env.DHAN_ACCESS_TOKEN;
    console.log(`  DHAN_CLIENT_ID    : ${hasId ? ok('set') : bad('MISSING')}`);
    console.log(`  DHAN_ACCESS_TOKEN : ${hasTok ? ok(`set (${process.env.DHAN_ACCESS_TOKEN.length} chars)`) : bad('MISSING')}`);
    if (!hasId || !hasTok) { console.log(bad('  → Dhan feed disabled without both. Set in backend/.env + restart.')); hardFail = true; }
  } else {
    console.log(`  ${ok('FREE — no API key needed')} ${dim('(Yahoo Finance public chart endpoint)')}`);
    console.log(dim('  Equities + indices = real LTP. Futures = underlying-spot proxy. Options = intrinsic (no time value).'));
  }

  // 2) Session -------------------------------------------------------------
  console.log('\n── 2. Market session (IST now) ──');
  for (const ex of ['NSE', 'NFO']) {
    const s = getSession(ex, new Date());
    console.log(`  ${ex.padEnd(4)} ${s.isOpen ? ok('OPEN') : dim(`closed (${s.reason})`)}   ${dim(`${s.opensAt}–${s.closesAt} ${s.tz || ''}`)}`);
  }
  console.log(dim('  (Prices only tick while OPEN. Outside hours the feed sleeps; cached LTP shown.)'));

  const URI = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!URI) { console.log(bad('\nNo MONGODB_URI — cannot check instruments.')); process.exit(1); }
  await mongoose.connect(URI);

  // 3) Instrument inventory ------------------------------------------------
  console.log('\n── 3. Imported Indian instruments ──');
  const rows = await Instrument.aggregate([
    { $match: { exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO'] } } },
    { $group: { _id: { exchange: '$exchange', segment: '$segment' }, n: { $sum: 1 }, active: { $sum: { $cond: ['$isActive', 1, 0] } } } },
    { $sort: { _id: 1 } },
  ]);
  if (!rows.length) {
    console.log(bad('  No Indian instruments found. Run the importer (free, no key):'));
    console.log(dim('    docker compose exec backend node scripts/import-dhan-instruments.js'));
    console.log(dim('    docker compose exec -e IMPORT_FUTURES=true backend node scripts/import-dhan-instruments.js'));
    hardFail = true;
  } else {
    let total = 0;
    for (const r of rows) { total += r.n; console.log(`  ${(r._id.exchange || '?').padEnd(4)} ${(r._id.segment || '?').padEnd(9)} ${String(r.n).padStart(5)}  ${dim(`(${r.active} active)`)}`); }
    console.log(`  ${'TOTAL'.padEnd(14)} ${ok(String(total).padStart(5))}`);
  }

  // 4) Live probe ----------------------------------------------------------
  console.log(`\n── 4. Live ${FEED.toUpperCase()} probe (validates feed end-to-end) ──`);
  const samples = await Instrument.find({ exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO'] }, isActive: true })
    .select('symbol exchange segment underlying strike optionType instrumentToken lastPrice lastPriceUpdatedAt')
    .sort({ segment: 1 }).limit(60).lean();
  const eq = samples.filter((i) => i.segment === 'EQ').slice(0, 5);
  const der = samples.filter((i) => i.segment === 'FUT' || i.segment === 'OPT').slice(0, 3);
  const probe = [...eq, ...der];

  if (!probe.length) {
    console.log(dim('  (no instruments to probe)'));
  } else if (FEED === 'yahoo') {
    for (const i of probe) {
      const sym = yahooFeed.spotSymbol(i);
      if (!sym) { console.log(`  ${i.symbol.padEnd(22)} ${dim('no Yahoo mapping')}`); continue; }
      try {
        const { status, px } = await yahooLtp(sym);
        if (status !== 200) { console.log(bad(`  ${i.symbol.padEnd(22)} ${sym} HTTP ${status} (Yahoo rate-limit/blocked)`)); hardFail = true; continue; }
        const derived = yahooFeed.priceFor(i, px);
        const live = px != null ? ok(`₹${derived}`) : bad('no quote');
        const note = i.segment === 'FUT' ? dim('[spot proxy]') : i.segment === 'OPT' ? dim('[intrinsic]') : '';
        console.log(`  ${i.symbol.padEnd(22)} ${dim(sym.padEnd(12))} live=${live} ${note}  ${dim(`db=₹${i.lastPrice ?? '—'} ${ageStr(i.lastPriceUpdatedAt)}`)}`);
      } catch (e) { console.log(bad(`  ${i.symbol}: ${e.message}`)); hardFail = true; }
    }
  } else {
    const withTok = probe.filter((i) => i.instrumentToken != null);
    const bySeg = {};
    for (const i of withTok) (bySeg[DHAN_SEG[i.exchange]] = bySeg[DHAN_SEG[i.exchange]] || []).push(i);
    for (const seg of Object.keys(bySeg)) {
      try {
        const { status, json, raw } = await dhanLtp(seg, bySeg[seg].map((i) => i.instrumentToken));
        if (status !== 200) { console.log(bad(`  ${seg}: HTTP ${status} — keys rejected/rate-limited`)); console.log(dim(`    ${(raw || '').slice(0, 200)}`)); hardFail = true; continue; }
        const data = (json && json.data && json.data[seg]) || {};
        for (const i of bySeg[seg]) {
          const q = data[String(i.instrumentToken)];
          const px = q && (q.last_price != null ? q.last_price : q.ltp);
          console.log(`  ${i.symbol.padEnd(22)} ${seg.padEnd(8)} live=${px != null ? ok(`₹${px}`) : bad('no quote')}  ${dim(`db=₹${i.lastPrice ?? '—'} ${ageStr(i.lastPriceUpdatedAt)}`)}`);
        }
      } catch (e) { console.log(bad(`  ${seg}: ${e.message}`)); hardFail = true; }
    }
  }

  // 5) Freshness -----------------------------------------------------------
  console.log('\n── 5. Cached-price freshness (newest Indian tick in DB) ──');
  const newest = await Instrument.findOne({ exchange: { $in: ['NSE', 'BSE', 'NFO', 'BFO'] }, lastPriceUpdatedAt: { $ne: null } })
    .select('symbol lastPrice lastPriceUpdatedAt').sort({ lastPriceUpdatedAt: -1 }).lean();
  if (newest) {
    console.log(`  ${newest.symbol} ₹${newest.lastPrice}  last updated ${ageStr(newest.lastPriceUpdatedAt)}`);
    console.log(dim('  During market hours this should read seconds ago. If minutes/hours → feed not running (check logs for "[Yahoo]"/"[Dhan]").'));
  } else {
    console.log(dim('  No Indian price ever written yet (feed has not ticked — normal before first open).'));
  }

  console.log(`\n${hardFail ? bad('RESULT: issues found — see red lines above.') : ok('RESULT: all core checks passed.')}\n`);
  await mongoose.disconnect();
  process.exit(hardFail ? 1 : 0);
})().catch((e) => { console.error(bad(`verify failed: ${e.stack || e.message}`)); process.exit(1); });
