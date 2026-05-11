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
    ...buildForexPairs([
      { symbol: 'EURUSD', name: 'Euro / US Dollar',           base: 'EUR', quote: 'USD', last: '1.17500', precision: 5, range: ['1.05000', '1.30000'], spread: '0.0002' },
      { symbol: 'GBPUSD', name: 'British Pound / US Dollar',  base: 'GBP', quote: 'USD', last: '1.36000', precision: 5, range: ['1.20000', '1.50000'], spread: '0.0003' },
      { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen',   base: 'USD', quote: 'JPY', last: '157.000', precision: 3, range: ['140.00',  '170.00'],  spread: '0.020' },
      { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc',    base: 'USD', quote: 'CHF', last: '0.77800', precision: 5, range: ['0.70000', '0.95000'], spread: '0.0003' },
      { symbol: 'AUDUSD', name: 'Australian Dollar / USD',    base: 'AUD', quote: 'USD', last: '0.72400', precision: 5, range: ['0.65000', '0.80000'], spread: '0.0003' },
      { symbol: 'NZDUSD', name: 'New Zealand Dollar / USD',   base: 'NZD', quote: 'USD', last: '0.59500', precision: 5, range: ['0.55000', '0.70000'], spread: '0.0003' },
      { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar',base: 'USD', quote: 'CAD', last: '1.36700', precision: 5, range: ['1.25000', '1.45000'], spread: '0.0003' },
      { symbol: 'EURGBP', name: 'Euro / British Pound',       base: 'EUR', quote: 'GBP', last: '0.86500', precision: 5, range: ['0.80000', '0.92000'], spread: '0.0003' },
      { symbol: 'EURJPY', name: 'Euro / Japanese Yen',        base: 'EUR', quote: 'JPY', last: '184.500', precision: 3, range: ['170.00',  '200.00'],  spread: '0.025' },
      { symbol: 'GBPJPY', name: 'British Pound / JPY',        base: 'GBP', quote: 'JPY', last: '213.500', precision: 3, range: ['195.00',  '230.00'],  spread: '0.030' },
      { symbol: 'AUDJPY', name: 'Australian Dollar / JPY',    base: 'AUD', quote: 'JPY', last: '113.500', precision: 3, range: ['100.00',  '125.00'],  spread: '0.025' },
      { symbol: 'EURCHF', name: 'Euro / Swiss Franc',         base: 'EUR', quote: 'CHF', last: '0.91500', precision: 5, range: ['0.85000', '1.00000'], spread: '0.0003' },
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
    { code: 'VIP',     name: 'VIP',     monthlyPrice: '99',  yearlyPrice: '990',  sortOrder: 3,
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
