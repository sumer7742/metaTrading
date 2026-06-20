const Order = require('../models/Order');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const Position = require('../models/Position');
const matchingEngine = require('../matching-engine/MatchingEngine');
const { updateCandlesForTrade } = require('../services/candleService');
const orderRouter = require('../services/orderRouter.service');
const walletService = require('../services/walletService');
const Trade = require('../models/Trade');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { ORDER_TYPE, ORDER_SIDE, ORDER_STATUS, POSITION_STATUS } = require('../config/constants');
const { gt, lt, mul, div, sub, eq, add } = require('../utils/decimal');

/**
 * Apply the 3-month history clip to a Mongo filter for any of the user's
 * plan-suspended accounts. Returns the augmented filter.
 *
 *   - Non-suspended accounts: full history (unchanged).
 *   - Suspended accounts: only docs where `dateField` is within the last 3
 *     months are returned.
 *
 * Implementation: rewrite the filter as a $or so the two cohorts can be
 * unioned in a single query. If the caller already passed an accountId
 * that is suspended, we just stamp the date floor on the existing filter.
 */
const SUSPENDED_HISTORY_WINDOW_MS = 3 * 30 * 24 * 60 * 60 * 1000; // ~3 months
const applySuspendedHistoryClip = async (userId, filter, dateField) => {
  const suspendedAccounts = await TradingAccount.find({
    userId,
    planSuspendedAt: { $ne: null },
  })
    .select('_id')
    .lean();
  if (!suspendedAccounts.length) return filter;

  const suspendedIds = suspendedAccounts.map((a) => a._id);
  const cutoff = new Date(Date.now() - SUSPENDED_HISTORY_WINDOW_MS);

  // Caller filtered to a specific account already.
  if (filter.accountId) {
    const isSuspended = suspendedIds.some((id) => String(id) === String(filter.accountId));
    if (!isSuspended) return filter;
    const existing = filter[dateField] || {};
    const existingGte = existing.$gte ? new Date(existing.$gte) : null;
    const effectiveGte = existingGte && existingGte > cutoff ? existingGte : cutoff;
    return { ...filter, [dateField]: { ...existing, $gte: effectiveGte } };
  }

  // No specific account: split into two cohorts via $or so non-suspended
  // accounts keep full history and suspended ones get clipped.
  const suspendedClause = {
    accountId: { $in: suspendedIds },
    [dateField]: { $gte: cutoff },
  };
  const otherClause = { accountId: { $nin: suspendedIds } };
  return { ...filter, $or: [otherClause, suspendedClause] };
};

/**
 * Compute the margin that *this* order would lock, accounting for an existing
 * open position. If the order side is opposite to the position, the overlapping
 * qty is just closing — no new margin needed for that portion.
 *
 * Returns { marginAmount, refPrice, openQty } where:
 *   marginAmount = (openQty * refPrice) / leverage
 *   openQty      = qty that opens new exposure (0 if order fully closes existing)
 */
const _computeMarginToLock = async ({ instrument, side, type, qty, price, stopPrice, leverage, account, symbol }) => {
  // Reference price by type:
  //   MARKET → last traded price (best estimate of fill price)
  //   LIMIT  → user's limit price
  //   STOP   → stopPrice (the trigger), since execution happens around that level.
  //            STOP-LIMIT is conservative: pick max(stop, limit) for BUY / min for SELL
  //            so we never under-lock the worst-case fill cost.
  let refPrice;
  if (type === ORDER_TYPE.MARKET) {
    refPrice = instrument.lastPrice || '0';
  } else if (type === ORDER_TYPE.STOP) {
    if (stopPrice && price) {
      refPrice = side === 'BUY'
        ? (gt(stopPrice, price) ? stopPrice : price)
        : (lt(stopPrice, price) ? stopPrice : price);
    } else {
      refPrice = String(stopPrice || price || instrument.lastPrice || '0');
    }
  } else {
    refPrice = String(price || instrument.lastPrice || '0');
  }
  if (!gt(refPrice, '0')) return { marginAmount: '0', refPrice: '0', openQty: '0' };

  const existing = await Position.findOne({
    accountId: account._id,
    symbol,
    status: POSITION_STATUS.OPEN,
  });

  let openQty = qty;
  if (existing && existing.side !== side) {
    // Opposite side — closing/reducing first, then any remainder opens flip.
    if (gt(existing.quantity, qty) || eq(existing.quantity, qty)) openQty = '0';
    else openQty = sub(qty, existing.quantity);
  }
  const marginAmount = gt(openQty, '0') ? div(mul(openQty, refPrice), String(leverage || 1)) : '0';
  return { marginAmount, refPrice, openQty };
};

/**
 * Compute the current effective bid/ask for an instrument from its
 * lastPrice + spread config. Mirrors the client-side derivation in
 * MarketWatch so server and UI agree on the "current market".
 */
const _currentBidAsk = (instrument) => {
  const last = Number(instrument?.lastPrice || 0);
  if (!last || !Number.isFinite(last)) return { bid: 0, ask: 0 };
  const spread = Number(instrument.spreadValue || 0);
  const half = spread / 2;
  if (instrument.spreadType === 'PERCENTAGE') {
    return { bid: last * (1 - half), ask: last * (1 + half) };
  }
  return { bid: last - half, ask: last + half };
};

/**
 * Resolve a unified "LIMIT-tab" order into the underlying engine type.
 * The frontend's order panel presents only MARKET and LIMIT to the user;
 * internally a "LIMIT" with a price ABOVE the ask (for BUY) is actually
 * a breakout STOP order. This helper centralises the disambiguation so
 * the same rules apply across all entry points (REST, OCO, etc).
 *
 *   BUY:
 *     limit < ask  → 'LIMIT'   (buy on a dip)
 *     limit > ask  → 'STOP'    (buy on a breakout)
 *     limit = ask  → 'INVALID' (would fill at market — use MARKET instead)
 *
 *   SELL:
 *     limit > bid  → 'LIMIT'   (sell into strength)
 *     limit < bid  → 'STOP'    (sell on a breakdown)
 *     limit = bid  → 'INVALID'
 */
function resolveLimitTabOrderType({ side, limitPrice, currentBid, currentAsk }) {
  const price = Number(limitPrice);
  if (!Number.isFinite(price) || price <= 0) return 'INVALID';
  if (side === 'BUY') {
    if (!Number.isFinite(currentAsk) || currentAsk <= 0) return 'INVALID';
    if (price < currentAsk) return 'LIMIT';
    if (price > currentAsk) return 'STOP';
    return 'INVALID';
  }
  if (side === 'SELL') {
    if (!Number.isFinite(currentBid) || currentBid <= 0) return 'INVALID';
    if (price > currentBid) return 'LIMIT';
    if (price < currentBid) return 'STOP';
    return 'INVALID';
  }
  return 'INVALID';
}

