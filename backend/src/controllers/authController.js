const login = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const { email, password, twoFactorCode } = req.body;

  console.log('[LOGIN] start', { email });

  if (!email || !password) {
    throw new AppError('Email and password required', 400);
  }

  console.log('[LOGIN] before find user');

  const user = await User.findOne({ email: email.toLowerCase() })
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