/**
 * AuthProvider — replaceable authentication strategy per broker.
 *
 * Deliberately NOT built around OAuth refresh tokens. Indian brokers differ
 * wildly: Dhan issues a long-lived token from its own dashboard, Zerodha needs
 * a daily request-token exchange, Angel One uses TOTP login, and official
 * partner programmes add OAuth on top. Baking "refresh token" into the core
 * would force every adapter to lie about its model.
 *
 * Instead each broker registers one provider per supported AUTH_MODE:
 *
 *   MANUAL — user pastes a token they generated at the broker. `authenticate()`
 *            validates it and reports the expiry the broker tells us.
 *   OAUTH  — `getAuthorizationUrl()` + `handleCallback()` implement the
 *            redirect dance. Adding this later changes NOTHING on the frontend:
 *            the UI calls /api/broker/oauth/:broker/authorize, which 404s with
 *            UNSUPPORTED_OPERATION until a provider is registered.
 *
 * `supportsRefresh()` is how callers ask — never an assumption.
 */

const { BrokerError, ERROR_CODE } = require('./BrokerError');
const { AUTH_MODE } = require('../constants');

class AuthProvider {
  /**
   * @param {object} ctx
   * @param {string} ctx.broker
   * @param {object} [ctx.config] broker config block (endpoints, client ids…)
   */
  constructor(ctx = {}) {
    if (new.target === AuthProvider) throw new Error('AuthProvider is abstract — subclass it.');
    this.broker = ctx.broker;
    this.config = ctx.config || {};
    this.logger = ctx.logger || require('../../utils/logger');
  }

  /** @returns {'MANUAL'|'OAUTH'} */
  get mode() { return AUTH_MODE.MANUAL; }

  /** Does this broker/mode issue refresh tokens we can act on? */
  supportsRefresh() { return false; }

  /**
   * Field descriptors for the "Connect broker" form. The frontend renders
   * whatever the backend declares, so a new broker with different credential
   * fields needs no frontend change.
   * @returns {Array<{key,label,type,required,placeholder?,help?}>}
   */
  credentialFields() { return []; }

  /**
   * Validate + normalize user-supplied credentials into a storable token set.
   *
   * @param {object} input raw credential fields from the user
   * @returns {Promise<{
   *   accessToken: string,
   *   refreshToken?: string|null,
   *   brokerClientId?: string|null,
   *   expiresAt?: Date|null,
   *   scopes?: string[],
   *   profile?: object
   * }>}
   */
  async authenticate(input) { throw BrokerError.unsupported('authenticate', this.broker); }

  /**
   * Prove a stored token still works. Called on connect, on demand from the
   * UI, and by the connection health sweep.
   * @param {object} credentials decrypted credentials
   * @returns {Promise<{valid: boolean, expiresAt?: Date|null, profile?: object, reason?: string}>}
   */
  async validate(credentials) { throw BrokerError.unsupported('validate', this.broker); }

  /**
   * Renew a token. Default implementation refuses loudly instead of silently
   * pretending — callers must check `supportsRefresh()` first.
   */
  async refresh(credentials) {
    throw new BrokerError(
      ERROR_CODE.UNSUPPORTED_OPERATION,
      `${this.broker} does not support automatic token refresh. Generate a new token and reconnect.`,
      { broker: this.broker }
    );
  }

  /** Best-effort revoke at the broker. Must not throw on "already revoked". */
  async revoke(credentials) { return { revoked: false, reason: 'not_supported' }; }

  // ─── OAuth plug points (MODE 2) ────────────────────────────────────
  /**
   * @param {object} ctx { userId, state, redirectUri }
   * @returns {Promise<{url: string, state: string}>}
   */
  async getAuthorizationUrl(ctx) { throw BrokerError.unsupported('oauth', this.broker); }

  /**
   * @param {object} ctx { code, state, redirectUri }
   * @returns {Promise<{accessToken, refreshToken?, expiresAt?, brokerClientId?, profile?}>}
   */
  async handleCallback(ctx) { throw BrokerError.unsupported('oauth', this.broker); }
}

module.exports = AuthProvider;
