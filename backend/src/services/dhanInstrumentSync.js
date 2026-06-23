/**
 * dhanInstrumentSync.js — periodic refresh of Indian instruments from Dhan's
 * scrip master, so F&O contracts (whose tokens roll each series) and new
 * expiries stay current without manual re-imports.
 *
 * One CSV pass upserts: all NSE cash equity (series EQ/BE) + futures + options
 * for the configured underlyings. Called by the background worker once a day
 * (pre-market). The CLI scripts/import-dhan-instruments.js stays for manual /
 * one-off imports.
 *
 * Env:
 *   DHAN_SCRIP_URL           (optional override)
 *   DHAN_SYNC_FNO=NIFTY,BANKNIFTY,FINNIFTY   underlyings to keep F&O for
 *   DHAN_SYNC_EQUITY=all|curated             default 'all'
 */
const Instrument = require('../models/Instrument');
const { LIQUID_NSE_SET } = require('../config/indianLiquidStocks');

const CSV_URL = process.env.DHAN_SCRIP_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const FO_UNDERLYINGS = (process.env.DHAN_SYNC_FNO || 'NIFTY,BANKNIFTY,FINNIFTY')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
// Default 'curated': only keep the liquid universe (real-price-able on the free
// Yahoo feed). Set DHAN_SYNC_EQUITY=all to import every listed scrip again.
const EQUITY_MODE = (process.env.DHAN_SYNC_EQUITY || 'curated').toLowerCase();
const EQ_CURATED = LIQUID_NSE_SET;
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

async function syncAll() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`scrip master HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...names) => {
    for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
    for (const n of names) { const i = header.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };
  const C = {
    exch: col('EXCH_ID'), sid: col('SECURITY_ID'), isin: col('ISIN'), inst: col('INSTRUMENT'),
    series: col('SERIES'), lot: col('LOT_SIZE'), exp: col('SM_EXPIRY_DATE'),
    strike: col('STRIKE_PRICE'), opt: col('OPTION_TYPE'), tick: col('TICK_SIZE'),
    custom: col('DISPLAY_NAME'), under: col('UNDERLYING_SYMBOL'),
  };
  if (C.exch < 0 || C.sid < 0 || C.inst < 0 || C.under < 0) throw new Error('unexpected scrip-master columns');
  const get = (a, i) => (i >= 0 && i < a.length ? String(a[i] || '').trim() : '');

  const ops = [];
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    if (get(r, C.exch).toUpperCase() !== 'NSE') continue;
    const inst = get(r, C.inst).toUpperCase();
    const under = get(r, C.under).toUpperCase();

    let category, segment;
    if (inst === 'EQUITY') {
      const ser = get(r, C.series).toUpperCase();
      if (ser && ser !== 'EQ' && ser !== 'BE') continue;
      if (EQUITY_MODE !== 'all' && !EQ_CURATED.has(under)) continue;
      category = 'STOCK'; segment = 'EQ';
    } else if ((inst === 'FUTIDX' || inst === 'FUTSTK') && FO_UNDERLYINGS.includes(under)) {
      category = inst === 'FUTIDX' ? 'INDEX' : 'STOCK'; segment = 'FUT';
    } else if ((inst === 'OPTIDX' || inst === 'OPTSTK') && FO_UNDERLYINGS.includes(under)) {
      category = inst === 'OPTIDX' ? 'INDEX' : 'STOCK'; segment = 'OPT';
    } else continue;
    if (!under) continue;

    let expDate = null, expTag = '';
    if (segment !== 'EQ') {
      const d = get(r, C.exp) ? new Date(get(r, C.exp)) : null;
      if (d && !isNaN(d.getTime())) { expDate = d; expTag = `${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`; }
    }
    let optType = null, strikeVal = null;
    if (segment === 'OPT') {
      const ot = get(r, C.opt).toUpperCase();
      optType = (ot === 'CE' || ot === 'CALL') ? 'CE' : ((ot === 'PE' || ot === 'PUT') ? 'PE' : null);
      if (!optType) continue;
      strikeVal = Number(get(r, C.strike)) || get(r, C.strike);
    }

    let symbol;
    if (segment === 'EQ') symbol = under.replace(/\s+/g, '');
    else if (segment === 'FUT') symbol = `${under}${expTag}FUT`;
    else symbol = `${under}${expTag}${strikeVal}${optType}`;
    symbol = (symbol || '').replace(/\s+/g, '');
    if (!symbol) continue;

    const lot = get(r, C.lot) || '1';
    const set$ = {
      symbol, name: get(r, C.custom) || symbol, category,
      exchange: segment === 'EQ' ? 'NSE' : 'NFO', segment,
      externalProvider: 'DHAN', instrumentToken: get(r, C.sid), isin: get(r, C.isin) || null,
      tickSize: String(Number(get(r, C.tick)) || 0.05), lotSize: String(lot),
      pricePrecision: 2, quantityPrecision: 0, minOrderSize: segment === 'EQ' ? '1' : String(lot),
      isActive: true,
    };
    if (segment !== 'EQ') { if (expDate) set$.expiryDate = expDate; set$.underlying = under; }
    if (segment === 'OPT') { set$.strike = String(strikeVal); set$.optionType = optType; }
    ops.push({ updateOne: {
      filter: { symbol },
      update: { $set: set$, $setOnInsert: { baseCurrency: set$.underlying || symbol, quoteCurrency: 'INR' } },
      upsert: true,
    } });
  }

  if (!ops.length) return { ops: 0, upserted: 0, modified: 0, deactivated: 0 };
  let upserted = 0, modified = 0;
  for (let k = 0; k < ops.length; k += 2000) { // batch to keep each bulkWrite modest
    const w = await Instrument.bulkWrite(ops.slice(k, k + 2000), { ordered: false });
    upserted += w.upsertedCount || 0; modified += w.modifiedCount || 0;
  }

  // Curated mode is the source of truth for the cash-equity universe: deactivate
  // any NSE EQ that's not in the liquid list (self-healing — keeps the daily sync
  // from re-surfacing penny stocks), and (re)activate the ones that are.
  let deactivated = 0;
  if (EQUITY_MODE !== 'all') {
    const keep = [...EQ_CURATED];
    const d = await Instrument.updateMany(
      { exchange: 'NSE', segment: 'EQ', symbol: { $nin: keep }, isActive: true },
      { $set: { isActive: false } },
    );
    deactivated = d.modifiedCount || 0;
    await Instrument.updateMany(
      { exchange: 'NSE', segment: 'EQ', symbol: { $in: keep }, isActive: false },
      { $set: { isActive: true } },
    );
  }
  return { ops: ops.length, upserted, modified, deactivated };
}

module.exports = { syncAll };
