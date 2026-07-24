/**
 * BrokerAdapter — the contract every broker integration implements.
 *
 * This is the Liskov boundary of the whole module: BrokerRouter, BrokerManager,
 * the order service and the controllers are written against THIS class and
 * nothing else. A new broker is added by subclassing it and registering the
 * subclass — no call site changes.
 *
 * Contract rules for implementers:
 *   1. Accept ONLY normalized inputs (constants.js vocabulary).
 *   2. Return ONLY values built by `base/normalize.js`.
 *   3. Throw ONLY BrokerError (use `BrokerError.from(err, this.broker)`).
 *   4. Never log, return or embed credentials.
 *   5. Never perform retries or rate limiting internally — the OrderQueue and
 *      RateLimiter own that, so behaviour is uniform across brokers.
 *
 * Unimplemented methods intentionally throw UNSUPPORTED_OPERATION rather than
 * returning empty data: a silent empty array in a portfolio screen is worse
 * than an explicit "this broker can't do that".
 */

const { BrokerError } = require('./BrokerError');
const { CAPABILITY } = require('../constants');

class BrokerAdapter {
  /**
   * @param {object} ctx
   * @param {string} ctx.broker       broker code, e.g. 'DHAN'
   * @param {string} ctx.userId       platform user id (string)
   * @param {object} ctx.credentials  decrypted credentials — NEVER persisted or logged
   * @param {object} [ctx.connection] safe (token-free) BrokerConnection view
   * @param {object} [ctx.logger]     logger with debug/info/warn/error
   * @param {object} [ctx.config]     broker config block from the registry
   */
  constructor(ctx = {}) {
    if (new.target === BrokerAdapter) {
      throw new Error('BrokerAdapter is abstract — subclass it.');
    }
    this.broker = ctx.broker;
    this.userId = ctx.userId ? String(ctx.userId) : null;
    this.connection = ctx.connection || null;
    this.config = ctx.config || {};
    this.logger = ctx.logger || require('../../utils/logger');
    // Credentials are held on a non-enumerable field so an accidental
    // `JSON.stringify(adapter)` or `{...adapter}` in a log line can't leak them.
    Object.defineProperty(this, 'credentials', {
      value: Object.freeze({ ...(ctx.credentials || {}) }),
      enumerable: false,
      writable: false,
    });
    this._connected = false;
    this._createdAt = Date.now();
  }

  // ─── Capabilities ──────────────────────────────────────────────────
  /**
   * Declare what this adapter actually implements. Subclasses override.
   * @returns {Object<string, boolean>} keyed by constants.CAPABILITY values
   */
  capabilities() {
    return {
      [CAPABILITY.PLACE_ORDER]: false,
      [CAPABILITY.MODIFY_ORDER]: false,
      [CAPABILITY.CANCEL_ORDER]: false,
      [CAPABILITY.POSITIONS]: false,
      [CAPABILITY.HOLDINGS]: false,
      [CAPABILITY.FUNDS]: false,
      [CAPABILITY.ORDERS]: false,
      [CAPABILITY.HISTORY]: false,
      [CAPABILITY.QUOTES]: false,
      [CAPABILITY.MARKET_STATUS]: false,
      [CAPABILITY.ORDER_STREAM]: false,
      [CAPABILITY.TICK_STREAM]: false,
      [CAPABILITY.OAUTH]: false,
    };
  }

  supports(capability) {
    return !!this.capabilities()[capability];
  }

  /** Throw a clean UNSUPPORTED_OPERATION unless the capability is declared. */
  assertSupports(capability) {
    if (!this.supports(capability)) throw BrokerError.unsupported(capability, this.broker);
  }

