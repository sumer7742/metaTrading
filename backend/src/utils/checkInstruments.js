/**
 * Diagnostic: print current external-feed config of all instruments.
 * Run: node src/utils/checkInstruments.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');

(async () => {
  await connectDB();
  console.log('--- .env ---');
  console.log('FINNHUB_API_KEY:', process.env.FINNHUB_API_KEY ? `${process.env.FINNHUB_API_KEY.slice(0, 8)}...` : '(not set)');
  console.log('USE_BINANCE_FEED:', process.env.USE_BINANCE_FEED);
  console.log('MONGODB_URI:', process.env.MONGODB_URI);
  console.log();

  const instruments = await Instrument.find({}).select('symbol externalProvider externalFeedSymbol isActive priceSimulator').lean();
  console.log('--- Instruments in DB ---');
  for (const inst of instruments) {
    console.log(`${inst.symbol.padEnd(8)} | provider=${String(inst.externalProvider).padEnd(12)} | feedSym=${String(inst.externalFeedSymbol).padEnd(20)} | sim=${inst.priceSimulator?.enabled} | active=${inst.isActive}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
