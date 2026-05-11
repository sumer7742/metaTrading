/**
 * Disable the price simulator on every active FOREX instrument so it
 * goes back to relying solely on the configured external feed.
 *
 * Run once:  node src/utils/enableForexSimulator.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');

(async () => {
  await connectDB();
  const result = await Instrument.updateMany(
    { category: 'FOREX', isActive: true },
    { $set: { 'priceSimulator.enabled': false } }
  );
  console.log(`✓ Reverted simulator on ${result.modifiedCount} forex instruments`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
