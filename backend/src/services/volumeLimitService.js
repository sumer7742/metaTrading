/**
 * Per-instrument DAILY volume limits — tracked SEPARATELY for BUY and SELL.
 *
 * "Daily volume" = OPENING order volume (lots) executed for a symbol since the
 * start of the current UTC day, summed across ALL users, split by side. A new
 * BUY opening order is rejected once the day's BUY volume reaches the symbol's
 * dailyBuyLimit; SELL likewise against dailySellLimit. 0 on a side = unlimited.
 * Closing orders never count toward — and are never blocked by — the caps.
 */
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../config/constants');
const { AppError } = require('../utils/errors');

const startOfUtcDay = (d = new Date()) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

const sideOf = (s) => (String(s || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY');

// Executed opening volume today per side for many symbols → Map<symbol,{BUY,SELL}>.
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
        _id: { symbol: '$symbol', side: '$side' },
        qty: { $sum: { $convert: { input: { $ifNull: ['$filledQuantity', '$quantity'] }, to: 'double', onError: 0, onNull: 0 } } },
      },
    },
  ]);
  for (const r of rows) {
    const cur = map.get(r._id.symbol) || { BUY: 0, SELL: 0 };
    cur[sideOf(r._id.side)] += r.qty || 0;
    map.set(r._id.symbol, cur);
  }
  return map;
}

// Used opening volume today for ONE symbol → { BUY, SELL } (or one side).
async function getUsedDailyVolume(symbol, side) {
  const m = await getUsedDailyVolumeForSymbols([symbol]);
  const v = m.get(symbol) || { BUY: 0, SELL: 0 };
  return side ? (v[sideOf(side)] || 0) : v;
}

// Dashboard payload for one instrument: per-side { limit, used, remaining }.
async function getDailyVolumeUsage(instrument) {
  if (!instrument?.dailyVolumeLimitEnabled) {
    return { enabled: false, buy: { limit: null, used: 0, remaining: null }, sell: { limit: null, used: 0, remaining: null } };
  }
  const used = await getUsedDailyVolume(instrument.symbol); // { BUY, SELL }
  const buyLimit = Number(instrument.dailyBuyLimit) || 0;
  const sellLimit = Number(instrument.dailySellLimit) || 0;
  return {
    enabled: true,
    buy:  { limit: buyLimit > 0 ? buyLimit : null,  used: used.BUY,  remaining: buyLimit > 0 ? Math.max(0, buyLimit - used.BUY) : null },
    sell: { limit: sellLimit > 0 ? sellLimit : null, used: used.SELL, remaining: sellLimit > 0 ? Math.max(0, sellLimit - used.SELL) : null },
  };
}

// Throws AppError(413, DAILY_VOLUME_LIMIT_EXCEEDED) if this opening order would
// exceed the symbol's daily cap for its side. No-op for closes / unlimited.
async function assertWithinDailyLimit(instrument, order) {
  if (!instrument || !order) return;
  if (order.closeOnly) return;                      // never cap closes
  if (!instrument.dailyVolumeLimitEnabled) return;  // unlimited
  const side = sideOf(order.side);
  const limit = Number(side === 'SELL' ? instrument.dailySellLimit : instrument.dailyBuyLimit);
  if (!Number.isFinite(limit) || limit <= 0) return; // this side unlimited

  const requested = Number(order.quantity) || 0;
  if (requested <= 0) return;
  const used = await getUsedDailyVolume(instrument.symbol, side);
  if (used + requested > limit) {
    const remaining = Math.max(0, limit - used);
    throw new AppError(
      `Daily ${side} volume limit reached for ${instrument.symbol}: limit ${limit} lots, used ${used}, remaining ${remaining}. This ${side} order (${requested} lots) would exceed it.`,
      413,
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