const placeOrder = asyncHandler(async (req, res) => {
  const {
    accountId,
    symbol,
    side,
    stopLoss,
    takeProfit,
    leverage,
    idempotencyKey,
  } = req.body;
  // `quantity` may be overridden by a fixed/scheduled instrument volume lock.
  let { quantity } = req.body;
  // The frontend now sends `orderMode` ('MARKET' | 'LIMIT'); legacy callers
  // can still send `type` directly. When `orderMode === 'LIMIT'` we
  // auto-resolve the engine-level type (LIMIT vs STOP) from the price
  // direction relative to the current market — see resolveLimitTabOrderType.
  let { orderMode, type, price, stopPrice } = req.body;

  // Idempotency check
  if (idempotencyKey) {
    const existing = await Order.findOne({ idempotencyKey });
    if (existing) return sendSuccess(res, existing);
  }

  if (!symbol || typeof symbol !== 'string') throw new AppError('symbol required', 400);
  if (!accountId) throw new AppError('accountId required', 400);
  if (!Object.values(ORDER_SIDE).includes(side)) throw new AppError('Invalid side', 400);
  if (quantity === undefined || quantity === null || quantity === '') {
    throw new AppError('Quantity required', 400);
  }
  if (!gt(quantity, '0')) throw new AppError('Quantity must be > 0', 400);

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId, isActive: true });
  if (!account) throw new AppError('Account not found', 404);

  const instrument = await Instrument.findOne({ symbol: symbol.toUpperCase(), isActive: true });
  if (!instrument) throw new AppError('Instrument not active', 404);

  // ─── Market-session gate ────────────────────────────────────────────
  // Exchange-bound instruments (NSE/BSE/MCX) only trade in-session; crypto/
  // forex (no `exchange`) stay 24/7. Keeps Indian orders from being placed
  // when the exchange is closed/holiday/weekend.
  {
    const { isInstrumentTradeable } = require('../services/marketHours');
    const { tradeable, session } = isInstrumentTradeable(instrument);
    if (!tradeable) {
      throw new AppError(
        `${instrument.exchange || 'Market'} is closed (${session.reason}). Trading hours ${session.opensAt}–${session.closesAt} IST.`,
        400,
        'MARKET_CLOSED'
      );
    }
  }

  // ─── Account-tier guards ────────────────────────────────────────────
  // 1. Leverage cap — STANDARD = 1:100, all others unlimited. When the
  //    tier returns null, no cap applies.
  // 2. Buy-close-only — IC tiers (STANDARD_IC / PRO_IC / FREE_IC) can
  //    open BUY only. SELL is permitted only as a close (reduceOnly or
  //    closeOnly) and only when an open LONG exists to reduce.
  const accountFeeService = require('../services/accountFeeService');
  const tierMaxLeverage = await accountFeeService.getAccountMaxLeverage(account);
  if (tierMaxLeverage != null && Number(req.body.leverage) > tierMaxLeverage) {
    throw new AppError(
      `Your account tier (${account.accountType}) caps leverage at 1:${tierMaxLeverage}.`,
      400,
      'LEVERAGE_OVER_TIER_CAP'
    );
  }
  if ((await accountFeeService.isBuyCloseOnly(account)) && side === 'SELL') {
    const isClose = req.body.closeOnly === true || req.body.reduceOnly === true;
    if (!isClose) {
      throw new AppError(
        `Your account tier (${account.accountType}) is buy-only. SELL is allowed only to close an existing long position.`,
        400,
        'SELL_NOT_ALLOWED_ON_IC_TIER'
      );
    }
    // Sanity check — a "close" SELL needs an actual LONG to reduce.
    const Position = require('../models/Position');
    const longOpen = await Position.findOne({
      accountId: account._id,
      symbol: instrument.symbol,
      positionSide: 'LONG',
      status: { $in: ['OPEN', 'CLOSING'] },
    }).lean();
    if (!longOpen) {
      throw new AppError(
        'No open long position on this symbol to close.',
        400,
        'NO_LONG_TO_CLOSE'
      );
    }
  }

  // ─── orderMode → engine type resolution ────────────────────────────
  // New unified path: frontend sends orderMode='MARKET' | 'LIMIT' (no STOP
  // tab in the UI). For LIMIT we look at the user's price relative to the
  // current ask (BUY) or bid (SELL) and decide whether the engine should
  // treat this as a LIMIT (better price) or STOP (breakout). Backward-
  // compat: if `type` is sent directly, we honor it — any internal API
  // user/admin tool that already uses LIMIT/STOP/MARKET keeps working.
  if (orderMode === 'LIMIT') {
    const { bid: curBid, ask: curAsk } = _currentBidAsk(instrument);
    const resolved = resolveLimitTabOrderType({
      side,
      limitPrice: price,
      currentBid: curBid,
      currentAsk: curAsk,
    });
    if (resolved === 'INVALID') {
      throw new AppError(
        'Limit price cannot be equal to current market price. Use Market order instead.',
        400,
        'LIMIT_INVALID'
      );
    }
    type = resolved; // 'LIMIT' or 'STOP'
    if (resolved === 'STOP') {
      // For STOP-tab equivalent: the user-entered price is the trigger.
      // Move it into stopPrice and clear price (engine treats this as
      // STOP-MARKET — fills at market on trigger).
      stopPrice = String(price);
      price = undefined;
    }
  } else if (orderMode === 'MARKET') {
    type = 'MARKET';
    price = undefined;
    stopPrice = undefined;
  }
  // else: caller sent `type` directly — keep it and validate below.

  if (!Object.values(ORDER_TYPE).includes(type)) throw new AppError('Invalid type', 400);
  if (type !== 'MARKET' && type !== 'STOP' && !price) {
    throw new AppError('Price required for non-market orders', 400);
  }
  if (type === 'STOP' && !stopPrice) {
    throw new AppError('Stop price required for stop orders', 400);
  }

  // Direction validation — same rules apply regardless of how we got here
  // (orderMode resolution OR direct `type` from a legacy caller). Skipped
  // when the resolution above already produced a STOP, because a "BUY at
  // a price above ask" is the LEGITIMATE BUY STOP case (breakout).
  if (type === ORDER_TYPE.LIMIT) {
    const { bid: curBid, ask: curAsk } = _currentBidAsk(instrument);
    const limitPx = Number(price);
    if (!Number.isFinite(limitPx) || limitPx <= 0) {
      throw new AppError('Invalid limit price', 400);
    }
    if (curAsk > 0 && side === 'BUY' && limitPx >= curAsk) {
      throw new AppError(
        `Buy limit price must be below current market price (current ask ${curAsk}).`,
        400, 'LIMIT_INVALID'
      );
    }
    if (curBid > 0 && side === 'SELL' && limitPx <= curBid) {
      throw new AppError(
        `Sell limit price must be above current market price (current bid ${curBid}).`,
        400, 'LIMIT_INVALID'
      );
    }
  }

  // Instrument override service — used for the leverage cap below. Volume is
  // bounded only by the min/max order size validated next (no fixed volume).
  const instrumentOverrideService = require('../services/instrumentOverrideService');

  // Validate min/max order size
  if (instrument.minOrderSize && lt(quantity, instrument.minOrderSize)) {
    throw new AppError(
      `Quantity ${quantity} below minimum order size ${instrument.minOrderSize} for ${instrument.symbol}`,
      400
    );
  }
  if (instrument.maxOrderSize && gt(quantity, instrument.maxOrderSize)) {
    throw new AppError(
      `Quantity ${quantity} exceeds max order size ${instrument.maxOrderSize} for ${instrument.symbol}`,
      400
    );
  }

  // Per-account total open-notional cap. Doc §4: admin can constrain how
  // much exposure a single account carries. Cheap sum over OPEN positions;
  // we project the new order's notional on top before comparing.
  if (account.maxPositionSize && gt(account.maxPositionSize, '0')) {
    const openPositions = await Position.find({
      accountId: account._id,
      status: POSITION_STATUS.OPEN,
    }).select('quantity entryPrice').lean();
    let openNotional = '0';
    for (const p of openPositions) {
      openNotional = add(openNotional, mul(p.quantity || '0', p.entryPrice || '0'));
    }
    const projected = mul(
      String(quantity),
      String(price || instrument.lastPrice || '0')
    );
    const totalAfter = add(openNotional, projected);
    if (gt(totalAfter, account.maxPositionSize)) {
      throw new AppError(
        `Total open notional ${totalAfter} would exceed account cap ${account.maxPositionSize}`,
        400,
        'MAX_POSITION_SIZE_EXCEEDED'
      );
    }
  }

  // Resolve leverage with the platform's priority-based rule:
  //   1. instrument.maxLeverage      — if set (>0), it's the FINAL value
  //                                    even when higher OR lower than what
  //                                    the account would allow
  //   2. account.leverage / plan     — used when the instrument hasn't
  //                                    set its own
  //   3. SYSTEM_DEFAULT_LEVERAGE     — final fallback (100)
  //
  // Practical effect: a crypto with maxLeverage=500 caps the trade at
  // 1:500 even if the user's plan is unlimited; an instrument left
  // un-set inherits the account's effective leverage.
  const SYSTEM_DEFAULT_LEVERAGE = 100;
  const instMax = Number(instrument.maxLeverage);
  const hasInstCap = Number.isFinite(instMax) && instMax > 0;

  // Effective cap from the priority chain.
  let effectiveCap;
  if (hasInstCap) {
    effectiveCap = instMax;
  } else if (Number.isFinite(Number(account.leverage)) && Number(account.leverage) > 0) {
    effectiveCap = Number(account.leverage);
  } else {
    effectiveCap = SYSTEM_DEFAULT_LEVERAGE;
  }

  // Scheduled instrument leverage override — during an active window the
  // override leverage becomes the cap for NEW positions (open positions are
  // never modified). Falls back to the chain above if there's no override.
  try {
    const lev = await instrumentOverrideService.getEffectiveLeverage(instrument);
    if (lev.isOverride && Number(lev.value) > 0) effectiveCap = Number(lev.value);
  } catch (_) { /* keep the default cap */ }

  let orderLeverage;
  if (leverage != null) {
    orderLeverage = Number(leverage);
    // Clamp (don't reject) to the resolved cap so the user can't request
    // more than the instrument allows. A request at the unlimited sentinel
    // when the instrument is capped just snaps down to the cap.
    if (orderLeverage > effectiveCap) orderLeverage = effectiveCap;
  } else {
    orderLeverage = effectiveCap;
  }
  if (!Number.isFinite(orderLeverage) || orderLeverage < 1) orderLeverage = 1;

  // Margin lock: compute how much new exposure this order opens (closing-leg
  // is netted out against existing position), and lock that from free balance.
  // STOP orders also lock at placement so the user can't double-spend the
  // funds while the stop sits pending — released on cancel.
  const { marginAmount, openQty } = await _computeMarginToLock({
    instrument,
    side,
    type,
    qty: String(quantity),
    price,
    stopPrice,
    leverage: orderLeverage,
    account,
    symbol: instrument.symbol,
  });

  // Routing is decided AFTER the order doc exists (in orderRouter.routeOrder)
  // because the router needs an Order doc to stamp executionSource onto.
  // Order is created with default routing/executionSource which the router
  // overwrites before submitting to the engine/LP.
  // Hedge mode — opening orders are explicitly tagged with their target
  // positionSide so the matching engine routes the fill to the correct
  // (LONG/SHORT) bucket. BUY opens/adds to LONG, SELL opens/adds to SHORT.
  // Legacy callers that don't send positionSide get this default; explicit
  // close orders (closePosition controller) override with the source
  // position's side so SELL-close-of-LONG hits LONG, not SHORT.
  const orderPositionSide = side === 'BUY' ? 'LONG' : 'SHORT';

  const order = await Order.create({
    userId: req.userId,
    accountId,
    instrumentId: instrument._id,
    symbol: instrument.symbol,
    side,
    positionSide: orderPositionSide,
    type,
    quantity: String(quantity),
    price: price ? String(price) : undefined,
    stopPrice: stopPrice ? String(stopPrice) : undefined,
    stopLoss: stopLoss ? String(stopLoss) : undefined,
    takeProfit: takeProfit ? String(takeProfit) : undefined,
    leverage: orderLeverage,
    status: ORDER_STATUS.PENDING,
    idempotencyKey,
    // Persisted on order so cancel/reject can release the exact amount
    // even if position state changes in between.
    lockedMargin: marginAmount,
  });

  if (gt(marginAmount, '0')) {
    try {
      await walletService.lockMargin({
        userId: req.userId,
        accountId,
        currency: account.baseCurrency || 'USD',
        amount: marginAmount,
        orderId: order._id,
        note: `Margin for ${side} ${openQty} ${instrument.symbol}`,
      });
    } catch (e) {
      // Roll back the order we just created so we don't leave a dangling pending
      order.status = ORDER_STATUS.REJECTED;
      order.rejectionReason = e.message;
      await order.save();
      throw e;
    }
  }

  // STOP and LIMIT orders rest as PENDING until the price-monitor worker
  // triggers them. Pre-fix LIMITs went straight to the engine, which has
  // a B-book / external fallback that fills at market price regardless of
  // the limit constraint — that's how a BUY LIMIT placed below market was
  // ending up filled immediately. Now LIMITs only execute when the worker
  // sees the market cross the limit price (ask <= BUY limit, bid >= SELL
  // limit) and submits the order to the engine.
  if (type === ORDER_TYPE.STOP || type === ORDER_TYPE.LIMIT) {
    return sendSuccess(res, order, 201);
  }

  // Route via the new per-account router. It picks INTERNAL vs LP based
  // on account.bookType (+ riskEngine for HYBRID), stamps executionSource
  // on the order, and dispatches to the appropriate execution service.
  const { settledOrder, executionSource } = await orderRouter.routeOrder({
    order,
    userId: req.userId,
  });

  // ── Copy-trading fan-out ────────────────────────────────────────────
  // If the user has public followers, fire mirror orders on each.
  // Best-effort: a failure here must NOT block the parent's order
  // response. Skipped for closeOnly/reduceOnly so we don't mirror
  // close orders (the close path has its own hook).
  if (settledOrder && !order.closeOnly && !order.reduceOnly) {
    setImmediate(async () => {
      try {
        // Resolve the resulting OPEN position created by this order.
        const pos = await Position.findOne({
          userId: req.userId,
          accountId: order.accountId,
          symbol: order.symbol,
          status: POSITION_STATUS.OPEN,
        }).sort({ createdAt: -1 }).lean();
        if (pos) {
          const copyService = require('../services/copyTradingService');
          await copyService.onMasterOrderFilled({ order: settledOrder.toObject?.() || settledOrder, position: pos });
        }
      } catch (e) {
        console.error('[copyTrading] fan-out (open) failed:', e.message);
      }
    });
  }

  // Update candles for any trades that just executed
  // (in MVP we look up trades created after order creation)
  const recentTrades = await Trade.find({
    symbol: order.symbol,
    $or: [{ buyOrderId: order._id }, { sellOrderId: order._id }],
  }).lean();
  for (const t of recentTrades) {
    await updateCandlesForTrade({
      symbol: t.symbol,
      price: t.price,
      quantity: t.quantity,
      ts: t.executedAt.getTime(),
    });
  }

  // executionSource on the response so the UI can show "Filled via LP"
  // / "Filled internally" if it wants. The order doc itself also carries it.
  sendSuccess(res, { ...settledOrder.toObject?.() || settledOrder, executionSource }, 201);
});

