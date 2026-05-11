const { verifyAccessToken } = require('../utils/jwt');
const { AppError } = require('../utils/errors');
const User = require('../models/User');
const { ROLES } = require('../config/constants');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AppError('Missing access token', 401, 'UNAUTHENTICATED');
    }
    const token = header.split(' ')[1];
    const payload = verifyAccessToken(token);

    const user = await User.findById(payload.sub).lean();
    if (!user || !user.isActive) {
      throw new AppError('User not found or inactive', 401, 'UNAUTHENTICATED');
    }
    req.user = user;
    req.userId = user._id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(new AppError('Token expired', 401, 'TOKEN_EXPIRED'));
    if (err.name === 'JsonWebTokenError') return next(new AppError('Invalid token', 401, 'INVALID_TOKEN'));
    next(err);
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
  }
  next();
};

// requireAdmin is the role gate + a 2FA-enabled check.
//
// Default behavior:
//   - Production (NODE_ENV=production): 2FA REQUIRED unless explicitly disabled
//     via ADMIN_REQUIRE_2FA=false.
//   - Dev / staging: 2FA NOT required unless explicitly enabled via
//     ADMIN_REQUIRE_2FA=true.
//
// This avoids a "fresh dev environment locks me out" footgun while keeping
// the production posture strict-by-default. Production deploys MUST verify
// admin users have 2FA enabled before relying on this gate.
const _adminRole = requireRole(ROLES.ADMIN, ROLES.SUPER_ADMIN);
const requireAdmin = (req, res, next) => {
  _adminRole(req, res, (err) => {
    if (err) return next(err);
    const envFlag = process.env.ADMIN_REQUIRE_2FA;
    const isProd = (process.env.NODE_ENV || 'development') === 'production';
    const require2fa = envFlag != null
      ? envFlag.toLowerCase() === 'true'
      : isProd; // default: on in prod, off in dev
    if (require2fa && req.user && req.user.twoFactorEnabled !== true) {
      return next(new AppError(
        '2FA must be enabled on this admin account. Enable it in Profile → Security before continuing.',
        403,
        'ADMIN_2FA_REQUIRED'
      ));
    }
    next();
  });
};

module.exports = { authenticate, requireRole, requireAdmin };
