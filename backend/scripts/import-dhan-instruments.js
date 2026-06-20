/**
 * import-dhan-instruments.js — import REAL Indian instruments from Dhan's public
 * scrip master (reachable where Angel's isn't). Covers NSE cash equity, and
 * NSE F&O futures + options (NFO).
 *
 *   node scripts/import-dhan-instruments.js                       # NSE equity (curated NIFTY set)
 *   IMPORT_ALL=true node scripts/import-dhan-instruments.js       # all NSE equity
 *   IMPORT_SYMBOLS=RELIANCE,TCS node scripts/import-dhan-instruments.js
 *   IMPORT_FUTURES=true node scripts/import-dhan-instruments.js                 # NIFTY/BANKNIFTY/FINNIFTY futures
 *   IMPORT_OPTIONS=true IMPORT_SYMBOLS=NIFTY node scripts/import-dhan-instruments.js   # NIFTY option chain
 *
 * Tokens are Dhan SECURITY_IDs (externalProvider='DHAN'). Live prices need the
 * Dhan feed (separate). Idempotent (upsert by symbol). Prints the detected CSV
 * header + a sample so column mapping can be verified.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const CSV_URL = process.env.DHAN_SCRIP_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const EQ_DEFAULT = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'ITC', 'HINDUNILVR',
  'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'BAJFINANCE', 'ASIANPAINT', 'MARUTI', 'WIPRO',
  'SUNPHARMA', 'TITAN', 'TATAMOTORS', 'TATASTEEL', 'HCLTECH', 'NTPC', 'ONGC'];
const FO_DEFAULT = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

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
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI)'); process.exit(1); }

  console.log(`[dhan] fetching ${CSV_URL} …`);
  const res = await fetch(CSV_URL);
  if (!res.ok) { console.error(`[dhan] fetch failed: HTTP ${res.status}`); process.exit(1); }
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  console.log(`[dhan] rows: ${lines.length.toLocaleString()}`);

  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  console.log('[dhan] header:', header.join(' | '));
  const col = (...names) => {
    for (const n of names) { const i = header.findIndex((h) => h === n || h.includes(n)); if (i >= 0) return i; }
    return -1;
  };
  const C = {
    exch: col('SEM_EXM_EXCH_ID', 'EXCH_ID', 'EXCHANGE'),
    sid: col('SEM_SMST_SECURITY_ID', 'SECURITY_ID'),
    inst: col('SEM_INSTRUMENT_NAME', 'INSTRUMENT_NAME', 'INSTRUMENT'),
    sym: col('SEM_TRADING_SYMBOL', 'TRADING_SYMBOL'),
    lot: col('SEM_LOT_UNITS', 'LOT_UNITS', 'LOT'),
    exp: col('SEM_EXPIRY_DATE', 'EXPIRY_DATE', 'EXPIRY'),
    strike: col('SEM_STRIKE_PRICE', 'STRIKE_PRICE', 'STRIKE'),
    opt: col('SEM_OPTION_TYPE', 'OPTION_TYPE'),
    tick: col('SEM_TICK_SIZE', 'TICK_SIZE', 'TICK'),
    custom: col('SEM_CUSTOM_SYMBOL', 'CUSTOM_SYMBOL'),
    under: col('SM_SYMBOL_NAME', 'UNDERLYING_SYMBOL', 'SYMBOL_NAME'),
  };
  console.log('[dhan] column map:', C);
  if (C.exch < 0 || C.sid < 0 || C.inst < 0 || C.sym < 0) {
    console.error('[dhan] essential columns not found — paste the header above so the mapping can be fixed.');
    process.exit(1);
  }

  const importFutures = String(process.env.IMPORT_FUTURES || '').toLowerCase() === 'true';
  const importOptions = String(process.env.IMPORT_OPTIONS || '').toLowerCase() === 'true';
  const importAll = String(process.env.IMPORT_ALL || '').toLowerCase() === 'true';
  const wanted = (process.env.IMPORT_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  const get = (arr, i) => (i >= 0 && i < arr.length ? String(arr[i] || '').trim() : '');
  const ourExch = (dhanExch, instName) => {
    const deriv = /^(FUT|OPT)/.test(instName);
    if (dhanExch === 'NSE') return deriv ? 'NFO' : 'NSE';
    if (dhanExch === 'BSE') return deriv ? 'BFO' : 'BSE';
    return dhanExch;
  };

  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  const ops = [];
  let scanned = 0;
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    const exch = get(r, C.exch).toUpperCase();
    const inst = get(r, C.inst).toUpperCase();
    if (exch !== 'NSE') continue; // Phase 1-3 scope: NSE only
    scanned++;

    let category, segment, want = false;
    if (importOptions) {
      if (inst !== 'OPTIDX' && inst !== 'OPTSTK') continue;
      const under = (get(r, C.under) || '').toUpperCase();
      const set = wanted.length ? new Set(wanted) : new Set(FO_DEFAULT);
      if (!set.has(under)) continue;
      category = inst === 'OPTIDX' ? 'INDEX' : 'STOCK'; segment = 'OPT'; want = true;
    } else if (importFutures) {
      if (inst !== 'FUTIDX' && inst !== 'FUTSTK') continue;
      const under = (get(r, C.under) || '').toUpperCase();
      const set = wanted.length ? new Set(wanted) : new Set(FO_DEFAULT);
      if (!set.has(under)) continue;
      category = inst === 'FUTIDX' ? 'INDEX' : 'STOCK'; segment = 'FUT'; want = true;
    } else {
      if (inst !== 'EQUITY') continue;
      const tsym = get(r, C.sym).toUpperCase().replace(/-EQ$/, '');
      const set = wanted.length ? new Set(wanted) : (importAll ? null : new Set(EQ_DEFAULT));
      if (set !== null && !set.has(tsym)) continue;
      category = 'STOCK'; segment = 'EQ'; want = true;
    }
    if (!want) continue;

    const tradeSym = get(r, C.sym).toUpperCase().replace(/-EQ$/, '');
    const symbol = (segment === 'EQ' ? tradeSym : get(r, C.sym).toUpperCase()).replace(/\s+/g, '');
    if (!symbol) continue;
    const tick = Number(get(r, C.tick)) || 0.05;
    const lot = get(r, C.lot) || '1';
    const set$ = {
      symbol, name: get(r, C.custom) || symbol,
      category, exchange: ourExch(exch, inst), segment,
      externalProvider: 'DHAN', externalFeedSymbol: get(r, C.sym),
      instrumentToken: get(r, C.sid),
      tickSize: String(tick), lotSize: String(lot),
      pricePrecision: 2, quantityPrecision: 0, minOrderSize: segment === 'EQ' ? '1' : String(lot),
      isActive: true,
    };
    if (segment !== 'EQ') {
      const exp = get(r, C.exp); const d = exp ? new Date(exp) : null;
      if (d && !isNaN(d.getTime())) set$.expiryDate = d;
      set$.underlying = (get(r, C.under) || '').toUpperCase() || null;
    }
    if (segment === 'OPT') {
      set$.strike = String(Number(get(r, C.strike)) || get(r, C.strike));
      const ot = get(r, C.opt).toUpperCase();
      set$.optionType = ot === 'CE' || ot === 'CALL' ? 'CE' : (ot === 'PE' || ot === 'PUT' ? 'PE' : null);
      if (!set$.optionType) continue;
    }
    ops.push({ updateOne: {
      filter: { symbol },
      update: { $set: set$, $setOnInsert: { baseCurrency: set$.underlying || symbol, quoteCurrency: 'INR' } },
      upsert: true,
    } });
  }

  console.log(`[dhan] NSE ${importOptions ? 'options' : importFutures ? 'futures' : 'equity'} matched: ${ops.length}`);
  if (!ops.length) { console.error('[dhan] nothing matched — check filters/header mapping above.'); process.exit(1); }
  const w = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[dhan] ✓ upserted=${w.upsertedCount || 0} modified=${w.modifiedCount || 0}`);
  console.log('[dhan] sample:', ops.slice(0, 6).map((o) => o.updateOne.update.$set.symbol).join(', '));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
