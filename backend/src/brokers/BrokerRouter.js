/**
 * BrokerRouter — decides WHICH broker handles a request, and dispatches to it.
 *
 *   Frontend  →  POST /api/orders  →  BrokerRouter  →  ┌─ Dhan Adapter
 *                                                      ├─ Upstox Adapter   (future)
 *                                                      ├─ FYERS Adapter    (future)
 *                                                      └─ Angel Adapter    (future)
 *
 * The frontend never names an endpoint per broker; at most it passes
 * `broker: 'DHAN'`. If it passes nothing, the router picks the user's default
 * connection. Adding a broker changes nothing here.
 *
 * Every dispatch goes through the queue, so the rate-limit guarantee cannot be
 * bypassed by calling the router:
 *
 *   dispatch() → OrderQueue → RateLimiter → Adapter
 *
 * The router also owns cross-broker post-call policy: mark a connection
 * invalid on auth failure, count failures, stamp last-used, and normalize
 * whatever escapes.
 */

const manager = require('./BrokerManager');
const registry = require('./registry');
const queue = require('./queue');
const connectionService = require('../services/broker/brokerConnection.service');
const audit = require('../services/broker/brokerAudit.service');
const { BrokerError, ERROR_CODE } = require('./base/BrokerError');
const { PRIORITY, RATE_CATEGORY, CAPABILITY } = require('./constants');

// Which rate-limit bucket each adapter method belongs to, and how urgent it is.
const DISPATCH_POLICY = {
  placeOrder: { category: RATE_CATEGORY.ORDERS, priority: PRIORITY.NORMAL, capability: CAPABILITY.PLACE_ORDER, maxRetries: 0 },
  modifyOrder: { category: RATE_CATEGORY.ORDERS, priority: PRIORITY.HIGH, capability: CAPABILITY.MODIFY_ORDER, maxRetries: 1 },
  cancelOrder: { category: RATE_CATEGORY.ORDERS, priority: PRIORITY.HIGH, capability: CAPABILITY.CANCEL_ORDER, maxRetries: 2 },
  positions: { category: RATE_CATEGORY.NON_TRADING, priority: PRIORITY.LOW, capability: CAPABILITY.POSITIONS, maxRetries: 2 },
  holdings: { category: RATE_CATEGORY.NON_TRADING, priority: PRIORITY.LOW, capability: CAPABILITY.HOLDINGS, maxRetries: 2 },
  funds: { category: RATE_CATEGORY.NON_TRADING, priority: PRIORITY.LOW, capability: CAPABILITY.FUNDS, maxRetries: 2 },
  orders: { category: RATE_CATEGORY.NON_TRADING, priority: PRIORITY.LOW, capability: CAPABILITY.ORDERS, maxRetries: 2 },
  history: { category: RATE_CATEGORY.NON_TRADING, priority: PRIORITY.LOW, capability: CAPABILITY.HISTORY, maxRetries: 2 },
  quotes: { category: RATE_CATEGORY.DATA, priority: PRIORITY.LOW, capability: CAPABILITY.QUOTES, maxRetries: 2 },
  marketStatus: { category: RATE_CATEGORY.DATA, priority: PRIORITY.LOW, capability: CAPABILITY.MARKET_STATUS, maxRetries: 1 },
  candles: { category: RATE_CATEGORY.DATA, priority: PRIORITY.LOW, capability: CAPABILITY.QUOTES, maxRetries: 2 },
};

/**
 * Resolve the broker + connection for a request.
 * @param {object} p { userId, broker? }
 * @returns {Promise<object>} safe connection view
 */
async function resolve({ userId, broker }) {
  return connectionService.resolveForRequest(userId, broker);
}

/**
 * Dispatch one adapter method.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} [p.broker]        omit to use the user's default connection
 * @param {string} p.method          adapter method name (see DISPATCH_POLICY)
 * @param {Array}  [p.args]          arguments for the method
 * @param {object} [p.connection]    pre-resolved connection (skips a lookup)
 * @param {number} [p.priority]      override the default priority
 * @param {string} [p.requestId] [p.clientOrderId]
 * @returns {Promise<any>} the adapter's normalized return value
 */
