const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers/authController');
const otpc = require('../controllers/passwordResetOtpController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Dedicated limiter for the OTP password-reset endpoints (tighter than the
// global /api/auth limiter). Per-IP; the controller adds per-USER caps on top
// (3 OTPs/hour, 5 verify attempts/code) and email-enumeration protection.
const pwdResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PWD_RESET_RATE_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
  }),
});

router.post('/register', c.register);
router.post('/login', c.login);
router.post('/refresh', c.refresh);
router.post('/logout', authenticate, c.logout);
router.get('/me', authenticate, c.me);

// End a read-only "View As User" impersonation session (audit + duration).
// Allow-listed in the read-only guard so the impersonation token may POST it.
router.post('/impersonation/end', authenticate, c.endImpersonation);

// Authenticated password change (Profile → Security).
router.post('/change-password', authenticate, c.changePassword);

router.post('/2fa/setup', authenticate, c.setup2FA);
router.post('/2fa/enable', authenticate, c.enable2FA);
router.post('/2fa/disable', authenticate, c.disable2FA);

// Password reset — legacy signed-link flow (kept for backward compat).
router.post('/password-reset/request', c.requestPasswordReset);
router.post('/password-reset/confirm', c.resetPassword);

// Password reset — Email-OTP flow (primary). No auth required.
router.post('/forgot-password', pwdResetLimiter, otpc.forgotPassword);
router.post('/verify-reset-otp', pwdResetLimiter, otpc.verifyResetOtp);
router.post('/reset-password', pwdResetLimiter, otpc.resetPasswordWithOtp);

// Active sessions / devices
router.get('/devices', authenticate, c.listDevices);
router.delete('/devices/:id', authenticate, c.revokeDevice);

// Email verification
router.post('/verify-email', c.verifyEmail);
router.post('/resend-verification', authenticate, c.resendVerifyEmail);

module.exports = router;
