/**
 * MODE 2 — OAuth / partner flow (plug point, deliberately not wired).
 *
 * Dhan's official partner programme issues tokens through a consent redirect
 * instead of a dashboard copy/paste. When we're onboarded as a partner, the
 * ONLY changes needed are:
 *
 *   1. Fill in the three methods below.
 *   2. Register this provider under AUTH_MODE.OAUTH in `dhan/index.js`.
 *
 * Nothing else moves. The frontend already calls
 *   GET  /api/broker/oauth/:broker/authorize
 *   GET  /api/broker/oauth/:broker/callback
 * which resolve the provider through the registry at runtime — so the same UI
 * that renders "paste your token" today renders "Login with Dhan" the moment
 * this class is registered.
 *
 * Until then every method throws UNSUPPORTED_OPERATION, which the routes
 * surface as a clean 501 rather than a half-working flow.
 */

const crypto = require('crypto');
const AuthProvider = require('../../base/AuthProvider');
const { BrokerError, ERROR_CODE } = require('../../base/BrokerError');
const { AUTH_MODE } = require('../../constants');

const BROKER = 'DHAN';

class DhanOAuthAuthProvider extends AuthProvider {
  get mode() { return AUTH_MODE.OAUTH; }

  /**
   * Partner tokens DO carry a refresh path — but we still report it from
   * config rather than assuming it, because the partner contract decides.
   */
  supportsRefresh() {
    return String(process.env.DHAN_OAUTH_REFRESH_ENABLED || 'false').toLowerCase() === 'true';
  }

  credentialFields() { return []; } // nothing to type — it's a redirect flow

  isConfigured() {
    return !!(process.env.DHAN_OAUTH_CLIENT_ID && process.env.DHAN_OAUTH_CLIENT_SECRET);
  }

  /** CSRF state — signed so the callback can verify it without server state. */
  static createState(userId) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${userId}.${Date.now()}.${nonce}`;
    const sig = crypto
      .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'broker-oauth-state')
      .update(payload)
      .digest('hex')
      .slice(0, 32);
    return `${Buffer.from(payload).toString('base64url')}.${sig}`;
  }

  static verifyState(state, userId) {
    try {
      const [b64, sig] = String(state).split('.');
      const payload = Buffer.from(b64, 'base64url').toString('utf8');
      const expected = crypto
        .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'broker-oauth-state')
        .update(payload)
        .digest('hex')
        .slice(0, 32);
      if (sig !== expected) return false;
      const [stateUser, ts] = payload.split('.');
      if (String(stateUser) !== String(userId)) return false;
      return Date.now() - Number(ts) < 10 * 60 * 1000; // 10 minute window
    } catch (_) { return false; }
  }

  async getAuthorizationUrl() {
    throw new BrokerError(
      ERROR_CODE.UNSUPPORTED_OPERATION,
      'Dhan OAuth is not enabled on this platform yet. Connect using an access token from your Dhan dashboard.',
      { broker: BROKER }
    );
  }

  async handleCallback() {
    throw new BrokerError(
      ERROR_CODE.UNSUPPORTED_OPERATION,
      'Dhan OAuth is not enabled on this platform yet.',
      { broker: BROKER }
    );
  }

  async authenticate() {
    throw new BrokerError(
      ERROR_CODE.UNSUPPORTED_OPERATION,
      'Dhan OAuth is not enabled on this platform yet.',
      { broker: BROKER }
    );
  }

  async validate() {
    throw new BrokerError(ERROR_CODE.UNSUPPORTED_OPERATION, 'Dhan OAuth is not enabled on this platform yet.', { broker: BROKER });
  }
}

module.exports = DhanOAuthAuthProvider;
