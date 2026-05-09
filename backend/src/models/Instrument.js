const mongoose = require('mongoose');
const { TRADING_MODE } = require('../config/constants');

const instrumentSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, unique: true, uppercase: true, index: true },
    name: { type: String, required: true },
    baseCurrency: { type: String, required: true },
    quoteCurrency: { type: String, required: true },
    category: { type: String, enum: ['CRYPTO', 'FOREX', 'STOCK', 'INDEX', 'COMMODITY'], required: true },

    // Trading config
    isActive: { type: Boolean, default: true },
    mode: { type: String, enum: Object.values(TRADING_MODE), default: TRADING_MODE.INTERNAL },
    bBookEnabled: { type: Boolean, default: false },

    // What to do with existing B-book positions when bBookEnabled is turned OFF (doc §9.4)
    //   CLOSE_ALL     - immediately close all open B-book positions at last price
    //   LET_RUN       - existing positions remain until user closes them naturally
    //   HEDGE_EXTERNAL - open offsetting positions on external market (requires external broker)
    bBookDisableMode: { type: String, enum: ['CLOSE_ALL', 'LET_RUN', 'HEDGE_EXTERNAL'], default: 'LET_RUN' },

    // Auto mode-switching rules (doc §4.4)
    autoSwitchRules: {
      enabled: { type: Boolean, default: false },
      // Switch to INTERNAL when external market is closed (e.g. NSE off-hours)
      // tradingHours.start/end already define market window; this just enables the behavior
      internalWhenMarketClosed: { type: Boolean, default: false },
      // Switch to INTERNAL when 24h internal volume exceeds threshold (graduate from Hybrid)
      // value as string-decimal to match other money/qty fields
      internalVolumeThreshold: { type: String, default: null },
      // Switch to EXTERNAL when 5-min price change exceeds % threshold (volatility safety)
      externalVolatilityThresholdPct: { type: Number, default: null },
    },

    // Pricing
    pricePrecision: { type: Number, default: 2 }, // decimals
    quantityPrecision: { type: Number, default: 4 },
    minOrderSize: { type: String, default: '0.001' },
    maxOrderSize: { type: String, default: '1000000' },
    lotSize: { type: String, default: '0.001' },

    // Spread & Commission
    spreadType: { type: String, enum: ['FIXED', 'PERCENTAGE'], default: 'FIXED' },
    spreadValue: { type: String, default: '0' }, // e.g. "0.5" pips or "0.001" %
    commissionPerTrade: { type: String, default: '0' }, // flat fee
    commissionPercent: { type: String, default: '0' }, // %

    // Leverage
    maxLeverage: { type: Number, default: 100 },
    leverageLadder: { type: [Number], default: [1, 5, 10, 20, 50, 100] },

    // Trading hours - simplified: 24/7 if empty
    tradingHours: {
      start: { type: String, default: '00:00' }, // UTC
      end: { type: String, default: '23:59' },
      days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=Sun
    },

    // External feed mapping
    externalFeedSymbol: String, // e.g. "BTCUSDT" on Binance
    externalProvider: String, // 'BINANCE', 'TRADINGVIEW', etc.

    // Synthetic price simulator (doc Phase 2: "market maker bot").
    // Useful when there are no real users + no external feed yet.
    // Generates random-walk price moves so chart, PnL, SL/TP all feel live.
    // Disable for production-grade real-money instruments.
    priceSimulator: {
      enabled: { type: Boolean, default: false },
      volatilityPct: { type: Number, default: 0.05 }, // % move per tick (e.g. 0.05 = 0.05% per tick)
      intervalMs: { type: Number, default: 3000 }, // tick frequency, default 3s
      driftPct: { type: Number, default: 0 }, // small upward/downward bias per tick
      minPrice: { type: String, default: null }, // floor (price won't go below)
      maxPrice: { type: String, default: null }, // ceiling
    },

    // Last known price (cached)
    lastPrice: { type: String, default: '0' },
    lastPriceUpdatedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Instrument', instrumentSchema);
