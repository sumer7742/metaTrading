/**
 * import-angel-instruments.js — seed NSE cash-equity instruments from Angel One's
 * public scrip master, with the correct symbolToken + tickSize for the feed.
 *
 * Saves you adding each stock by hand. Upserts by symbol, so re-running is safe
 * (updates tokens/tick if Angel changed them).
 *
 * Source: https://margincalc.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
 *   NSE equity rows: exch_seg='NSE', symbol like 'RELIANCE-EQ', tick_size in paise.
 *
 * Usage (inside the backend container):
 *   docker compose exec backend node scripts/import-angel-instruments.js                 # curated NIFTY set
 *   docker compose exec -e IMPORT_SYMBOLS=RELIANCE,TCS,INFY backend node scripts/import-angel-instruments.js
 *   docker compose exec -e IMPORT_ALL=true backend node scripts/import-angel-instruments.js   # ALL NSE -EQ (~2000)
 *
 *   # Futures (NFO) — tokens are expiry-specific, re-run each new series:
 *   docker compose exec -e IMPORT_FUTURES=true backend node scripts/import-angel-instruments.js                        # NIFTY/BANKNIFTY/FINNIFTY
 *   docker compose exec -e IMPORT_FUTURES=true -e IMPORT_SYMBOLS=NIFTY,RELIANCE backend node scripts/import-angel-instruments.js
 */
require('dotenv').config(); // load backend/.env when run locally (container uses env_file)
const mongoose = require('mongoose');
const fs = require('fs');

const MASTER_URL = process.env.ANGEL_SCRIP_MASTER_URL
  || 'https://margincalc.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

// Default curated set (liquid NIFTY names) when neither IMPORT_ALL nor
// IMPORT_SYMBOLS is given — gives a usable platform without 2000 rows.
const DEFAULT_SET = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN',
  'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'BAJFINANCE', 'ASIANPAINT', 'MARUTI',
  'HCLTECH', 'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO', 'NESTLEIND', 'ONGC', 'NTPC',
  'POWERGRID', 'TATAMOTORS', 'TATASTEEL', 'ADANIENT', 'ADANIPORTS', 'COALINDIA',
  'BAJAJFINSV', 'TECHM', 'GRASIM', 'JSWSTEEL', 'HINDALCO', 'CIPLA', 'DRREDDY',
  'EICHERMOT', 'BRITANNIA', 'DIVISLAB', 'HEROMOTOCO',
];

// Default underlyings when importing futures with no explicit list.
const FUT_DEFAULT = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

// Parse Angel's expiry ('26JUN2025' / '26Jun2025') → Date at 15:30 IST (10:00 UTC).
function parseAngelExpiry(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})([A-Za-z]{3})(\d{4})$/);
  if (!m) { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  const M = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const mon = M[m[2].toUpperCase()];
  if (mon == null) return null;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), 10, 0, 0)); // 15:30 IST
}

