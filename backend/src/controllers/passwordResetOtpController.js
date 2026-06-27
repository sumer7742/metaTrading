const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PasswordResetOtp = require('../models/PasswordResetOtp');
const { AppError, asyncHandler, sendSuccess } = require('../utils/errors');
const { validatePasswordStrength } = require('../utils/passwordPolicy');

/**
 * Forgot-Password via Email OTP (production-grade).
 *
 *   POST /auth/forgot-password   → generate + email a 6-digit OTP
 *   POST /auth/verify-reset-otp  → verify the OTP, return a short-lived ticket
 *   POST /auth/reset-password    → change the password using that ticket
 *
 * Email-OTP is the primary channel; the PasswordResetOtp.channel field and the
 * ticket design leave room for SMS / WhatsApp / 2FA without reshaping the flow.
 */

const OTP_TTL_MIN = Number(process.env.PWD_OTP_TTL_MIN) || 10;       // validity window
const MAX_VERIFY_ATTEMPTS = Number(process.env.PWD_OTP_MAX_ATTEMPTS) || 5;
const RESEND_COOLDOWN_SEC = Number(process.env.PWD_OTP_RESEND_SEC) || 60;
const MAX_GEN_PER_HOUR = Number(process.env.PWD_OTP_MAX_PER_HOUR) || 3;
const TICKET_PURPOSE = 'PWD_RESET_OTP';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Identical body whether or not the account exists — defeats enumeration.
const GENERIC = { message: 'If an account exists for this email, an OTP has been sent.' };

const _audit = (action, user, req, metadata) => {
  try {
    const { AuditLog } = require('../models');
    return AuditLog.create({
      actorId: user._id,
      actorRole: user.role,
      action,
      targetType: 'USER',
      targetId: String(user._id),
      metadata: metadata || undefined,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  } catch (_) { return null; } // audit is best-effort
};

// ── Step 1: request an OTP ────────────────────────────────────────────────
const forgotPassword = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email || !EMAIL_RE.test(email)) throw new AppError('Enter a valid email address', 400, 'INVALID_EMAIL');

  const user = await User.findOne({ email });
  // Enumeration-safe: every branch below returns the SAME generic response.
  if (!user || user.isActive === false) return sendSuccess(res, GENERIC);

  const now = Date.now();

  // Hard cap — max generations per hour per user.
  const genCount = await PasswordResetOtp.countDocuments({
    userId: user._id, createdAt: { $gte: new Date(now - 60 * 60 * 1000) },
  });
  if (genCount >= MAX_GEN_PER_HOUR) return sendSuccess(res, GENERIC); // silently throttle

  // Soft resend cooldown (the client also shows a 60s countdown).
  const last = await PasswordResetOtp.findOne({ userId: user._id }).sort({ createdAt: -1 }).lean();
  if (last && now - new Date(last.createdAt).getTime() < RESEND_COOLDOWN_SEC * 1000) {
    return sendSuccess(res, GENERIC);
  }

  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); // cryptographically secure
  const otpHash = await bcrypt.hash(otp, 10);

  // Single active OTP per user: invalidate all prior, then store the new one.
  await PasswordResetOtp.updateMany({ userId: user._id, active: true }, { $set: { active: false } });
  await PasswordResetOtp.create({
    userId: user._id,
    email,
    otpHash,
    expiresAt: new Date(now + OTP_TTL_MIN * 60 * 1000),
    purgeAt: new Date(now + 2 * 60 * 60 * 1000),
    active: true,
    ip: req.ip,
    channel: 'EMAIL',
  });

  // Respond first; send the mail + write the audit row off the hot path (also
  // keeps response timing uniform regardless of provider latency).
  sendSuccess(res, GENERIC);
  setImmediate(async () => {
    try { await require('../services/emailService').sendPasswordResetOtp({ to: email, otp }); }
    catch (e) { console.warn('[pwd-reset] OTP email failed:', e.message); }
    _audit('PASSWORD_RESET_OTP_REQUESTED', user, req);
  });
});

