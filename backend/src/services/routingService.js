const Instrument = require('../models/Instrument');
const Position = require('../models/Position');
const Trade = require('../models/Trade');
const User = require('../models/User');
const { ROUTING, TRADING_MODE } = require('../config/constants');
const { D, gt, gte, lt, mul } = require('../utils/decimal');

/**
 * Order Routing Engine
 *
 * Decides where each order should be executed:
 *  - INTERNAL  — match against internal order book (default for crypto/private exchange)
 *  - EXTERNAL  — forward to external feed/liquidity provider (for forex/stocks under broker model)
 *  - B_BOOK    — broker becomes counterparty (profit/loss inverted vs trader)
 *
 * Routing decision factors (per doc §9.3):
 *  1. Instrument config: bBookEnabled, mode, b_book_priority
 *  2. User group: VIP/PROFITABLE/NEW/SUSPICIOUS
 *  3. Risk overrides: forceABook flag on user
 *  4. Position size relative to broker exposure limits
 *  5. User trading history (win-rate, profit factor)
 *
 * Doc §4.1 critical: B-book MUST be disabled in INTERNAL-Only mode (validated at instrument level).
 */

/**
 * Compute the user's "trader profile" used for routing decisions.
 * Cached per-call; in production this would be precomputed and cached in Redis.
 */
const _computeTraderProfile = async (userId) => {
  const closedPositions = await Position.find({ userId, status: 'CLOSED' }).lean();
  if (closedPositions.length < 10) {
    // Not enough history - treat as NEW
    return { tag: 'NEW', winRate: 0, profitFactor: 0, totalTrades: closedPositions.length };
  }

  const winners = closedPositions.filter((p) => Number(p.realizedPnl || 0) > 0);
  const losers = closedPositions.filter((p) => Number(p.realizedPnl || 0) < 0);
  const winRate = (winners.length / closedPositions.length) * 100;

  const totalWin = winners.reduce((s, p) => s + Number(p.realizedPnl), 0);
  const totalLoss = Math.abs(losers.reduce((s, p) => s + Number(p.realizedPnl), 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 99 : 0;

  let tag = 'AVERAGE';
  if (winRate >= 60 && profitFactor >= 2) tag = 'PROFITABLE'; // route to A-book to limit broker risk
  else if (winRate < 35 && profitFactor < 0.5) tag = 'LOSING'; // safe for B-book
  else if (winRate >= 80 && closedPositions.length >= 30) tag = 'SUSPICIOUS'; // unusually high - investigate

  return { tag, winRate, profitFactor, totalTrades: closedPositions.length };
};

/**
 * Decide routing for a single order. Returns one of ROUTING.* values.
 *
 * Decision tree:
 *   1. If user has riskOverride.forceABook -> always A-book (INTERNAL or EXTERNAL based on mode)
 *   2. If user.userGroup === 'VIP' or 'PROFITABLE' trader profile -> A-book (no broker risk on these)
 *   3. If instrument.bBookEnabled && user is NEW or LOSING -> B-book (broker keeps the loss)
 *   4. Else default to instrument's mode (INTERNAL or EXTERNAL)
 */
const decideRouting = async ({ userId, instrument, order }) => {
  // Critical safety: never B-book in Internal-Only mode (doc §4.1)
  if (instrument.mode === TRADING_MODE.INTERNAL && instrument.bBookEnabled) {
    console.warn(`[Routing] WARNING: B-book enabled on INTERNAL mode instrument ${instrument.symbol}. Forcing INTERNAL.`);
    return ROUTING.INTERNAL;
  }

  const user = await User.findById(userId).select('userGroup riskOverride').lean();
  const forceABook = user?.riskOverride?.forceABook === true;
  const group = user?.userGroup || 'DEFAULT';

  // Rule 1: explicit force A-book on user
  if (forceABook) {
    return instrument.mode === TRADING_MODE.EXTERNAL ? ROUTING.EXTERNAL : ROUTING.INTERNAL;
  }

  // Rule 2: VIP / explicit no-B-book groups always A-book
  if (group === 'VIP' || group === 'NO_BBOOK') {
    return instrument.mode === TRADING_MODE.EXTERNAL ? ROUTING.EXTERNAL : ROUTING.INTERNAL;
  }

  // Rule 3: B-book candidate check (only if instrument allows it)
  if (instrument.bBookEnabled) {
    const profile = await _computeTraderProfile(userId);

    // PROFITABLE traders -> A-book (broker doesn't want their flow)
    if (profile.tag === 'PROFITABLE') {
      return instrument.mode === TRADING_MODE.EXTERNAL ? ROUTING.EXTERNAL : ROUTING.INTERNAL;
    }

    // SUSPICIOUS -> A-book + flag for review
    if (profile.tag === 'SUSPICIOUS') {
      console.warn(`[Routing] Suspicious trader ${userId} flagged - routing A-book`);
      return instrument.mode === TRADING_MODE.EXTERNAL ? ROUTING.EXTERNAL : ROUTING.INTERNAL;
    }

    // NEW or LOSING -> B-book (broker keeps the spread + losses)
    if (profile.tag === 'NEW' || profile.tag === 'LOSING' || profile.tag === 'AVERAGE') {
      // Additional safety: cap B-book exposure per instrument
      const notional = mul(order.quantity, order.price || instrument.lastPrice || '1');
      const maxBookExposure = '500000'; // configurable per-instrument later
      if (gt(notional, maxBookExposure)) {
        return ROUTING.EXTERNAL; // too big - hedge externally
      }
      return ROUTING.B_BOOK;
    }
  }

  // Rule 4: default to instrument's mode
  if (instrument.mode === TRADING_MODE.EXTERNAL) return ROUTING.EXTERNAL;
  return ROUTING.INTERNAL;
};

/**
 * Get aggregate B-book exposure for an instrument.
 * Used for risk monitoring and alerts when broker exposure gets too large.
 *
 * From the broker's POV:
 *   trader BUYs  → broker is SHORT (sold to the trader) → netShort += qty
 *   trader SELLs → broker is LONG  (bought from the trader) → netLong += qty
 *
 * B-book trades record buyOrderId === sellOrderId (broker is synthetic
 * counterparty), so the trader's actual side has to be looked up from the
 * order doc — without that, every trade was being bucketed into netShort
 * regardless of direction.
 */
const Order = require('../models/Order');
const getBBookExposure = async (symbol) => {
  const trades = await Trade.find({
    symbol,
    routing: 'B_BOOK',
    executedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  }).lean();
  if (!trades.length) return { symbol, netLong: 0, netShort: 0, recentTradeCount: 0 };

  const orderIds = trades.map((t) => t.buyOrderId).filter(Boolean);
  const orders = await Order.find({ _id: { $in: orderIds } }).select('_id side').lean();
  const sideById = new Map(orders.map((o) => [String(o._id), o.side]));

  let netLong = 0;
  let netShort = 0;
  for (const t of trades) {
    const traderSide = sideById.get(String(t.buyOrderId));
    const qty = Number(t.quantity) || 0;
    if (traderSide === 'BUY') netShort += qty;
    else if (traderSide === 'SELL') netLong += qty;
  }
  return { symbol, netLong, netShort, recentTradeCount: trades.length };
};

module.exports = { decideRouting, getBBookExposure, _computeTraderProfile };
