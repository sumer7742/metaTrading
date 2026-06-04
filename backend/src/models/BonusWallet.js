const mongoose = require('mongoose');

/**
 * Bonus Wallet — a dedicated, withdrawal-locked wallet that receives ALL
 * referral- and partner-program earnings (referral commissions, multi-
 * level commissions, partner commissions, revenue share, referral/partner
 * bonuses).
 *
 * Design mirrors SubscriptionWallet exactly (one doc per user, balance as
 * a string-decimal, paired transaction log) so it slots into the existing
 * wallet/transfer/admin patterns with zero changes to those systems.
 *
 * Key rule: funds here CANNOT be withdrawn directly. They must first be
 * transferred to an eligible wallet (Main / trading) via the existing
 * internal-transfer flow. The withdrawal workflow is account-scoped and
 * never sees this wallet, so it's excluded by construction.
 */
const bonusWalletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    walletType: { type: String, default: 'bonus', immutable: true },
    balance: { type: String, default: '0' }, // string-decimal
    currency: { type: String, default: 'USD' },

    // Subscription billing lives on this wallet: plan purchases / renewals
    // debit it, and these knobs drive the auto-renew + low-balance UX.
    autoRenew: { type: Boolean, default: true },
    gracePeriodDays: { type: Number, default: 3 },
    lowBalanceThreshold: { type: String, default: '10' },
  },
  { timestamps: true }
);

/**
 * Bonus transaction log — every credit/debit lands here. Doubles as the
 * user-facing history and the admin audit trail.
 *
 * `transactionType`: CREDIT | DEBIT
 * `reason`:           REFERRAL_COMMISSION | PARTNER_COMMISSION |
 *                     REVENUE_SHARE | BONUS_REWARD | TRANSFER_IN |
 *                     TRANSFER_OUT | ADMIN_CREDIT | ADMIN_DEBIT
 * `status`:           SUCCESS | PENDING | FAILED
 */
const bonusTransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'BonusWallet' },

    transactionType: { type: String, enum: ['CREDIT', 'DEBIT'], required: true, index: true },
    reason: {
      type: String,
      enum: [
        'REFERRAL_COMMISSION',
        'PARTNER_COMMISSION',
        'REVENUE_SHARE',
        'BONUS_REWARD',
        'DEPOSIT',
        'SUBSCRIPTION_CHARGE',
        'RENEWAL',
        'TRANSFER_IN',
        'TRANSFER_OUT',
        'ADMIN_CREDIT',
        'ADMIN_DEBIT',
        'WITHDRAWAL',
        'REFUND',
      ],
      required: true,
      index: true,
    },
    status: { type: String, enum: ['SUCCESS', 'PENDING', 'FAILED'], default: 'SUCCESS', index: true },

    amount: { type: String, required: true },   // unsigned string-decimal
    currency: { type: String, default: 'USD' },
    balanceAfter: { type: String },

    note: String,                                // human-readable description
    // Idempotency key (e.g. "commission:<id>", "transfer:<ledgerId>"). A
    // unique sparse index makes credits with the same ref a safe no-op,
    // preventing duplicate earnings on retries / double-fires.
    paymentRef: String,
    sourceWallet: String,                        // for transfers: 'trading:<acctId>' | 'subscription'
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

bonusTransactionSchema.index({ userId: 1, createdAt: -1 });
bonusTransactionSchema.index({ reason: 1, createdAt: -1 });
// Idempotency: at most one transaction per non-null paymentRef.
bonusTransactionSchema.index({ paymentRef: 1 }, { unique: true, sparse: true });

module.exports = {
  BonusWallet: mongoose.model('BonusWallet', bonusWalletSchema),
  BonusTransaction: mongoose.model('BonusTransaction', bonusTransactionSchema),
};
