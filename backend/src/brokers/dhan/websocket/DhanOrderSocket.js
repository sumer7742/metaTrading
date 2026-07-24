/**
 * DhanOrderSocket — live order updates from Dhan.
 *
 *   Dhan Socket → BrokerManager → our WebSocket → Frontend
 *
 * The socket is ISOLATED per user connection: one Dhan account, one socket,
 * owned by the adapter. It knows nothing about our own WebSocket server —
 * BrokerManager does the fan-out. That separation is what lets a broker socket
 * die and reconnect without any user-facing socket noticing.
 *
 * Resilience:
 *   - Heartbeat ping every HEARTBEAT_MS.
 *   - Idle watchdog: no frame at all for IDLE_TIMEOUT_MS ⇒ assume a half-open
 *     TCP connection (common behind mobile NAT) and force a reconnect. A
 *     socket that is open but silent is the failure mode that silently breaks
 *     order updates, so we treat silence as death.
 *   - Exponential backoff with jitter, capped at RECONNECT_MAX_MS. Jitter
 *     matters: without it, a broker restart makes every user's socket
 *     reconnect in lockstep and we self-DDoS.
 *   - Auth failures do NOT retry — they mark the connection invalid, because
 *     retrying a bad token forever is how an account gets blocked.
 *   - On every successful (re)connect the manager re-syncs the order book via
 *     REST, so updates missed while disconnected are recovered.
 */

const WebSocket = require('ws');
const config = require('../config');
const mappers = require('../mappers');
const { BrokerError, ERROR_CODE } = require('../../base/BrokerError');
const logger = require('../../../utils/logger');

const BROKER = 'DHAN';

const STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  OPEN: 'OPEN',
  RECONNECTING: 'RECONNECTING',
  CLOSED: 'CLOSED',
  FAILED: 'FAILED',
};

class DhanOrderSocket {
  /**
   * @param {object} ctx
   * @param {{accessToken: string, brokerClientId: string}} ctx.credentials
   * @param {string} ctx.userId
   * @param {(update: object) => void} ctx.onUpdate    normalized order update
   * @param {(info: object) => void} [ctx.onStateChange]
   * @param {(err: BrokerError) => void} [ctx.onAuthFailure]
   */
  constructor({ credentials, userId, onUpdate, onStateChange, onAuthFailure } = {}) {
    Object.defineProperty(this, '_creds', { value: credentials || {}, enumerable: false });
    this.userId = userId ? String(userId) : null;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
    this.onAuthFailure = typeof onAuthFailure === 'function' ? onAuthFailure : () => {};

    this.ws = null;
    this.state = STATE.IDLE;
    this.attempts = 0;
    this.stopped = false;
    this.lastMessageAt = 0;
    this.connectedAt = null;
    this.messageCount = 0;

    this._heartbeatTimer = null;
    this._idleTimer = null;
    this._reconnectTimer = null;
  }

  get isOpen() { return this.state === STATE.OPEN; }

  /** Open the socket. Resolves once connected (or rejects on auth failure). */
  async start() {
    if (!this._creds.accessToken || !this._creds.brokerClientId) {
      throw new BrokerError(ERROR_CODE.NOT_CONNECTED, 'Dhan credentials missing — cannot open the order stream.', { broker: BROKER });
    }
    this.stopped = false;
    return this._connect();
  }

