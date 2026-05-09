const mongoose = require('mongoose');

/**
 * Subscription Plans (doc §7.16).
 *
 * Each plan defines limits and benefits that gate features:
 *   - maxAccounts         : how many trading accounts user can create
 *   - maxLeverageOverride : raise leverage cap globally (null = use instrument default)
 *   - feeDiscountPercent  : % off commission/spread (e.g. 0.20 = 20% off)
 *   - apiAccess           : allow programmatic API key generation
 *   - prioritySupport     : flag picked up by helpdesk
 *   - copyTradingEnabled  : Phase 3 copy-trading access
 *   - withdrawalDailyLimit: USD daily cap, null = no extra cap
 *   - affiliateBonus      : additional % commission on this plan
 */
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true }, // FREE, PREMIUM, VIP
    name: { type: String, required: true },
    description: String,
    monthlyPrice: { type: String, default: '0' }, // USD per month, string for decimal precision
    yearlyPrice: { type: String, default: '0' },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },

    limits: {
      maxAccounts: { type: Number, default: 2 },
      maxLeverageOverride: { type: Number, default: null }, // null = no override
      withdrawalDailyLimit: { type: String, default: null }, // null = no extra cap
    },
    features: {
      feeDiscountPercent: { type: String, default: '0' }, // 0.00 to 1.00
      apiAccess: { type: Boolean, default: false },
      prioritySupport: { type: Boolean, default: false },
      copyTradingEnabled: { type: Boolean, default: false },
      affiliateBonus: { type: String, default: '0' }, // extra % on commissions
      customSupport: { type: Boolean, default: false }, // dedicated account manager
    },

    // Display in pricing page UI
    highlights: [String], // e.g. ["20% fee discount", "API access", "Priority support"]
    badge: String, // e.g. "Most Popular"
  },
  { timestamps: true }
);

const subscriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    planCode: { type: String, required: true, index: true }, // denormalized for fast checks
    status: {
      type: String,
      enum: ['ACTIVE', 'CANCELLED', 'EXPIRED', 'PENDING_PAYMENT', 'TRIAL'],
      default: 'ACTIVE',
      index: true,
    },
    billingCycle: { type: String, enum: ['MONTHLY', 'YEARLY', 'LIFETIME'], default: 'MONTHLY' },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null }, // null = never expires (FREE / LIFETIME)
    cancelledAt: Date,
    cancelReason: String,
    autoRenew: { type: Boolean, default: true },

    // Last payment reference (when paid plans go through Razorpay/Stripe)
    lastPayment: {
      provider: String, // 'RAZORPAY' | 'STRIPE' | 'MANUAL'
      transactionId: String,
      amount: String,
      currency: { type: String, default: 'USD' },
      paidAt: Date,
    },
  },
  { timestamps: true }
);

module.exports = {
  Plan: mongoose.model('Plan', planSchema),
  Subscription: mongoose.model('Subscription', subscriptionSchema),
};
