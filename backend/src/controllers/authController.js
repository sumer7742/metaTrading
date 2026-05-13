const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { AppError, asyncHandler, sendSuccess } = require('../utils/errors');
const { ACCOUNT_TYPES, TRADING_MODE } = require('../config/constants');

const register = asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, phone, country, referralCode } = req.body;
  if (!email || !password) throw new AppError('Email and password are required', 400);
  if (password.length < 8) throw new AppError('Password must be at least 8 characters', 400);

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) throw new AppError('Email already registered', 409, 'DUPLICATE_EMAIL');

  // AML screening on registration (doc §12.4)
  const aml = require('../services/amlService').screenPerson({ firstName, lastName, country });
  if (!aml.allowed) {
    throw new AppError('Registration cannot be completed. Please contact support.', 403, 'AML_BLOCKED');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const myReferralCode = uuidv4().slice(0, 8).toUpperCase();

  let referredBy = null;
  if (referralCode) {
    const referrer = await User.findOne({ referralCode });
    if (referrer) referredBy = referrer._id;
  }

  // Build all initial fields in a single create — including the email
  // verification token — so we don't issue 2-3 saves back-to-back (each one
  // is a chance for partial state on failure).
  const crypto = require('crypto');
  const verifyToken = crypto.randomBytes(32).toString('hex');

  const user = await User.create({
    email: normalizedEmail,
    passwordHash,
    firstName,
    lastName,
    phone,
    referralCode: myReferralCode,
    referredBy,
    emailVerificationToken: verifyToken,
    emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    lastLoginAt: new Date(),
    lastLoginIp: req.ip,
  });

  // Create a default DEMO trading account with ₹1,00,000 virtual funds
  const demoAccountNumber = 'TA' + Date.now().toString().slice(-9);
  const demoAccount = await TradingAccount.create({
    userId: user._id,
    accountNumber: demoAccountNumber,
    accountType: ACCOUNT_TYPES.DEMO,
    baseCurrency: 'INR',
    leverage: 100,
    mode: TRADING_MODE.HYBRID,
    nickname: 'Practice Account',
  });
  await Wallet.create({ userId: user._id, accountId: demoAccount._id, currency: 'INR', balance: '100000' });

  // Also create an empty REAL (live) trading account.
  // Balance starts at ₹0 - user funds it via deposit. KYC must be approved before live trading.
  const liveAccountNumber = 'TA' + (Date.now() + 1).toString().slice(-9);
  const liveAccount = await TradingAccount.create({
    userId: user._id,
    accountNumber: liveAccountNumber,
    accountType: ACCOUNT_TYPES.REAL,
    baseCurrency: 'INR',
    leverage: 100,
    mode: TRADING_MODE.HYBRID,
    nickname: 'Live Account',
  });
  await Wallet.create({ userId: user._id, accountId: liveAccount._id, currency: 'INR', balance: '0' });

  // Issue real tokens. Push the refresh token via atomic $push so a
  // concurrent login doesn't blow away the array.
  const realAccessToken = signAccessToken({ sub: user._id.toString(), role: user.role });
  const realRefreshToken = signRefreshToken({ sub: user._id.toString() });
  await User.updateOne(
    { _id: user._id },
    { $push: { refreshTokens: { token: realRefreshToken, deviceInfo: req.headers['user-agent'] } } }
  );

  // Send welcome + verification emails (non-blocking).
  
 sendSuccess(res, { user: user.toSafeJSON(), accessToken: realAccessToken, refreshToken: realRefreshToken }, 201);

setImmediate(async () => {
  try {
    const email = require('../services/emailService');

    await email.sendWelcome({ to: user.email, firstName: user.firstName });
    await email.sendVerifyEmail({
      to: user.email,
      token: verifyToken,
      baseUrl: process.env.CLIENT_URL || 'http://localhost:5173',
    });

    if (aml.riskLevel === 'MEDIUM') {
      console.log(`[AML] Medium-risk registration ${user.email}: ${JSON.stringify(aml.hits)}`);
    }
  } catch (e) {
    console.warn('[REGISTER] Email send failed:', e.message);
  }
});
});


