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
    // Per-instrument routing override — same semantics as the
    // user-level RiskOverride.routingMode. INHERIT means "use the
    // platform-wide Settings → Routing Mode". An explicit value
    // (A_BOOK / B_BOOK / HYBRID) wins over the global for THIS symbol.
    // Order of precedence at trade time: user override → instrument
    // override → global setting.
    routingOverride: {
      type: String,
      enum: ['INHERIT', 'A_BOOK', 'B_BOOK', 'HYBRID'],
      default: 'INHERIT',
    },
    // ─── @deprecated routing fields ──────────────────────────────────
    // Book-type / external routing is now a PER-ACCOUNT decision (see
    // TradingAccount.bookType + lpProvider). The instrument-level fields
    // below are preserved only so legacy data / admin instruments page
    // keep working. orderRouter.service.js does NOT branch on these.
    // Safe to delete once nothing in the codebase reads them.
    mode: { type: String, enum: Object.values(TRADING_MODE), default: TRADING_MODE.INTERNAL },
    bBookEnabled: { type: Boolean, default: false },
    bBookDisableMode: { type: String, enum: ['CLOSE_ALL', 'LET_RUN', 'HEDGE_EXTERNAL'], default: 'LET_RUN' },
    autoSwitchRules: {
      enabled: { type: Boolean, default: false },
      internalWhenMarketClosed: { type: Boolean, default: false },
      internalVolumeThreshold: { type: String, default: null },
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
    // Profit-share fee (doc §5) — charged only when a closing trade
    // realises positive PnL. Expressed as a percent of the realized
    // profit (e.g. "2" = take 2% of profit). 0 disables.
    profitSharePercent: { type: String, default: '0' },

    // Leverage — defaults to Unlimited (999999 sentinel). Admin can
    // override to a finite cap per instrument; instrument leverage has
    // the highest priority over account/plan leverage at order time.
    // null is also accepted as "unlimited" for legacy rows.
    maxLeverage: { type: Number, default: 999999 },
    leverageLadder: { type: [Number], default: [1, 5, 10, 20, 50, 100, 200, 500, 1000] },

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
