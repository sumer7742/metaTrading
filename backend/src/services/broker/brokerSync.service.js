/**
 * brokerSync.service.js — reconciliation and the polling fallback.
 *
 * "Use websocket where available. Fallback polling."
 *
 * Websockets miss things. They drop mid-fill, they reconnect after the fill
 * happened, and some brokers don't offer one at all. So the broker's order
 * book — not our socket feed — is the source of truth, and this service is
 * what keeps OrderSync honest against it.
 *
 * Three entry points:
 *   reconcileUser()  — pull one user's order book and apply any differences.
 *                      Runs after every (re)connect of a broker socket, which
 *                      is exactly when updates go missing.
 *   sweep()          — periodic pass over users who have OPEN orders. Only
 *                      those users, only while their exchange is open.
 *   start()/stop()   — the background loop, feature-flagged.
 *
 * Cost control is deliberate: an unbounded sweep across every connection would
 * exhaust broker rate limits on its own. We scope by "has a non-terminal order
 * updated in the last N hours", cap the batch, and skip users whose socket is
 * live and recently active.
 */

const OrderSync = require('../../models/OrderSync');
const orderService = require('./brokerOrder.service');
const router = require('../../brokers/BrokerRouter');
const audit = require('./brokerAudit.service');
const cache = require('./cache');
const marketHours = require('../marketHours');
const { BrokerError } = require('../../brokers/base/BrokerError');
const {
  TERMINAL_STATUSES, UPDATE_SOURCE, EXCHANGE_SESSION_KEY, PRIORITY,
} = require('../../brokers/constants');
const logger = require('../../utils/logger');

const ENABLED = () => String(process.env.BROKER_SYNC_ENABLED || 'true').toLowerCase() === 'true';
const INTERVAL_MS = Number(process.env.BROKER_SYNC_INTERVAL_MS) || 20000;
const BATCH = Number(process.env.BROKER_SYNC_BATCH) || 50;
const LOOKBACK_HOURS = Number(process.env.BROKER_SYNC_LOOKBACK_HOURS) || 12;

let _timer = null;
let _running = false;
let _lastSweep = null;

/**
 * Pull one user's live order book and apply anything we missed.
 *
 * @param {object} p { userId, broker, reason? }
 * @returns {Promise<{checked: number, updated: number}>}
 */
async function reconcileUser({ userId, broker, reason = 'manual' }) {
  const code = String(broker).toUpperCase();

  const open = await OrderSync.find({
    userId,
    broker: code,
    status: { $nin: TERMINAL_STATUSES },
    updatedAt: { $gte: new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000) },
  }).lean();

  if (!open.length) return { checked: 0, updated: 0 };

  let rows;
  try {
    // LOW priority: reconciliation must never delay a user's live order.
    rows = await router.dispatch({
      userId, broker: code, method: 'orders', args: [{}], priority: PRIORITY.LOW,
    });
  } catch (err) {
    const e = BrokerError.from(err, code);
    audit.log({
      userId, broker: code, stage: audit.STAGE.SYNC, action: 'reconcile', level: 'warn',
      message: `Reconcile failed: ${e.message}`, payload: { reason, code: e.code },
    });
    return { checked: open.length, updated: 0, error: e.code };
  }

  const byBrokerId = new Map();
  const byClientId = new Map();
  for (const r of rows || []) {
    if (r.orderId) byBrokerId.set(String(r.orderId), r);
    if (r.clientOrderId) byClientId.set(String(r.clientOrderId), r);
  }

  let updated = 0;
  for (const local of open) {
    const remote = byClientId.get(local.clientOrderId)
      || (local.brokerOrderId ? byBrokerId.get(String(local.brokerOrderId)) : null);
    if (!remote) continue;
    if (remote.status === local.status
      && Number(remote.filledQty || 0) === Number(local.filledQty || 0)) continue;

    await orderService.applyBrokerUpdate({
      userId, broker: code, update: remote, source: UPDATE_SOURCE.POLL,
    });
    updated++;
  }

  if (updated) {
    await cache.invalidateUser(userId, code);
    audit.log({
      userId, broker: code, stage: audit.STAGE.SYNC, action: 'reconcile',
      message: `Reconciled ${updated} order(s) from the broker order book`,
      payload: { reason, checked: open.length },
    });
  }
  return { checked: open.length, updated };
}

/**
 * One sweep across users with open orders.
 *
 * Only users who have a non-terminal order are touched, and only while at
 * least one Indian exchange is open — an idle overnight loop would burn rate
 * limit for nothing.
 */
async function sweep() {
  if (_running) return { skipped: 'already-running' };
  _running = true;
  const startedAt = Date.now();

  try {
    const anyOpen = ['NSE', 'BSE', 'MCX'].some((ex) => marketHours.isExchangeOpen(EXCHANGE_SESSION_KEY[ex] || ex));
    if (!anyOpen) return { skipped: 'markets-closed' };

    const targets = await OrderSync.aggregate([
      {
        $match: {
          status: { $nin: TERMINAL_STATUSES },
          updatedAt: { $gte: new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000) },
        },
      },
      { $group: { _id: { userId: '$userId', broker: '$broker' }, count: { $sum: 1 }, oldest: { $min: '$updatedAt' } } },
      { $sort: { oldest: 1 } },
      { $limit: BATCH },
    ]);

    let updated = 0;
    for (const t of targets) {
      try {
        const res = await reconcileUser({ userId: t._id.userId, broker: t._id.broker, reason: 'sweep' });
        updated += res.updated || 0;
      } catch (err) {
        logger.warn('[broker] sweep target failed', { userId: String(t._id.userId), broker: t._id.broker, err });
      }
    }

    _lastSweep = { at: new Date().toISOString(), targets: targets.length, updated, durationMs: Date.now() - startedAt };
    return _lastSweep;
  } finally {
    _running = false;
  }
}

function start() {
  if (_timer) return;
  if (!ENABLED()) {
    logger.info('[broker] sync sweep disabled (BROKER_SYNC_ENABLED=false)');
    return;
  }
  _timer = setInterval(() => {
    sweep().catch((e) => logger.warn('[broker] sync sweep failed', { err: e }));
  }, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
  logger.info('[broker] sync sweep started', { intervalMs: INTERVAL_MS, batch: BATCH });
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

const health = () => ({ enabled: ENABLED(), running: _running, intervalMs: INTERVAL_MS, lastSweep: _lastSweep });

module.exports = { reconcileUser, sweep, start, stop, health };
