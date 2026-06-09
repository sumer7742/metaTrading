const express = require('express');
const c = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/register', c.register);
router.post('/login', c.login);
router.post('/refresh', c.refresh);
router.post('/logout', authenticate, c.logout);
router.get('/me', authenticate, c.me);

// End a read-only "View As User" impersonation session (audit + duration).
// Allow-listed in the read-only guard so the impersonation token may POST it.
router.post('/impersonation/end', authenticate, c.endImpersonation);

router.post('/2fa/setup', authenticate, c.setup2FA);
router.post('/2fa/enable', authenticate, c.enable2FA);
router.post('/2fa/disable', authenticate, c.disable2FA);

// Password reset (no auth required)
router.post('/password-reset/request', c.requestPasswordReset);
router.post('/password-reset/confirm', c.resetPassword);

// Active sessions / devices
router.get('/devices', authenticate, c.listDevices);
router.delete('/devices/:id', authenticate, c.revokeDevice);

// Email verification
router.post('/verify-email', c.verifyEmail);
router.post('/resend-verification', authenticate, c.resendVerifyEmail);

module.exports = router;
