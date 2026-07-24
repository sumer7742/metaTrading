/**
 * Queue facade — the ONLY sanctioned path to a broker API.
 *
 *   submit(broker, fn, opts)  →  Broker Queue → Rate Limiter → Broker Adapter
 *
 * Services call `queue.submit(...)`; they never touch OrderQueue or
 * RateLimiter directly, and never call an adapter method outside a submit.
 * That single choke point is what makes the rate-limit guarantee hold no
 * matter how many brokers or call sites exist.
 */

const { registry: queues } = require('./OrderQueue');
const { registry: limiters } = require('./RateLimiter');
const brokerRegistry = require('../registry');
const { PRIORITY, RATE_CATEGORY } = require('../constants');

/** Build (once) the queue+limiter pair for a broker from its descriptor. */
function queueFor(broker) {
  const code = String(broker).toUpperCase();
  const descriptor = brokerRegistry.has(code) ? brokerRegistry.get(code) : null;
  const limiter = limiters.for(code, (descriptor && descriptor.rateLimits) || {});
  return queues.for(code, { rateLimiter: limiter });
}

/**
 * @param {string} broker
 * @param {(ctx: {attempt:number, broker:string}) => Promise<any>} fn
 * @param {object} [opts] { priority, category, label, maxRetries, timeoutMs, meta }
 */
function submit(broker, fn, opts = {}) {
  return queueFor(broker).enqueue(fn, opts);
}

/** Aggregate health for the admin dashboard. */
function stats() {
  return { queues: queues.stats(), limiters: limiters.stats() };
}

async function drainAll(timeoutMs) {
  return queues.drainAll(timeoutMs);
}

module.exports = { submit, queueFor, stats, drainAll, PRIORITY, RATE_CATEGORY, queues, limiters };