  get isConnected() {
    return this._connected;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────
  /**
   * Establish/verify the session. Called once by BrokerManager before first
   * use. Must be idempotent and cheap — for token-based brokers this is just
   * a profile/funds probe that proves the token works.
   * @returns {Promise<{connected: boolean, broker: string, profile?: object}>}
   */
  async connect() { throw BrokerError.unsupported('connect', this.broker); }

  /** Tear down sockets/timers. Must never throw. */
  async disconnect() { this._connected = false; }

  // ─── Commands (CQRS write side) ────────────────────────────────────
  /**
   * @param {object} req normalized order request:
   *   { clientOrderId, symbol, exchange, securityId?, side, qty, orderType,
   *     productType, price?, triggerPrice?, validity?, disclosedQty?, amo?, tag? }
   * @returns {Promise<object>} normalize.orderAck(...)
   */
  async placeOrder(req) { throw BrokerError.unsupported('placeOrder', this.broker); }

  /**
   * @param {object} req { orderId, qty?, price?, triggerPrice?, orderType?, validity?, disclosedQty?, legName? }
   * @returns {Promise<object>} normalize.orderAck(...)
   */
  async modifyOrder(req) { throw BrokerError.unsupported('modifyOrder', this.broker); }

  /**
   * @param {object} req { orderId }
   * @returns {Promise<object>} normalize.orderAck(...)
   */
  async cancelOrder(req) { throw BrokerError.unsupported('cancelOrder', this.broker); }

  // ─── Queries (CQRS read side) ──────────────────────────────────────
  /** @returns {Promise<Array<object>>} normalize.position(...)[] */
  async positions() { throw BrokerError.unsupported('positions', this.broker); }

  /** @returns {Promise<Array<object>>} normalize.holding(...)[] */
  async holdings() { throw BrokerError.unsupported('holdings', this.broker); }

  /** @returns {Promise<object>} normalize.funds(...) */
  async funds() { throw BrokerError.unsupported('funds', this.broker); }

  /**
   * Live order book from the broker.
   * @param {object} [filter] { orderId?, clientOrderId? }
   * @returns {Promise<Array<object>>} normalize.order(...)[]
   */
  async orders(filter) { throw BrokerError.unsupported('orders', this.broker); }

  /**
   * Executed-trade history.
   * @param {object} [range] { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD', page?: number }
   * @returns {Promise<Array<object>>} normalize.trade(...)[]
   */
  async history(range) { throw BrokerError.unsupported('history', this.broker); }

  /**
   * @param {Array<{symbol: string, exchange: string, securityId?: string}>} instruments
   * @returns {Promise<Array<object>>} normalize.quote(...)[]
   */
  async quotes(instruments) { throw BrokerError.unsupported('quotes', this.broker); }

  /**
   * @param {string} [exchange] limit to one segment; omit for all
   * @returns {Promise<Array<object>>} normalize.marketStatus(...)[]
   */
  async marketStatus(exchange) { throw BrokerError.unsupported('marketStatus', this.broker); }

  // ─── Streaming (optional) ──────────────────────────────────────────
  /**
   * Subscribe to live order updates. The adapter owns its socket; BrokerManager
   * owns the fan-out to our own websocket clients.
   * @param {(update: object) => void} handler receives normalize.order(...) shapes
   * @returns {Promise<{stop: () => Promise<void>}>}
   */
  async subscribeOrderUpdates(handler) { throw BrokerError.unsupported('orderStream', this.broker); }

  /**
   * Structural leak guard.
   *
   * Adapters compose sub-services that legitimately hold account identifiers
   * (a broker client id, an account number). Any of those becoming enumerable
   * would make an accidental `JSON.stringify(adapter)` — in a log line, an
   * error payload, a debug response — leak them. Serializing an adapter
   * therefore yields the safe health snapshot and nothing else, for every
   * present and future subclass.
   */
  toJSON() { return this.health(); }

  /** Health snapshot for the admin "Connections" dashboard. */
  health() {
    return {
      broker: this.broker,
      connected: this._connected,
      uptimeMs: Date.now() - this._createdAt,
      streams: {},
    };
  }
}

module.exports = BrokerAdapter;
