const mongoose = require('mongoose');
const { ROLES, KYC_STATUS } = require('../config/constants');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Stored as the normalised E.164-ish form ("+919876543210"). Sparse
    // unique so multiple users can leave it blank, but no two filled-in
    // phones can collide. App-level check in authController catches it
    // earlier with a friendlier error; this index is the safety net for
    // race conditions / direct DB writes.
    phone: { type: String, sparse: true, unique: true, index: true },
    passwordHash: { type: String, required: true },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.USER },

    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    isPhoneVerified: { type: Boolean, default: false },

    // 2FA
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: null },
    // Hashed backup codes for 2FA recovery (doc §7.1). Each code single-use.
    twoFactorBackupCodes: [{ codeHash: String, usedAt: Date }],

    // Email verification (doc §7.1)
    emailVerificationToken: { type: String, default: null },
    emailVerificationExpiresAt: { type: Date, default: null },

    // KYC
    kycStatus: { type: String, enum: Object.values(KYC_STATUS), default: KYC_STATUS.NOT_SUBMITTED },
    kycDocuments: [
      {
        type: { type: String }, // 'ID', 'SELFIE', 'ADDRESS_PROOF'
        url: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    kycReviewedAt: Date,
    kycReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    kycRejectionReason: String,

    // Risk / Group
    userGroup: { type: String, default: 'DEFAULT' }, // VIP, NEW, PROFITABLE, SUSPICIOUS, DEFAULT
    riskOverride: {
      // Per-user routing override. When set, the orderRouter uses this
      // value instead of the global SystemSetting.routingMode.
      // null/empty = INHERIT (use the global mode).
      routingMode: { type: String, enum: ['A_BOOK', 'B_BOOK', 'HYBRID', null], default: null },
      forceABook: { type: Boolean, default: false }, // @deprecated — use routingMode='A_BOOK' instead
      maxLeverage: { type: Number, default: null },
      maxPositionSize: { type: Number, default: null },
    },
    // Symbol-level block list (doc §9, per-user permissions). When non-empty,
    // orders on these symbols are rejected at the router with
    // INSTRUMENT_BLOCKED. Used to keep specific users out of high-risk
    // instruments without blocking them globally.
    blockedInstruments: { type: [String], default: [] },

    // Referrals
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    // Partner / Referral program. `partnerLevel` is normally derived
    // from the active-referral count + tier thresholds in SystemSetting,
    // but admin can pin it (`partnerLevelLocked: true`) to override
    // auto-progression. `partnerBlocked` excludes the user from earning
    // commissions WITHOUT touching `isActive` (which gates login).
    partnerLevel:       { type: String, default: null },   // 'BRONZE' | 'SILVER' | 'GOLD' | 'DIAMOND'
    partnerLevelLocked: { type: Boolean, default: false },
    partnerBlocked:     { type: Boolean, default: false, index: true },

    // ─── Admin-controlled leverage override ─────────────────────────
    // The effective leverage cap for this user follows this precedence:
    //   1. customLeverage (set by admin) — overrides everything below
    //   2. The user's active plan's `limits.defaultLeverage`
    //   3. Hardcoded fallback (100×)
    // When admin clears the override (customLeverage = null), the
    // leverage automatically returns to the plan default.
    customLeverage: { type: Number, default: null, min: 1, max: 1000 },
    leverageOverride: {
      by:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      at:     { type: Date, default: null },
      reason: { type: String, default: null },
      // Optional auto-expiry — for temporary overrides. Null = permanent.
      expiresAt: { type: Date, default: null },
    },

    // Sessions
    refreshTokens: [{ token: String, deviceInfo: String, createdAt: { type: Date, default: Date.now } }],

    // FCM device tokens for push notifications
    pushTokens: [
      {
        token: String,
        platform: String, // 'ios' | 'android' | 'web'
        registeredAt: { type: Date, default: Date.now },
      },
    ],

    lastLoginAt: Date,
    lastLoginIp: String,
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.twoFactorSecret;
  delete obj.refreshTokens;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
