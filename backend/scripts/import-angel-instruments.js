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
 */
require('dotenv').config(); // load backend/.env when run locally (container uses env_file)
const mongoose = require('mongoose');

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

(async () => {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI).'); process.exit(1); }

  const importAll = String(process.env.IMPORT_ALL || '').toLowerCase() === 'true';
  const wanted = (process.env.IMPORT_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const useSet = wanted.length ? new Set(wanted) : (importAll ? null : new Set(DEFAULT_SET));

  console.log(`[import] fetching Angel scrip master …`);
  const res = await fetch(MASTER_URL);
  if (!res.ok) { console.error(`[import] master fetch failed: HTTP ${res.status}`); process.exit(1); }
  const all = await res.json();
  console.log(`[import] master rows: ${all.length.toLocaleString()}`);

  // NSE cash equity only: exch_seg NSE + symbol '*-EQ'.
  const rows = all.filter((r) => r.exch_seg === 'NSE' && typeof r.symbol === 'string' && r.symbol.endsWith('-EQ'));
  const picked = rows.filter((r) => {
    if (useSet === null) return true;                 // IMPORT_ALL
    return useSet.has(r.symbol.replace(/-EQ$/, ''));   // curated / explicit list
  });
  console.log(`[import] NSE -EQ rows: ${rows.length} · selected: ${picked.length}`);
  if (!picked.length) { console.error('[import] nothing selected — check IMPORT_SYMBOLS / set.'); process.exit(1); }

  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  const ops = picked.map((r) => {
    const symbol = r.symbol.replace(/-EQ$/, '').toUpperCase();
    // tick_size is in paise (e.g. "5.000000" = ₹0.05).
    const tick = (Number(r.tick_size || '5') / 100) || 0.05;
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
            externalFeedSymbol: r.symbol,        // 'RELIANCE-EQ'
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

  const r = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[import] ✓ upserted=${(r.upsertedCount || 0)} modified=${(r.modifiedCount || 0)} matched=${(r.matchedCount || 0)}`);
  console.log('[import] sample:', picked.slice(0, 5).map((x) => x.symbol).join(', '));
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