const login = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const { email, password, twoFactorCode } = req.body;

  console.log('[LOGIN] start', { email });

  if (!email || !password) {
    throw new AppError('Email and password required', 400);
  }

  console.log('[LOGIN] before find user');

  const user = await User.findOne({ email: email.toLowerCase().trim() })
    .select('+passwordHash email role isActive twoFactorEnabled twoFactorSecret twoFactorBackupCodes refreshTokens')
    .maxTimeMS(10000);

  console.log('[LOGIN] after find user', {
    found: !!user,
    ms: Date.now() - startedAt,
  });

  if (!user || !user.isActive) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  console.log('[LOGIN] before bcrypt compare');

  const ok = await bcrypt.compare(password, user.passwordHash);

  console.log('[LOGIN] after bcrypt compare', {
    ok,
    ms: Date.now() - startedAt,
  });

  if (!ok) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  if (user.twoFactorEnabled) {
    if (!twoFactorCode) {
      throw new AppError('2FA code required', 401, '2FA_REQUIRED');
    }

    let valid = authenticator.verify({
      token: twoFactorCode,
      secret: user.twoFactorSecret,
    });

    if (!valid) {
      const crypto = require('crypto');
      const inputHash = crypto
        .createHash('sha256')
        .update(twoFactorCode.toUpperCase().replace(/-/g, ''))
        .digest('hex');

      const backup = (user.twoFactorBackupCodes || []).find(
        (c) => c.codeHash === inputHash && !c.usedAt
      );

      if (backup) {
        backup.usedAt = new Date();
        valid = true;
      }
    }

    if (!valid) {
      throw new AppError('Invalid 2FA code', 401, '2FA_INVALID');
    }
  }

  console.log('[LOGIN] before token sign');

  const accessToken = signAccessToken({
    sub: user._id.toString(),
    role: user.role,
  });

  const refreshToken = signRefreshToken({
    sub: user._id.toString(),
  });

  const incomingUA = req.headers['user-agent'] || 'Unknown device';
  const isNewDevice = !(user.refreshTokens || []).some(
    (t) => t.deviceInfo === incomingUA
  );

  console.log('[LOGIN] before refresh token update');

  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshTokens: {
          $each: [{ token: refreshToken, deviceInfo: incomingUA }],
          $slice: -5,
        },
      },
      $set: {
        lastLoginAt: new Date(),
        lastLoginIp: req.ip,
      },
    }
  ).maxTimeMS(10000);

  console.log('[LOGIN] after refresh token update', {
    ms: Date.now() - startedAt,
  });

  sendSuccess(res, {
    user: user.toSafeJSON(),
    accessToken,
    refreshToken,
  });

  console.log('[LOGIN] response sent', {
    ms: Date.now() - startedAt,
  });

  if (isNewDevice) {
    setImmediate(async () => {
      try {
        const emailSvc = require('../services/emailService');
        await emailSvc.sendLoginAlert({
          to: user.email,
          ip: req.ip,
          userAgent: incomingUA,
        });
      } catch (e) {
        console.warn('[LOGIN] Email alert failed:', e.message);
      }
    });
  }
});




const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new AppError('Refresh token required', 400);
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError('Invalid refresh token', 401);
  }
  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw new AppError('User not found', 401);
  const tokenExists = user.refreshTokens.some((t) => t.token === refreshToken);
  if (!tokenExists) throw new AppError('Refresh token revoked', 401);

  // Rotate
  user.refreshTokens = user.refreshTokens.filter((t) => t.token !== refreshToken);
  const newAccess = signAccessToken({ sub: user._id.toString(), role: user.role });
  const newRefresh = signRefreshToken({ sub: user._id.toString() });
  user.refreshTokens.push({ token: newRefresh, deviceInfo: req.headers['user-agent'] });
  await user.save();

  sendSuccess(res, { accessToken: newAccess, refreshToken: newRefresh });
});

const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken && req.user) {
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { refreshTokens: { token: refreshToken } },
    });
  }
  sendSuccess(res, { ok: true });
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  // Defend against the user being deleted between the auth-middleware check
  // and this query — without this, .toSafeJSON() throws on null.
  if (!user) throw new AppError('User not found', 404);
  sendSuccess(res, user.toSafeJSON());
});

const setup2FA = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  const secret = authenticator.generateSecret();
  user.twoFactorSecret = secret;
  await user.save();
  const otpauth = authenticator.keyuri(user.email, 'TradingPlatform', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  sendSuccess(res, { secret, qrDataUrl });
});

const enable2FA = asyncHandler(async (req, res) => {
  const { code } = req.body;
  const user = await User.findById(req.userId);
  if (!user.twoFactorSecret) throw new AppError('2FA not initialized; call setup first', 400);
  const valid = authenticator.verify({ token: code, secret: user.twoFactorSecret });
  if (!valid) throw new AppError('Invalid 2FA code', 400);
  user.twoFactorEnabled = true;

  // Generate 8 single-use backup codes (xxxx-xxxx format).
  const crypto = require('crypto');
  const plainCodes = [];
  const hashedCodes = [];
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plainCodes.push(formatted);
    hashedCodes.push({
      codeHash: crypto.createHash('sha256').update(raw).digest('hex'),
      usedAt: null,
    });
  }
  user.twoFactorBackupCodes = hashedCodes;
  await user.save();

  // Email the codes (one-time)
  try {
    const emailSvc = require('../services/emailService');
    await emailSvc.sendBackupCodes({ to: user.email, codes: plainCodes });
  } catch (e) { /* non-fatal */ }

  // Return codes to user once - they will not be retrievable again
  sendSuccess(res, { enabled: true, backupCodes: plainCodes });
});

