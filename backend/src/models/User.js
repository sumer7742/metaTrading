const mongoose = require('mongoose');
const { ROLES, KYC_STATUS } = require('../config/constants');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, sparse: true, index: true },
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
      forceABook: { type: Boolean, default: false },
      maxLeverage: { type: Number, default: null },
      maxPositionSize: { type: Number, default: null },
    },

    // Referrals
    referralCode: { type: String, unique: true, sparse: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

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