const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.userId });
  if (!order) throw new AppError('Order not found', 404);
  if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) {
    throw new AppError('Order cannot be cancelled', 400);
  }
  // Route the cancel — for A-book orders this also cancels on the LP so
  // the upstream venue doesn't fill an order the user thinks is dead.
  await orderRouter.routeCancel({ order });

  // Release the unfilled portion's margin. Filled portion's margin stays
  // locked because it's now backing the resulting position (released on
  // position close via settleTradeClose).
  if (gt(order.lockedMargin || '0', '0')) {
    // Floor remaining at 0 — under decimal-noise edge cases filledQuantity
    // can drift slightly above quantity, which would yield a negative
    // releaseAmt and unwind margin in the wrong direction.
    const rawRemaining = sub(order.quantity, order.filledQuantity || '0');
    const remaining = gt(rawRemaining, '0') ? rawRemaining : '0';
    if (gt(remaining, '0')) {
      const releaseAmt = div(mul(order.lockedMargin, remaining), order.quantity);
      const account = await TradingAccount.findById(order.accountId);
      await walletService.releaseMargin({
        userId: order.userId,
        accountId: order.accountId,
        currency: account?.baseCurrency || 'USD',
        amount: releaseAmt,
        orderId: order._id,
        note: `Cancel: released ${releaseAmt} for unfilled ${remaining}`,
      });
    }
  }

  sendSuccess(res, order);
});