  _setState(state, extra = {}) {
    this.state = state;
    try {
      this.onStateChange({ broker: BROKER, userId: this.userId, state, attempts: this.attempts, ...extra });
    } catch (_) { /* a listener must never break the socket */ }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      if (this.stopped) return resolve(false);
      this._setState(this.attempts ? STATE.RECONNECTING : STATE.CONNECTING);

      let settled = false;
      const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

      let ws;
      try {
        ws = new WebSocket(config.ORDER_WS_URL, { handshakeTimeout: 10000 });
      } catch (err) {
        this._scheduleReconnect();
        return settle(reject, BrokerError.from(err, BROKER));
      }
      this.ws = ws;

      ws.on('open', () => {
        this.lastMessageAt = Date.now();
        this.connectedAt = Date.now();
        // Dhan authenticates AFTER the socket opens, via a login frame.
        try {
          ws.send(JSON.stringify({
            LoginReq: {
              MsgCode: config.WS.LOGIN_MSG_CODE,
              ClientId: String(this._creds.brokerClientId),
              Token: String(this._creds.accessToken),
            },
            UserType: config.WS.USER_TYPE,
          }));
        } catch (err) {
          logger.warn('[dhan-ws] login frame failed', { userId: this.userId, err });
        }
        this.attempts = 0;
        this._setState(STATE.OPEN);
        this._startTimers();
        logger.info('[dhan-ws] order stream connected', { userId: this.userId });
        settle(resolve, true);
      });

      ws.on('message', (raw) => {
        this.lastMessageAt = Date.now();
        this.messageCount++;
        this._handleMessage(raw);
      });

      ws.on('pong', () => { this.lastMessageAt = Date.now(); });

      ws.on('error', (err) => {
        logger.warn('[dhan-ws] socket error', { userId: this.userId, err });
      });

      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf ? reasonBuf.toString() : '';
        this._stopTimers();
        // 1008/4001-style auth rejections: retrying can get the account
        // throttled, so stop and surface it for a reconnect prompt.
        if (this._isAuthClose(code, reason)) {
          this._setState(STATE.FAILED, { code, reason });
          const err = new BrokerError(ERROR_CODE.INVALID_TOKEN, 'Dhan rejected the order-stream credentials.', { broker: BROKER });
          try { this.onAuthFailure(err); } catch (_) { /* ignore */ }
          return settle(reject, err);
        }
        if (this.stopped) { this._setState(STATE.CLOSED, { code }); return settle(resolve, false); }

        logger.warn('[dhan-ws] disconnected — reconnecting', { userId: this.userId, code, reason: reason.slice(0, 120) });
        this._scheduleReconnect();
        // First connect never succeeded → let the caller know; later drops are
        // handled silently by the reconnect loop.
        settle(resolve, false);
      });
    });
  }

  _isAuthClose(code, reason) {
    if ([1008, 4001, 4002, 4004].includes(Number(code))) return true;
    return /auth|token|unauthor|invalid client/i.test(String(reason || ''));
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return; // binary/keepalive frames — nothing to do
    }

    // Dhan wraps order events as { Type: 'order_alert', Data: {...} }.
    // Tolerate casing/shape drift: the socket contract is less stable than REST.
    const type = String(msg.Type || msg.type || '').toLowerCase();
    const data = msg.Data || msg.data || null;

    if (type.includes('auth') && /fail|error/i.test(JSON.stringify(msg).slice(0, 200))) {
      const err = new BrokerError(ERROR_CODE.INVALID_TOKEN, 'Dhan order stream authentication failed.', { broker: BROKER });
      try { this.onAuthFailure(err); } catch (_) { /* ignore */ }
      return;
    }
    if (!data || typeof data !== 'object') return;

    const normalized = mappers.toOrder(data);
    if (!normalized || !normalized.orderId) return;

    try {
      this.onUpdate(normalized);
    } catch (err) {
      logger.error('[dhan-ws] update handler threw', { userId: this.userId, err });
    }
  }

  _startTimers() {
    this._stopTimers();

    this._heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.ping(); } catch (_) { /* the idle watchdog will catch it */ }
      }
    }, config.WS.HEARTBEAT_MS);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();

    this._idleTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > config.WS.IDLE_TIMEOUT_MS) {
        logger.warn('[dhan-ws] idle timeout — forcing reconnect', {
          userId: this.userId, idleMs: Date.now() - this.lastMessageAt,
        });
        this._forceReconnect();
      }
    }, Math.max(5000, Math.floor(config.WS.IDLE_TIMEOUT_MS / 3)));
    if (this._idleTimer.unref) this._idleTimer.unref();
  }

  _stopTimers() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
  }

  _forceReconnect() {
    this._stopTimers();
    try { if (this.ws) this.ws.terminate(); } catch (_) { /* already gone */ }
    // The 'close' handler schedules the reconnect.
  }

  _scheduleReconnect() {
    if (this.stopped || this._reconnectTimer) return;
    this.attempts++;
    const raw = Math.min(config.WS.RECONNECT_BASE_MS * 2 ** (this.attempts - 1), config.WS.RECONNECT_MAX_MS);
    const delay = Math.round(raw * (0.75 + Math.random() * 0.5)); // ±25% jitter
    this._setState(STATE.RECONNECTING, { delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect().catch((e) => logger.warn('[dhan-ws] reconnect failed', { userId: this.userId, err: e }));
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  /** Stop for good. Never throws — used on shutdown paths. */
  async stop() {
    this.stopped = true;
    this._stopTimers();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    try {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        this.ws.close(1000, 'client shutdown');
      }
    } catch (_) { /* nothing to do */ }
    this.ws = null;
    this._setState(STATE.CLOSED);
  }

  health() {
    return {
      broker: BROKER,
      state: this.state,
      connected: this.isOpen,
      attempts: this.attempts,
      messageCount: this.messageCount,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
    };
  }
}

module.exports = DhanOrderSocket;
module.exports.STATE = STATE;
