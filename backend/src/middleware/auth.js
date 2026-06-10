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
    // Manager Access Control master switch — a disabled manager can't use the
    // app at all (login is blocked + existing tokens stop working instantly).
    if (user.role === ROLES.MANAGER && user.managerAccessEnabled === false) {
      throw new AppError('Manager access has been disabled. Contact your administrator.', 403, 'MANAGER_DISABLED');
    }
    req.user = user;
    req.userId = user._id;

    // ── Read-only impersonation ("View As User") ──────────────────────
    // An impersonation token carries isImpersonation + readOnly + the
    // admin who started it. We stamp these onto req so downstream code can
    // see them, and HARD-BLOCK any state-changing request: only safe HTTP
    // methods (GET/HEAD/OPTIONS) are allowed, plus the single endpoint that
    // ends the session. This is the authoritative server-side guard —
    // browser/UI tampering can't bypass it.
    if (payload.isImpersonation) {
      req.user.isImpersonation = true;
      req.user.readOnly = payload.readOnly !== false;
      req.user.impersonatedBy = payload.impersonatedBy || null;
      req.impersonation = {
        readOnly: req.user.readOnly,
        by: payload.impersonatedBy || null,
        sid: payload.sid || null,
        startedAt: payload.iat ? payload.iat * 1000 : null,
      };
      const isSafe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      const isEndSession = /\/impersonation\/end$/.test(req.originalUrl.split('?')[0]);
      if (req.user.readOnly && !isSafe && !isEndSession) {
        throw new AppError(
          'Read-only impersonation session — this action is disabled. Return to your admin account to make changes.',
          403,
          'IMPERSONATION_READONLY'
        );
      }
    }

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

// ─── Hierarchy RBAC (additive — does NOT touch requireAdmin) ──────────
// allowRoles / allowPermission gate the new /api/admin/hierarchy routes.
// SUPER_ADMIN always bypasses. No 2FA enforcement here (managers must
// stay usable); the legacy requireAdmin keeps its strict 2FA gate.
const allowRoles = (...roles) => (req, res, next) => {
  if (!req.user) return next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
  if (req.user.role === ROLES.SUPER_ADMIN) return next();
  if (!roles.includes(req.user.role)) {
    return next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
  }
  next();
};

const allowPermission = (perm) => (req, res, next) => {
  const { hasPermission } = require('../config/hierarchy');
  if (req.user && hasPermission(req.user.role, perm)) return next();
  next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
};

// Manager Access Control — gate a route by a per-manager module permission.
// SUPER_ADMIN / ADMIN bypass; a MANAGER must have the permission toggled ON.
const requireManagerPermission = (key) => (req, res, next) => {
  const role = req.user && req.user.role;
  if (role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN) return next();
  if (role === ROLES.MANAGER) {
    const { effectivePermissions } = require('../config/managerPermissions');
    if (effectivePermissions(req.user.managerPermissions)[key]) return next();
    return next(new AppError('This module is disabled for your account', 403, 'PERMISSION_DENIED'));
  }
  next(new AppError('Insufficient permissions', 403, 'FORBIDDEN'));
};

// Feature flag gate — when ENABLE_HIERARCHY=false, hierarchy routes behave
// as if they don't exist (404), so the rest of the platform is untouched.
const requireHierarchy = (req, res, next) => {
  const { FEATURE_ENABLED } = require('../config/hierarchy');
  if (!FEATURE_ENABLED) return next(new AppError('Not found', 404, 'NOT_FOUND'));
  next();
};

module.exports = { authenticate, requireRole, requireAdmin, allowRoles, allowPermission, requireManagerPermission, requireHierarchy };
