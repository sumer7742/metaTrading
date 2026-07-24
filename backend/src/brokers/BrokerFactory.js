/**
 * BrokerFactory — builds adapter instances.
 *
 * The ONLY place in the codebase that constructs an adapter. It knows how to
 * assemble one (registry descriptor + decrypted credentials + context) and
 * nothing about when or how long to keep it — that's BrokerManager's job.
 *
 * Open/Closed in practice: this file never changes when a broker is added,
 * because it only ever calls `descriptor.createAdapter(ctx)`.
 */

const registry = require('./registry');
const connectionService = require('../services/broker/brokerConnection.service');
const { BrokerError } = require('./base/BrokerError');
const logger = require('../utils/logger');

/**
 * Build a ready-to-use adapter for a user + broker.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.broker
 * @param {object} [p.connection] safe connection view (avoids a re-fetch)
 * @param {string} [p.requestId]
 * @returns {Promise<import('./base/BrokerAdapter')>}
 */
async function create({ userId, broker, connection, requestId }) {
  const descriptor = registry.get(broker);

  // The single decryption point in the request path.
  const credentials = await connectionService.getCredentials(userId, descriptor.code);

  const adapter = descriptor.createAdapter({
    broker: descriptor.code,
    userId: String(userId),
    credentials,
    connection: connection || null,
    config: descriptor.config,
    logger,
    requestId: requestId || null,
  });

  if (!adapter || typeof adapter.placeOrder !== 'function') {
    throw new BrokerError('INTERNAL_ERROR', `${descriptor.code} adapter is malformed.`, { broker: descriptor.code });
  }
  return adapter;
}

/**
 * Build a market-data provider. Independent of execution: the provider used
 * for prices need not be the broker used for orders.
 */
async function createMarketDataProvider({ userId, broker, requestId }) {
  const descriptor = registry.get(broker);
  if (typeof descriptor.createMarketDataProvider !== 'function') {
    throw BrokerError.unsupported('marketData', descriptor.code);
  }
  const credentials = await connectionService.getCredentials(userId, descriptor.code);
  return descriptor.createMarketDataProvider({ credentials, userId: String(userId), requestId: requestId || null, logger });
}

/** Auth provider for a broker + mode (delegates to the registry). */
const createAuthProvider = (broker, mode) => registry.createAuthProvider(broker, mode);

/** Catalogue for the frontend. */
const listBrokers = () => registry.list();

module.exports = { create, createMarketDataProvider, createAuthProvider, listBrokers };
