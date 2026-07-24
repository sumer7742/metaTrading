/**
 * brokerPortfolio.service.js — CQRS QUERY side.
 *
 * Queries: Positions · Funds · Orders · Holdings · Trade History · Portfolio
 *
 * Separate from the command side because the constraints are opposite:
 *   - commands must be exactly-once, durable and audited;
 *   - queries must be cheap, cacheable and safe to repeat.
 *
 * Caching (Redis when configured, in-process otherwise) exists to protect the
 * BROKER's rate limit, not ours: a portfolio screen polling every 2 seconds
 * across a few thousand users would exhaust a broker's data quota in minutes.
 * TTLs are deliberately short (2–30s) and every write invalidates the user's
 * read models immediately, so a fill is never hidden behind a stale cache.
 *
 * `force: true` (the UI's pull-to-refresh) always bypasses the cache.
 */

const router = require('../../brokers/BrokerRouter');
const cache = require('./cache');
const registry = require('../../brokers/registry');
const { BrokerError } = require('../../brokers/base/BrokerError');
const { CAPABILITY } = require('../../brokers/constants');

/** Resolve the connection once, then reuse it for every call in a request. */
async function _ctx({ userId, broker, requestId }) {
  const connection = await router.resolve({ userId, broker });
  return { userId, broker: connection.broker, connection, requestId };
}

const _supports = (broker, capability) => {
  const d = registry.get(broker);
  return !d.capabilities || d.capabilities[capability] !== false;
};

/** @returns {Promise<{broker, positions: Array}>} */
async function positions({ userId, broker, requestId, force = false, includeClosed = false }) {
  const ctx = await _ctx({ userId, broker, requestId });
  const key = cache.key('positions', userId, ctx.broker, includeClosed ? 'all' : 'open');
  const rows = await cache.getOrFetch(key, cache.TTL.positions,
    () => router.queries.positions(ctx, { includeClosed }), { force });
  return { broker: ctx.broker, positions: rows || [] };
}

/** @returns {Promise<{broker, holdings: Array}>} */
async function holdings({ userId, broker, requestId, force = false }) {
  const ctx = await _ctx({ userId, broker, requestId });
  const key = cache.key('holdings', userId, ctx.broker);
  const rows = await cache.getOrFetch(key, cache.TTL.holdings, () => router.queries.holdings(ctx), { force });
  return { broker: ctx.broker, holdings: rows || [] };
}

/** @returns {Promise<{broker, funds: object}>} */
async function funds({ userId, broker, requestId, force = false }) {
  const ctx = await _ctx({ userId, broker, requestId });
  const key = cache.key('funds', userId, ctx.broker);
  const row = await cache.getOrFetch(key, cache.TTL.funds, () => router.queries.funds(ctx), { force });
  return { broker: ctx.broker, funds: row };
}

/** Live order book from the broker. */
async function orders({ userId, broker, requestId, force = false, filter = {} }) {
  const ctx = await _ctx({ userId, broker, requestId });
  // A single-order lookup is never cached — it's the "did it fill?" question.
  if (filter.orderId || filter.clientOrderId) {
    return { broker: ctx.broker, orders: await router.queries.orders(ctx, filter) };
  }
  const key = cache.key('orders', userId, ctx.broker);
  const rows = await cache.getOrFetch(key, cache.TTL.orders, () => router.queries.orders(ctx, {}), { force });
  return { broker: ctx.broker, orders: rows || [] };
}

/** Executed-trade history. */
async function history({ userId, broker, requestId, force = false, range = {} }) {
  const ctx = await _ctx({ userId, broker, requestId });
  const key = cache.key('history', userId, ctx.broker, `${range.from || ''}_${range.to || ''}_${range.page ?? ''}${range.today ? '_today' : ''}`);
  const rows = await cache.getOrFetch(key, cache.TTL.history, () => router.queries.history(ctx, range), { force });
  return { broker: ctx.broker, trades: rows || [] };
}

/** Quotes for the order pad / watchlist. */
async function quotes({ userId, broker, requestId, instruments, mode }) {
  const ctx = await _ctx({ userId, broker, requestId });
  if (!Array.isArray(instruments) || !instruments.length) return { broker: ctx.broker, quotes: [] };
  return { broker: ctx.broker, quotes: await router.queries.quotes(ctx, instruments, { mode }) };
}

/** Exchange session status. */
async function marketStatus({ userId, broker, requestId, exchange, force = false }) {
  const ctx = await _ctx({ userId, broker, requestId });
  const key = cache.key('marketStatus', userId, ctx.broker, exchange || 'all');
  const rows = await cache.getOrFetch(key, cache.TTL.marketStatus, () => router.queries.marketStatus(ctx, exchange), { force });
  return { broker: ctx.broker, markets: rows || [] };
}

/**
 * One-shot portfolio snapshot — funds + positions + holdings in parallel.
 *
 * A partial failure does NOT fail the whole call: a user whose holdings
 * endpoint is erroring should still see their funds and positions, with the
 * broken section reported. That is the difference between a degraded screen
 * and a blank one.
 */
async function summary({ userId, broker, requestId, force = false }) {
  const ctx = await _ctx({ userId, broker, requestId });
  const code = ctx.broker;

  const run = async (capability, fn, fallback) => {
    if (!_supports(code, capability)) return { ok: false, unsupported: true, data: fallback };
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      const e = BrokerError.from(err, code);
      return { ok: false, data: fallback, error: { code: e.code, message: e.message } };
    }
  };

  const [f, p, h] = await Promise.all([
    run(CAPABILITY.FUNDS, async () => (await funds({ userId, broker: code, requestId, force })).funds, null),
    run(CAPABILITY.POSITIONS, async () => (await positions({ userId, broker: code, requestId, force })).positions, []),
    run(CAPABILITY.HOLDINGS, async () => (await holdings({ userId, broker: code, requestId, force })).holdings, []),
  ]);

  const positionsPnl = (p.data || []).reduce((sum, x) => sum + (Number(x.pnl) || 0), 0);
  const holdingsPnl = (h.data || []).reduce((sum, x) => sum + (Number(x.pnl) || 0), 0);
  const investedValue = (h.data || []).reduce((sum, x) => sum + (Number(x.investedValue) || 0), 0);
  const currentValue = (h.data || []).reduce((sum, x) => sum + (Number(x.currentValue) || 0), 0);

  return {
    broker: code,
    funds: f.data,
    positions: p.data,
    holdings: h.data,
    totals: {
      positionsPnl: +positionsPnl.toFixed(2),
      holdingsPnl: +holdingsPnl.toFixed(2),
      totalPnl: +(positionsPnl + holdingsPnl).toFixed(2),
      investedValue: +investedValue.toFixed(2),
      currentValue: +currentValue.toFixed(2),
      openPositions: (p.data || []).length,
    },
    // Only present when something degraded — the UI can show a partial banner.
    errors: [f, p, h].filter((r) => r.error).map((r) => r.error),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { positions, holdings, funds, orders, history, quotes, marketStatus, summary };
