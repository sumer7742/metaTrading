/**
 * Broker registry — the single extension point of the module.
 *
 * Adding a broker is exactly two steps:
 *   1. Create the adapter package under `brokers/<code>/` exporting a descriptor.
 *   2. `registry.register(require('./<code>'))` in `brokers/index.js`.
 *
 * Nothing else in the codebase changes. Routes, controllers, services, models,
 * the queue, the rate limiter and the frontend are all broker-agnostic and
 * discover capabilities through this registry at runtime.
 *
 * Descriptor shape:
 *   {
 *     code: 'DHAN',
 *     name: 'Dhan',
 *     website: 'https://dhan.co',
 *     createAdapter(ctx): BrokerAdapter,
 *     authProviders: { MANUAL: () => AuthProvider, OAUTH?: () => AuthProvider },
 *     capabilities: { placeOrder: true, ... },
 *     rateLimits: { orders: {...}, data: {...}, nonTrading: {...}, default: {...} },
 *     createMarketDataProvider?(ctx): MarketDataProvider,
 *     config?: {}
 *   }
 */

const { BrokerError, ERROR_CODE } = require('./base/BrokerError');
const { BROKER_CODES, AUTH_MODE } = require('./constants');
const logger = require('../utils/logger');

/** @type {Map<string, object>} */
const _registry = new Map();

const _required = ['code', 'name', 'createAdapter'];

/**
 * Register a broker descriptor. Idempotent — re-registering the same code
 * replaces the descriptor (useful for tests), and logs at debug level.
 */
function register(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('registry.register: descriptor object required');
  }
  for (const key of _required) {
    if (!descriptor[key]) throw new Error(`registry.register: "${key}" is required`);
  }
  const code = String(descriptor.code).toUpperCase();
  if (!BROKER_CODES.includes(code)) {
    // Not fatal — a white-label deployment may add its own broker. But make
    // it visible so typos ('DHANN') don't silently create a ghost broker.
    logger.warn('Broker registered with a code missing from constants.BROKER', { code });
  }
  if (typeof descriptor.createAdapter !== 'function') {
    throw new Error(`registry.register(${code}): createAdapter must be a function`);
  }

  const entry = Object.freeze({
    code,
    name: descriptor.name,
    website: descriptor.website || null,
    description: descriptor.description || null,
    createAdapter: descriptor.createAdapter,
    authProviders: Object.freeze({ ...(descriptor.authProviders || {}) }),
    capabilities: Object.freeze({ ...(descriptor.capabilities || {}) }),
    rateLimits: Object.freeze({ ...(descriptor.rateLimits || {}) }),
    createMarketDataProvider: descriptor.createMarketDataProvider || null,
    config: Object.freeze({ ...(descriptor.config || {}) }),
    // Modes actually wired up, derived — never hardcoded by callers.
    authModes: Object.freeze(Object.keys(descriptor.authProviders || {}).filter((m) => AUTH_MODE[m])),
  });

  if (_registry.has(code)) logger.debug('Broker descriptor replaced', { broker: code });
  _registry.set(code, entry);
  return entry;
}

function has(code) {
  return _registry.has(String(code || '').toUpperCase());
}

/** Get a descriptor or throw UNKNOWN_BROKER. */
function get(code) {
  const key = String(code || '').toUpperCase();
  const entry = _registry.get(key);
  if (!entry) {
    throw new BrokerError(
      ERROR_CODE.UNKNOWN_BROKER,
      `Broker "${code}" is not supported on this platform.`,
      { details: { supported: codes() } }
    );
  }
  return entry;
}

function codes() {
  return [..._registry.keys()];
}

/** Public catalogue for the frontend "choose your broker" screen. */
function list() {
  return [..._registry.values()].map((b) => ({
    code: b.code,
    name: b.name,
    website: b.website,
    description: b.description,
    authModes: b.authModes,
    capabilities: b.capabilities,
    credentialFields: _credentialFields(b),
  }));
}

function _credentialFields(entry) {
  const factory = entry.authProviders[AUTH_MODE.MANUAL];
  if (typeof factory !== 'function') return [];
  try {
    return factory({ broker: entry.code, config: entry.config }).credentialFields();
  } catch (e) {
    logger.warn('credentialFields failed', { broker: entry.code, err: e });
    return [];
  }
}

/**
 * Build the auth provider for a broker + mode.
 * @param {string} code
 * @param {'MANUAL'|'OAUTH'} mode
 */
function createAuthProvider(code, mode = AUTH_MODE.MANUAL) {
  const entry = get(code);
  const factory = entry.authProviders[mode];
  if (typeof factory !== 'function') {
    throw new BrokerError(
      ERROR_CODE.UNSUPPORTED_OPERATION,
      `${entry.name} does not support ${mode} authentication yet.`,
      { broker: entry.code, details: { supportedModes: entry.authModes } }
    );
  }
  return factory({ broker: entry.code, config: entry.config });
}

/** Reset — tests only. */
function _clear() { _registry.clear(); }

module.exports = { register, has, get, codes, list, createAuthProvider, _clear };
