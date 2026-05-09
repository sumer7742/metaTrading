const mongoose = require('mongoose');
const { WALLET_TX_TYPE } = require('../config/constants');

const walletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
    currency: { type: String, required: true },
    // Stored as string to preserve decimal precision; convert to Decimal for arithmetic.
    balance: { type: String, default: '0' },
    locked: { type: String, default: '0' }, // Reserved for open orders / margin
  },
  { timestamps: true }
);

walletSchema.index({ userId: 1, accountId: 1, currency: 1 }, { unique: true });

const ledgerSchema = new mongoose.Schema(
  {
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true },
    type: { type: String, enum: Object.values(WALLET_TX_TYPE), required: true },
    currency: { type: String, required: true },
    amount: { type: String, required: true }, // signed string decimal (positive credit, negative debit)
    balanceAfter: { type: String, required: true },
    referenceType: String, // 'order', 'trade', 'withdrawal', 'deposit'
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    // Idempotency key. When set, the sparse unique index ensures a duplicate
    // settlement insert (e.g. two concurrent close requests, or a worker
    // racing the controller) is rejected with E11000 — the second insert
    // becomes a no-op so PnL can never be double-credited. Format examples:
    //   "TRADE_SETTLE:<tradeId>"   one settle per fill
    //   "POSITION_SETTLE:<posId>"  one settle per position close
    dedupeKey: { type: String },
    note: String,
    createdAt: { type: Date, default: Date.now, immutable: true },
  },
  { timestamps: false }
);

ledgerSchema.index({ userId: 1, createdAt: -1 });
// Sparse: only documents with dedupeKey set are indexed, so legacy ledger
// rows without the key don't collide.
ledgerSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

module.exports = {
  Wallet: mongoose.model('Wallet', walletSchema),
  WalletLedger: mongoose.model('WalletLedger', ledgerSchema),
};
