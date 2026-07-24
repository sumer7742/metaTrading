/**
 * Broker module entry point.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  ADDING A BROKER — the complete checklist
 * ══════════════════════════════════════════════════════════════════════
 *   1. Create `brokers/<code>/` with an adapter extending BrokerAdapter and
 *      an `index.js` exporting a descriptor (copy `brokers/dhan/index.js`).
 *   2. Add ONE line to `_registerBrokers()` below.
 *
 *   That is the entire change. Routes, controllers, services, models, the
 *   queue, the rate limiter, the audit trail and the frontend are all
 *   broker-agnostic and discover the new broker at runtime.
 * ══════════════════════════════════════════════════════════════════════
 *
 * `init()` is called once from server.js. It is intentionally defensive: a
 * broker-module failure must NEVER prevent the platform from booting, because
 * the forex engine, crypto engine, wallet and admin do not depend on it.
 */

const registry = require('./registry');
const manager = require('./BrokerManager');
const router = require('./BrokerRouter');
const factory = require('./BrokerFactory');
const queue = require('./queue');
const marketData = require('./marketdata/MarketDataRegistry');
const constants = require('./constants');
const { BrokerError, ERROR_CODE } = require('./base/BrokerError');
const logger = require('../utils/logger');

let _initialized = false;

function _registerBrokers() {
  // ── Live ──
  registry.register(require('./dhan'));

  // ── Future (uncomment once the adapter package exists) ──
  // registry.register(require('./upstox'));
  // registry.register(require('./fyers'));
  // registry.register(require('./angelone'));
  // registry.register(require('./zerodha'));
  // registry.register(require('./shoonya'));
}

/**
 * @param {object} [opts]
 * @param {object} [opts.broadcaster] the platform WebSocket broadcaster
 * @param {boolean} [opts.startSync]  run the reconciliation sweep
 */
function init({ broadcaster, startSync = true } = {}) {
  if (_initialized) return { initialized: true, brokers: registry.codes() };

  try {
    _registerBrokers();

    // ── Prefer IPv4 for broker API calls ──────────────────────────────
    // Broker order APIs (Dhan's especially) gate ORDER PLACEMENT to the STATIC
    // IP(s) you register in the broker dashboard. Home/office links usually
    // egress over a ROTATING temporary IPv6 (privacy extensions) whose current
    // value won't match the registered IPv6 — so orders get "Invalid IP"
    // (Dhan DH-905) even though reads succeed (reads aren't IP-gated). Pinning
    // outbound DNS to IPv4-first makes the broker consistently see your
    // registered IPv4. Safe + widely used (it was Node's default pre-v17).
    // Disable with BROKER_FORCE_IPV4=false if you registered a static IPv6.
    if (String(process.env.BROKER_FORCE_IPV4 || 'true').toLowerCase() !== 'false') {
      try {
        require('dns').setDefaultResultOrder('ipv4first');
        // Don't race to IPv6 via Happy Eyeballs — connect IPv4-first, in order.
        const net = require('net');
        if (typeof net.setDefaultAutoSelectFamily === 'function') net.setDefaultAutoSelectFamily(false);
        logger.info('[broker] outbound DNS pinned to IPv4-first (broker OMS static-IP compatibility)');
      } catch (e) {
        logger.warn('[broker] could not set IPv4-first DNS order', { err: e });
      }
    }

    if (broadcaster) manager.setBroadcaster(broadcaster);
    manager.start();

    if (startSync) require('../services/broker/brokerSync.service').start();

    // Encryption is checked at boot so a misconfigured box is loud in the
    // logs immediately, not at 09:15 when the first order fails. In
    // production the first connect attempt throws; here we only warn, so
    // the rest of the platform still starts.
    const encryption = require('../services/broker/tokenEncryption.service');
    if (!encryption.isConfigured()) {
      logger.warn('[broker] BROKER_ENCRYPTION_KEY is not configured — broker connections will be refused in production.');
    }

    _initialized = true;
    logger.info('[broker] module initialized', {
      brokers: registry.codes(),
      encryption: encryption.describe().configured,
      marketDataProvider: marketData.defaultProviderName(),
    });
  } catch (err) {
    // Never take the platform down over the broker module.
    logger.error('[broker] initialization failed — Indian broker features are unavailable', { err });
  }

  return { initialized: _initialized, brokers: registry.codes() };
}

async function shutdown() {
  try { require('../services/broker/brokerSync.service').stop(); } catch (_) { /* not started */ }
  try { await queue.drainAll(8000); } catch (_) { /* going down anyway */ }
  try { await manager.shutdown(); } catch (_) { /* going down anyway */ }
  _initialized = false;
}

/** Aggregate health for the admin dashboard. */
function health() {
  const encryption = require('../services/broker/tokenEncryption.service');
  return {
    initialized: _initialized,
    brokers: registry.list(),
    manager: manager.health(),
    queue: queue.stats(),
    sync: require('../services/broker/brokerSync.service').health(),
    cache: require('../services/broker/cache').describe(),
    encryption: encryption.describe(),
    marketData: { default: marketData.defaultProviderName(), providers: marketData.list() },
  };
}

module.exports = {
  init,
  shutdown,
  health,
  registry,
  manager,
  router,
  factory,
  queue,
  marketData,
  constants,
  BrokerError,
  ERROR_CODE,
};
