/**
 * upstoxFnoMap.js — map our F&O instruments to Upstox instrument_keys so the live
 * feed can pull the REAL futures/option price (instead of the spot-proxy /
 * intrinsic fallback).
 *
 * Upstox publishes a gzipped instrument master; we download it, index the NSE_FO
 * (+ BSE_FO) contracts by underlying|expiry|strike|type, then stamp the matching
 * `instrument_key` onto Instrument.upstoxKey. F&O tokens roll each series, so the
 * background worker re-runs this daily after the Dhan sync.
 *
 * Env:
 *   UPSTOX_INSTRUMENTS_URL  (optional override of the NSE master URL)
 */
const zlib = require('zlib');
const Instrument = require('../models/Instrument');

const URL = process.env.UPSTOX_INSTRUMENTS_URL
  || 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

// Normalise any expiry (ms timestamp or Date) to an IST YYYY-MM-DD string, so
// Upstox (expiry at ~15:30 IST) and Dhan (often midnight) align on the same day.
function istDay(ms) {
  return new Date(Number(ms) + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Build the contract lookup key shared by both sides.
function contractKey(under, expDayStr, strike, type) {
  const t = type === 'CE' || type === 'PE' ? type : 'FUT';
  const k = t === 'FUT' ? '' : String(Number(strike));
  return `${String(under).toUpperCase()}|${expDayStr}|${k}|${t}`;
}

async function mapFnoKeys() {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Upstox instruments HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

  // Index Upstox F&O contracts.
  const lut = new Map();
  for (const it of json) {
    const seg = it.segment || it.exchange_segment || '';
    if (seg !== 'NSE_FO' && seg !== 'BSE_FO') continue;
    if (!it.instrument_key || !it.expiry) continue;
    const type = String(it.instrument_type || '').toUpperCase(); // CE / PE / FUT
    const under = it.underlying_symbol || it.asset_symbol || it.name;
    if (!under) continue;
    lut.set(contractKey(under, istDay(it.expiry), it.strike_price, type), it.instrument_key);
  }

  // Stamp the key onto our active F&O instruments.
  const ours = await Instrument.find({ segment: { $in: ['FUT', 'OPT'] }, isActive: true })
    .select('symbol segment underlying expiryDate strike optionType upstoxKey').lean();

  const ops = [];
  let matched = 0; let missing = 0;
  for (const i of ours) {
    if (!i.expiryDate || !i.underlying) { missing += 1; continue; }
    const type = i.segment === 'OPT' ? String(i.optionType || '').toUpperCase() : 'FUT';
    const key = lut.get(contractKey(i.underlying, istDay(new Date(i.expiryDate).getTime()), i.strike, type));
    if (!key) { missing += 1; continue; }
    if (i.upstoxKey === key) { matched += 1; continue; } // already set
    ops.push({ updateOne: { filter: { symbol: i.symbol }, update: { $set: { upstoxKey: key } } } });
    matched += 1;
  }
  for (let k = 0; k < ops.length; k += 2000) {
    await Instrument.bulkWrite(ops.slice(k, k + 2000), { ordered: false });
  }
  return { fno: ours.length, matched, missing, updated: ops.length, upstoxContracts: lut.size };
}

module.exports = { mapFnoKeys };
