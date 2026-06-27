const mongoose = require('mongoose');

/**
 * PasswordResetOtp — one-time email OTPs for the Forgot-Password flow.
 *
 * Security model:
 *   • otpHash is a bcrypt hash — the plaintext code never touches the DB.
 *   • expiresAt enforces the 10-minute validity window (logical check on use).
 *   • attempts caps brute force (max 5 verifications per code).
 *   • active=false invalidates a code the moment a newer one is generated, so
 *     only the latest OTP per user is ever valid.
 *   • verifiedAt records a successful step-2 verification; consumedAt marks the
 *     code single-use once the password is actually changed.
 *   • purgeAt drives a TTL index so spent rows auto-clean (kept 2h so the
 *     per-hour generation-rate count stays accurate).
 *
 * Future-ready: `channel` lets the same table back SMS / WhatsApp / 2FA OTPs.
 */
const passwordResetOtpSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null }, // single-use: set when password is reset
    active: { type: Boolean, default: true, index: true }, // false once superseded/consumed
    channel: { type: String, enum: ['EMAIL', 'SMS', 'WHATSAPP'], default: 'EMAIL' },
    ip: { type: String, default: '' },
    purgeAt: { type: Date }, // TTL cleanup anchor (createdAt + 2h)
  },
  { timestamps: true }, // createdAt / updatedAt
);

// Per-user newest-first lookups + hourly generation count.
passwordResetOtpSchema.index({ userId: 1, createdAt: -1 });
// Auto-remove spent rows ~2h after creation (TTL fires when purgeAt < now).
passwordResetOtpSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordResetOtp', passwordResetOtpSchema);