const listOpen = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    userId: req.userId,
    status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] },
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!orders.length) return sendSuccess(res, []);

  // A pending order carries no fee yet — it's only charged when it fills into a
  // Position and that position closes. Surface an ESTIMATE (account fee model at
  // the order price, pnl=0) + the fee category so the UI shows it under the
  // right column. Display estimate only; no stored value/calculation changes.
  const accountFeeService = require('../services/accountFeeService');
  const acctIds = [...new Set(orders.map((o) => String(o.accountId)).filter(Boolean))];
  const symbols = [...new Set(orders.map((o) => o.symbol).filter(Boolean))];
  const [accts, insts] = await Promise.all([
    acctIds.length ? TradingAccount.find({ _id: { $in: acctIds } }).select('accountType').lean() : [],
    symbols.length ? Instrument.find({ symbol: { $in: symbols } }).select('symbol commissionOverrides commissionType commissionPercent commissionPerTrade').lean() : [],
  ]);
  const accMap = new Map(accts.map((a) => [String(a._id), a]));
  const iMap = new Map(insts.map((i) => [i.symbol, i]));

  for (const o of orders) {
    const acct = accMap.get(String(o.accountId));
    const inst = iMap.get(o.symbol);
    const px = o.price != null ? Number(o.price) : (o.stopPrice != null ? Number(o.stopPrice) : null);
    let est = 0;
    try {
      if (inst && acct && px != null && Number(o.quantity) > 0) {
        est = Number(await accountFeeService.computeCloseFee({
          account: { accountType: acct.accountType },
          instrument: inst,
          closeQty: Number(o.quantity),
          closePrice: px,
          closePnl: 0,
        })) || 0;
      }
    } catch (_) { est = 0; }
    let cat = 'COMMISSION';
    try { if (inst) cat = await accountFeeService.resolveFeeCategory({ account: { accountType: acct?.accountType }, instrument: inst }); } catch (_) { cat = 'COMMISSION'; }
    o.commission = Math.round((est + Number.EPSILON) * 100) / 100;
    o.feeCategory = cat;
    o.commissionEstimated = true;
  }
  sendSuccess(res, orders);
});

const listHistory = asyncHandler(async (req, res) => {
  const baseFilter = {
    userId: req.userId,
    status: { $in: [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED] },
  };
  // Suspended accounts only show the last 3 months of history (plan rule).
  // Non-suspended accounts keep full history.
  const filter = await applySuspendedHistoryClip(req.userId, baseFilter, 'createdAt');
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  sendSuccess(res, orders);
});

/**
 * Trade history: closed positions for the authenticated user.
 *
 * Query params (all optional):
 *   accountId   - filter to a single account
 *   symbol      - filter to a single instrument symbol
 *   side        - 'BUY' | 'SELL'
 *   from / to   - ISO date range on closedAt
 *   page, limit - pagination (1-based; defaults: 1 / 30)
 *
 * Response includes a `summary` block computed across the FILTERED set
 * (not just the current page) so the footer cards can show TOTAL TRADES,
 * TOTAL LOT, WINS, LOSSES and NET P/L. The summary is intentionally cheap
 * — a single Mongo aggregation, no per-doc work.
 */
