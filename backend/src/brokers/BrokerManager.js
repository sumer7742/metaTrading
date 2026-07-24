/**
 * BrokerManager — owns adapter lifetime and broker socket fan-out.
 *
 *   Dhan Socket → BrokerManager → our WebSocket → Frontend
 *
 * Two jobs:
 *
 * 1. ADAPTER POOL. Building an adapter means decrypting credentials and
 *    proving the session works — too expensive to repeat per request. Adapters
 *    are cached per (userId, broker) with an idle TTL and an LRU cap, and are
 *    evicted the moment the underlying connection changes (token rotated,
 *    disconnected, marked invalid) so a stale token can never be reused.
 *
 * 2. STREAM SUPERVISION. Broker sockets are isolated per user and know nothing
 *    about our WebSocket server. The manager subscribes to them, normalizes
 *    updates into OrderSync, and republishes on the existing `user:broker`
 *    channel via the platform broadcaster — the SAME broadcaster the forex and
 *    crypto engines use, with no change to it.
 */

const factory = require('./BrokerFactory');
const registry = require('./registry');
const { BrokerError, ERROR_CODE } = require('./base/BrokerError');
const { UPDATE_SOURCE } = require('./constants');
const logger = require('../utils/logger');

const IDLE_TTL_MS = Number(process.env.BROKER_ADAPTER_TTL_MS) || 10 * 60 * 1000;
const MAX_ADAPTERS = Number(process.env.BROKER_ADAPTER_MAX) || 2000;
const SWEEP_MS = 60 * 1000;

const _key = (userId, broker) => `${String(userId)}:${String(broker).toUpperCase()}`;

class BrokerManager {
  constructor() {
    /** @type {Map<string, {adapter, lastUsed, createdAt, connectionUpdatedAt}>} */
    this._adapters = new Map();
    /** @type {Map<string, {stop: Function, adapterKey: string, startedAt: number}>} */
    this._streams = new Map();
    this._broadcaster = null;
    this._sweepTimer = null;
    this._started = false;
    this._pending = new Map(); // in-flight builds, so concurrent orders share one
  }

  /** Wire the platform WebSocket broadcaster (same instance as forex/crypto). */
  setBroadcaster(broadcaster) { this._broadcaster = broadcaster; }

  start() {
    if (this._started) return;
    this._started = true;
    this._sweepTimer = setInterval(() => this._sweep(), SWEEP_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
    logger.info('[broker] manager started', { brokers: registry.codes() });
  }

  // ─── Adapter pool ──────────────────────────────────────────────────
  /**
   * Get (or build) a connected adapter.
   *
   * @param {object} p { userId, broker, connection?, requestId? }
   * @returns {Promise<import('./base/BrokerAdapter')>}
   */
  async getAdapter({ userId, broker, connection, requestId }) {
    const code = String(broker).toUpperCase();
    const key = _key(userId, code);

    const entry = this._adapters.get(key);
    if (entry && this._isFresh(entry, connection)) {
      entry.lastUsed = Date.now();
      return entry.adapter;
    }
    if (entry) await this._destroy(key, entry);

    // Collapse concurrent builds — a burst of orders from one user must not
    // each decrypt credentials and probe the broker.
    if (this._pending.has(key)) return this._pending.get(key);

    const build = (async () => {
      const adapter = await factory.create({ userId, broker: code, connection, requestId });
      try {
        await adapter.connect();
      } catch (err) {
        const e = BrokerError.from(err, code);
        // An auth failure at connect time means the stored token is dead —
        // flip the connection so the UI prompts a reconnect immediately.
        if ([ERROR_CODE.INVALID_TOKEN, ERROR_CODE.TOKEN_EXPIRED].includes(e.code)) {
          await require('../services/broker/brokerConnection.service')
            .markInvalid({ userId, broker: code, code: e.code, message: e.message })
            .catch(() => {});
        }
        throw e;
      }

      this._evictIfFull();
      this._adapters.set(key, {
        adapter,
        lastUsed: Date.now(),
        createdAt: Date.now(),
        connectionUpdatedAt: connection && connection.updatedAt ? new Date(connection.updatedAt).getTime() : null,
      });
      return adapter;
    })();

    this._pending.set(key, build);
    try {
      return await build;
    } finally {
      this._pending.delete(key);
    }
  }

  _isFresh(entry, connection) {
    if (Date.now() - entry.lastUsed > IDLE_TTL_MS) return false;
    // Connection row changed since this adapter was built (token rotated,
    // status changed) → rebuild rather than risk a stale credential.
    if (connection && connection.updatedAt && entry.connectionUpdatedAt
      && new Date(connection.updatedAt).getTime() !== entry.connectionUpdatedAt) return false;
    return true;
  }

  _evictIfFull() {
    if (this._adapters.size < MAX_ADAPTERS) return;
    // Evict the least-recently-used entry.
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of this._adapters) {
      if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
    }
    if (oldestKey) {
      const entry = this._adapters.get(oldestKey);
      this._destroy(oldestKey, entry).catch(() => {});
    }
  }

  /** Drop a cached adapter + its stream. Called on token change/disconnect. */
  evict(userId, broker) {
    const key = _key(userId, broker);
    const entry = this._adapters.get(key);
    if (entry) this._destroy(key, entry).catch(() => {});
    this.stopStream(userId, broker).catch(() => {});
  }

