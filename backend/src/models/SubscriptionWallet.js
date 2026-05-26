const mongoose = require('mongoose');

/**
 * Subscription Wallet — completely separate from the trading wallet.
 * Funds in this wallet are reserved for plan purchases / renewals and
 * NEVER touched by trading flows. Top-ups go in via deposit; debits
 * happen on subscribe / renew. Admins can credit or debit manually.
 *
 * One wallet per user (currency is captured at creation; the platform
 * defaults to USD to match plan pricing).
 */
const subscriptionWalletSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    walletType: { type: String, default: 'subscription', immutable: true },
    balance: { type: String, default: '0' },        // string-decimal
    currency: { type: String, default: 'USD' },

    // User preferences
    autoRenew: { type: Boolean, default: true },
    // When auto-renew runs and balance < plan price, the user gets a
    // grace window before the subscription expires. Days, admin-tunable.
    gracePeriodDays: { type: Number, default: 3 },
    // If balance falls below this, the FE shows a low-balance warning.
    // String-decimal in `currency`.
    lowBalanceThreshold: { type: String, default: '10' },
  },
  { timestamps: true }
);

/**
 * Subscription transaction log — every credit, debit, refund, or admin
 * adjustment lands here. Used as both the user-facing transaction list
 * and the admin "subscription payment logs" audit trail.
 *
 * `transactionType`: CREDIT | DEBIT | REFUND
 * `reason`:           DEPOSIT | SUBSCRIPTION_CHARGE | RENEWAL |
 *                     ADMIN_CREDIT | ADMIN_DEBIT | REFUND
 * `status`:           SUCCESS | PENDING | FAILED
 */
const subscriptionTransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionWallet' },

    transactionType: {
      type: String,
      enum: ['CREDIT', 'DEBIT', 'REFUND'],
      required: true,
      index: true,
    },
    reason: {
      type: String,
      enum: ['DEPOSIT', 'SUBSCRIPTION_CHARGE', 'RENEWAL', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'REFUND'],
      required: true,
    },
    status: {
      type: String,
      enum: ['SUCCESS', 'PENDING', 'FAILED'],
      default: 'SUCCESS',
      index: true,
    },

    amount: { type: String, required: true },      // unsigned string decimal
    currency: { type: String, default: 'USD' },
    balanceAfter: { type: String },

    // Free-text columns for what plan / period the charge corresponds to.
    planCode: String,           // e.g. PREMIUM
    billingCycle: String,       // MONTHLY | YEARLY
    note: String,
    paymentMethod: String,      // 'wallet' | 'razorpay' | 'stripe' | 'manual'
    paymentRef: String,         // provider transaction id

    // Admin attribution — set when an admin manually credited/debited.
    adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

subscriptionTransactionSchema.index({ userId: 1, createdAt: -1 });
subscriptionTransactionSchema.index({ status: 1, createdAt: -1 });

module.exports = {
  SubscriptionWallet: mongoose.model('SubscriptionWallet', subscriptionWalletSchema),
  SubscriptionTransaction: mongoose.model('SubscriptionTransaction', subscriptionTransactionSchema),
};