// Tag each position/trade row with its DISPLAY fee category ('COMMISSION' |
// 'CHARGES'), derived from the account's fee type (+ instrument override). The
// UI uses this so a trade's single fee shows under exactly one column. This is
// display metadata only — no stored value or calculation changes.
async function attachFeeCategory(rows) {
  if (!rows || !rows.length) return rows;
  const acctIds = [...new Set(rows.map((r) => String(r.accountId)).filter(Boolean))];
  const instIds = [...new Set(rows.map((r) => String(r.instrumentId)).filter(Boolean))];
  const [accts, insts] = await Promise.all([
    acctIds.length ? TradingAccount.find({ _id: { $in: acctIds } }).select('accountType').lean() : [],
    instIds.length ? Instrument.find({ _id: { $in: instIds } }).select('commissionOverrides commissionType commissionPercent commissionPerTrade').lean() : [],
  ]);
  const accMap = new Map(accts.map((a) => [String(a._id), a]));
  const instMap = new Map(insts.map((i) => [String(i._id), i]));
  const accountFeeService = require('../services/accountFeeService');
  const cache = new Map(); // (accountType|instrumentId) → category
  for (const r of rows) {
    const acct = accMap.get(String(r.accountId));
    const inst = instMap.get(String(r.instrumentId));
    const key = `${acct?.accountType || ''}|${String(r.instrumentId)}`;
    let cat = cache.get(key);
    if (cat === undefined) {
      try { cat = await accountFeeService.resolveFeeCategory({ account: acct, instrument: inst }); }
      catch (_) { cat = 'COMMISSION'; }
      cache.set(key, cat);
    }
    r.feeCategory = cat;
  }
  return rows;
}

const positionHistory = asyncHandler(async (req, res) => {
  const {
    accountId,
    accountIds, // optional CSV — used when the FE picks "All" with a TYPE filter
    symbol,
    side,
    from,
    to,
    page: pageRaw = '1',
    limit: limitRaw = '30',
  } = req.query;

  const baseFilter = { userId: req.userId, status: POSITION_STATUS.CLOSED };
  if (accountId) {
    baseFilter.accountId = accountId;
  } else if (accountIds) {
    // CSV list — restricts the rollup to a specific set of accounts
    // (e.g. all REAL accounts the user owns). The userId guard above
    // already ensures the caller can't query someone else's accounts.
    const ids = String(accountIds).split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length) baseFilter.accountId = { $in: ids };
  }
  if (symbol) baseFilter.symbol = String(symbol).toUpperCase();
  if (side && (side === 'BUY' || side === 'SELL')) baseFilter.side = side;
  if (from || to) {
    baseFilter.closedAt = {};
    if (from) baseFilter.closedAt.$gte = new Date(from);
    if (to) baseFilter.closedAt.$lte = new Date(to);
  }
  // Plan-suspended accounts: clip history to last 3 months.
  const filter = await applySuspendedHistoryClip(req.userId, baseFilter, 'closedAt');

  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 30));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Position.find(filter).sort({ closedAt: -1 }).skip(skip).limit(limit).lean(),
    Position.countDocuments(filter),
  ]);
  await attachFeeCategory(items);

  // Aggregate summary across the filtered set (not just this page).
  // We keep numbers as JS Number here — cumulative trade counts and lot sums
  // don't need the Decimal precision that individual orders do.
  const aggResult = await Position.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalTrades: { $sum: 1 },
        totalLot: { $sum: { $toDouble: '$quantity' } },
        netPnl: { $sum: { $toDouble: '$realizedPnl' } },
        wins: { $sum: { $cond: [{ $gt: [{ $toDouble: '$realizedPnl' }, 0] }, 1, 0] } },
        losses: { $sum: { $cond: [{ $lt: [{ $toDouble: '$realizedPnl' }, 0] }, 1, 0] } },
      },
    },
  ]);
  const summary = aggResult[0] || { totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 };
  delete summary._id;

  sendSuccess(res, {
    items,
    summary,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

// POSITIONS
const listPositions = asyncHandler(async (req, res) => {
  const positions = await Position.find({ userId: req.userId, status: POSITION_STATUS.OPEN }).lean();
  if (!positions.length) return sendSuccess(res, []);

  // Batch-fetch all unique instruments at once (avoids N+1 queries)
  const uniqueInstrumentIds = [...new Set(positions.map((p) => String(p.instrumentId)))];
  const instruments = await Instrument.find({ _id: { $in: uniqueInstrumentIds } })
    .select('_id lastPrice')
    .lean();
  const instrumentMap = new Map(instruments.map((i) => [String(i._id), i]));

  // attach mark price + unrealized PnL
  for (const p of positions) {
    const inst = instrumentMap.get(String(p.instrumentId));
    p.markPrice = inst?.lastPrice || p.entryPrice;
    p.unrealizedPnl =
      p.side === 'BUY'
        ? mul(sub(p.markPrice, p.entryPrice), p.quantity)
        : mul(sub(p.entryPrice, p.markPrice), p.quantity);
  }
  await attachFeeCategory(positions);
  sendSuccess(res, positions);
});

const closePosition = asyncHandler(async (req, res) => {
  // Atomic claim: only the request that flips OPEN → CLOSING proceeds.
  // A second concurrent click (or the worker firing SL/TP at the same
  // instant) sees position=null and gets a clean "already settling" 409
  // — much better than racing to create two closing orders that would
  // each try to settle and double-credit (which the wallet ledger's
  // dedupeKey would still block, but at the cost of an extra round-trip).
  const position = await Position.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
    { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'MANUAL' } },
    { new: true }
  );
  if (!position) {
    // Differentiate "doesn't exist" from "currently settling" so the UI
    // can show the right message instead of a generic 404.
    const existing = await Position.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!existing) throw new AppError('Position not found', 404);
    if (existing.status === POSITION_STATUS.CLOSING) {
      throw new AppError('Position is already settling', 409, 'ALREADY_SETTLING');
    }
    if (existing.status === POSITION_STATUS.CLOSED) {
      throw new AppError('Position is already closed', 409, 'ALREADY_CLOSED');
    }
    throw new AppError('Position not found', 404);
  }

  // Place opposite-side market order. Route via orderRouter so the close
  // fills through whichever execution path (B/A/LP) the account is
  // configured for. closeOnly caps qty at remaining position size.
  //
  // Hedge mode: positionSide is inherited from the source position so the
  // engine knows which bucket to reduce. A SELL close-order against a LONG
  // position is stamped positionSide=LONG so the engine doesn't accidentally
  // hit the user's SHORT position on the same symbol.
  const oppositeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
  const sourcePositionSide = position.positionSide || (position.side === 'BUY' ? 'LONG' : 'SHORT');
  const order = await Order.create({
    userId: req.userId,
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    symbol: position.symbol,
    side: oppositeSide,
    positionSide: sourcePositionSide,
    type: ORDER_TYPE.MARKET,
    quantity: position.quantity,
    leverage: position.leverage,
    status: ORDER_STATUS.PENDING,
    closeOnly: true,
    reduceOnly: true,
  });

  // Router throws → roll CLOSING back to OPEN so the user can retry.
  // Engine settle path is idempotent (dedupeKey) so re-submit is safe.
  let result;
  try {
    const routed = await orderRouter.routeOrder({ order, userId: req.userId });
    result = routed.settledOrder;
  } catch (engineErr) {
    await Position.updateOne(
      { _id: position._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.OPEN } }
    );
    throw engineErr;
  }

  // Re-fetch the now-closed position + the wallet so the client can update
  // immediately, without waiting for the WS event → refetch round-trip.
  // (We still emit the WS event for other open tabs / the dashboard.)
  const closedPosition = await Position.findById(position._id).lean();

  // Defense against stuck state: if the engine returned without closing
  // (e.g. order REJECTED for missing reference price), revert CLOSING →
  // OPEN so the user can retry. Without this the position would sit in
  // CLOSING forever and every retry would 409.
  if (closedPosition && closedPosition.status === POSITION_STATUS.CLOSING && !closedPosition.settled) {
    await Position.updateOne(
      { _id: position._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.OPEN } }
    );
    throw new AppError(
      result?.rejectionReason || 'Close order did not fill — please retry',
      400,
      'CLOSE_FAILED'
    );
  }
  const account = await TradingAccount.findById(position.accountId).lean();
  const currency = account?.baseCurrency || 'INR';
  const wallet = await require('../models/Wallet').Wallet.findOne({
    userId: req.userId,
    accountId: position.accountId,
    currency,
  }).lean();

  // Backstop broadcast — every settle path inside MatchingEngine already
  // notifies, but doing it here too guarantees frontends refresh even if a
  // future routing path forgets to.
  try {
    const broadcaster = require('../websocket/server');
    broadcaster.notifyUser(String(req.userId), 'wallet', {
      reason: 'POSITION_SETTLEMENT',
      positionId: String(position._id),
      realizedPnl: closedPosition?.realizedPnl,
      balance: wallet?.balance,
    });
    broadcaster.notifyUser(String(req.userId), 'positions', {
      reason: 'POSITION_CLOSED',
      positionId: String(position._id),
    });
  } catch (e) {
    // WS broadcast is best-effort — never fail the close because of it.
    console.warn('[closePosition] broadcast failed:', e.message);
  }

  // ── Copy-trading: close every mirrored follower position ──────────
  setImmediate(async () => {
    try {
      const copyService = require('../services/copyTradingService');
      await copyService.onMasterPositionClosed({
        position: closedPosition || position,
        realizedPnl: closedPosition?.realizedPnl,
      });
    } catch (err) {
      console.error('[copyTrading] fan-out (close) failed:', err.message);
    }
  });

  sendSuccess(res, {
    order: result,
    position: closedPosition,
    wallet: wallet
      ? {
          balance: wallet.balance,
          locked: wallet.locked,
          free: gt(wallet.balance, wallet.locked || '0')
            ? sub(wallet.balance, wallet.locked || '0')
            : '0',
          currency: wallet.currency,
        }
      : null,
  });
});

