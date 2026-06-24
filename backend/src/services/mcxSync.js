/**
 * mcxSync.js — import MCX commodity FUTURES (FUTCOM) from Dhan's scrip master.
 * The main NSE sync is exchange-scoped to NSE; commodities live on MCX, so they
 * get this dedicated, lightweight importer (futures only — no options, so it's a
 * few dozen contracts).
 *
 * Keeps the nearest N expiries per commodity (DHAN_MCX_EXPIRIES, default 3),
 * deactivates older/expired ones. Pricing comes from the Upstox feed once mapped
 * (services/upstoxFnoMap maps MCX_FO keys).
 *
 * Env: DHAN_SYNC_MCX (underlyings), DHAN_MCX_EXPIRIES (default 3).
 */
const Instrument = require('../models/Instrument');
const { nearestExpiries } = require('./optionUniverse');
const { MCX_UNDERLYINGS } = require('../config/indianFnoUnderlyings');

const CSV_URL = process.env.DHAN_SCRIP_URL || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const N_EXPIRIES = Math.max(1, Number(process.env.DHAN_MCX_EXPIRIES) || 3);
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

async function syncMcxFutures() {
  if (!MCX_UNDERLYINGS.length) return { ops: 0, kept: 0, deactivated: 0, skipped: 'no MCX underlyings' };

  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`scrip master HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const C = {
    exch: col('EXCH_ID'), sid: col('SECURITY_ID'), inst: col('INSTRUMENT'),
    lot: col('LOT_SIZE'), exp: col('SM_EXPIRY_DATE'), tick: col('TICK_SIZE'),
    custom: col('DISPLAY_NAME'), under: col('UNDERLYING_SYMBOL'),
    upperLimit: col('SM_UPPER_LIMIT'), lowerLimit: col('SM_LOWER_LIMIT'), freezeQty: col('SM_FREEZE_QTY'),
  };
  if (C.exch < 0 || C.sid < 0 || C.inst < 0 || C.under < 0 || C.exp < 0) throw new Error('unexpected scrip-master columns');
  const get = (a, i) => (i >= 0 && i < a.length ? String(a[i] || '').trim() : '');
  const band = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? String(x) : null; };

  const wanted = new Set(MCX_UNDERLYINGS);
  const rowsByUnder = new Map();
  for (let li = 1; li < lines.length; li++) {
    const r = parseCsvLine(lines[li]);
    if (get(r, C.exch).toUpperCase() !== 'MCX') continue;
    if (get(r, C.inst).toUpperCase() !== 'FUTCOM') continue;            // commodity futures only
    const under = get(r, C.under).toUpperCase();
    if (!wanted.has(under)) continue;
    const ds = get(r, C.exp); const d = ds ? new Date(ds) : null;
    if (!d || isNaN(d.getTime())) continue;
    if (!rowsByUnder.has(under)) rowsByUnder.set(under, []);
    rowsByUnder.get(under).push({
      under, expDate: d, sid: get(r, C.sid), lot: get(r, C.lot) || '1',
      tick: Number(get(r, C.tick)) || 0.05, custom: get(r, C.custom),
      upperCircuit: band(get(r, C.upperLimit)), lowerCircuit: band(get(r, C.lowerLimit)), freezeQty: band(get(r, C.freezeQty)),
    });
  }

  const now = Date.now();
  const ops = [];
  const keptSymbols = [];
  for (const [under, rows] of rowsByUnder) {
    const keepExp = nearestExpiries(rows.map((o) => o.expDate.getTime()), now, N_EXPIRIES);
    for (const o of rows) {
      if (!keepExp.has(o.expDate.getTime())) continue;
      const tag = `${MON[o.expDate.getUTCMonth()]}${String(o.expDate.getUTCFullYear()).slice(2)}`;
      const symbol = `${under}${tag}FUT`.replace(/\s+/g, '');
      if (!symbol || !o.sid) continue;
      keptSymbols.push(symbol);
      ops.push({ updateOne: {
        filter: { symbol },
        update: {
          $set: {
            symbol, name: o.custom || symbol, category: 'COMMODITY',
            exchange: 'MCX', segment: 'FUT', externalProvider: 'DHAN',
            instrumentToken: o.sid, tickSize: String(o.tick), lotSize: String(o.lot),
            upperCircuit: o.upperCircuit, lowerCircuit: o.lowerCircuit, freezeQty: o.freezeQty,
            pricePrecision: 2, quantityPrecision: 0, minOrderSize: String(o.lot),
            isActive: true, expiryDate: o.expDate, underlying: under,
          },
          $setOnInsert: { baseCurrency: under, quoteCurrency: 'INR' },
        },
        upsert: true,
      } });
    }
  }

  let upserted = 0; let modified = 0;
  for (let k = 0; k < ops.length; k += 1000) {
    const w = await Instrument.bulkWrite(ops.slice(k, k + 1000), { ordered: false });
    upserted += w.upsertedCount || 0; modified += w.modifiedCount || 0;
  }

  // Deactivate old/expired MCX futures not in the kept set.
  let deactivated = 0;
  if (rowsByUnder.size) {
    const d = await Instrument.updateMany(
      { exchange: 'MCX', segment: 'FUT', isActive: true, symbol: { $nin: keptSymbols } },
      { $set: { isActive: false } },
    );
    deactivated = d.modifiedCount || 0;
  }
  return { ops: ops.length, kept: keptSymbols.length, upserted, modified, deactivated };
}

module.exports = { syncMcxFutures };