const disable2FA = asyncHandler(async (req, res) => {
  const { code } = req.body;
  const user = await User.findById(req.userId);
  if (!user.twoFactorEnabled) return sendSuccess(res, { enabled: false });
  const valid = authenticator.verify({ token: code, secret: user.twoFactorSecret });
  if (!valid) throw new AppError('Invalid 2FA code', 400);
  user.twoFactorEnabled = false;
  user.twoFactorSecret = null;
  await user.save();
  sendSuccess(res, { enabled: false });
});

/**
 * Request a password reset. Returns success regardless of whether email exists
 * (privacy: don't leak which emails are registered). In production this would
 * email a one-time signed token.
 */
const requestPasswordReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new AppError('Email required', 400);
  const user = await User.findOne({ email: email.toLowerCase() });
  if (user) {
    const jwt = require('jsonwebtoken');
    const resetToken = jwt.sign({ sub: user._id.toString(), purpose: 'PWD_RESET' }, process.env.JWT_ACCESS_SECRET, {
      expiresIn: '30m',
    });
    try {
      const emailSvc = require('../services/emailService');
      await emailSvc.sendPasswordReset({
        to: user.email,
        resetToken,
        baseUrl: process.env.CLIENT_URL || 'http://localhost:5173',
      });
    } catch (e) { /* non-fatal */ }
  }
  sendSuccess(res, { ok: true, message: 'If the email exists, a reset link has been sent.' });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) throw new AppError('Token and new password required', 400);
  if (newPassword.length < 8) throw new AppError('Password must be at least 8 characters', 400);

  const jwt = require('jsonwebtoken');
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
  } catch {
    throw new AppError('Invalid or expired reset token', 401);
  }
  if (payload.purpose !== 'PWD_RESET') throw new AppError('Wrong token purpose', 401);

  const user = await User.findById(payload.sub);
  if (!user) throw new AppError('User not found', 404);

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.refreshTokens = []; // invalidate all sessions on password change
  await user.save();
  sendSuccess(res, { ok: true });
});

/**
 * List the user's currently active sessions (refresh tokens) for self-service revoke.
 *
 * Returns each session's stable Mongo subdoc `_id` so revokeDevice can target
 * the right token even if the array reorders (e.g. someone else logged in
 * between list and revoke). Pre-fix used the array index, which is fragile.
 */
const listDevices = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select('refreshTokens');
  if (!user) throw new AppError('User not found', 404);
  const devices = (user.refreshTokens || []).map((t) => ({
    id: t._id ? t._id.toString() : null,
    deviceInfo: t.deviceInfo || 'Unknown device',
    createdAt: t.createdAt,
  }));
  sendSuccess(res, devices);
});

const revokeDevice = asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!id) throw new AppError('Device id required', 400);
  // Pull by stable subdoc _id (atomic). Falls back to numeric-index lookup
  // for legacy clients that still send an integer.
  const mongoose = require('mongoose');
  if (mongoose.Types.ObjectId.isValid(id)) {
    const result = await User.updateOne(
      { _id: req.userId },
      { $pull: { refreshTokens: { _id: new mongoose.Types.ObjectId(id) } } }
    );
    if (!result.modifiedCount) throw new AppError('Device not found', 404);
    return sendSuccess(res, { ok: true });
  }
  // Legacy index path — kept narrow so it can be removed once clients update.
  const idx = Number(id);
  if (!Number.isInteger(idx) || idx < 0) throw new AppError('Invalid device id', 400);
  const user = await User.findById(req.userId);
  if (!user || !user.refreshTokens[idx]) throw new AppError('Device not found', 404);
  user.refreshTokens.splice(idx, 1);
  await user.save();
  sendSuccess(res, { ok: true });
});

const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) throw new AppError('Token required', 400);
  const user = await User.findOne({ emailVerificationToken: token });
  if (!user) throw new AppError('Invalid or expired token', 400);
  if (user.emailVerificationExpiresAt && user.emailVerificationExpiresAt < new Date()) {
    throw new AppError('Token expired - request a new verification email', 400);
  }
  user.isEmailVerified = true;
  user.emailVerificationToken = null;
  user.emailVerificationExpiresAt = null;
  await user.save();
  sendSuccess(res, { verified: true });
});

const resendVerifyEmail = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  if (user.isEmailVerified) return sendSuccess(res, { ok: true, alreadyVerified: true });
  const crypto = require('crypto');
  user.emailVerificationToken = crypto.randomBytes(32).toString('hex');
  user.emailVerificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await user.save();
  try {
    const emailSvc = require('../services/emailService');
    await emailSvc.sendVerifyEmail({
      to: user.email,
      token: user.emailVerificationToken,
      baseUrl: process.env.CLIENT_URL || 'http://localhost:5173',
    });
  } catch (e) { /* non-fatal */ }
  sendSuccess(res, { ok: true });
});

module.exports = { register, login, refresh, logout, me, setup2FA, enable2FA, disable2FA, requestPasswordReset, resetPassword, listDevices, revokeDevice, verifyEmail, resendVerifyEmail };
