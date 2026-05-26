const mongoose = require('mongoose');
const { ACCOUNT_TYPES, TRADING_MODE, BOOK_TYPE, LP_PROVIDER } = require('../config/constants');

const tradingAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountNumber: { type: String, unique: true, required: true },
    accountType: {
      type: String,
      enum: [...Object.values(ACCOUNT_TYPES), 'CUSTOM'],
      // Default new accounts to STANDARD — the lowest-friction tier that
      // still has the classic Buy/Sell + capped leverage. Tier metadata
      // (fees, leverage cap, buy-close-only) lives in config/accountTypes.js
      // and is derived from this field at runtime.
      default: ACCOUNT_TYPES.STANDARD,
    },
    customTypeName: String, // when accountType === 'CUSTOM'
    baseCurrency: { type: String, default: 'USD' },
    leverage: { type: Number, default: 100 }, // 1:100
    // @deprecated — left in place for backward compatibility with older
    // reports/dashboards. New code MUST NOT branch on `mode`; routing is
    // driven by `bookType` + `lpProvider` below.
    mode: { type: String, enum: Object.values(TRADING_MODE), default: TRADING_MODE.HYBRID },
    isActive: { type: Boolean, default: true },
    nickname: String,

    // ─── Execution routing (per-account, NOT per-instrument) ─────────
    // bookType decides where this account's flow is sent:
    //   A_BOOK  - forward every order to the LP adapter (`lpProvider`)
    //   B_BOOK  - internalise: broker acts as counterparty (default)
    //   HYBRID  - risk engine decides per order (volume / exposure /
    //             trader profile). See riskEngine.service.js.
    // Two users trading the SAME instrument can sit on different books.
    bookType: {
      type: String,
      enum: Object.values(BOOK_TYPE),
      default: BOOK_TYPE.B_BOOK,
      index: true,
    },
    // LP routing target. Required when bookType !== B_BOOK; if NONE is
    // set on an A_BOOK account, order placement is rejected with a clear
    // "LP provider is required for A-book execution." error.
    lpProvider: {
      type: String,
      enum: Object.values(LP_PROVIDER),
      default: LP_PROVIDER.NONE,
    },
    // Hard kill-switch: when false, every order is rejected at the
    // router with TRADING_DISABLED. Lets ops freeze a single account
    // (e.g. for fraud review) without disabling the user globally.
    isTradingEnabled: { type: Boolean, default: true },

    // Risk safety (doc §7.10): when balance + unrealized PnL <= 0, auto-close all positions
    // and floor balance at 0. Required for retail accounts in most jurisdictions.
    negativeBalanceProtection: { type: Boolean, default: true },
    // Cap on total open notional exposure across all positions on this account.
    // null = no limit. Stored as string-decimal in base currency.
    maxPositionSize: { type: String, default: null },

    // Plan-driven suspension (separate from isTradingEnabled which is the
    // ops/fraud freeze). When set, the account is over the user's current
    // plan's maxAccounts cap — e.g. they downgraded from VIP (10 accounts)
    // to FREE (2). Suspended accounts:
    //   - cannot open new positions (close-only still allowed so positions
    //     can be liquidated to free up withdrawable funds)
    //   - can still receive withdrawals
    //   - history is clipped to the last 3 months in reports
    // Auto-lifted by planEnforcementService when the user upgrades back.
    planSuspendedAt: { type: Date, default: null, index: true },
    planSuspendedReason: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TradingAccount', tradingAccountSchema);
