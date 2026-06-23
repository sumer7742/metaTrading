/**
 * upstoxFnoMap.js — map our F&O instruments to Upstox instrument_keys so the live
 * feed can pull the REAL futures/option price (instead of the spot-proxy /
 * intrinsic fallback).
 *
 * Upstox publishes a gzipped instrument master; we download it, index the NSE_FO
 * (+ BSE_FO) contracts by canonical-underlying|expiry|strike|type, then stamp the
 * matching `instrument_key` onto Instrument.upstoxKey. F&O tokens roll each
 * series, so the background worker re-runs this daily after the Dhan sync.
 *
 * Robustness: underlyings are canonicalised (NIFTY vs "Nifty 50", BANKNIFTY vs
 * "Nifty Bank", …) and expiry is matched with ±1-day tolerance (Dhan stores
 * midnight, Upstox ~15:30 IST — a timezone edge can shift the day).
 *
 * Env: UPSTOX_INSTRUMENTS_URL (optional override of the NSE master URL).
 */
const zlib = require('zlib');
const Instrument = require('../models/Instrument');

const URL = process.env.UPSTOX_INSTRUMENTS_URL
  || 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

// Canonicalise an index/underlying name so both sides agree.
const ALIAS = {
  NIFTY: 'NIFTY', NIFTY50: 'NIFTY',
  BANKNIFTY: 'BANKNIFTY', NIFTYBANK: 'BANKNIFTY',
  FINNIFTY: 'FINNIFTY', NIFTYFINSERVICE: 'FINNIFTY', NIFTYFINANCIALSERVICES: 'FINNIFTY',
  MIDCPNIFTY: 'MIDCPNIFTY', NIFTYMIDSELECT: 'MIDCPNIFTY', NIFTYMIDCAPSELECT: 'MIDCPNIFTY',
};
const canon = (u) => {
  const s = String(u || '').toUpperCase().replace(/\s+/g, '');
  return ALIAS[s] || s;
};

// Normalise any expiry (ms or Date) to an IST YYYY-MM-DD string.
const istDay = (ms) => new Date(Number(ms) + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
const addDays = (dayStr, n) => {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const key = (cu, day, strike, type) => {
  const t = type === 'CE' || type === 'PE' ? type : 'FUT';
  return `${cu}|${day}|${t === 'FUT' ? '' : String(Number(strike))}|${t}`;
};

async function mapFnoKeys() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Upstox instruments HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

  // Index Upstox F&O contracts by canonical key, plus a reverse index
  // (underlying|strike|type → expiry days) for diagnosing date mismatches.
  const lut = new Map();
  const ustCT = new Map();
  for (const it of json) {
    const seg = it.segment || it.exchange_segment || '';
    if (seg !== 'NSE_FO' && seg !== 'BSE_FO') continue;
    if (!it.instrument_key || !it.expiry) continue;
    const type = String(it.instrument_type || '').toUpperCase(); // CE / PE / FUT
    const under = canon(it.underlying_symbol || it.asset_symbol || it.name);
    if (!under) continue;
    const day = istDay(it.expiry);
    lut.set(key(under, day, it.strike_price, type), it.instrument_key);
    const ct = `${under}|${type === 'FUT' ? '' : String(Number(it.strike_price))}|${type === 'FUT' ? 'FUT' : type}`;
    if (!ustCT.has(ct)) ustCT.set(ct, new Set());
    ustCT.get(ct).add(day);
  }

  // Stamp the key onto our active F&O instruments.
  const ours = await Instrument.find({ segment: { $in: ['FUT', 'OPT'] }, isActive: true })
    .select('symbol segment underlying expiryDate strike optionType upstoxKey').lean();

  const ops = [];
  let matched = 0; let missing = 0;
  const byUnder = {}; const missSamples = [];
  for (const i of ours) {
    const u = canon(i.underlying);
    const bucket = byUnder[u] || (byUnder[u] = { matched: 0, missing: 0 });
    if (!i.expiryDate || !i.underlying) { missing += 1; bucket.missing += 1; continue; }
    const type = i.segment === 'OPT' ? String(i.optionType || '').toUpperCase() : 'FUT';
    const base = istDay(new Date(i.expiryDate).getTime());
    let found = null;
    for (const d of [base, addDays(base, -1), addDays(base, 1)]) { // ±1 day tolerance
      found = lut.get(key(u, d, i.strike, type));
      if (found) break;
    }
    if (!found) {
      missing += 1; bucket.missing += 1;
      if (missSamples.length < 8) {
        const ct = `${u}|${type === 'FUT' ? '' : String(Number(i.strike))}|${type}`;
        const have = ustCT.get(ct);
        missSamples.push(`${i.symbol}  ours=${base}  upstoxHas=[${have ? [...have].sort().join(',') : 'NONE'}]`);
      }
      continue;
    }
    matched += 1; bucket.matched += 1;
    if (i.upstoxKey !== found) ops.push({ updateOne: { filter: { symbol: i.symbol }, update: { $set: { upstoxKey: found } } } });
  }
  for (let k = 0; k < ops.length; k += 2000) {
    await Instrument.bulkWrite(ops.slice(k, k + 2000), { ordered: false });
  }
  return { fno: ours.length, matched, missing, updated: ops.length, upstoxContracts: lut.size, byUnder, missSamples };
}

module.exports = { mapFnoKeys };
