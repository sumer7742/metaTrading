const mongoose = require('mongoose');
const { ACCOUNT_TYPES, TRADING_MODE } = require('../config/constants');

const tradingAccountSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountNumber: { type: String, unique: true, required: true },
    accountType: {
      type: String,
      enum: [...Object.values(ACCOUNT_TYPES), 'CUSTOM'],
      default: ACCOUNT_TYPES.DEMO,
    },
    customTypeName: String, // when accountType === 'CUSTOM'
    baseCurrency: { type: String, default: 'USD' },
    leverage: { type: Number, default: 100 }, // 1:100
    mode: { type: String, enum: Object.values(TRADING_MODE), default: TRADING_MODE.HYBRID },
    isActive: { type: Boolean, default: true },
    nickname: String,

    // Risk safety (doc §7.10): when balance + unrealized PnL <= 0, auto-close all positions
    // and floor balance at 0. Required for retail accounts in most jurisdictions.
    negativeBalanceProtection: { type: Boolean, default: true },
    // Cap on total open notional exposure across all positions on this account.
    // null = no limit. Stored as string-decimal in base currency.
    maxPositionSize: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TradingAccount', tradingAccountSchema);