/**
 * Modify a pending LIMIT or STOP order. Only price/quantity/stopLoss/takeProfit can be changed.
 * For LIMIT orders sitting in the book, we cancel + re-add (loses time priority by design).
 *
 * Margin: changes to qty or price recompute the required margin against the
 * order's current state, then top-up or release the delta on the wallet so
 * the user can't escape the margin check by placing a tiny order and bumping
 * the size after the fact.
 */
const modifyOrder = asyncHandler(async (req, res) => {
  const { price, quantity, stopPrice, stopLoss, takeProfit } = req.body;
  const order = await Order.findOne({ _id: req.params.id, userId: req.userId });
  if (!order) throw new AppError('Order not found', 404);
  if (order.status !== ORDER_STATUS.PENDING) {
    throw new AppError('Only PENDING orders can be modified', 400);
  }
  if (order.type === 'MARKET') throw new AppError('MARKET orders cannot be modified', 400);
  if (order.type === 'STOP' && order.triggeredAt) {
    throw new AppError('Stop has already triggered and cannot be modified', 400);
  }

  // For LIMIT in book: remove first, then re-add with new params.
  // Routed through the engine's per-symbol queue so we don't mutate the
  // book mid-match for some other order on the same symbol.
  if (order.type === 'LIMIT') {
    await matchingEngine.removeFromBook(order.symbol, String(order._id), order.side);
  }

  // Snapshot the pre-modify values so we can revert if margin top-up fails.
  const original = {
    price: order.price,
    quantity: order.quantity,
    stopPrice: order.stopPrice,
    stopLoss: order.stopLoss,
    takeProfit: order.takeProfit,
  };

  if (price != null) order.price = String(price);
  if (quantity != null) {
    if (!gt(quantity, '0')) throw new AppError('Quantity must be > 0', 400);
    order.quantity = String(quantity);
  }
  if (stopPrice != null) order.stopPrice = String(stopPrice);
  if (stopLoss !== undefined) order.stopLoss = stopLoss == null ? null : String(stopLoss);
  if (takeProfit !== undefined) order.takeProfit = takeProfit == null ? null : String(takeProfit);

  // Recompute required margin under the new params and reconcile against
  // the amount already locked. Lock more / release the delta as needed.
  const account = await TradingAccount.findById(order.accountId);
  const instrument = await Instrument.findById(order.instrumentId);
  if (account && instrument && (price != null || quantity != null || stopPrice != null)) {
    const { marginAmount: newMargin } = await _computeMarginToLock({
      instrument,
      side: order.side,
      type: order.type,
      qty: order.quantity,
      price: order.price,
      stopPrice: order.stopPrice,
      leverage: order.leverage,
      account,
      symbol: order.symbol,
    });
    const oldMargin = order.lockedMargin || '0';
    if (gt(newMargin, oldMargin)) {
      const topUp = sub(newMargin, oldMargin);
      try {
        await walletService.lockMargin({
          userId: order.userId,
          accountId: order.accountId,
          currency: account.baseCurrency || 'USD',
          amount: topUp,
          orderId: order._id,
          note: `Modify: top-up margin by ${topUp}`,
        });
      } catch (e) {
        // Insufficient free balance — revert the in-memory mutations so the
        // re-added book entry matches the persisted state, then refuse cleanly.
        // Use addToBook (queued) instead of submit() so the order is restored
        // exactly as it was, without re-running the matcher (which could
        // partially fill at the OLD price and produce surprising trades).
        order.price = original.price;
        order.quantity = original.quantity;
        order.stopPrice = original.stopPrice;
        order.stopLoss = original.stopLoss;
        order.takeProfit = original.takeProfit;
        if (order.type === 'LIMIT') {
          await matchingEngine.addToBook(order);
        }
        throw new AppError(`Modification rejected: ${e.message}`, 400);
      }
    } else if (gt(oldMargin, newMargin)) {
      const release = sub(oldMargin, newMargin);
      await walletService.releaseMargin({
        userId: order.userId,
        accountId: order.accountId,
        currency: account.baseCurrency || 'USD',
        amount: release,
        orderId: order._id,
        note: `Modify: released margin ${release}`,
      });
    }
    order.lockedMargin = newMargin;
  }

  await order.save();

  if (order.type === 'LIMIT') {
    // Re-submit through the router so the modified LIMIT respects the
    // account's bookType — an A-book account's modified LIMIT must still
    // flow to the LP, not just the internal engine book.
    await orderRouter.routeOrder({ order, userId: req.userId });
  }
  sendSuccess(res, order);
});

