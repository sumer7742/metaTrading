/**
 * DhanAdapter — implements BrokerAdapter for DhanHQ v2.
 *
 * A composition root, nothing more: it wires the HTTP client into the
 * per-domain services and forwards the interface calls. All the real logic
 * lives in `orders/`, `positions/`, `holdings/`, `funds/`, `history/`,
 * `websocket/` and `marketdata/`, which keeps each file small enough to reason
 * about and lets a second broker copy the structure rather than the code.
 *
 * What this class must NEVER do (all of it belongs one layer up):
 *   - retry, rate-limit, or queue          → OrderQueue / RateLimiter
 *   - read or write the database           → services/broker/*
 *   - talk to our own WebSocket clients    → BrokerManager
 *   - decrypt or persist credentials       → brokerConnection.service
 */

const BrokerAdapter = require('../base/BrokerAdapter');
const DhanHttpClient = require('./DhanHttpClient');
const DhanOrderService = require('./orders/DhanOrderService');
const DhanPositionService = require('./positions/DhanPositionService');
const DhanHoldingService = require('./holdings/DhanHoldingService');
const DhanFundsService = require('./funds/DhanFundsService');
const DhanHistoryService = require('./history/DhanHistoryService');
const DhanMarketDataProvider = require('./marketdata/DhanMarketDataProvider');
const DhanOrderSocket = require('./websocket/DhanOrderSocket');
const config = require('./config');
const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const { CAPABILITY } = require('../constants');

const BROKER = 'DHAN';

class DhanAdapter extends BrokerAdapter {
  constructor(ctx = {}) {
    super({ ...ctx, broker: BROKER });

    this.http = new DhanHttpClient({
      credentials: this.credentials,
      userId: this.userId,
      requestId: ctx.requestId,
      logger: this.logger,
    });

    const http = this.http;
    this.orderService = new DhanOrderService({ http, clientId: this.credentials.brokerClientId });
    this.positionService = new DhanPositionService({ http });
    this.holdingService = new DhanHoldingService({ http });
    this.fundsService = new DhanFundsService({ http });
    this.historyService = new DhanHistoryService({ http });
    this.marketData = new DhanMarketDataProvider({ http, history: this.historyService });

    this._socket = null;
  }

  capabilities() {
    return {
      [CAPABILITY.PLACE_ORDER]: true,
      [CAPABILITY.MODIFY_ORDER]: true,
      [CAPABILITY.CANCEL_ORDER]: true,
      [CAPABILITY.POSITIONS]: true,
      [CAPABILITY.HOLDINGS]: true,
      [CAPABILITY.FUNDS]: true,
      [CAPABILITY.ORDERS]: true,
      [CAPABILITY.HISTORY]: true,
      [CAPABILITY.QUOTES]: true,
      [CAPABILITY.MARKET_STATUS]: true,
      [CAPABILITY.ORDER_STREAM]: true,
      // Dhan's market-data websocket (20 instruments/message, binary protocol)
      // is a separate integration; REST quotes cover the terminal today.
      [CAPABILITY.TICK_STREAM]: false,
      [CAPABILITY.OAUTH]: false,
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────
  /**
   * Cheap liveness probe. Funds is the smallest authenticated payload that
   * proves BOTH that the token works and that the account is trade-enabled.
   */
  async connect() {
    if (!this.credentials.brokerClientId) {
      throw new BrokerError(ERROR_CODE.NOT_CONNECTED, 'Dhan client id missing — reconnect your Dhan account.', { broker: BROKER });
    }
    await this.fundsService.get();
    this._connected = true;
    return { connected: true, broker: BROKER };
  }

  async disconnect() {
    this._connected = false;
    if (this._socket) {
      try { await this._socket.stop(); } catch (_) { /* shutting down anyway */ }
      this._socket = null;
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────
  placeOrder(req) { return this.orderService.place(req); }
  modifyOrder(req) { return this.orderService.modify(req); }
  cancelOrder(req) { return this.orderService.cancel(req); }

  // ─── Queries ───────────────────────────────────────────────────────
  positions(opts) { return this.positionService.list(opts); }
  holdings() { return this.holdingService.list(); }
  funds() { return this.fundsService.get(); }
  orders(filter) { return this.orderService.list(filter); }

  /**
   * Trade history. `range.today === true` uses the intraday trade book, which
   * is fresher than the dated history endpoint (that one lags by a day).
   */
  history(range = {}) {
    if (range.today) return this.orderService.trades();
    return this.historyService.trades(range);
  }

  quotes(instruments, opts) { return this.marketData.quotes(instruments, opts); }
  marketStatus(exchange) { return this.marketData.marketStatus(exchange); }

  /** Candles via the market-data abstraction (charts are unaffected). */
  candles(req) { return this.marketData.historical(req); }

  // ─── Streaming ─────────────────────────────────────────────────────
  /**
   * @param {(update: object) => void} handler receives normalize.order shapes
   * @param {object} [opts] { onStateChange, onAuthFailure }
   */
  async subscribeOrderUpdates(handler, opts = {}) {
    if (this._socket) return { stop: () => this._socket.stop() };

    this._socket = new DhanOrderSocket({
      credentials: this.credentials,
      userId: this.userId,
      onUpdate: handler,
      onStateChange: opts.onStateChange,
      onAuthFailure: opts.onAuthFailure,
    });
    await this._socket.start();
    return { stop: () => this._socket.stop() };
  }

  health() {
    return {
      ...super.health(),
      apiBase: config.BASE_URL,
      streams: { orderUpdates: this._socket ? this._socket.health() : { state: 'IDLE', connected: false } },
    };
  }
}

module.exports = DhanAdapter;
