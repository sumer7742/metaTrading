/**
 * Risk engine — for HYBRID accounts only.
 *
 * Decides per-order whether a HYBRID account's order goes to A-book (LP)
 * or B-book (internal). Pure-A and pure-B accounts never hit this engine.
 *
 * Decision factors (in priority order):
 *   1. Large notional volume → A-book (cap broker exposure)
 *   2. High aggregate open exposure on the symbol → A-book
 *   3. Trader profile: PROFITABLE / SUSPICIOUS → A-book
 *   4. Trader profile: NEW / AVERAGE / LOSING → B-book
 *
 * Thresholds are tunable via env so we can dial broker risk appetite
 * without code changes:
 *   HYBRID_LARGE_NOTIONAL_USD   default 50000   per-order notional that flips to A
 *   HYBRID_MAX_BBOOK_EXPOSURE   default 500000  symbol-wide B-book cap
 *
 * Returns 'A_BOOK' | 'B_BOOK' (never 'HYBRID' — that's resolved here).
 */
const Position = require('../models/Position');
const User = require('../models/User');
const { BOOK_TYPE } = require('../config/constants');
const { mul, gt } = require('../utils/decimal');

const HYBRID_LARGE_NOTIONAL_USD = Number(process.env.HYBRID_LARGE_NOTIONAL_USD) || 50000;
const HYBRID_MAX_BBOOK_EXPOSURE = Number(process.env.HYBRID_MAX_BBOOK_EXPOSURE) || 500000;

/**
 * Aggregate the broker's B-book exposure on a symbol (sum of open
 * notional across users that internalised). When this is already large
 * we route NEW orders to the LP regardless of trader profile.
 */
const _bbookExposureOnSymbol = async (symbol) => {
  const positions = await Position.find({
    symbol,
    status: 'OPEN',
    // Optimistic filter — pre-router orders may not have executionSource
    // set yet. Counting all open positions over-states broker risk
    // slightly (safer than under-stating).
  })
    .select('quantity entryPrice')
    .lean();
  let exposure = 0;
  for (const p of positions) {
    exposure += Number(p.quantity || 0) * Number(p.entryPrice || 0);
  }
  return exposure;
};

/**
 * Trader profile classifier. Cheap heuristic; production-grade impl
 * would memoize per-user in Redis and recompute on FILLED events.
 */
const _classifyTrader = async (userId) => {
  const user = await User.findById(userId).select('userGroup riskOverride').lean();
  if (user?.riskOverride?.forceABook) return 'FORCE_A';
  if (user?.userGroup === 'VIP' || user?.userGroup === 'NO_BBOOK') return 'NO_BBOOK';

  const closed = await Position.find({ userId, status: 'CLOSED' }).select('realizedPnl').lean();
  if (closed.length < 10) return 'NEW';

  const winners = closed.filter((p) => Number(p.realizedPnl || 0) > 0);
  const losers = closed.filter((p) => Number(p.realizedPnl || 0) < 0);
  const winRate = winners.length / closed.length;
  const totalWin = winners.reduce((s, p) => s + Number(p.realizedPnl), 0);
  const totalLoss = Math.abs(losers.reduce((s, p) => s + Number(p.realizedPnl), 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? 99 : 0);

  if (winRate >= 0.8 && closed.length >= 30) return 'SUSPICIOUS';
  if (winRate >= 0.6 && profitFactor >= 2) return 'PROFITABLE';
  if (winRate < 0.35 && profitFactor < 0.5) return 'LOSING';
  return 'AVERAGE';
};

/**
 * decideHybridRoute — call only when account.bookType === HYBRID.
 * Returns { book, reason } where book ∈ { A_BOOK, B_BOOK }.
 */
const decideHybridRoute = async ({ userId, instrument, order }) => {
  const refPrice = order.price || instrument.lastPrice || '0';
  const notional = Number(mul(order.quantity, refPrice));

  // Rule 1 — large single-order notional → A
  if (Number.isFinite(notional) && notional >= HYBRID_LARGE_NOTIONAL_USD) {
    return { book: BOOK_TYPE.A_BOOK, reason: `notional ${notional.toFixed(2)} >= ${HYBRID_LARGE_NOTIONAL_USD}` };
  }

  // Rule 2 — aggregate B-book exposure on this symbol already large → A
  const symbolExposure = await _bbookExposureOnSymbol(instrument.symbol);
  if (symbolExposure >= HYBRID_MAX_BBOOK_EXPOSURE) {
    return {
      book: BOOK_TYPE.A_BOOK,
      reason: `symbol exposure ${symbolExposure.toFixed(0)} >= ${HYBRID_MAX_BBOOK_EXPOSURE}`,
    };
  }

  // Rule 3 — trader profile
  const profile = await _classifyTrader(userId);
  if (profile === 'FORCE_A' || profile === 'NO_BBOOK' || profile === 'PROFITABLE' || profile === 'SUSPICIOUS') {
    return { book: BOOK_TYPE.A_BOOK, reason: `trader profile ${profile}` };
  }
  return { book: BOOK_TYPE.B_BOOK, reason: `trader profile ${profile}` };
};

module.exports = { decideHybridRoute };