(async () => {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI).'); process.exit(1); }

  const importAll = String(process.env.IMPORT_ALL || '').toLowerCase() === 'true';
  const wanted = (process.env.IMPORT_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const useSet = wanted.length ? new Set(wanted) : (importAll ? null : new Set(DEFAULT_SET));

  // Source: a local file (ANGEL_SCRIP_MASTER_FILE) if DNS/network blocks the
  // fetch, else the live URL. The file lets you download once via a browser/curl
  // and import offline.
  let all;
  const file = process.env.ANGEL_SCRIP_MASTER_FILE;
  if (file) {
    console.log(`[import] reading scrip master from file: ${file}`);
    all = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    // Try known scrip-master hosts in order (Angel rebranded angelbroking→angelone,
    // so the host moved). First one that responds wins.
    const candidates = [...new Set([
      process.env.ANGEL_SCRIP_MASTER_URL,
      'https://margincalc.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json',
      'https://margincalc.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json',
    ].filter(Boolean))];
    let lastErr;
    for (const url of candidates) {
      try {
        console.log(`[import] fetching scrip master … (${url})`);
        const res = await fetch(url);
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        all = await res.json();
        break;
      } catch (e) { lastErr = e; }
    }
    if (!all) {
      console.error(`[import] all scrip-master URLs failed: ${lastErr && lastErr.message}`);
      console.error('[import] Download it in a browser (try each), then re-run with the file:');
      candidates.forEach((u) => console.error('           ' + u));
      console.error('         ANGEL_SCRIP_MASTER_FILE=OpenAPIScripMaster.json node scripts/import-angel-instruments.js');
      process.exit(1);
    }
  }
  console.log(`[import] master rows: ${all.length.toLocaleString()}`);

  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  const importFutures = String(process.env.IMPORT_FUTURES || '').toLowerCase() === 'true';
  let picked, ops;

  if (importFutures) {
    // NFO futures: FUTIDX (index) + FUTSTK (stock). Tokens are expiry-specific.
    const futSet = wanted.length ? new Set(wanted) : (importAll ? null : new Set(FUT_DEFAULT));
    const rows = all.filter((r) => r.exch_seg === 'NFO' && (r.instrumenttype === 'FUTIDX' || r.instrumenttype === 'FUTSTK'));
    picked = rows.filter((r) => futSet === null || futSet.has(String(r.name || '').toUpperCase()));
    console.log(`[import] NFO futures rows: ${rows.length} · selected: ${picked.length}`);
    if (!picked.length) { console.error('[import] no futures selected — set IMPORT_SYMBOLS=NIFTY,BANKNIFTY or IMPORT_ALL.'); process.exit(1); }
    ops = picked.map((r) => {
      const symbol = String(r.symbol).toUpperCase();
      const tick = (Number(r.tick_size || '5') / 100) || 0.05;
      const lot = String(r.lotsize || '1');
      return {
        updateOne: {
          filter: { symbol },
          update: {
            $set: {
              symbol,
              name: r.name || symbol,
              category: r.instrumenttype === 'FUTIDX' ? 'INDEX' : 'STOCK',
              exchange: 'NFO',
              segment: 'FUT',
              underlying: String(r.name || '').toUpperCase(),
              expiryDate: parseAngelExpiry(r.expiry),
              externalProvider: 'ANGEL',
              externalFeedSymbol: r.symbol,
              instrumentToken: String(r.token),
              tickSize: String(tick),
              lotSize: lot,
              pricePrecision: 2,
              quantityPrecision: 0,
              minOrderSize: lot,        // trade in whole lots
              isActive: true,
            },
            $setOnInsert: { baseCurrency: String(r.name || symbol).toUpperCase(), quoteCurrency: 'INR' },
          },
          upsert: true,
        },
      };
    });
  } else {
    // NSE cash equity: exch_seg NSE + symbol '*-EQ'.
    const rows = all.filter((r) => r.exch_seg === 'NSE' && typeof r.symbol === 'string' && r.symbol.endsWith('-EQ'));
    picked = rows.filter((r) => useSet === null || useSet.has(r.symbol.replace(/-EQ$/, '')));
    console.log(`[import] NSE -EQ rows: ${rows.length} · selected: ${picked.length}`);
    if (!picked.length) { console.error('[import] nothing selected — check IMPORT_SYMBOLS / set.'); process.exit(1); }
    ops = picked.map((r) => {
      const symbol = r.symbol.replace(/-EQ$/, '').toUpperCase();
      const tick = (Number(r.tick_size || '5') / 100) || 0.05; // tick in paise
      return {
        updateOne: {
          filter: { symbol },
          update: {
            $set: {
              symbol,
              name: r.name || symbol,
              category: 'STOCK',
              exchange: 'NSE',
              segment: 'EQ',
              externalProvider: 'ANGEL',
              externalFeedSymbol: r.symbol,
              instrumentToken: String(r.token),
              tickSize: String(tick),
              lotSize: String(r.lotsize || '1'),
              pricePrecision: 2,
              quantityPrecision: 0,
              minOrderSize: '1',
              isActive: true,
            },
            $setOnInsert: { baseCurrency: symbol, quoteCurrency: 'INR' },
          },
          upsert: true,
        },
      };
    });
  }

  const r = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[import] ✓ upserted=${(r.upsertedCount || 0)} modified=${(r.modifiedCount || 0)} matched=${(r.matchedCount || 0)}`);
  console.log('[import] sample:', picked.slice(0, 5).map((x) => x.symbol).join(', '));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
