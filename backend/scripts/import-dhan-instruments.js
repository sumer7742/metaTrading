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
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }       // exact first
    for (const n of names) { const i = header.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };
  const C = {
    exch: col('EXCH_ID', 'SEM_EXM_EXCH_ID', 'EXCHANGE'),
    sid: col('SECURITY_ID', 'SEM_SMST_SECURITY_ID'),
    isin: col('ISIN', 'SEM_ISIN', 'ISIN_CODE'),
    inst: col('INSTRUMENT', 'SEM_INSTRUMENT_NAME'),
    sym: col('SYMBOL_NAME', 'SEM_TRADING_SYMBOL', 'TRADING_SYMBOL'),
    series: col('SERIES'),
    lot: col('LOT_SIZE', 'SEM_LOT_UNITS', 'LOT_UNITS'),
    exp: col('SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE'),
    strike: col('STRIKE_PRICE', 'SEM_STRIKE_PRICE', 'STRIKE'),
    opt: col('OPTION_TYPE', 'SEM_OPTION_TYPE'),
    tick: col('TICK_SIZE', 'SEM_TICK_SIZE'),
    custom: col('DISPLAY_NAME', 'SEM_CUSTOM_SYMBOL'),
    under: col('UNDERLYING_SYMBOL', 'SM_SYMBOL_NAME'),
    upperLimit: col('SM_UPPER_LIMIT'), lowerLimit: col('SM_LOWER_LIMIT'), freezeQty: col('SM_FREEZE_QTY'),
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

  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const ops = [];
  const nseInstCounts = {}; // diagnostic: distinct INSTRUMENT values for NSE
  const eqSamples = [];     // diagnostic: sample EQUITY rows [SYMBOL_NAME, DISPLAY_NAME, UNDERLYING_SYMBOL, SERIES]
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    if (get(r, C.exch).toUpperCase() !== 'NSE') continue; // scope: NSE only
    const inst = get(r, C.inst).toUpperCase();
    nseInstCounts[inst] = (nseInstCounts[inst] || 0) + 1;

    let category, segment;
    if (importOptions) {
      if (inst !== 'OPTIDX' && inst !== 'OPTSTK') continue;
      category = inst === 'OPTIDX' ? 'INDEX' : 'STOCK'; segment = 'OPT';
    } else if (importFutures) {
      if (inst !== 'FUTIDX' && inst !== 'FUTSTK') continue;
      category = inst === 'FUTIDX' ? 'INDEX' : 'STOCK'; segment = 'FUT';
    } else {
      if (inst !== 'EQUITY') continue;
      if (eqSamples.length < 6) eqSamples.push([get(r, C.sym), get(r, C.custom), get(r, C.under), C.series >= 0 ? get(r, C.series) : '']);
      const ser = C.series >= 0 ? get(r, C.series).toUpperCase() : '';
      if (ser && ser !== 'EQ' && ser !== 'BE') continue; // keep EQ + BE series
      category = 'STOCK'; segment = 'EQ';
    }

    const under = (get(r, C.under) || '').toUpperCase();

    // Selection filter.
    if (segment === 'EQ') {
      const tsym = under.replace(/\s+/g, ''); // UNDERLYING_SYMBOL is the clean ticker (SYMBOL_NAME is the long name)
      const set = wanted.length ? new Set(wanted) : (importAll ? null : new Set(EQ_DEFAULT));
      if (set !== null && !set.has(tsym)) continue;
    } else {
      const set = wanted.length ? new Set(wanted) : new Set(FO_DEFAULT);
      if (!under || !set.has(under)) continue;
    }

    // Expiry + tag (F&O).
    let expDate = null, expTag = '';
    if (segment !== 'EQ') {
      const d = get(r, C.exp) ? new Date(get(r, C.exp)) : null;
      if (d && !isNaN(d.getTime())) { expDate = d; expTag = `${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`; }
    }
    // Option type + strike.
    let optType = null, strikeVal = null;
    if (segment === 'OPT') {
      const ot = get(r, C.opt).toUpperCase();
      optType = (ot === 'CE' || ot === 'CALL') ? 'CE' : ((ot === 'PE' || ot === 'PUT') ? 'PE' : null);
      if (!optType) continue;
      strikeVal = Number(get(r, C.strike)) || get(r, C.strike);
    }

    // Unique platform symbol (F&O built from components — Dhan's SYMBOL_NAME is
    // the underlying, not unique per contract).
    let symbol;
    if (segment === 'EQ') symbol = under.replace(/\s+/g, ''); // ticker from UNDERLYING_SYMBOL
    else if (segment === 'FUT') symbol = `${under}${expTag}FUT`;
    else symbol = `${under}${expTag}${strikeVal}${optType}`;
    symbol = (symbol || '').replace(/\s+/g, '');
    if (!symbol) continue;

    const tick = Number(get(r, C.tick)) || 0.05;
    const lot = get(r, C.lot) || '1';
    const set$ = {
      symbol, name: get(r, C.custom) || symbol,
      category, exchange: ourExch(get(r, C.exch).toUpperCase(), inst), segment,
      externalProvider: 'DHAN', externalFeedSymbol: get(r, C.sym),
      instrumentToken: get(r, C.sid), isin: get(r, C.isin) || null,
      upperCircuit: (Number(get(r, C.upperLimit)) > 0 ? String(Number(get(r, C.upperLimit))) : null),
      lowerCircuit: (Number(get(r, C.lowerLimit)) > 0 ? String(Number(get(r, C.lowerLimit))) : null),
      freezeQty: (Number(get(r, C.freezeQty)) > 0 ? String(Number(get(r, C.freezeQty))) : null),
      tickSize: String(tick), lotSize: String(lot),
      pricePrecision: 2, quantityPrecision: 0, minOrderSize: segment === 'EQ' ? '1' : String(lot),
      isActive: true,
    };
    if (segment !== 'EQ') { if (expDate) set$.expiryDate = expDate; set$.underlying = under || null; }
    if (segment === 'OPT') { set$.strike = String(strikeVal); set$.optionType = optType; }

    ops.push({ updateOne: {
      filter: { symbol },
      update: { $set: set$, $setOnInsert: { baseCurrency: set$.underlying || symbol, quoteCurrency: 'INR' } },
      upsert: true,
    } });
  }

  console.log(`[dhan] NSE ${importOptions ? 'options' : importFutures ? 'futures' : 'equity'} matched: ${ops.length}`);
  if (!ops.length) {
    console.error('[dhan] nothing matched. NSE INSTRUMENT values seen (name: count):');
    console.error(JSON.stringify(nseInstCounts, null, 0));
    console.error('[dhan] sample EQUITY rows [SYMBOL_NAME, DISPLAY_NAME, UNDERLYING_SYMBOL, SERIES]:');
    eqSamples.forEach((s) => console.error('   ' + JSON.stringify(s)));
    process.exit(1);
  }
  const w = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[dhan] ✓ upserted=${w.upsertedCount || 0} modified=${w.modifiedCount || 0}`);
  console.log('[dhan] sample:', ops.slice(0, 6).map((o) => o.updateOne.update.$set.symbol).join(', '));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
