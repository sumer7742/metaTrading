const mongoose = require('mongoose');

/**
 * Whitelisted withdrawal addresses (per doc §12.3).
 * Withdrawals can only go to addresses on this list. New entries require email confirm
 * and a 24h cooldown before they can be used.
 */
const whitelistedAddressSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true }, // user-friendly name e.g. "My Coinbase BTC"
    method: { type: String, enum: ['CRYPTO', 'BANK'], required: true },
    currency: { type: String, required: true }, // BTC, USDT, USD, etc
    address: { type: String, required: true },
    network: String, // for crypto: BTC, ETH, TRC20, ERC20
    bankDetails: {
      accountName: String,
      accountNumber: String,
      bankName: String,
      swift: String,
      iban: String,
    },
    isActive: { type: Boolean, default: true },
    confirmedAt: Date, // null until user confirms via email link
    activeFrom: Date, // 24h after confirmation - withdrawals only allowed after this
  },
  { timestamps: true }
);

whitelistedAddressSchema.index({ userId: 1, currency: 1 });

/**
 * Affiliate / referral commission ledger (per doc §7.15).
 * Each trade generates commissions for the referrer (L1), and optionally L2/L3.
 * Commission rates are configured per-affiliate; default 20% L1, 5% L2, 1% L3.
 */
const commissionSchema = new mongoose.Schema(
  {
    referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Required for trade-derived commissions; optional for admin
    // adjustments (sourceType: 'ADJUSTMENT') where there's no specific
    // referee transaction behind the credit.
    refereeId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // Level is only meaningful for the L1/L2/L3 trade-fee chain.
    // Admin adjustments use level=0 (effectively n/a).
    level: { type: Number, enum: [0, 1, 2, 3], required: true, default: 0 },
    sourceType: {
      type: String,
      enum: ['TRADE_FEE', 'SPREAD', 'DEPOSIT_BONUS', 'ADJUSTMENT'],
      default: 'SPREAD',
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId }, // Trade._id typically; null for ADJUSTMENT
    currency: { type: String, default: 'USD' },
    amount: { type: String, required: true }, // commission amount (positive)
    rate: { type: String }, // % rate applied (informational)
    status: { type: String, enum: ['PENDING', 'PAID', 'REVERSED'], default: 'PENDING', index: true },
    paidAt: Date,
    // For ADJUSTMENT rows — who credited it (admin user _id).
    adjustedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: String,
  },
  { timestamps: true }
);

// Hard, DB-level guarantee that a first-deposit referral bonus is paid at most
// ONCE per referred user — the partial unique index only applies to
// DEPOSIT_BONUS rows (revenue-share TRADE_FEE/SPREAD rows, which legitimately
// repeat per referee, are unaffected). This is the lock the partner service
// relies on to prevent duplicate payouts under concurrent deposit confirms.
commissionSchema.index(
  { refereeId: 1, sourceType: 1 },
  { unique: true, partialFilterExpression: { sourceType: 'DEPOSIT_BONUS' } },
);

/**
 * Uploaded KYC documents stored on local disk (or S3 in production).
 * Keeps the actual file paths separate from User.kycDocuments URLs so we can
 * version, encrypt, and audit independently.
 */
const kycDocumentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    docType: { type: String, enum: ['ID_FRONT', 'ID_BACK', 'SELFIE', 'ADDRESS_PROOF', 'OTHER'], required: true },
    originalFilename: String,
    storagePath: String, // local path or S3 key
    mimeType: String,
    sizeBytes: Number,
    sha256: String, // integrity check
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    rejectionReason: String,
  },
  { timestamps: true }
);

module.exports = {
  WhitelistedAddress: mongoose.model('WhitelistedAddress', whitelistedAddressSchema),
  Commission: mongoose.model('Commission', commissionSchema),
  KycDocument: mongoose.model('KycDocument', kycDocumentSchema),
};
