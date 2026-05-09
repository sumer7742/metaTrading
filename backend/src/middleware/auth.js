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

const requireAdmin = requireRole(ROLES.ADMIN, ROLES.SUPER_ADMIN);

module.exports = { authenticate, requireRole, requireAdmin };
