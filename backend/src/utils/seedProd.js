/**
 * Production-safe seed.
 *
 * Differs from `seed.js` in important ways:
 *   1. NO test users (no `admin@tradingplatform.local`, no `trader@…`).
 *   2. NO demo wallet balances. Demo accounts are created per-user on signup.
 *   3. NO hardcoded passwords anywhere.
 *
 * It ONLY seeds the data the platform genuinely needs to be operational
 * on day one:
 *   - Instruments (forex pairs, crypto, commodities) — idempotent upserts.
 *   - Subscription plans (FREE / PREMIUM / VIP).
 *   - Global routing setting (defaults to B_BOOK).
 *
 * Run once after first deploy:
 *   MONGODB_URI='mongodb+srv://...' node src/utils/seedProd.js
 *
 * Safe to re-run — every operation is idempotent.
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const SystemSetting = require('../models/SystemSetting');
const { TRADING_MODE } = require('../config/constants');

// Shared factories for each asset class — keep production seed
// declarative so the catalog can grow without copy-paste boilerplate.

const buildCryptoPairs = (pairs) => pairs.map((p) => ({
  symbol: p.symbol,
  name: p.name,
  baseCurrency: p.base,
  quoteCurrency: 'USD',
  category: 'CRYPTO',
  pricePrecision: p.precision,
  quantityPrecision: 4,
  minOrderSize: '0.001',
  maxOrderSize: '10000',
  maxLeverage: p.maxLev || 25,
  lastPrice: p.last,
  externalProvider: p.feed ? 'BINANCE' : null,
  externalFeedSymbol: p.feed || null,
  spreadType: 'FIXED',
  spreadValue: p.spread,
  commissionPercent: '0.001',
  priceSimulator: { enabled: !p.feed, volatilityPct: 0.02, intervalMs: 3000 },
  isActive: true,
}));

const buildCommodities = (items) => items.map((c) => ({
  symbol: c.symbol,
  name: c.name,
  baseCurrency: c.base,
  quoteCurrency: 'USD',
  category: 'COMMODITY',
  pricePrecision: c.precision,
  quantityPrecision: 2,
  minOrderSize: '0.01',
  maxOrderSize: '10000',
  maxLeverage: c.maxLev || 50,
  lastPrice: c.last,
  externalProvider: process.env.FINNHUB_API_KEY ? 'FINNHUB' : null,
  externalFeedSymbol: process.env.FINNHUB_API_KEY ? c.feed : null,
  spreadType: 'FIXED',
  spreadValue: c.spread,
  commissionPercent: '0.0005',
  priceSimulator: { enabled: !process.env.FINNHUB_API_KEY, volatilityPct: 0.015, intervalMs: 3000 },
  isActive: true,
}));

const buildIndices = (items) => items.map((i) => ({
  symbol: i.symbol,
  name: i.name,
  baseCurrency: i.base,
  quoteCurrency: 'USD',
  category: 'INDEX',
  pricePrecision: i.precision,
  quantityPrecision: 2,
  minOrderSize: '1',
  maxOrderSize: '100000',
  maxLeverage: i.maxLev || 100,
  lastPrice: i.last,
  externalProvider: process.env.FINNHUB_API_KEY ? 'FINNHUB' : null,
  externalFeedSymbol: process.env.FINNHUB_API_KEY ? i.feed : null,
  spreadType: 'FIXED',
  spreadValue: i.spread,
  commissionPercent: '0.0003',
  priceSimulator: { enabled: !process.env.FINNHUB_API_KEY, volatilityPct: 0.01, intervalMs: 3000 },
  isActive: true,
}));

const buildStocks = (items) => items.map((s) => ({
  symbol: s.symbol,
  name: s.name,
  baseCurrency: s.symbol,
  quoteCurrency: 'USD',
  category: 'STOCK',
  pricePrecision: 2,
  quantityPrecision: 2,
  minOrderSize: '1',
  maxOrderSize: '100000',
  maxLeverage: s.maxLev || 10,
  lastPrice: s.last,
  externalProvider: process.env.FINNHUB_API_KEY ? 'FINNHUB' : null,
  externalFeedSymbol: process.env.FINNHUB_API_KEY ? s.feed : null,
  spreadType: 'FIXED',
  spreadValue: s.spread,
  commissionPercent: '0.0005',
  priceSimulator: { enabled: !process.env.FINNHUB_API_KEY, volatilityPct: 0.015, intervalMs: 3000 },
  isActive: true,
}));

// Reuse the same forex-pair generator from the dev seed so the symbol
// set stays consistent.
const buildForexPairs = (pairs) =>
  pairs.map((p) => {
    const oandaSym = `${p.base}_${p.quote}`;
    const twelveSym = `${p.base}/${p.quote}`;
    const provider = process.env.FINNHUB_API_KEY
      ? 'FINNHUB'
      : (process.env.OANDA_API_KEY
        ? 'OANDA'
        : (process.env.TWELVE_DATA_API_KEY ? 'TWELVE_DATA' : null));
    const feedSymbol = process.env.FINNHUB_API_KEY
      ? `OANDA:${oandaSym}`
      : (process.env.OANDA_API_KEY ? oandaSym : twelveSym);
    return {
      symbol: p.symbol,
      name: p.name,
      baseCurrency: p.base,
      quoteCurrency: p.quote,
      category: 'FOREX',
      mode: TRADING_MODE.EXTERNAL,
      pricePrecision: p.precision,
      quantityPrecision: 2,
      minOrderSize: '100',
      maxOrderSize: '1000000',
      maxLeverage: 200,
      lastPrice: p.last,
      externalProvider: provider,
      externalFeedSymbol: feedSymbol,
      spreadType: 'FIXED',
      spreadValue: p.spread,
      commissionPercent: '0.0005',
      // Production should rely on a real feed — disable simulator unless
      // intentionally enabled later via admin.
      priceSimulator: { enabled: false, volatilityPct: 0.02, intervalMs: 3000 },
      isActive: true,
    };
  });

const seedProd = async () => {
  await connectDB();
  console.log('Seeding production data…');

  // ─── INSTRUMENTS ──────────────────────────────────────────────────
  const instruments = [
    {
      symbol: 'BTCUSD',
      name: 'Bitcoin / US Dollar',
      baseCurrency: 'BTC', quoteCurrency: 'USD',
      category: 'CRYPTO',
      pricePrecision: 2, quantityPrecision: 6,
      minOrderSize: '0.0001', maxOrderSize: '50',
      maxLeverage: 50,
      spreadType: 'FIXED', spreadValue: '5',
      commissionPercent: '0.001',
      externalProvider: 'BINANCE',
      externalFeedSymbol: 'BTCUSDT',
      lastPrice: '80000',
      isActive: true,
    },
    {
      symbol: 'ETHUSD',
      name: 'Ethereum / US Dollar',
      baseCurrency: 'ETH', quoteCurrency: 'USD',
      category: 'CRYPTO',
      pricePrecision: 2, quantityPrecision: 4,
      minOrderSize: '0.01', maxOrderSize: '500',
      maxLeverage: 50,
      spreadType: 'FIXED', spreadValue: '0.5',
      commissionPercent: '0.001',
      externalProvider: 'BINANCE',
      externalFeedSymbol: 'ETHUSDT',
      lastPrice: '2300',
      isActive: true,
    },
    {
      symbol: 'XAUUSD',
      name: 'Gold / US Dollar',
      baseCurrency: 'XAU', quoteCurrency: 'USD',
      category: 'COMMODITY',
      pricePrecision: 2, quantityPrecision: 2,
      minOrderSize: '0.01', maxOrderSize: '100',
      maxLeverage: 100,
      spreadType: 'FIXED', spreadValue: '0.5',
      commissionPercent: '0.0005',
      externalProvider: process.env.FINNHUB_API_KEY ? 'FINNHUB' : null,
      externalFeedSymbol: process.env.FINNHUB_API_KEY ? 'OANDA:XAU_USD' : null,
      lastPrice: '4600',
      isActive: true,
    },
    // ── Extra Crypto (BINANCE feed) ─────────────────────────────────
    ...buildCryptoPairs([
      { symbol: 'SOLUSD',  name: 'Solana / USD',     base: 'SOL',   feed: 'SOLUSDT',   last: '180',   precision: 2, spread: '0.05', maxLev: 25 },
      { symbol: 'XRPUSD',  name: 'XRP / USD',        base: 'XRP',   feed: 'XRPUSDT',   last: '2.40',  precision: 4, spread: '0.0005', maxLev: 25 },
      { symbol: 'DOGEUSD', name: 'Dogecoin / USD',   base: 'DOGE',  feed: 'DOGEUSDT',  last: '0.180', precision: 5, spread: '0.0001', maxLev: 20 },
      { symbol: 'ADAUSD',  name: 'Cardano / USD',    base: 'ADA',   feed: 'ADAUSDT',   last: '0.640', precision: 4, spread: '0.0005', maxLev: 20 },
      { symbol: 'BNBUSD',  name: 'BNB / USD',        base: 'BNB',   feed: 'BNBUSDT',   last: '680',   precision: 2, spread: '0.10', maxLev: 25 },
      { symbol: 'AVAXUSD', name: 'Avalanche / USD',  base: 'AVAX',  feed: 'AVAXUSDT',  last: '32',    precision: 3, spread: '0.01', maxLev: 20 },
      { symbol: 'MATICUSD',name: 'Polygon / USD',    base: 'MATIC', feed: 'MATICUSDT', last: '0.580', precision: 4, spread: '0.0005', maxLev: 20 },
      { symbol: 'LINKUSD', name: 'Chainlink / USD',  base: 'LINK',  feed: 'LINKUSDT',  last: '18.50', precision: 3, spread: '0.005', maxLev: 20 },
      { symbol: 'DOTUSD',  name: 'Polkadot / USD',   base: 'DOT',   feed: 'DOTUSDT',   last: '7.20',  precision: 3, spread: '0.005', maxLev: 20 },
      { symbol: 'LTCUSD',  name: 'Litecoin / USD',   base: 'LTC',   feed: 'LTCUSDT',   last: '105',   precision: 2, spread: '0.05', maxLev: 25 },
      { symbol: 'USDTUSD', name: 'Tether / USD',     base: 'USDT',  feed: null,        last: '1.00',  precision: 4, spread: '0.0002', maxLev: 5 },
    ]),
    // ── Extra Commodities (FINNHUB feed where possible) ─────────────
    ...buildCommodities([
      { symbol: 'XAGUSD',  name: 'Silver / USD',      base: 'XAG', feed: 'OANDA:XAG_USD', last: '32',     precision: 3, spread: '0.02',  maxLev: 50 },
      { symbol: 'USOIL',   name: 'WTI Crude Oil',     base: 'WTI', feed: 'OANDA:WTICO_USD', last: '75',   precision: 2, spread: '0.04',  maxLev: 50 },
      { symbol: 'UKOIL',   name: 'Brent Crude Oil',   base: 'BRT', feed: 'OANDA:BCO_USD',  last: '79',    precision: 2, spread: '0.04',  maxLev: 50 },
      { symbol: 'NATGAS',  name: 'Natural Gas',       base: 'NGC', feed: 'OANDA:NATGAS_USD', last: '2.95', precision: 3, spread: '0.01', maxLev: 30 },
    ]),
    // ── Indices ─────────────────────────────────────────────────────
    ...buildIndices([
      { symbol: 'NAS100',  name: 'US Nasdaq 100',      base: 'NDX', feed: 'OANDA:NAS100_USD', last: '20800', precision: 2, spread: '1',   maxLev: 100 },
      { symbol: 'US30',    name: 'Dow Jones 30',       base: 'DJI', feed: 'OANDA:US30_USD',   last: '43000', precision: 2, spread: '2',   maxLev: 100 },
      { symbol: 'SPX500',  name: 'S&P 500',            base: 'SPX', feed: 'OANDA:SPX500_USD', last: '5950',  precision: 2, spread: '0.5', maxLev: 100 },
      { symbol: 'UK100',   name: 'FTSE 100',           base: 'FTS', feed: 'OANDA:UK100_GBP',  last: '8200',  precision: 2, spread: '1',   maxLev: 100 },
      { symbol: 'GER40',   name: 'Germany 40 (DAX)',   base: 'DAX', feed: 'OANDA:DE30_EUR',   last: '19500', precision: 2, spread: '1',   maxLev: 100 },
      { symbol: 'JPN225',  name: 'Nikkei 225',         base: 'NKY', feed: 'OANDA:JP225_USD',  last: '38500', precision: 2, spread: '2',   maxLev: 100 },
    ]),
    // ── Forex (OANDA feed) — majors + crosses + exotics ─────────────
    ...buildForexPairs([
      // Majors
      { symbol: 'EURUSD', name: 'Euro / US Dollar',           base: 'EUR', quote: 'USD', last: '1.17500', precision: 5, range: ['1.05000', '1.30000'], spread: '0.0002' },
      { symbol: 'GBPUSD', name: 'British Pound / US Dollar',  base: 'GBP', quote: 'USD', last: '1.36000', precision: 5, range: ['1.20000', '1.50000'], spread: '0.0003' },
      { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen',   base: 'USD', quote: 'JPY', last: '157.000', precision: 3, range: ['140.00',  '170.00'],  spread: '0.020' },
      { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc',    base: 'USD', quote: 'CHF', last: '0.77800', precision: 5, range: ['0.70000', '0.95000'], spread: '0.0003' },
      { symbol: 'AUDUSD', name: 'Australian Dollar / USD',    base: 'AUD', quote: 'USD', last: '0.72400', precision: 5, range: ['0.65000', '0.80000'], spread: '0.0003' },
      { symbol: 'NZDUSD', name: 'New Zealand Dollar / USD',   base: 'NZD', quote: 'USD', last: '0.59500', precision: 5, range: ['0.55000', '0.70000'], spread: '0.0003' },
      { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar',base: 'USD', quote: 'CAD', last: '1.36700', precision: 5, range: ['1.25000', '1.45000'], spread: '0.0003' },
      // Crosses
      { symbol: 'EURGBP', name: 'Euro / British Pound',       base: 'EUR', quote: 'GBP', last: '0.86500', precision: 5, range: ['0.80000', '0.92000'], spread: '0.0003' },
      { symbol: 'EURJPY', name: 'Euro / Japanese Yen',        base: 'EUR', quote: 'JPY', last: '184.500', precision: 3, range: ['170.00',  '200.00'],  spread: '0.025' },
      { symbol: 'GBPJPY', name: 'British Pound / JPY',        base: 'GBP', quote: 'JPY', last: '213.500', precision: 3, range: ['195.00',  '230.00'],  spread: '0.030' },
      { symbol: 'AUDJPY', name: 'Australian Dollar / JPY',    base: 'AUD', quote: 'JPY', last: '113.500', precision: 3, range: ['100.00',  '125.00'],  spread: '0.025' },
      { symbol: 'EURCHF', name: 'Euro / Swiss Franc',         base: 'EUR', quote: 'CHF', last: '0.91500', precision: 5, range: ['0.85000', '1.00000'], spread: '0.0003' },
      { symbol: 'EURAUD', name: 'Euro / Australian Dollar',   base: 'EUR', quote: 'AUD', last: '1.62000', precision: 5, range: ['1.50000', '1.75000'], spread: '0.0004' },
      { symbol: 'EURCAD', name: 'Euro / Canadian Dollar',     base: 'EUR', quote: 'CAD', last: '1.60500', precision: 5, range: ['1.45000', '1.75000'], spread: '0.0004' },
      { symbol: 'GBPCAD', name: 'British Pound / CAD',        base: 'GBP', quote: 'CAD', last: '1.85800', precision: 5, range: ['1.70000', '2.00000'], spread: '0.0005' },
      { symbol: 'GBPAUD', name: 'British Pound / AUD',        base: 'GBP', quote: 'AUD', last: '1.87900', precision: 5, range: ['1.75000', '2.00000'], spread: '0.0005' },
      { symbol: 'GBPCHF', name: 'British Pound / CHF',        base: 'GBP', quote: 'CHF', last: '1.05900', precision: 5, range: ['0.95000', '1.15000'], spread: '0.0004' },
      { symbol: 'AUDCAD', name: 'Australian Dollar / CAD',    base: 'AUD', quote: 'CAD', last: '0.98800', precision: 5, range: ['0.90000', '1.05000'], spread: '0.0003' },
      { symbol: 'AUDNZD', name: 'Australian Dollar / NZD',    base: 'AUD', quote: 'NZD', last: '1.21700', precision: 5, range: ['1.10000', '1.30000'], spread: '0.0004' },
      { symbol: 'AUDCHF', name: 'Australian Dollar / CHF',    base: 'AUD', quote: 'CHF', last: '0.56400', precision: 5, range: ['0.50000', '0.65000'], spread: '0.0004' },
      { symbol: 'NZDJPY', name: 'New Zealand Dollar / JPY',   base: 'NZD', quote: 'JPY', last: '93.500',  precision: 3, range: ['85.00',   '105.00'],  spread: '0.025' },
      { symbol: 'NZDCAD', name: 'New Zealand Dollar / CAD',   base: 'NZD', quote: 'CAD', last: '0.81300', precision: 5, range: ['0.75000', '0.90000'], spread: '0.0004' },
      { symbol: 'CADJPY', name: 'Canadian Dollar / JPY',      base: 'CAD', quote: 'JPY', last: '114.800', precision: 3, range: ['100.00',  '125.00'],  spread: '0.025' },
      { symbol: 'CADCHF', name: 'Canadian Dollar / CHF',      base: 'CAD', quote: 'CHF', last: '0.56900', precision: 5, range: ['0.50000', '0.65000'], spread: '0.0004' },
      { symbol: 'CHFJPY', name: 'Swiss Franc / JPY',          base: 'CHF', quote: 'JPY', last: '201.800', precision: 3, range: ['180.00',  '220.00'],  spread: '0.030' },
      // Exotics
      { symbol: 'USDINR', name: 'US Dollar / Indian Rupee',   base: 'USD', quote: 'INR', last: '83.500',  precision: 3, range: ['80.00',   '88.00'],   spread: '0.040' },
      { symbol: 'USDSGD', name: 'US Dollar / Singapore Dollar',base: 'USD', quote: 'SGD', last: '1.34000', precision: 5, range: ['1.25000', '1.45000'], spread: '0.0004' },
      { symbol: 'USDHKD', name: 'US Dollar / Hong Kong Dollar',base: 'USD', quote: 'HKD', last: '7.78500', precision: 4, range: ['7.70000', '7.85000'], spread: '0.0050' },
      { symbol: 'USDMXN', name: 'US Dollar / Mexican Peso',   base: 'USD', quote: 'MXN', last: '20.500',  precision: 4, range: ['18.00',   '22.00'],   spread: '0.0080' },
      { symbol: 'USDZAR', name: 'US Dollar / South African Rand', base: 'USD', quote: 'ZAR', last: '18.150', precision: 4, range: ['16.00', '20.00'],  spread: '0.0080' },
    ]),
    // ── Major US stocks (FINNHUB feed) ──────────────────────────────
    ...buildStocks([
      { symbol: 'AAPL',  name: 'Apple Inc.',       feed: 'AAPL',  last: '230', spread: '0.05', maxLev: 10 },
      { symbol: 'TSLA',  name: 'Tesla, Inc.',      feed: 'TSLA',  last: '330', spread: '0.10', maxLev: 10 },
      { symbol: 'GOOGL', name: 'Alphabet Inc.',    feed: 'GOOGL', last: '180', spread: '0.05', maxLev: 10 },
      { symbol: 'AMZN',  name: 'Amazon.com',       feed: 'AMZN',  last: '205', spread: '0.05', maxLev: 10 },
      { symbol: 'MSFT',  name: 'Microsoft Corp.',  feed: 'MSFT',  last: '425', spread: '0.10', maxLev: 10 },
      { symbol: 'META',  name: 'Meta Platforms',   feed: 'META',  last: '595', spread: '0.10', maxLev: 10 },
      { symbol: 'NVDA',  name: 'NVIDIA Corp.',     feed: 'NVDA',  last: '145', spread: '0.05', maxLev: 10 },
      { symbol: 'NFLX',  name: 'Netflix, Inc.',    feed: 'NFLX',  last: '840', spread: '0.15', maxLev: 10 },
    ]),
  ];

  let created = 0;
  let skipped = 0;
  for (const data of instruments) {
    const exists = await Instrument.findOne({ symbol: data.symbol });
    if (!exists) {
      await Instrument.create(data);
      console.log(`  + ${data.symbol} (${data.name})`);
      created++;
    } else {
      skipped++;
    }
  }
  console.log(`✓ Instruments: ${created} created, ${skipped} already present`);

  // ─── SUBSCRIPTION PLANS ───────────────────────────────────────────
  const { Plan } = require('../models/Subscription');
  const plans = [
    { code: 'FREE',    name: 'Free',    monthlyPrice: '0',   yearlyPrice: '0',    sortOrder: 1,
      limits: { maxAccounts: 2, maxLeverageOverride: null, withdrawalDailyLimit: null }, isActive: true },
    { code: 'PREMIUM', name: 'Premium', monthlyPrice: '19',  yearlyPrice: '190',  sortOrder: 2,
      limits: { maxAccounts: 5, maxLeverageOverride: null, withdrawalDailyLimit: null }, isActive: true },
    { code: 'GOLD',    name: 'Gold',    monthlyPrice: '49',  yearlyPrice: '490',  sortOrder: 3,
      limits: { maxAccounts: 7, maxLeverageOverride: null, withdrawalDailyLimit: null }, isActive: true },
    { code: 'VIP',     name: 'VIP',     monthlyPrice: '99',  yearlyPrice: '990',  sortOrder: 4,
      limits: { maxAccounts: 20, maxLeverageOverride: null, withdrawalDailyLimit: null }, isActive: true },
  ];
  for (const p of plans) {
    const exists = await Plan.findOne({ code: p.code });
    if (!exists) {
      await Plan.create(p);
      console.log(`  + Plan ${p.code}`);
    }
  }
  console.log(`✓ Subscription plans verified`);

  // ─── GLOBAL ROUTING SETTING ──────────────────────────────────────
  // Safe default — every order goes internal until admin flips A-Book / Hybrid.
  const routingExists = await SystemSetting.findOne({ key: 'routingMode' });
  if (!routingExists) {
    await SystemSetting.create({ key: 'routingMode', value: 'B_BOOK' });
    console.log('  + routingMode = B_BOOK');
  }
  const lpExists = await SystemSetting.findOne({ key: 'defaultLpProvider' });
  if (!lpExists) {
    await SystemSetting.create({ key: 'defaultLpProvider', value: 'NONE' });
    console.log('  + defaultLpProvider = NONE');
  }
  console.log(`✓ System settings verified`);

  console.log('\n─────────────────────────────────────────────');
  console.log('Done. Next steps:');
  console.log('  1. Create your admin user manually in MongoDB:');
  console.log('     db.users.insertOne({ email, passwordHash, role: "SUPER_ADMIN", ... })');
  console.log('     OR sign up via the client app, then in mongosh:');
  console.log('     db.users.updateOne({email:"<you>"}, {$set:{role:"SUPER_ADMIN", kycStatus:"APPROVED"}})');
  console.log('  2. Login to admin and enable 2FA IMMEDIATELY.');
  console.log('─────────────────────────────────────────────');
  process.exit(0);
};

seedProd().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
