/**
 * Per-instrument LIFETIME volume limits — GLOBAL (across ALL users),
 * tracked separately for BUY and SELL across ALL time.
 *
 * "Lifetime volume" = the instrument's total EXECUTED OPENING order volume
 * (lots), summed over all users and all time, split by side. Computed live from
 * the Order collection (FILLED / PARTIALLY_FILLED, closeOnly excluded) so it
 * always reflects real executed flow and never needs a separate counter or
 * backfill. A new opening BUY is rejected for EVERY user once the instrument's
 * cumulative BUY volume reaches lifetimeBuyLimit (SELL vs lifetimeSellLimit).
 * 0 on a side = unlimited. Closing orders never count toward — and are never
 * blocked by — the caps. Limit changes affect future orders only (history is
 * read, never rewritten).
 *
 * Applies to every order path (market / limit / stop / copy / API) because
 * enforcement runs inside orderRouter, which every order flows through.
 */
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../config/constants');
const { AppError } = require('../utils/errors');

const sideOf = (s) => (String(s || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY');

// The instrument's executed opening volume (all users, all-time) → { BUY, SELL }
// (or a single side's number when `side` is given).
async function getUsedLifetimeVolume(symbol, side) {
  const out = { BUY: 0, SELL: 0 };
  if (!symbol) return side ? 0 : out;
  const rows = await Order.aggregate([
    {
      $match: {
        symbol,
        status: { $in: [ORDER_STATUS.FILLED, ORDER_STATUS.PARTIALLY_FILLED] },
        closeOnly: { $ne: true },
      },
    },
    {
      $group: {
        _id: '$side',
        qty: { $sum: { $convert: { input: { $ifNull: ['$filledQuantity', '$quantity'] }, to: 'double', onError: 0, onNull: 0 } } },
      },
    },
  ]);
  for (const r of rows) out[sideOf(r._id)] += r.qty || 0;
  return side ? (out[sideOf(side)] || 0) : out;
}

// Dashboard payload for one instrument: per-side { limit, used, remaining }.
// `used` is always the real global volume (even when the cap is disabled) so
// admins can see actual flow before enabling a limit.
async function getLifetimeVolumeUsage(instrument) {
  if (!instrument) return { enabled: false, buy: { limit: null, used: 0, remaining: null }, sell: { limit: null, used: 0, remaining: null } };
  const used = await getUsedLifetimeVolume(instrument.symbol);
  const enabled = !!instrument.lifetimeVolumeLimitEnabled;
  const buyLimit = Number(instrument.lifetimeBuyLimit) || 0;
  const sellLimit = Number(instrument.lifetimeSellLimit) || 0;
  const side = (limit, u) => ({
    limit: enabled && limit > 0 ? limit : null,
    used: u,
    remaining: enabled && limit > 0 ? Math.max(0, limit - u) : null,
  });
  return { enabled, buy: side(buyLimit, used.BUY), sell: side(sellLimit, used.SELL) };
}

// Throws AppError(413, LIFETIME_VOLUME_LIMIT_EXCEEDED) if this opening order
// would push the instrument's GLOBAL cumulative executed volume past the cap
// for its side. No-op for closes / unlimited sides.
async function assertWithinLifetimeLimit(instrument, order) {
  if (!instrument || !order) return;
  if (order.closeOnly) return;                         // never cap closes
  if (!instrument.lifetimeVolumeLimitEnabled) return;  // unlimited
  const side = sideOf(order.side);
  const limit = Number(side === 'SELL' ? instrument.lifetimeSellLimit : instrument.lifetimeBuyLimit);
  if (!Number.isFinite(limit) || limit <= 0) return;   // this side unlimited

  const requested = Number(order.quantity) || 0;
  if (requested <= 0) return;
  const used = await getUsedLifetimeVolume(instrument.symbol, side);
  if (used + requested > limit) {
    const remaining = Math.max(0, limit - used);
    throw new AppError(
      `Lifetime ${side} volume limit reached for ${instrument.symbol}: limit ${limit} lots, used ${used}, remaining ${remaining}. This ${side} order (${requested} lots) would exceed it.`,
      413,
      'LIFETIME_VOLUME_LIMIT_EXCEEDED'
    );
  }
}

module.exports = {
  getUsedLifetimeVolume,
  getLifetimeVolumeUsage,
  assertWithinLifetimeLimit,
};