// ── Step 2: verify the OTP ────────────────────────────────────────────────
const verifyResetOtp = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const otp = String(req.body.otp || '').trim();
  if (!email || !otp) throw new AppError('Email and code are required', 400);
  const invalid = () => new AppError('Invalid or expired code', 400, 'INVALID_OTP');

  const user = await User.findOne({ email });
  if (!user) throw invalid(); // same message as a wrong code — no enumeration

  const rec = await PasswordResetOtp.findOne({ userId: user._id, active: true, consumedAt: null })
    .sort({ createdAt: -1 });
  if (!rec) throw invalid();
  if (rec.expiresAt.getTime() < Date.now()) throw new AppError('Code expired. Request a new one.', 400, 'OTP_EXPIRED');
  if (rec.attempts >= MAX_VERIFY_ATTEMPTS) throw new AppError('Too many incorrect attempts. Request a new code.', 429, 'OTP_LOCKED');

  const ok = await bcrypt.compare(otp, rec.otpHash);
  if (!ok) {
    rec.attempts += 1;
    await rec.save();
    const left = Math.max(0, MAX_VERIFY_ATTEMPTS - rec.attempts);
    throw new AppError(
      left > 0 ? `Invalid code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.',
      left > 0 ? 400 : 429,
      left > 0 ? 'INVALID_OTP' : 'OTP_LOCKED',
    );
  }

  rec.verifiedAt = new Date();
  await rec.save();

  // Short-lived ticket binds step 3 to THIS verified code (no need to re-send
  // the OTP, and the code can't be replayed after the password changes).
  const resetToken = jwt.sign(
    { sub: user._id.toString(), otpId: rec._id.toString(), purpose: TICKET_PURPOSE },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: '10m' },
  );
  _audit('PASSWORD_RESET_OTP_VERIFIED', user, req);
  sendSuccess(res, { verified: true, resetToken });
});

// ── Step 3: set the new password ──────────────────────────────────────────
const resetPasswordWithOtp = asyncHandler(async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword) throw new AppError('Reset token and new password are required', 400);

  const strengthErr = validatePasswordStrength(newPassword);
  if (strengthErr) throw new AppError(strengthErr, 400, 'WEAK_PASSWORD');

  let payload;
  try { payload = jwt.verify(resetToken, process.env.JWT_ACCESS_SECRET); }
  catch { throw new AppError('Your reset session has expired. Please start again.', 401, 'RESET_TOKEN_INVALID'); }
  if (payload.purpose !== TICKET_PURPOSE) throw new AppError('Invalid reset token', 401, 'RESET_TOKEN_INVALID');

  const rec = await PasswordResetOtp.findById(payload.otpId);
  if (!rec || rec.consumedAt || !rec.verifiedAt || !rec.active || String(rec.userId) !== payload.sub) {
    throw new AppError('Your reset session is invalid. Please start again.', 400, 'RESET_NOT_VERIFIED');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new AppError('User not found', 404);

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.refreshTokens = []; // invalidate ALL active sessions → force a fresh login everywhere
  await user.save();

  // Burn this code + any other lingering active ones (single-use guarantee).
  rec.consumedAt = new Date();
  rec.active = false;
  await rec.save();
  await PasswordResetOtp.updateMany(
    { userId: user._id, active: true },
    { $set: { active: false, consumedAt: new Date() } },
  );

  sendSuccess(res, { ok: true, message: 'Password updated. Please log in with your new password.' });
  setImmediate(async () => {
    _audit('PASSWORD_RESET_COMPLETED', user, req);
    try {
      await require('../services/emailService').send({
        to: user.email,
        subject: 'Your password was changed',
        html: '<p>Your TradePro password was just changed. If this wasn\'t you, reset it again immediately and contact support.</p>',
        text: 'Your TradePro password was just changed. If this wasn\'t you, reset it again immediately and contact support.',
      });
    } catch (_) { /* non-fatal */ }
  });
});

module.exports = { forgotPassword, verifyResetOtp, resetPasswordWithOtp };
