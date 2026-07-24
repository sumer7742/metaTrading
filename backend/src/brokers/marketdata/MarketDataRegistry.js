/**
 * MarketDataRegistry — price sources, decoupled from execution.
 *
 * The platform can execute through Dhan while pricing from TrueData, and
 * neither the frontend nor the chart pipeline needs to know. Providers are
 * registered by name and selected per request (or by MARKET_DATA_PROVIDER).
 *
 * Two kinds of provider:
 *   - BROKER-BACKED (Dhan today) — needs the user's own broker credentials, so
 *     it's built per user through BrokerFactory.
 *   - VENDOR (TrueData, GlobalDataFeeds, Polygon, Finnhub…) — platform-wide
 *     credentials, built once and shared. Register one with `register()`.
 *
 * ⚠️ Charts are NOT affected. The TradingView Lightweight Charts pipeline runs
 * on the existing feed services (`services/dhanFeed.js`, `candleService`, the
 * `ticker:`/`candles:` WS channels). This registry serves the broker terminal
 * and is available as a future chart source without any frontend change.
 */

const registry = require('../registry');
const factory = require('../BrokerFactory');
const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const logger = require('../../utils/logger');

/** @type {Map<string, {name: string, provider: object, brokerBacked: boolean}>} */
const _vendors = new Map();

/**
 * Register a platform-wide (non-broker) market-data provider.
 * @param {string} name  e.g. 'TRUEDATA'
 * @param {import('../base/MarketDataProvider')} providerInstance
 */
function register(name, providerInstance) {
  const key = String(name).toUpperCase();
  if (!providerInstance || typeof providerInstance.quotes !== 'function') {
    throw new Error(`MarketDataRegistry.register(${key}): provider must implement quotes()`);
  }
  _vendors.set(key, { name: key, provider: providerInstance, brokerBacked: false });
  logger.info('[broker] market-data provider registered', { provider: key });
  return providerInstance;
}

/** The configured default: a vendor name, a broker code, or 'AUTO'. */
const defaultProviderName = () => String(process.env.MARKET_DATA_PROVIDER || 'AUTO').toUpperCase();

/**
 * Resolve a provider for a request.
 *
 * @param {object} p { userId, provider?, broker? }
 * @returns {Promise<{name: string, provider: object}>}
 */
async function resolve({ userId, provider, broker } = {}) {
  const requested = String(provider || defaultProviderName()).toUpperCase();

  // 1. Explicit vendor.
  if (_vendors.has(requested)) return _vendors.get(requested);

  // 2. Explicit broker-backed provider.
  if (registry.has(requested)) {
    return { name: requested, provider: await factory.createMarketDataProvider({ userId, broker: requested }), brokerBacked: true };
  }

  // 3. AUTO — prefer a registered vendor (no per-user credentials, no
  //    per-user rate limit), else the broker the user is executing through.
  if (requested === 'AUTO') {
    if (_vendors.size) return [..._vendors.values()][0];
    const code = broker || (registry.codes()[0] || null);
    if (code) {
      return { name: code, provider: await factory.createMarketDataProvider({ userId, broker: code }), brokerBacked: true };
    }
  }

  throw new BrokerError(
    ERROR_CODE.UNSUPPORTED_OPERATION,
    `No market-data provider named "${requested}" is available.`,
    { details: { vendors: [..._vendors.keys()], brokers: registry.codes() } }
  );
}

/** What the admin dashboard shows: every price source we could use. */
const list = () => [
  ...[..._vendors.values()].map((v) => ({
    name: v.name,
    type: 'vendor',
    capabilities: v.provider.capabilities(),
  })),
  ...registry.list()
    .filter((b) => b.capabilities && b.capabilities.quotes)
    .map((b) => ({
      name: b.code,
      type: 'broker',
      capabilities: { quotes: true, historical: true, marketStatus: !!b.capabilities.marketStatus },
    })),
];

module.exports = { register, resolve, list, defaultProviderName };
