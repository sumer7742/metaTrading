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
// Hard cap — beyond this aggregate symbol exposure the order is REJECTED
// (0 = disabled). Protects the broker book from runaway concentration.
const HYBRID_REJECT_EXPOSURE = Number(process.env.HYBRID_REJECT_EXPOSURE) || 0;
// When true, prefer user↔user matching whenever the book has opposing
// liquidity (broker stays flat + earns fees) before falling back to B-book.
const HYBRID_PREFER_INTERNAL_MATCHING = process.env.HYBRID_PREFER_INTERNAL_MATCHING !== 'false';

/** Does the internal order book hold opposing resting liquidity right now? */
const _hasOpposingLiquidity = (symbol, side) => {
  try {
    const me = require('../matching-engine/MatchingEngine');
    const snap = me.getSnapshot(symbol, 5) || {};
    const opp = side === 'BUY' ? snap.asks : snap.bids;
    return Array.isArray(opp) && opp.length > 0;
  } catch (_) {
    return false;
  }
};

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
 * decideHybridRoute — call only when executionMode === HYBRID.
 *
 * Returns { route, reason } where route ∈
 *   'INTERNAL_MATCHING' | 'B_BOOK' | 'A_BOOK' | 'REJECT'.
 *
 * Decision order (configurable via env): exposure hard-cap → reject;
 * winners/VIP/forced → A-book; large notional → A-book; symbol exposure
 * large → A-book; opposing book liquidity → internal matching; else B-book.
 */
const decideHybridRoute = async ({ userId, instrument, account, order }) => {
  const { ROUTING_RESULT } = require('../config/constants');
  const refPrice = order.price || instrument.lastPrice || '0';
  const notional = Number(mul(order.quantity, refPrice));
  const notionalNum = Number.isFinite(notional) ? notional : 0;

  const symbolExposure = await _bbookExposureOnSymbol(instrument.symbol);

  // 0 — hard exposure cap → reject (never warehouse beyond this).
  if (HYBRID_REJECT_EXPOSURE > 0 && symbolExposure + notionalNum >= HYBRID_REJECT_EXPOSURE) {
    return { route: 'REJECT', reason: `exposure ${(symbolExposure + notionalNum).toFixed(0)} >= reject cap ${HYBRID_REJECT_EXPOSURE}` };
  }

  // 1 — winners / VIP / forced → A-book (transfer their flow to the LP).
  const profile = await _classifyTrader(userId);
  if (profile === 'FORCE_A' || profile === 'NO_BBOOK' || profile === 'PROFITABLE' || profile === 'SUSPICIOUS') {
    return { route: ROUTING_RESULT.A_BOOK, reason: `trader profile ${profile}` };
  }

  // 2 — large single-order notional → A-book.
  if (notionalNum >= HYBRID_LARGE_NOTIONAL_USD) {
    return { route: ROUTING_RESULT.A_BOOK, reason: `notional ${notionalNum.toFixed(2)} >= ${HYBRID_LARGE_NOTIONAL_USD}` };
  }

  // 3 — aggregate B-book exposure on this symbol already large → A-book.
  if (symbolExposure >= HYBRID_MAX_BBOOK_EXPOSURE) {
    return { route: ROUTING_RESULT.A_BOOK, reason: `symbol exposure ${symbolExposure.toFixed(0)} >= ${HYBRID_MAX_BBOOK_EXPOSURE}` };
  }

  // 4 — opposing book liquidity → match user↔user (broker flat, earns fees).
  if (HYBRID_PREFER_INTERNAL_MATCHING && _hasOpposingLiquidity(instrument.symbol, order.side)) {
    return { route: ROUTING_RESULT.INTERNAL_MATCHING, reason: 'opposing book liquidity available' };
  }

  // 5 — default: broker internalises the flow (B-book).
  return { route: ROUTING_RESULT.B_BOOK, reason: `trader profile ${profile}, no opposing liquidity` };
};

module.exports = { decideHybridRoute };