/**
 * Modify SL/TP on an open position (no new order created).
 * The background worker will close the position when price crosses these levels.
 */
const modifyPosition = asyncHandler(async (req, res) => {
  const { stopLoss, takeProfit } = req.body;
  const position = await Position.findOne({ _id: req.params.id, userId: req.userId, status: 'OPEN' });
  if (!position) throw new AppError('Position not found', 404);
  if (stopLoss !== undefined) position.stopLoss = stopLoss == null ? null : String(stopLoss);
  if (takeProfit !== undefined) position.takeProfit = takeProfit == null ? null : String(takeProfit);
  await position.save();
  sendSuccess(res, position);

  // Copy-trading: propagate SL/TP to mirrored follower positions.
  setImmediate(async () => {
    try {
      const copyService = require('../services/copyTradingService');
      await copyService.onMasterSlTpChanged({ position });
    } catch (err) {
      console.error('[copyTrading] fan-out (sl/tp) failed:', err.message);
    }
  });
});

/**
 * Partially close a position by submitting an opposite-side market order
 * for the requested quantity (must be < position.quantity).
 *
 * Concurrency: the partialClosing flag is flipped atomically; if a second
 * partial-close request arrives while this one is in flight we reject with
 * 409 instead of letting both run and risk over-closing / flipping the
 * position into the opposite direction. The engine also caps qty at the
 * current position size as a defense-in-depth measure (closeOnly=true).
 */
const partialClose = asyncHandler(async (req, res) => {
  const { quantity } = req.body;
  if (!quantity || !gt(quantity, '0')) throw new AppError('Quantity must be > 0', 400);

  const qtyNum = Number(quantity);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    throw new AppError('Quantity must be a positive number', 400);
  }

  // Atomic claim: ensure (a) status=OPEN, (b) no other partial in flight, and
  // (c) current quantity strictly greater than the requested partial size.
  const position = await Position.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: req.userId,
      status: 'OPEN',
      partialClosing: { $ne: true },
      $expr: { $gt: [{ $toDouble: '$quantity' }, qtyNum] },
    },
    { $set: { partialClosing: true, partialClosingAt: new Date() } },
    { new: true }
  );
  if (!position) {
    const existing = await Position.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!existing) throw new AppError('Position not found', 404);
    if (existing.status !== 'OPEN') throw new AppError('Position not open', 409);
    if (existing.partialClosing) {
      throw new AppError('Another partial close is already in flight', 409, 'PARTIAL_IN_FLIGHT');
    }
    // The only remaining failure is qty >= position.quantity.
    throw new AppError('Use full close endpoint for closing the entire position', 400);
  }

  try {
    const oppositeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const sourcePositionSide = position.positionSide || (position.side === 'BUY' ? 'LONG' : 'SHORT');
    const order = await Order.create({
      userId: req.userId,
      accountId: position.accountId,
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      side: oppositeSide,
      positionSide: sourcePositionSide,
      type: ORDER_TYPE.MARKET,
      quantity: String(quantity),
      leverage: position.leverage,
      status: ORDER_STATUS.PENDING,
      closeOnly: true,
      reduceOnly: true,
    });
    const { settledOrder, executionSource } = await orderRouter.routeOrder({
      order,
      userId: req.userId,
    });
    return sendSuccess(res, { ...settledOrder.toObject?.() || settledOrder, executionSource });
  } finally {
    // Always clear the flag — finally guarantees we don't strand the
    // position with partialClosing=true on a thrown engine error.
    await Position.updateOne(
      { _id: position._id },
      { $set: { partialClosing: false } }
    );
  }
});

/**
 * Place an OCO (One-Cancels-Other) pair: typically a take-profit LIMIT and a stop-loss STOP.
 * Both orders share an ocoGroupId. When one fills or cancels, the worker cancels the other.
 *
 * Body: {
 *   accountId, symbol, side, quantity, leverage,
 *   limitPrice,  // for the take-profit leg
 *   stopPrice,   // for the stop-loss leg
 * }
 */
