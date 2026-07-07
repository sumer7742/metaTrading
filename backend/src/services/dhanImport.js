/**
 * dhanImport.js — on-demand import of SPECIFIC Indian instruments from Dhan's
 * public scrip master. The callable core of scripts/import-dhan-instruments.js,
 * but it runs against the already-connected mongoose (no connect/exit), so an
 * admin endpoint can invoke it. Full exchange metadata is saved: exchange,
 * segment, instrument token, ISIN, tick/lot, expiry, strike, optionType,
 * circuit limits, INR currency. Live price is served separately by the feed.
 */
const Instrument = require('../models/Instrument');

const CSV_URL = process.env.DHAN_SCRIP_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
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

const _ourExch = (dhanExch, instName) => {
  const deriv = /^(FUT|OPT)/.test(instName);
  if (dhanExch === 'NSE') return deriv ? 'NFO' : 'NSE';
  if (dhanExch === 'BSE') return deriv ? 'BFO' : 'BSE';
  return dhanExch;
};

/**
 * Import specific NSE instruments by symbol.
 * @param {'EQUITY'|'FUTURES'|'OPTIONS'} kind
 * @param {string[]} symbols  EQUITY → tickers (RELIANCE, TCS); FUT/OPT → underlyings (NIFTY)
 */
async function importDhanInstruments({ kind = 'EQUITY', symbols = [] } = {}) {
  const wanted = (symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  if (!wanted.length) throw new Error('At least one symbol is required');
  const wantedSet = new Set(wanted);
  const isOpt = kind === 'OPTIONS';
  const isFut = kind === 'FUTURES';

  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`scrip master HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = {
    exch: col('EXCH_ID'), sid: col('SECURITY_ID'), isin: col('ISIN'), inst: col('INSTRUMENT'),
    sym: col('SYMBOL_NAME'), custom: col('DISPLAY_NAME'), under: col('UNDERLYING_SYMBOL'),
    series: col('SERIES'), lot: col('LOT_SIZE'), exp: col('SM_EXPIRY_DATE'),
    strike: col('STRIKE_PRICE'), opt: col('OPTION_TYPE'), tick: col('TICK_SIZE'),
    upperLimit: col('SM_UPPER_LIMIT'), lowerLimit: col('SM_LOWER_LIMIT'), freezeQty: col('SM_FREEZE_QTY'),
  };
  if (C.exch < 0 || C.sid < 0 || C.inst < 0 || C.under < 0) throw new Error('unexpected scrip-master columns');
  const get = (arr, i) => (i >= 0 && i < arr.length ? String(arr[i] || '').trim() : '');

  const ops = [];
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    if (get(r, C.exch).toUpperCase() !== 'NSE') continue; // NSE only (equity + F&O)
    const inst = get(r, C.inst).toUpperCase();

    let category, segment;
    if (isOpt) { if (inst !== 'OPTIDX' && inst !== 'OPTSTK') continue; category = inst === 'OPTIDX' ? 'INDEX' : 'STOCK'; segment = 'OPT'; }
    else if (isFut) { if (inst !== 'FUTIDX' && inst !== 'FUTSTK') continue; category = inst === 'FUTIDX' ? 'INDEX' : 'STOCK'; segment = 'FUT'; }
    else { if (inst !== 'EQUITY') continue; const ser = C.series >= 0 ? get(r, C.series).toUpperCase() : ''; if (ser && ser !== 'EQ' && ser !== 'BE') continue; category = 'STOCK'; segment = 'EQ'; }

    const under = (get(r, C.under) || '').toUpperCase();
    if (segment === 'EQ') { if (!wantedSet.has(under.replace(/\s+/g, ''))) continue; }
    else { if (!under || !wantedSet.has(under)) continue; }

    let expDate = null, expTag = '';
    if (segment !== 'EQ') { const d = get(r, C.exp) ? new Date(get(r, C.exp)) : null; if (d && !isNaN(d.getTime())) { expDate = d; expTag = `${MON[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}`; } }
    let optType = null, strikeVal = null;
    if (segment === 'OPT') { const ot = get(r, C.opt).toUpperCase(); optType = (ot === 'CE' || ot === 'CALL') ? 'CE' : ((ot === 'PE' || ot === 'PUT') ? 'PE' : null); if (!optType) continue; strikeVal = Number(get(r, C.strike)) || get(r, C.strike); }

    let symbol;
    if (segment === 'EQ') symbol = under.replace(/\s+/g, '');
    else if (segment === 'FUT') symbol = `${under}${expTag}FUT`;
    else symbol = `${under}${expTag}${strikeVal}${optType}`;
    symbol = (symbol || '').replace(/\s+/g, '');
    if (!symbol) continue;

    const tick = Number(get(r, C.tick)) || 0.05;
    const lot = get(r, C.lot) || '1';
    const set$ = {
      symbol, name: get(r, C.custom) || symbol,
      category, exchange: _ourExch(get(r, C.exch).toUpperCase(), inst), segment,
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

  if (!ops.length) {
    return { kind, requested: wanted, matched: 0, upserted: 0, modified: 0, symbols: [], note: 'No matching instruments found in the Dhan scrip master for those symbols. Check the ticker spelling (use the exact NSE symbol, e.g. RELIANCE, TCS).' };
  }
  let upserted = 0; let modified = 0;
  for (let k = 0; k < ops.length; k += 1000) {
    const w = await Instrument.bulkWrite(ops.slice(k, k + 1000), { ordered: false });
    upserted += w.upsertedCount || 0; modified += w.modifiedCount || 0;
  }
  return { kind, requested: wanted, matched: ops.length, upserted, modified, symbols: ops.slice(0, 25).map((o) => o.updateOne.update.$set.symbol) };
}

module.exports = { importDhanInstruments };
