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

    // ─── Permanent public User ID (additive, immutable) ────────────────
    // Human-readable, platform-unique handle shown in the user's profile
    // and throughout the admin system (e.g. "USR100245"). Generated exactly
    // once on creation by the pre-save hook below and never changed.
    // `sparse` so the unique index tolerates legacy docs in the brief window
    // before the backfill migration assigns them one. Read-only everywhere —
    // no controller ever overwrites it.
    userUid: { type: String, unique: true, sparse: true, index: true },

    passwordHash: { type: String, required: true },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    role: { type: String, enum: Object.values(ROLES), default: ROLES.USER },

    isActive: { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    isPhoneVerified: { type: Boolean, default: false },

    // Multi-watchlist: remembers which watchlist the user last had open so
    // it re-opens automatically on next login. Null until they own a list.
    lastSelectedWatchlistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Watchlist', default: null },

    // ─── Management hierarchy (additive, optional) ──────────────────────
    // Links a user (or a manager) up the SuperAdmin → Admin → Manager chain.
    // null = "Unassigned". Never read by the user-facing app — purely
    // internal management metadata. See config/hierarchy.js.
    adminId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    managerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedAt: { type: Date, default: null },

    // ─── Auto-provisioning / staff lifecycle (additive) ─────────────────
    // When the scalable auto-assignment engine runs out of capacity it spawns
    // ADMIN / MANAGER accounts on the fly. Those are flagged `autoCreated` and
    // start with `loginEnabled: false` — they hold users but CANNOT sign in
    // until a SuperAdmin "claims" them (sets real credentials + enables login).
    // `loginEnabled` defaults true so every existing/real account is unaffected.
    autoCreated:  { type: Boolean, default: false, index: true },
    loginEnabled: { type: Boolean, default: true },
    claimedAt:    { type: Date, default: null },
    claimedBy:    { type: String, default: null }, // SuperAdmin email/id who claimed it

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
      routingMode: { type: String, enum: ['INTERNAL_MATCHING', 'A_BOOK', 'B_BOOK', 'HYBRID', null], default: null },
      forceABook: { type: Boolean, default: false }, // @deprecated — use routingMode='A_BOOK' instead
      maxLeverage: { type: Number, default: null },
      maxPositionSize: { type: Number, default: null },
    },

    // ── Hierarchical limits (Super Admin → Admin → Manager → User) ──────
    // The maximum amounts this actor was GRANTED by their parent. Each is
    // validated server-side to never exceed the parent's own limit (set
    // time), and enforced at the relevant action point (create / deposit /
    // order / etc.). `null` = no limit (unlimited) — so every pre-existing
    // user keeps working exactly as before. Counts are subtree quotas for
    // admins/managers; money/leverage/position caps apply per user.
    hierarchyLimits: {
      maxUsers:                 { type: Number, default: null },
      maxManagers:              { type: Number, default: null },
      maxTradingAccounts:       { type: Number, default: null },
      maxDepositLimit:          { type: Number, default: null }, // USD, per-request ceiling
      maxWithdrawalLimit:       { type: Number, default: null }, // USD, per-request ceiling
      maxLeverage:              { type: Number, default: null },
      maxCreditAllocation:      { type: Number, default: null }, // USD
      maxBonusAllocation:       { type: Number, default: null }, // USD
      maxOpenPositions:         { type: Number, default: null },
      maxExposure:              { type: Number, default: null }, // USD notional
      maxReferralCommission:    { type: Number, default: null }, // %
      maxCopyTradingCommission: { type: Number, default: null }, // %
      updatedAt:                { type: Date, default: null },
      updatedBy:                { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
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

// Indexes to keep hierarchy queries fast at scale (100k+ users). email is
// already unique-indexed; role/createdAt + the adminId/managerId field
// indexes above cover the assignment/workload/list query patterns.
userSchema.index({ role: 1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ adminId: 1, managerId: 1 });

// Assign a permanent public User ID exactly once, on first save. Guarded by
// `isNew && !userUid` so it costs one atomic counter read per new account and
// is a no-op on every subsequent update — the id can never change. Covers all
// creation paths (registration, admin/manager creation, scripts) without
// touching any call site.
userSchema.pre('save', async function (next) {
  if (this.isNew && !this.userUid) {
    try {
      const { nextUserUid } = require('../utils/userUid');
      this.userUid = await nextUserUid();
    } catch (err) {
      return next(err);
    }
  }
  next();
});

userSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.twoFactorSecret;
  delete obj.refreshTokens;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