const placeOcoOrder = asyncHandler(async (req, res) => {
  const { accountId, symbol, side, quantity, limitPrice, stopPrice, leverage } = req.body;

  // Required-field & sanity validation up front.
  if (!symbol || typeof symbol !== 'string') throw new AppError('symbol required', 400);
  if (!accountId) throw new AppError('accountId required', 400);
  if (!Object.values(ORDER_SIDE).includes(side)) throw new AppError('Invalid side', 400);
  if (!quantity || !gt(quantity, '0')) throw new AppError('Quantity must be > 0', 400);
  if (!limitPrice || !stopPrice) throw new AppError('limitPrice and stopPrice required for OCO', 400);
  if (!gt(limitPrice, '0')) throw new AppError('limitPrice must be > 0', 400);
  if (!gt(stopPrice, '0')) throw new AppError('stopPrice must be > 0', 400);

  const { v4: uuidv4 } = require('uuid');
  const ocoGroupId = uuidv4();

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId, isActive: true });
  if (!account) throw new AppError('Account not found', 404);
  const instrument = await Instrument.findOne({ symbol: symbol.toUpperCase(), isActive: true });
  if (!instrument) throw new AppError('Instrument not active', 404);

  // Validate min/max order size (same as placeOrder).
  if (instrument.minOrderSize && lt(quantity, instrument.minOrderSize)) {
    throw new AppError(
      `Quantity ${quantity} below minimum order size ${instrument.minOrderSize} for ${instrument.symbol}`,
      400
    );
  }
  if (instrument.maxOrderSize && gt(quantity, instrument.maxOrderSize)) {
    throw new AppError(
      `Quantity ${quantity} exceeds max order size ${instrument.maxOrderSize} for ${instrument.symbol}`,
      400
    );
  }

  // Priority-based leverage resolution (matches the single-order path):
  //   instrument.maxLeverage > account.leverage > SYSTEM_DEFAULT (100).
  // Instrument always wins when set, even if higher than account.
  const _SYSTEM_DEFAULT_LEV_OCO = 100;
  const _instMaxOco = Number(instrument.maxLeverage);
  const _hasInstCapOco = Number.isFinite(_instMaxOco) && _instMaxOco > 0;
  let _effectiveCapOco;
  if (_hasInstCapOco) {
    _effectiveCapOco = _instMaxOco;
  } else if (Number.isFinite(Number(account.leverage)) && Number(account.leverage) > 0) {
    _effectiveCapOco = Number(account.leverage);
  } else {
    _effectiveCapOco = _SYSTEM_DEFAULT_LEV_OCO;
  }
  let cappedLeverage = leverage != null ? Number(leverage) : _effectiveCapOco;
  if (cappedLeverage > _effectiveCapOco) cappedLeverage = _effectiveCapOco;
  if (!Number.isFinite(cappedLeverage) || cappedLeverage < 1) cappedLeverage = 1;

  // Margin: only ONE of the two legs ever fills (the other is cancelled by
  // the OCO worker), so we lock margin once at the worst-case price across
  // the two legs to avoid escaping the margin check by going OCO.
  const worstPrice = side === 'BUY'
    ? (gt(limitPrice, stopPrice) ? limitPrice : stopPrice)
    : (lt(limitPrice, stopPrice) ? limitPrice : stopPrice);

  const { marginAmount, openQty } = await _computeMarginToLock({
    instrument,
    side,
    type: ORDER_TYPE.LIMIT, // worst-case treated like LIMIT at worstPrice
    qty: String(quantity),
    price: String(worstPrice),
    leverage: cappedLeverage,
    account,
    symbol: instrument.symbol,
  });

  const limitOrder = await Order.create({
    userId: req.userId,
    accountId,
    instrumentId: instrument._id,
    symbol: instrument.symbol,
    side,
    type: ORDER_TYPE.LIMIT,
    quantity: String(quantity),
    price: String(limitPrice),
    leverage: cappedLeverage,
    ocoGroupId,
    status: ORDER_STATUS.PENDING,
    // Margin is tracked on the LIMIT leg only — when either fills, the
    // OCO worker cancels the other and (for the cancelled leg) doesn't try
    // to release margin a second time.
    lockedMargin: marginAmount,
  });

  const stopOrder = await Order.create({
    userId: req.userId,
    accountId,
    instrumentId: instrument._id,
    symbol: instrument.symbol,
    side,
    type: ORDER_TYPE.STOP,
    quantity: String(quantity),
    stopPrice: String(stopPrice),
    leverage: cappedLeverage,
    ocoGroupId,
    status: ORDER_STATUS.PENDING,
  });

  if (gt(marginAmount, '0')) {
    try {
      await walletService.lockMargin({
        userId: req.userId,
        accountId,
        currency: account.baseCurrency || 'USD',
        amount: marginAmount,
        orderId: limitOrder._id,
        note: `OCO margin: ${side} ${openQty} ${instrument.symbol} (group ${ocoGroupId})`,
      });
    } catch (e) {
      // Roll back both legs on margin failure so we don't leave dangling pending orders.
      limitOrder.status = ORDER_STATUS.REJECTED;
      limitOrder.rejectionReason = e.message;
      await limitOrder.save();
      stopOrder.status = ORDER_STATUS.REJECTED;
      stopOrder.rejectionReason = e.message;
      await stopOrder.save();
      throw e;
    }
  }

  // Submit limit leg via the router — so an A-book OCO actually places the
  // LIMIT on the LP. STOP leg stays PENDING; worker triggers + routes it.
  await orderRouter.routeOrder({ order: limitOrder, userId: req.userId });

  sendSuccess(res, { ocoGroupId, limitOrder, stopOrder }, 201);
});

/**
 * Set or update a trailing stop loss on an open position.
 * Worker maintains the high-watermark and closes the position
 * when price retraces by `distance` from the best favorable level.
 *
 * Body: { distance: "100"  }   // distance in price units; null/0 to remove
 */
const setTrailingStop = asyncHandler(async (req, res) => {
  const { distance } = req.body;
  const position = await Position.findOne({ _id: req.params.id, userId: req.userId, status: 'OPEN' });
  if (!position) throw new AppError('Position not found', 404);

  if (distance == null || distance === '' || Number(distance) <= 0) {
    position.trailingDistance = null;
    position.trailingHighWatermark = null;
  } else {
    position.trailingDistance = String(distance);
    // Initialize watermark from current entry price (worker updates as market moves)
    if (!position.trailingHighWatermark) {
      const Instrument = require('../models/Instrument');
      const inst = await Instrument.findById(position.instrumentId).lean();
      position.trailingHighWatermark = inst?.lastPrice || position.entryPrice;
    }
  }
  await position.save();
  sendSuccess(res, position);
});

/**
 * Close every OPEN position for the authenticated user — "panic close"
 * button on the trader UI. Optional `accountId` body field scopes the
 * close to a single account.
 *
 * Each position is claimed atomically (OPEN → CLOSING) so we don't
 * race the worker's SL/TP path; on router failure we revert that
 * position to OPEN and continue with the rest.
 *
 * Returns { closed, failed } counts so the UI can show partial outcomes.
 */
const closeAllPositions = asyncHandler(async (req, res) => {
  const { accountId } = req.body || {};
  const filter = { userId: req.userId, status: POSITION_STATUS.OPEN };
  if (accountId) filter.accountId = accountId;
  const positions = await Position.find(filter);

  let closed = 0;
  const failed = [];
  for (const pos of positions) {
    const claimed = await Position.findOneAndUpdate(
      { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'MANUAL' } },
      { new: true }
    );
    if (!claimed) continue; // already being closed
    const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
    const closingOrder = await Order.create({
      userId: req.userId,
      accountId: pos.accountId,
      instrumentId: pos.instrumentId,
      symbol: pos.symbol,
      side: oppositeSide,
      positionSide: sourcePositionSide,
      type: ORDER_TYPE.MARKET,
      quantity: pos.quantity,
      leverage: pos.leverage,
      status: ORDER_STATUS.PENDING,
      closeOnly: true,
      reduceOnly: true,
    });
    try {
      await orderRouter.routeOrder({ order: closingOrder, userId: req.userId });
      closed++;
    } catch (err) {
      await Position.updateOne(
        { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.OPEN } }
      );
      failed.push({ positionId: String(pos._id), symbol: pos.symbol, reason: err.message });
    }
  }
  sendSuccess(res, { closed, failed, total: positions.length });
});

module.exports = {
  placeOrder,
  cancelOrder,
  listOpen,
  listHistory,
  listPositions,
  positionHistory,
  closePosition,
  closeAllPositions,
  modifyOrder,
  modifyPosition,
  partialClose,
  placeOcoOrder,
  setTrailingStop,
};
