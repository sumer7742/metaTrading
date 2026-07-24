/**
 * MODE 1 — manual access token.
 *
 * The user generates a token in the DhanHQ dashboard (Profile → DhanHQ Trading
 * APIs → Generate Access Token) and pastes it here together with their Dhan
 * client id. There is NO refresh token in this model, and pretending otherwise
 * would produce a silently-broken renewal path — `supportsRefresh()` returns
 * false and the UI prompts a reconnect before expiry instead.
 *
 * We validate the token against Dhan BEFORE storing it, so a bad paste fails
 * immediately at connect time rather than on the user's first order.
 */

const AuthProvider = require('../../base/AuthProvider');
const DhanHttpClient = require('../DhanHttpClient');
const config = require('../config');
const { BrokerError, ERROR_CODE } = require('../../base/BrokerError');
const { AUTH_MODE } = require('../../constants');

const BROKER = 'DHAN';

class DhanManualTokenAuthProvider extends AuthProvider {
  get mode() { return AUTH_MODE.MANUAL; }

  supportsRefresh() { return false; }

  /** Rendered by the frontend's generic "Connect broker" form. */
  credentialFields() {
    return [
      {
        key: 'clientId',
        label: 'Dhan Client ID',
        type: 'text',
        required: true,
        placeholder: '1100XXXXXX',
        help: 'Find it in the Dhan app under Profile → My Profile.',
      },
      {
        key: 'accessToken',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: 'Paste the token generated in DhanHQ',
        help: 'Dhan web → Profile → DhanHQ Trading APIs → Generate Access Token. Valid up to 30 days.',
      },
    ];
  }

  /**
   * @param {{clientId: string, accessToken: string}} input
   * @returns {Promise<{accessToken, refreshToken, brokerClientId, expiresAt, profile}>}
   */
  async authenticate(input = {}) {
    const accessToken = String(input.accessToken || '').trim();
    const clientId = String(input.clientId || input.brokerClientId || '').trim();

    if (!accessToken) throw BrokerError.validation('Access token is required.', null, BROKER);
    if (!clientId) throw BrokerError.validation('Dhan Client ID is required.', null, BROKER);
    // Cheap shape check before we spend a network round trip. Dhan issues a
    // JWT; anything obviously not a token is almost always a copy/paste slip.
    if (accessToken.length < 40) {
      throw new BrokerError(ERROR_CODE.INVALID_TOKEN, 'That does not look like a Dhan access token — copy the full value.', { broker: BROKER });
    }

    const probe = await this._probe({ accessToken, brokerClientId: clientId });

    return {
      accessToken,
      refreshToken: null,          // MODE 1 has none — never fake one
      brokerClientId: clientId,
      expiresAt: probe.expiresAt,
      scopes: [],
      profile: probe.profile,
    };
  }

  /** Re-check a stored token (on demand + by the health sweep). */
  async validate(credentials = {}) {
    try {
      const probe = await this._probe(credentials);
      return { valid: true, expiresAt: probe.expiresAt, profile: probe.profile };
    } catch (err) {
      const e = BrokerError.from(err, BROKER);
      if ([ERROR_CODE.INVALID_TOKEN, ERROR_CODE.TOKEN_EXPIRED, ERROR_CODE.BROKER_UNAUTHORIZED].includes(e.code)) {
        return { valid: false, reason: e.message };
      }
      // Broker down / network blip — NOT a credential problem. Bubble it up so
      // the connection isn't wrongly marked invalid over a transient failure.
      throw e;
    }
  }

  /**
   * Dhan has no token-revocation API: tokens are managed from the user's own
   * dashboard. We report that honestly instead of pretending to revoke.
   */
  async revoke() {
    return { revoked: false, reason: 'Dhan tokens are revoked from the DhanHQ dashboard.' };
  }

  /**
   * Probe the token. /profile is the cheapest authenticated endpoint and, on
   * Dhan, it also returns `tokenValidity` — the real expiry, which beats
   * guessing "30 days from today".
   */
  async _probe(credentials) {
    const client = new DhanHttpClient({ credentials, logger: this.logger });
    let profile = null;
    try {
      profile = await client.request(config.ENDPOINTS.PROFILE, { category: 'nonTrading', operation: 'validateToken' });
    } catch (err) {
      const e = BrokerError.from(err, BROKER);
      // Older API keys may not have /profile enabled; fall back to funds,
      // which every trading-enabled token can reach.
      if (e.code === ERROR_CODE.ORDER_NOT_FOUND || e.code === ERROR_CODE.VALIDATION_ERROR) {
        await client.request(config.ENDPOINTS.FUNDS, { category: 'nonTrading', operation: 'validateToken:funds' });
        return { profile: null, expiresAt: null };
      }
      throw e;
    }

    return {
      profile: profile
        ? {
          name: profile.dhanClientName || profile.clientName || null,
          clientId: profile.dhanClientId || null,
          ucc: profile.dhanClientUcc || null,
          activeSegments: profile.activeSegment || profile.activeSegments || null,
        }
        : null,
      expiresAt: _parseValidity(profile && (profile.tokenValidity || profile.token_validity)),
    };
  }
}

/**
 * Dhan returns token validity as 'DD/MM/YYYY HH:mm' (IST). Parse defensively:
 * an unparseable value yields null ("unknown expiry"), which is safer than a
 * wrong date that would expire the connection early.
 */
function _parseValidity(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (m) {
    const [, dd, mm, yyyy, hh = '23', mi = '59'] = m;
    // IST is UTC+5:30 — build the instant explicitly so the server's own
    // timezone can't shift it.
    const utcMs = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi) - (5.5 * 60 * 60 * 1000);
    const d = new Date(utcMs);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = DhanManualTokenAuthProvider;
module.exports._parseValidity = _parseValidity;
