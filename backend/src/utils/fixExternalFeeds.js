/**
 * One-off fix: update existing instruments' external-feed config from current .env.
 *
 * The seed script only creates instruments if they don't already exist, so changing
 * FINNHUB_API_KEY / USE_BINANCE_FEED in .env after the first seed has no effect on
 * the rows already in MongoDB. This script reconciles them.
 *
 * Run:  npm run fix:feeds   (or: node src/utils/fixExternalFeeds.js)
 */

require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');

const hasFinnhub = !!process.env.FINNHUB_API_KEY;
const hasOanda = !!process.env.OANDA_API_KEY;
const hasTwelve = !!process.env.TWELVE_DATA_API_KEY;
const useBinance = process.env.USE_BINANCE_FEED === 'true';

const forexProvider = hasFinnhub ? 'FINNHUB' : (hasOanda ? 'OANDA' : (hasTwelve ? 'TWELVE_DATA' : null));
const forexSymbol = (base) => {
  if (hasFinnhub) return `OANDA:${base}`;
  if (hasOanda) return base;
  return base.replace('_', '/');
};

const updates = [
  {
    symbol: 'BTCUSD',
    externalProvider: useBinance ? 'BINANCE' : null,
    externalFeedSymbol: 'BTCUSDT',
    simulatorEnabled: !useBinance,
  },
  {
    symbol: 'ETHUSD',
    externalProvider: useBinance ? 'BINANCE' : null,
    externalFeedSymbol: 'ETHUSDT',
    simulatorEnabled: !useBinance,
  },
  {
    symbol: 'EURUSD',
    externalProvider: forexProvider,
    externalFeedSymbol: forexSymbol('EUR_USD'),
    simulatorEnabled: !forexProvider,
  },
  {
    symbol: 'GBPUSD',
    externalProvider: forexProvider,
    externalFeedSymbol: forexSymbol('GBP_USD'),
    simulatorEnabled: !forexProvider,
  },
  {
    symbol: 'XAUUSD',
    externalProvider: forexProvider,
    externalFeedSymbol: forexSymbol('XAU_USD'),
    simulatorEnabled: !forexProvider,
  },
];

const run = async () => {
  await connectDB();
  console.log('--- Fixing external feed config from .env ---');
  console.log(`FINNHUB key: ${hasFinnhub ? 'YES' : 'no'} | BINANCE: ${useBinance ? 'YES' : 'no'} | OANDA: ${hasOanda ? 'YES' : 'no'} | TWELVE_DATA: ${hasTwelve ? 'YES' : 'no'}`);
  console.log();

  let changed = 0;
  let skipped = 0;

  for (const u of updates) {
    const inst = await Instrument.findOne({ symbol: u.symbol });
    if (!inst) {
      console.log(`  ? ${u.symbol}: not found in DB — skipped`);
      skipped++;
      continue;
    }

    const before = {
      provider: inst.externalProvider,
      symbol: inst.externalFeedSymbol,
      sim: inst.priceSimulator?.enabled,
    };

    inst.externalProvider = u.externalProvider;
    inst.externalFeedSymbol = u.externalFeedSymbol;
    if (!inst.priceSimulator) inst.priceSimulator = {};
    inst.priceSimulator.enabled = u.simulatorEnabled;

    await inst.save();
    changed++;
    console.log(`  ✓ ${u.symbol}:`);
    console.log(`      provider:  ${before.provider || 'null'}  →  ${u.externalProvider || 'null'}`);
    console.log(`      feedSym:   ${before.symbol || 'null'}  →  ${u.externalFeedSymbol || 'null'}`);
    console.log(`      simulator: ${before.sim}  →  ${u.simulatorEnabled}`);
  }

  console.log();
  console.log(`Done. ${changed} updated, ${skipped} skipped.`);
  console.log('Restart the backend to pick up the new feed config.');
  process.exit(0);
};

run().catch((e) => {
  console.error('Fix failed:', e);
  process.exit(1);
});
