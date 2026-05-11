/**
 * Audit every active instrument and report:
 *   • lastPrice + how stale it is (age since lastPriceUpdatedAt)
 *   • external feed provider + feed symbol
 *   • simulator on/off
 *   • whether 1m candles exist for the symbol
 *
 * Flags issues that would explain "instrument not working" symptoms
 * (frozen prices, missing candles, mis-configured feed routing).
 *
 * Run:  node src/utils/checkInstruments.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const Candle = require('../models/Candle');

const ageStr = (date) => {
  if (!date) return 'never';
  const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
};

(async () => {
  await connectDB();
  console.log('--- .env ---');
  console.log('FINNHUB_API_KEY:', process.env.FINNHUB_API_KEY ? `${process.env.FINNHUB_API_KEY.slice(0, 8)}...` : '(not set)');
  console.log('USE_BINANCE_FEED:', process.env.USE_BINANCE_FEED || '(not set)');
  console.log('OANDA_API_KEY:', process.env.OANDA_API_KEY ? 'set' : '(not set)');
  console.log('TWELVE_DATA_API_KEY:', process.env.TWELVE_DATA_API_KEY ? 'set' : '(not set)');
  console.log();

  const instruments = await Instrument.find({ isActive: true }).sort({ symbol: 1 }).lean();
  console.log(`${instruments.length} active instruments\n`);

  const widths = [10, 10, 10, 10, 20, 14, 8, 5, 10];
  const cols = ['SYMBOL', 'CAT', 'MODE', 'PROVIDER', 'FEED_SYMBOL', 'LAST_PRICE', 'AGE', 'SIM', '1m_CDLS'];
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join(' '));
  console.log('-'.repeat(widths.reduce((a, b) => a + b + 1, 0)));

  const issues = [];
  for (const i of instruments) {
    const candleCount = await Candle.countDocuments({ symbol: i.symbol, timeframe: '1m' });
    const age = ageStr(i.lastPriceUpdatedAt);
    const ageSecs = i.lastPriceUpdatedAt
      ? Math.floor((Date.now() - new Date(i.lastPriceUpdatedAt).getTime()) / 1000)
      : Infinity;
    const sim = i.priceSimulator?.enabled ? 'Y' : 'N';

    const row = [
      (i.symbol || '').padEnd(widths[0]),
      (i.category || '').padEnd(widths[1]),
      (i.mode || '').padEnd(widths[2]),
      String(i.externalProvider || '-').padEnd(widths[3]),
      String(i.externalFeedSymbol || '-').padEnd(widths[4]),
      String(i.lastPrice || '').padEnd(widths[5]),
      age.padEnd(widths[6]),
      sim.padEnd(widths[7]),
      String(candleCount).padEnd(widths[8]),
    ];
    console.log(row.join(' '));

    if (!i.lastPrice || Number(i.lastPrice) <= 0) {
      issues.push(`${i.symbol}: lastPrice missing or zero`);
    }
    if (ageSecs > 180 && !i.priceSimulator?.enabled && i.externalProvider) {
      issues.push(`${i.symbol}: external feed stale (${age} old) and simulator OFF — prices frozen`);
    }
    if (candleCount === 0) {
      issues.push(`${i.symbol}: no 1m candles in DB — chart will be empty`);
    }
    if (!i.externalProvider && !i.priceSimulator?.enabled) {
      issues.push(`${i.symbol}: no external provider and simulator OFF — prices will never tick`);
    }
  }

  console.log('\n=== ISSUES ===');
  if (!issues.length) {
    console.log('✓ No issues detected.');
  } else {
    for (const m of issues) console.log(`⚠ ${m}`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
