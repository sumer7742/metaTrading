require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { ROLES, KYC_STATUS, ACCOUNT_TYPES, TRADING_MODE } = require('../config/constants');

/**
 * Generate Instrument config for a list of forex pairs. Centralises the
 * provider-priority logic (Finnhub > OANDA > Twelve > simulator) and
 * symbol-format mapping so each pair only declares its semantic info.
 *
 * Provider symbol formats:
 *   • Finnhub:    "OANDA:USD_JPY"
 *   • OANDA:      "USD_JPY"
 *   • Twelve:     "USD/JPY"
 */
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
      bBookEnabled: true,
      bBookDisableMode: 'LET_RUN',
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
      priceSimulator: {
        // Simulator only kicks in when no real provider is configured.
        enabled: !process.env.FINNHUB_API_KEY && !process.env.OANDA_API_KEY && !process.env.TWELVE_DATA_API_KEY,
        // JPY pairs move in larger absolute units, so volatility % is the
        // same — random-walk per-tick is `price × volatilityPct`.
        volatilityPct: 0.02,
        intervalMs: 3000,
        minPrice: p.range[0],
        maxPrice: p.range[1],
      },
    };
  });

const seed = async () => {
  await connectDB();
  console.log('Seeding database...');

  // ADMIN USER
  const adminEmail = 'admin@tradingplatform.local';
  let admin = await User.findOne({ email: adminEmail });
  if (!admin) {
    const passwordHash = await bcrypt.hash('Admin@12345', 12);
    admin = await User.create({
      email: adminEmail,
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      role: ROLES.SUPER_ADMIN,
      isEmailVerified: true,
      kycStatus: KYC_STATUS.APPROVED,
      referralCode: 'ADMIN001',
    });
    console.log(`✓ Admin created: ${adminEmail} / Admin@12345`);
  }

  // SAMPLE TRADER
  const traderEmail = 'trader@tradingplatform.local';
  let trader = await User.findOne({ email: traderEmail });
  if (!trader) {
    const passwordHash = await bcrypt.hash('Trader@12345', 12);
    trader = await User.create({
      email: traderEmail,
      passwordHash,
      firstName: 'Test',
      lastName: 'Trader',
      role: ROLES.USER,
      isEmailVerified: true,
      kycStatus: KYC_STATUS.APPROVED,
      referralCode: uuidv4().slice(0, 8).toUpperCase(),
    });
    console.log(`✓ Trader created: ${traderEmail} / Trader@12345`);
  } else {
    console.log(`• Trader already exists: ${traderEmail}`);
  }

  // Ensure trader has a DEMO account (idempotent)
  let demoAcct = await TradingAccount.findOne({
    userId: trader._id,
    accountType: ACCOUNT_TYPES.DEMO,
  });
  if (!demoAcct) {
    demoAcct = await TradingAccount.create({
      userId: trader._id,
      accountNumber: 'TA' + Date.now().toString().slice(-9),
      accountType: ACCOUNT_TYPES.DEMO,
      baseCurrency: 'USD',
      leverage: 100,
      mode: TRADING_MODE.HYBRID,
      nickname: 'Demo Account',
    });
    await Wallet.create({ userId: trader._id, accountId: demoAcct._id, currency: 'USD', balance: '50000' });
    console.log(`  ✓ Demo account added ($50,000 USD)`);
  } else {
    console.log(`  • Demo account already exists`);
  }

  // Ensure trader has a REAL (live) account (idempotent)
  let realAcct = await TradingAccount.findOne({
    userId: trader._id,
    accountType: ACCOUNT_TYPES.REAL,
  });
  if (!realAcct) {
    realAcct = await TradingAccount.create({
      userId: trader._id,
      accountNumber: 'TA' + (Date.now() + 1).toString().slice(-9),
      accountType: ACCOUNT_TYPES.REAL,
      baseCurrency: 'USD',
      leverage: 100,
      mode: TRADING_MODE.HYBRID,
      nickname: 'Live Account',
    });
    await Wallet.create({ userId: trader._id, accountId: realAcct._id, currency: 'USD', balance: '2500' });
    console.log(`  ✓ Live (Real) account added ($2,500 USD)`);
  } else {
    console.log(`  • Live account already exists`);
  }

  // INSTRUMENTS
  const instruments = [
    {
      symbol: 'BTCUSD',
      name: 'Bitcoin / US Dollar',
      baseCurrency: 'BTC',
      quoteCurrency: 'USD',
      category: 'CRYPTO',
      // HYBRID + B-Book = modern crypto broker (BingX/Bybit-style).
      // Tries user-to-user match first, falls back to broker counterparty.
      // Pro traders auto-routed to external (A-book hedge).
      mode: TRADING_MODE.HYBRID,
      bBookEnabled: true,
      bBookDisableMode: 'LET_RUN',
      pricePrecision: 2,
      quantityPrecision: 6,
      minOrderSize: '0.0001',
      maxOrderSize: '100',
      maxLeverage: 50,
      lastPrice: '67000',
      // Binance external feed mapping (free, no signup)
      // Auto-enabled when USE_BINANCE_FEED=true in .env
      externalProvider: process.env.USE_BINANCE_FEED === 'true' ? 'BINANCE' : null,
      externalFeedSymbol: 'BTCUSDT',
      // 0.05% commission both sides (industry standard for crypto)
      spreadType: 'FIXED',
      spreadValue: '5',          // $5 spread on B-book BTC trades
      commissionPercent: '0.0005', // 0.05%
      priceSimulator: {
        enabled: process.env.USE_BINANCE_FEED !== 'true',
        // 0.4% per 2s tick gives clearly-visible candle bodies/wicks in
        // demo mode. 0.08% (prior value) produced near-flat lines that
        // looked broken even when the simulator was running correctly.
        volatilityPct: 0.4,
        intervalMs: 2000,
        minPrice: '50000',
        maxPrice: '100000',
      },
    },
    {
      symbol: 'ETHUSD',
      name: 'Ethereum / US Dollar',
      baseCurrency: 'ETH',
      quoteCurrency: 'USD',
      category: 'CRYPTO',
      mode: TRADING_MODE.HYBRID,
      bBookEnabled: true,
      bBookDisableMode: 'LET_RUN',
      pricePrecision: 2,
      quantityPrecision: 4,
      minOrderSize: '0.01',
      maxOrderSize: '1000',
      maxLeverage: 50,
      lastPrice: '3500',
      externalProvider: process.env.USE_BINANCE_FEED === 'true' ? 'BINANCE' : null,
      externalFeedSymbol: 'ETHUSDT',
      spreadType: 'FIXED',
      spreadValue: '0.50',
      commissionPercent: '0.0005',
      priceSimulator: {
        enabled: process.env.USE_BINANCE_FEED !== 'true',
        // ETH is ~10% more volatile than BTC historically — bump to match.
        volatilityPct: 0.5,
        intervalMs: 2000,
        minPrice: '2000',
        maxPrice: '5000',
      },
    },
    {
      symbol: 'EURUSD',
      name: 'Euro / US Dollar',
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      category: 'FOREX',
      mode: TRADING_MODE.EXTERNAL,
      bBookEnabled: true,
      bBookDisableMode: 'LET_RUN',
      pricePrecision: 5,
      quantityPrecision: 2,
      minOrderSize: '100',
      maxOrderSize: '1000000',
      maxLeverage: 200,
      lastPrice: '1.08750',
      // Provider priority: Finnhub (Indian-friendly real-time) > OANDA > Twelve Data > simulator
      externalProvider: process.env.FINNHUB_API_KEY
        ? 'FINNHUB'
        : (process.env.OANDA_API_KEY
          ? 'OANDA'
          : (process.env.TWELVE_DATA_API_KEY ? 'TWELVE_DATA' : null)),
      externalFeedSymbol: process.env.FINNHUB_API_KEY
        ? 'OANDA:EUR_USD'
        : (process.env.OANDA_API_KEY ? 'EUR_USD' : 'EUR/USD'),
      spreadType: 'FIXED',
      spreadValue: '0.0002',
      commissionPercent: '0.0005',
      priceSimulator: {
        enabled: !process.env.FINNHUB_API_KEY && !process.env.OANDA_API_KEY && !process.env.TWELVE_DATA_API_KEY,
        volatilityPct: 0.02,
        intervalMs: 3000,
        minPrice: '1.00000',
        maxPrice: '1.20000',
      },
    },
    {
      symbol: 'GBPUSD',
      name: 'British Pound / US Dollar',
      baseCurrency: 'GBP',
      quoteCurrency: 'USD',
      category: 'FOREX',
      mode: TRADING_MODE.EXTERNAL,
      bBookEnabled: true,
      bBookDisableMode: 'LET_RUN',
      pricePrecision: 5,
      quantityPrecision: 2,
      minOrderSize: '100',
      maxOrderSize: '1000000',
      maxLeverage: 200,
      lastPrice: '1.27500',
      externalProvider: process.env.FINNHUB_API_KEY
        ? 'FINNHUB'
        : (process.env.OANDA_API_KEY
          ? 'OANDA'
          : (process.env.TWELVE_DATA_API_KEY ? 'TWELVE_DATA' : null)),
      externalFeedSymbol: process.env.FINNHUB_API_KEY
        ? 'OANDA:GBP_USD'
        : (process.env.OANDA_API_KEY ? 'GBP_USD' : 'GBP/USD'),
      spreadType: 'FIXED',
      spreadValue: '0.0002',
      commissionPercent: '0.0005',
      priceSimulator: {
        enabled: !process.env.FINNHUB_API_KEY && !process.env.OANDA_API_KEY && !process.env.TWELVE_DATA_API_KEY,
        volatilityPct: 0.02,
        intervalMs: 3000,
        minPrice: '1.20000',
        maxPrice: '1.35000',
      },
    },
    {
      symbol: 'XAUUSD',
      name: 'Gold / US Dollar',
      baseCurrency: 'XAU',
      quoteCurrency: 'USD',
      category: 'COMMODITY',
      mode: TRADING_MODE.EXTERNAL,
      bBookEnabled: true,
      bBookDisableMode: 'LET_RUN',
      pricePrecision: 2,
      quantityPrecision: 2,
      minOrderSize: '0.01',
      maxOrderSize: '1000',
      maxLeverage: 100,
      lastPrice: '2350.50',
      externalProvider: process.env.FINNHUB_API_KEY
        ? 'FINNHUB'
        : (process.env.OANDA_API_KEY
          ? 'OANDA'
          : (process.env.TWELVE_DATA_API_KEY ? 'TWELVE_DATA' : null)),
      externalFeedSymbol: process.env.FINNHUB_API_KEY
        ? 'OANDA:XAU_USD'
        : (process.env.OANDA_API_KEY ? 'XAU_USD' : 'XAU/USD'),
      spreadType: 'FIXED',
      spreadValue: '0.50',
      commissionPercent: '0.001',
      priceSimulator: {
        enabled: !process.env.FINNHUB_API_KEY && !process.env.OANDA_API_KEY && !process.env.TWELVE_DATA_API_KEY,
        volatilityPct: 0.05,
        intervalMs: 2500,
        minPrice: '2000',
        maxPrice: '2700',
      },
    },

    // ─── Major + cross forex pairs ──────────────────────────────────
    // Helper-driven so each entry stays 1 line of config. JPY pairs use
    // pricePrecision 3 (the 0.001 pip is the fx market convention since
    // 1 JPY ≈ $0.006 — 5-decimal precision would be noise).
    ...buildForexPairs([
      { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen',  base: 'USD', quote: 'JPY', last: '155.215', precision: 3, range: ['130.00',  '160.00'],  spread: '0.020' },
      { symbol: 'USDCHF', name: 'US Dollar / Swiss Franc',   base: 'USD', quote: 'CHF', last: '0.90325', precision: 5, range: ['0.85000', '0.95000'], spread: '0.0002' },
      { symbol: 'AUDUSD', name: 'Australian Dollar / USD',   base: 'AUD', quote: 'USD', last: '0.66150', precision: 5, range: ['0.60000', '0.70000'], spread: '0.0002' },
      { symbol: 'NZDUSD', name: 'New Zealand Dollar / USD',  base: 'NZD', quote: 'USD', last: '0.60280', precision: 5, range: ['0.55000', '0.65000'], spread: '0.0002' },
      { symbol: 'USDCAD', name: 'US Dollar / Canadian Dollar', base: 'USD', quote: 'CAD', last: '1.36450', precision: 5, range: ['1.30000', '1.40000'], spread: '0.0002' },
      { symbol: 'EURGBP', name: 'Euro / British Pound',      base: 'EUR', quote: 'GBP', last: '0.85320', precision: 5, range: ['0.80000', '0.90000'], spread: '0.0003' },
      { symbol: 'EURJPY', name: 'Euro / Japanese Yen',       base: 'EUR', quote: 'JPY', last: '168.475', precision: 3, range: ['150.00',  '180.00'],  spread: '0.025' },
      { symbol: 'GBPJPY', name: 'British Pound / Japanese Yen', base: 'GBP', quote: 'JPY', last: '197.840', precision: 3, range: ['180.00',  '210.00'],  spread: '0.030' },
      { symbol: 'AUDJPY', name: 'Australian Dollar / JPY',   base: 'AUD', quote: 'JPY', last: '102.640', precision: 3, range: ['90.00',   '115.00'],  spread: '0.025' },
      { symbol: 'EURCHF', name: 'Euro / Swiss Franc',        base: 'EUR', quote: 'CHF', last: '0.97240', precision: 5, range: ['0.90000', '1.05000'], spread: '0.0003' },
    ]),
  ];

  for (const data of instruments) {
    const exists = await Instrument.findOne({ symbol: data.symbol });
    if (!exists) {
      await Instrument.create(data);
      console.log(`✓ Instrument created: ${data.symbol}`);
    }
  }

  // SUBSCRIPTION PLANS
  const { Plan } = require('../models/Subscription');
  const defaultPlans = [
    {
      code: 'FREE',
      name: 'Free',
      description: 'Get started with basic trading.',
      monthlyPrice: '0',
      yearlyPrice: '0',
      sortOrder: 1,
      limits: { maxAccounts: 2, defaultLeverage: 100, maxLeverageOverride: null, withdrawalDailyLimit: null },
      features: { feeDiscountPercent: '0', apiAccess: false, prioritySupport: false, copyTradingEnabled: false, affiliateBonus: '0' },
      highlights: ['2 trading accounts', 'Up to 1:100 leverage', 'All instruments', 'Standard support'],
    },
    {
      code: 'PREMIUM',
      name: 'Premium',
      description: 'For active traders. Better fees and more accounts.',
      monthlyPrice: '29.99',
      yearlyPrice: '299.99',
      sortOrder: 2,
      badge: 'Most Popular',
      limits: { maxAccounts: 5, defaultLeverage: 200, maxLeverageOverride: null, withdrawalDailyLimit: null },
      features: { feeDiscountPercent: '0.20', apiAccess: true, prioritySupport: true, copyTradingEnabled: false, affiliateBonus: '0.05' },
      highlights: ['5 trading accounts', 'Up to 1:200 leverage', '20% fee discount', 'API access', 'Priority support'],
    },
    {
      code: 'VIP',
      name: 'VIP',
      description: 'Elite traders. Lowest fees, dedicated manager.',
      monthlyPrice: '99.99',
      yearlyPrice: '999.99',
      sortOrder: 3,
      limits: { maxAccounts: 10, defaultLeverage: 500, maxLeverageOverride: 500, withdrawalDailyLimit: null },
      features: { feeDiscountPercent: '0.40', apiAccess: true, prioritySupport: true, copyTradingEnabled: false, affiliateBonus: '0.10', customSupport: true },
      highlights: ['10 trading accounts', 'Up to 1:500 leverage', '40% fee discount', 'Dedicated account manager', 'White-glove onboarding'],
    },
  ];
  for (const p of defaultPlans) {
    const existing = await Plan.findOne({ code: p.code });
    if (!existing) {
      await Plan.create(p);
      console.log(`✓ Plan created: ${p.code} ($${p.monthlyPrice}/mo)`);
    } else {
      // Always sync `features` + `highlights` to the canonical seed —
      // these are content, not user-tweakable pricing. Keeps the
      // running app aligned with the codebase even when admins have
      // already created plans manually (e.g. "Copy trading" removal
      // rolls out automatically on next deploy).
      existing.features   = p.features;
      existing.highlights = p.highlights;
      // Pick up new badges / descriptions on re-seed too.
      if (p.badge !== undefined)       existing.badge = p.badge;
      if (p.description !== undefined) existing.description = p.description;
      await existing.save();
      console.log(`✓ Plan synced:  ${p.code}`);
    }
  }

  console.log('\n=== Seed complete ===');
  console.log('Admin login: admin@tradingplatform.local / Admin@12345');
  console.log('Trader login: trader@tradingplatform.local / Trader@12345');
  process.exit(0);
};

seed().catch((e) => {
  console.error('Seed error:', e);
  process.exit(1);
});