async function dispatch({ userId, broker, method, args = [], connection, priority, requestId, clientOrderId, maxRetries }) {
  const policy = DISPATCH_POLICY[method];
  if (!policy) throw new BrokerError(ERROR_CODE.INTERNAL_ERROR, `Unknown broker operation "${method}".`);

  const conn = connection || await resolve({ userId, broker });
  const code = conn.broker;

  // Fail fast on a capability the broker doesn't have — before we burn a
  // queue slot and a rate-limit token on a call that can't work.
  const descriptor = registry.get(code);
  if (descriptor.capabilities && descriptor.capabilities[policy.capability] === false) {
    throw BrokerError.unsupported(policy.capability, code);
  }

  const startedAt = Date.now();
  try {
    const result = await queue.submit(code, async () => {
      const adapter = await manager.getAdapter({ userId, broker: code, connection: conn, requestId });
      adapter.assertSupports(policy.capability);
      return adapter[method](...args);
    }, {
      category: policy.category,
      priority: priority != null ? priority : policy.priority,
      maxRetries: maxRetries != null ? maxRetries : policy.maxRetries,
      label: `${code}:${method}`,
      meta: { userId: String(userId), broker: code, method, clientOrderId: clientOrderId || null },
    });

    connectionService.touch(userId, code);
    return result;
  } catch (rawErr) {
    const err = BrokerError.from(rawErr, code);

    // Auth failures invalidate the connection immediately — one clear
    // "reconnect your broker" beats a stream of confusing order rejections.
    if ([ERROR_CODE.INVALID_TOKEN, ERROR_CODE.TOKEN_EXPIRED].includes(err.code)) {
      await connectionService.markInvalid({ userId, broker: code, code: err.code, message: err.message }).catch(() => {});
    } else if ([ERROR_CODE.BROKER_OFFLINE, ERROR_CODE.NETWORK_FAILURE, ERROR_CODE.TIMEOUT].includes(err.code)) {
      await connectionService.recordFailure({ userId, broker: code, code: err.code, message: err.message }).catch(() => {});
    }

    audit.recordError(err, {
      userId, broker: code, operation: method, requestId, clientOrderId,
      context: { durationMs: Date.now() - startedAt },
    });
    throw err;
  }
}

/** Convenience wrappers — read as intent at the call site. */
const commands = {
  placeOrder: (ctx, req) => dispatch({ ...ctx, method: 'placeOrder', args: [req], clientOrderId: req.clientOrderId }),
  modifyOrder: (ctx, req) => dispatch({ ...ctx, method: 'modifyOrder', args: [req], clientOrderId: req.clientOrderId }),
  cancelOrder: (ctx, req) => dispatch({ ...ctx, method: 'cancelOrder', args: [req], clientOrderId: req.clientOrderId }),
};

const queries = {
  positions: (ctx, opts) => dispatch({ ...ctx, method: 'positions', args: [opts] }),
  holdings: (ctx) => dispatch({ ...ctx, method: 'holdings', args: [] }),
  funds: (ctx) => dispatch({ ...ctx, method: 'funds', args: [] }),
  orders: (ctx, filter) => dispatch({ ...ctx, method: 'orders', args: [filter] }),
  history: (ctx, range) => dispatch({ ...ctx, method: 'history', args: [range] }),
  quotes: (ctx, instruments, opts) => dispatch({ ...ctx, method: 'quotes', args: [instruments, opts] }),
  marketStatus: (ctx, exchange) => dispatch({ ...ctx, method: 'marketStatus', args: [exchange] }),
  candles: (ctx, req) => dispatch({ ...ctx, method: 'candles', args: [req] }),
};

module.exports = { resolve, dispatch, commands, queries, DISPATCH_POLICY };
