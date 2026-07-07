/**
 * indianIndices.js — ensures the Indian INDEX *spot* instruments exist
 * (NIFTY 50, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX).
 *
 * The Dhan scrip-master sync only imports index FUTURES / OPTIONS (FUTIDX /
 * OPTIDX) — never the cash index itself — and the seed only ships GLOBAL index
 * CFDs (NAS100, US30, …). So without this the platform has NIFTY/BANKNIFTY
 * derivatives but no standalone "NIFTY 50 = 24,525" tile.
 *
 * Each row is created with `underlying` set to its OWN name so the live feed's
 * index map resolves it to the real index LTP:
 *   - Upstox  (services/upstoxFeed.js  INDEX_UP): NIFTY → NSE_INDEX|Nifty 50 …
 *   - Yahoo   (services/yahooFeed.js   INDEX_YH): NIFTY → ^NSEI …
 * The feed selects instruments by `exchange ∈ {NSE,BSE,…} & isActive`, so these
 * tiles start ticking automatically — no feed change needed.
 *
 * Idempotent: trading config is refreshed on every run, but `lastPrice` is only
 * set on INSERT (`$setOnInsert`) so a re-run never clobbers a live price.
 */
const Instrument = require('../models/Instrument');

// symbol === underlying (required so the feed's index map resolves the spot).
// exchange drives market-hours + which feed segment; NSE for NIFTY family,
// BSE for SENSEX. seedLast is a placeholder overwritten within seconds by the
// live feed while the market is open.
const INDIAN_INDICES = [
  { symbol: 'NIFTY',      name: 'NIFTY 50',            exchange: 'NSE', seedLast: '24500', spread: '1' },
  { symbol: 'BANKNIFTY',  name: 'NIFTY Bank',          exchange: 'NSE', seedLast: '52000', spread: '2' },
  { symbol: 'FINNIFTY',   name: 'NIFTY Fin Service',   exchange: 'NSE', seedLast: '23500', spread: '1' },
  { symbol: 'MIDCPNIFTY', name: 'NIFTY Midcap 50',     exchange: 'NSE', seedLast: '13000', spread: '1' },
  { symbol: 'SENSEX',     name: 'BSE SENSEX',          exchange: 'BSE', seedLast: '80000', spread: '2' },
];

async function ensureIndianIndices() {
  const ops = INDIAN_INDICES.map((ix) => ({
    updateOne: {
      filter: { symbol: ix.symbol },
      update: {
        $set: {
          symbol: ix.symbol,
          name: ix.name,
          category: 'INDEX',
          exchange: ix.exchange,
          segment: null,            // cash index (not EQ/FUT/OPT)
          underlying: ix.symbol,    // self → feed index-map resolves the LTP
          quoteCurrency: 'INR',
          pricePrecision: 2,
          quantityPrecision: 2,
          minOrderSize: '1',
          maxOrderSize: '100000',
          maxLeverage: 100,
          spreadType: 'FIXED',
          spreadValue: ix.spread,
          commissionPercent: '0.0003',
          // Real feed serves the price — keep the synthetic simulator OFF so it
          // can't fight the live LTP.
          priceSimulator: { enabled: false },
          isActive: true,
        },
        $setOnInsert: {
          baseCurrency: ix.symbol,
          lastPrice: ix.seedLast,
        },
      },
      upsert: true,
    },
  }));

  const res = await Instrument.bulkWrite(ops, { ordered: false });
  return {
    total: INDIAN_INDICES.length,
    inserted: res.upsertedCount || 0,
    updated: res.modifiedCount || 0,
    symbols: INDIAN_INDICES.map((i) => i.symbol),
  };
}

module.exports = { INDIAN_INDICES, ensureIndianIndices };
