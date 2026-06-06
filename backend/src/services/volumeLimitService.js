/**
 * Per-instrument DAILY volume limit (optional, off by default = unlimited).
 *
 * "Daily volume" = total OPENING order volume (lots) executed for a symbol
 * since the start of the current UTC day, summed across ALL users. Closing
 * orders never count toward — and are never blocked by — the cap, so a limit
 * can't trap open positions.
 *
 * Enforcement is reject-on-exceed: an opening order whose volume would push
 * the day's used total past the configured limit is rejected with a clear
 * error. (No silent partial fills — the trader gets an explicit message and
 * the remaining headroom.)
 */
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../config/constants');
const { AppError } = require('../utils/errors');

const startOfUtcDay = (d = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// Executed opening volume today for ONE symbol (sum of filledQuantity on
// FILLED / PARTIALLY_FILLED non-close orders).
async function getUsedDailyVolume(symbol) {
  const map = await getUsedDailyVolumeForSymbols([symbol]);
  return map.get(symbol) || 0;
}

// Same, batched for many symbols → Map<symbol, usedLots>. One aggregation.
async function getUsedDailyVolumeForSymbols(symbols = []) {
  const map = new Map();
  if (!symbols.length) return map;
  const rows = await Order.aggregate([
    {
      $match: {
        symbol: { $in: symbols },
        status: { $in: [ORDER_STATUS.FILLED, ORDER_STATUS.PARTIALLY_FILLED] },
        closeOnly: { $ne: true },
        createdAt: { $gte: startOfUtcDay() },
      },
    },
    {
      $group: {
        _id: '$symbol',
        // Prefer filledQuantity (actual executed lots); fall back to quantity.
        qty: {
          $sum: {
            $convert: {
              input: { $ifNull: ['$filledQuantity', '$quantity'] },
              to: 'double', onError: 0, onNull: 0,
            },
          },
        },
      },
    },
  ]);
  for (const r of rows) map.set(r._id, r.qty || 0);
  return map;
}

// Dashboard payload for one instrument: { enabled, limit, used, remaining }.
async function getDailyVolumeUsage(instrument) {
  const enabled = !!instrument?.dailyVolumeLimitEnabled && Number(instrument?.dailyVolumeLimit) > 0;
  if (!enabled) return { enabled: false, limit: null, used: 0, remaining: null };
  const limit = Number(instrument.dailyVolumeLimit);
  const used = await getUsedDailyVolume(instrument.symbol);
  return { enabled: true, limit, used, remaining: Math.max(0, limit - used) };
}

// Throws AppError(400, DAILY_VOLUME_LIMIT_EXCEEDED) if this opening order
// would exceed the symbol's daily cap. No-op for closes / unlimited symbols.
async function assertWithinDailyLimit(instrument, order) {
  if (!instrument || !order) return;
  if (order.closeOnly) return;                          // never cap closes
  if (!instrument.dailyVolumeLimitEnabled) return;      // unlimited
  const limit = Number(instrument.dailyVolumeLimit);
  if (!Number.isFinite(limit) || limit <= 0) return;    // 0 / invalid = unlimited

  const requested = Number(order.quantity) || 0;
  if (requested <= 0) return;
  const used = await getUsedDailyVolume(instrument.symbol);
  if (used + requested > limit) {
    const remaining = Math.max(0, limit - used);
    throw new AppError(
      `Daily volume limit reached for ${instrument.symbol}: limit ${limit} lots, used ${used}, remaining ${remaining}. This order (${requested} lots) would exceed it.`,
      400,
      'DAILY_VOLUME_LIMIT_EXCEEDED'
    );
  }
}

module.exports = {
  getUsedDailyVolume,
  getUsedDailyVolumeForSymbols,
  getDailyVolumeUsage,
  assertWithinDailyLimit,
};
