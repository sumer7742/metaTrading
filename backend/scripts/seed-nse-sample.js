/**
 * seed-nse-sample.js — add a curated set of NSE stocks WITHOUT any network.
 *
 * Use this when the live scrip-master fetch is blocked (DNS/ENOTFOUND) and you
 * just want Indian instruments to show up. Tokens are the standard Angel One
 * SmartAPI NSE symbolTokens (stable NSE security tokens). Upserts by symbol, so
 * re-running is safe and it won't clobber instruments you already have.
 *
 *   node scripts/seed-nse-sample.js
 *
 * ⚠️ If a symbol shows no live price once the feed is on, its token is wrong —
 * fix it from the official scrip master (scripts/import-angel-instruments.js
 * with ANGEL_SCRIP_MASTER_FILE) which is the authoritative source.
 */
require('dotenv').config();
const mongoose = require('mongoose');

// [symbol, name, angelToken, tickSize]
const NSE = [
  ['RELIANCE',   'Reliance Industries',        '2885',  '0.05'],
  ['TCS',        'Tata Consultancy Services',  '11536', '0.05'],
  ['INFY',       'Infosys',                    '1594',  '0.05'],
  ['HDFCBANK',   'HDFC Bank',                  '1333',  '0.05'],
  ['ICICIBANK',  'ICICI Bank',                 '4963',  '0.05'],
  ['SBIN',       'State Bank of India',        '3045',  '0.05'],
  ['ITC',        'ITC',                        '1660',  '0.05'],
  ['HINDUNILVR', 'Hindustan Unilever',         '1394',  '0.05'],
  ['BHARTIARTL', 'Bharti Airtel',              '10604', '0.05'],
  ['KOTAKBANK',  'Kotak Mahindra Bank',        '1922',  '0.05'],
  ['LT',         'Larsen & Toubro',            '11483', '0.05'],
  ['AXISBANK',   'Axis Bank',                  '5900',  '0.05'],
  ['BAJFINANCE', 'Bajaj Finance',              '317',   '0.05'],
  ['ASIANPAINT', 'Asian Paints',               '236',   '0.05'],
  ['MARUTI',     'Maruti Suzuki',              '10999', '0.05'],
  ['WIPRO',      'Wipro',                      '3787',  '0.05'],
  ['SUNPHARMA',  'Sun Pharmaceutical',         '3351',  '0.05'],
  ['TITAN',      'Titan Company',              '3506',  '0.05'],
  ['TATAMOTORS', 'Tata Motors',                '3456',  '0.05'],
  ['TATASTEEL',  'Tata Steel',                 '3499',  '0.05'],
  ['HCLTECH',    'HCL Technologies',           '7229',  '0.05'],
  ['NTPC',       'NTPC',                       '11630', '0.05'],
  ['ONGC',       'Oil & Natural Gas Corp',     '2475',  '0.05'],
];

(async () => {
  const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!URI) { console.error('Set MONGODB_URI (or MONGO_URI) — check backend/.env'); process.exit(1); }
  await mongoose.connect(URI);
  const Instrument = require('../src/models/Instrument');

  const ops = NSE.map(([symbol, name, token, tick]) => ({
    updateOne: {
      filter: { symbol },
      update: {
        $set: {
          symbol, name, category: 'STOCK', exchange: 'NSE', segment: 'EQ',
          externalProvider: 'ANGEL', externalFeedSymbol: `${symbol}-EQ`,
          instrumentToken: token, tickSize: tick,
          lotSize: '1', minOrderSize: '1', pricePrecision: 2, quantityPrecision: 0,
          isActive: true,
        },
        $setOnInsert: { baseCurrency: symbol, quoteCurrency: 'INR' },
      },
      upsert: true,
    },
  }));

  const r = await Instrument.bulkWrite(ops, { ordered: false });
  console.log(`[seed-nse] ✓ ${NSE.length} stocks — upserted=${r.upsertedCount || 0} modified=${r.modifiedCount || 0}`);
  const n = await Instrument.countDocuments({ exchange: 'NSE' });
  console.log(`[seed-nse] NSE instruments in DB now: ${n}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