  async _destroy(key, entry) {
    this._adapters.delete(key);
    if (!entry) return;
    try { await entry.adapter.disconnect(); } catch (_) { /* best effort */ }
  }

  _sweep() {
    const now = Date.now();
    for (const [key, entry] of [...this._adapters]) {
      if (now - entry.lastUsed > IDLE_TTL_MS) this._destroy(key, entry).catch(() => {});
    }
  }

  // ─── Streams ───────────────────────────────────────────────────────
  /**
   * Start the broker's live order stream for a user and pipe updates to the
   * frontend. Idempotent — calling it twice keeps one socket.
   *
   * Falls back silently when the broker has no stream capability: the polling
   * reconciler (brokerSync.service) covers those brokers.
   */
  async startStream({ userId, broker, connection }) {
    const code = String(broker).toUpperCase();
    const key = _key(userId, code);
    if (this._streams.has(key)) return { started: false, reason: 'already-running' };

    const descriptor = registry.get(code);
    if (!descriptor.capabilities.orderStream) return { started: false, reason: 'not-supported' };

    const adapter = await this.getAdapter({ userId, broker: code, connection });
    if (!adapter.supports('orderStream')) return { started: false, reason: 'not-supported' };

    // Reserve the slot BEFORE awaiting the socket handshake so two concurrent
    // calls can't both open a socket.
    this._streams.set(key, { stop: async () => {}, adapterKey: key, startedAt: Date.now() });

    try {
      const handle = await adapter.subscribeOrderUpdates(
        (update) => this._onOrderUpdate({ userId, broker: code, update }),
        {
          onStateChange: (info) => this.publishStream(userId, info),
          onAuthFailure: async (err) => {
            await require('../services/broker/brokerConnection.service')
              .markInvalid({ userId, broker: code, code: err.code, message: err.message })
              .catch(() => {});
            this.publishStream(userId, { broker: code, state: 'FAILED', reason: 'auth' });
          },
        }
      );
      this._streams.set(key, { stop: handle.stop, adapterKey: key, startedAt: Date.now() });

      // Recovery: a fresh socket only carries updates from NOW on, so pull the
      // broker's order book once to catch anything missed while we were down.
      require('../services/broker/brokerSync.service')
        .reconcileUser({ userId, broker: code, reason: 'stream-start' })
        .catch((e) => logger.warn('[broker] post-connect reconcile failed', { userId, broker: code, err: e }));

      return { started: true };
    } catch (err) {
      this._streams.delete(key);
      throw BrokerError.from(err, code);
    }
  }

  async stopStream(userId, broker) {
    const key = _key(userId, broker);
    const stream = this._streams.get(key);
    if (!stream) return { stopped: false };
    this._streams.delete(key);
    try { await stream.stop(); } catch (_) { /* best effort */ }
    return { stopped: true };
  }

  /**
   * Broker socket → our system. Persist first (so a websocket drop can't lose
   * an update), then broadcast.
   */
  async _onOrderUpdate({ userId, broker, update }) {
    try {
      const applied = await require('../services/broker/brokerOrder.service').applyBrokerUpdate({
        userId, broker, update, source: UPDATE_SOURCE.WEBSOCKET,
      });
      this.publishOrder(userId, applied || update);
    } catch (err) {
      logger.error('[broker] failed to apply order update', { userId, broker, err });
      // Persisting failed — still tell the user what the broker said.
      this.publishOrder(userId, update);
    }
  }

  /** Order update → frontend, on the single `broker` channel. */
  publishOrder(userId, order) {
    this._publish(userId, { type: 'order', order });
  }

  /** Stream-health event → frontend, on the single `broker` channel. */
  publishStream(userId, info) {
    this._publish(userId, { type: 'stream', ...info });
  }

  /**
   * Publish on the platform's existing WebSocket.
   *
   * The channel is the SINGLE segment `broker`: `notifyUser` scopes it to
   * `user:broker:<userId>`, which is exactly what the existing client's
   * channel matcher collapses back to `user:broker` (it keeps only the first
   * segment after `user:`, like `user:notifications`). A two-segment channel
   * such as `broker:order` would be collapsed to `user:broker` on the client
   * and never match a `user:broker:order` subscription — so the event kind is
   * carried in the payload's `type` field instead of the channel name.
   */
  _publish(userId, data) {
    if (!this._broadcaster || typeof this._broadcaster.notifyUser !== 'function') return;
    try {
      this._broadcaster.notifyUser(String(userId), 'broker', data);
    } catch (err) {
      logger.warn('[broker] websocket publish failed', { userId, err });
    }
  }

  // ─── Health / shutdown ─────────────────────────────────────────────
  health() {
    return {
      started: this._started,
      brokers: registry.codes(),
      adapters: { cached: this._adapters.size, max: MAX_ADAPTERS, idleTtlMs: IDLE_TTL_MS },
      streams: [...this._streams.keys()].map((k) => {
        const [userId, broker] = k.split(':');
        return { userId, broker, startedAt: new Date(this._streams.get(k).startedAt).toISOString() };
      }),
    };
  }

  async shutdown() {
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    this._started = false;
    await Promise.all([...this._streams.values()].map((s) => Promise.resolve(s.stop()).catch(() => {})));
    this._streams.clear();
    await Promise.all([...this._adapters.entries()].map(([k, e]) => this._destroy(k, e)));
    this._adapters.clear();
  }
}

module.exports = new BrokerManager();
module.exports.BrokerManager = BrokerManager;
