const mongoose = require('mongoose');
const { TRADING_MODE } = require('../config/constants');

const instrumentSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, unique: true, uppercase: true, index: true },
    name: { type: String, required: true },
    baseCurrency: { type: String, required: true },
    quoteCurrency: { type: String, required: true },
    category: { type: String, enum: ['CRYPTO', 'FOREX', 'STOCK', 'INDEX', 'COMMODITY'], required: true },

    // ── Exchange-bound market fields (Phase 1: Indian NSE/BSE cash) ──
    // `exchange` drives session gating (services/marketHours.js) + charges.
    // Null/absent = 24/7 instrument (crypto/forex) — existing behaviour intact.
    // NFO/BFO = NSE/BSE F&O segments (futures + options).
    exchange: { type: String, enum: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'NCDEX'], default: null, index: true },
    segment: { type: String, enum: ['EQ', 'FUT', 'OPT', 'CURRENCY', 'COMM'], default: null }, // EQ = cash equity
    tickSize: { type: String, default: '0.05' },        // NSE equity default tick (₹0.05)
    instrumentToken: { type: String, default: null, index: true }, // feed/broker token (Kite/Angel/Dhan)
    isin: { type: String, default: null },              // ISIN for cash equity
    // ── Order-safety bands (from Dhan scrip master; null = not enforced) ──
    upperCircuit: { type: String, default: null },      // daily upper price band (SM_UPPER_LIMIT)
    lowerCircuit: { type: String, default: null },      // daily lower price band (SM_LOWER_LIMIT)
    freezeQty: { type: String, default: null },         // max qty per F&O order (SM_FREEZE_QTY)
    // Upstox instrument_key for F&O contracts (NSE_FO|<token>) — lets the live
    // feed pull the REAL futures/option price instead of a spot-proxy/intrinsic.
    upstoxKey: { type: String, default: null },

    // ── Derivatives (Phase 2: Futures, Phase 3: Options) ──
    // expiryDate triggers auto square-off; underlying links FUT/OPT to its spot.
    expiryDate: { type: Date, default: null, index: true },
    underlying: { type: String, default: null },        // spot symbol, e.g. 'NIFTY' for NIFTY futures
    // Options only:
    strike: { type: String, default: null },            // strike price (string decimal)
    optionType: { type: String, enum: ['CE', 'PE'], default: null }, // CE = call, PE = put

    // Trading config
    isActive: { type: Boolean, default: true },
    // Per-instrument routing override — same semantics + options as the
    // user-level RiskOverride.routingMode. INHERIT means "use the
    // platform-wide Settings → Routing Mode". An explicit value
    // (INTERNAL_MATCHING / A_BOOK / B_BOOK / HYBRID) wins over the global
    // for THIS symbol. Order of precedence at trade time: user override →
    // instrument override → global setting.
    routingOverride: {
      type: String,
      enum: ['INHERIT', 'INTERNAL_MATCHING', 'A_BOOK', 'B_BOOK', 'HYBRID'],
      default: 'INHERIT',
    },
    // ─── Optional daily volume cap (lots) ────────────────────────────────
    // Platform-wide cap on OPENING order volume per UTC day for THIS symbol,
    // summed across all users — tracked SEPARATELY for BUY and SELL. Disabled
    // by default → UNLIMITED. When enabled, a new BUY opening order is rejected
    // once the day's BUY volume reaches dailyBuyLimit (and likewise SELL vs
    // dailySellLimit). A 0 on either side = that side is unlimited. Closes are
    // never capped. (dailyVolumeLimit kept for legacy data; no longer enforced.)
    dailyVolumeLimitEnabled: { type: Boolean, default: false },
    dailyBuyLimit:           { type: Number, default: 0, min: 0 }, // lots; 0 = unlimited BUY
    dailySellLimit:          { type: Number, default: 0, min: 0 }, // lots; 0 = unlimited SELL
    dailyVolumeLimit:        { type: Number, default: 0, min: 0 }, // @deprecated (combined)

    // ─── Optional LIFETIME volume cap (lots), GLOBAL per instrument ──────
    // Platform-wide cumulative cap on total executed OPENING volume for THIS
    // symbol across ALL users and ALL time — tracked SEPARATELY for BUY and
    // SELL. Disabled by default → UNLIMITED. Once the instrument's cumulative
    // BUY volume reaches lifetimeBuyLimit, NO user can open more BUYs on this
    // symbol (SELL vs lifetimeSellLimit). 0 on a side = that side unlimited
    // (usage still tracked). Closes are never capped; existing positions are
    // unaffected. Changes apply to future orders only (history is never rewritten).
    lifetimeVolumeLimitEnabled: { type: Boolean, default: false },
    lifetimeBuyLimit:           { type: Number, default: 0, min: 0 }, // lots; 0 = unlimited BUY
    lifetimeSellLimit:          { type: Number, default: 0, min: 0 }, // lots; 0 = unlimited SELL
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
    // Commission model — exactly ONE method is active per instrument:
    //   FIXED      → commission = commissionPerTrade (flat fee per trade)
    //   PERCENTAGE → commission = tradeValue × commissionPercent
    // The inactive field is forced to '0' on save so the two can never
    // both charge. See utils/commission.computeInstrumentCommission().
    // @deprecated for user-facing fees — commission now inherits from the
    // ACCOUNT TYPE (AccountPlan) and is overridden PER ACCOUNT TYPE via
    // `commissionOverrides` below. These flat fields are retained only as the
    // affiliate-distribution basis + ultimate fallback for orphaned accounts.
    commissionType: { type: String, enum: ['FIXED', 'PERCENTAGE'], default: 'PERCENTAGE' },
    commissionPerTrade: { type: String, default: '0' }, // flat fee (FIXED mode)
    commissionPercent: { type: String, default: '0' }, // % (PERCENTAGE mode)

    // Per-account-type commission OVERRIDES. By default an instrument inherits
    // each account type's own commission (AccountPlan fee model). An entry here
    // overrides the fee for ONLY that account type on THIS instrument; other
    // account types are unaffected. Multiple entries (one per account type)
    // may coexist. PERCENTAGE → fee = tradeValue × commissionValue (raw
    // fraction, 0.0005 = 0.05%); FIXED → flat commissionValue per trade.
    // commissionType:
    //   PERCENTAGE    → fee = tradeValue × commissionValue (raw fraction)
    //   FIXED         → flat commissionValue per trade
    //   PCT_OF_PROFIT → fee = realizedProfit × commissionValue, charged ONLY on
    //                   profitable closes (loss / breakeven → 0)
    commissionOverrides: {
      type: [{
        accountType: { type: String, required: true }, // AccountPlan.code (e.g. STANDARD)
        commissionType: { type: String, enum: ['PERCENTAGE', 'FIXED', 'PCT_OF_PROFIT'], default: 'PERCENTAGE' },
        commissionValue: { type: Number, default: 0 },
        _id: false,
      }],
      default: [],
    },
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

    // Fixed-volume (lot size) lock. When enabled, every NEW order on this
    // instrument is forced to `fixedVolumeValue` and the client volume input
    // is read-only. Independent of leverage. Min/max/step reuse the existing
    // minOrderSize / maxOrderSize / lotSize fields. A scheduled volume
    // override (InstrumentVolumeOverride) takes precedence over this static
    // setting while its window is active. Never affects open positions.
    fixedVolumeEnabled: { type: Boolean, default: false },
    fixedVolumeValue:   { type: String, default: '0' },

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
