const Order = require('../models/Order');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const Position = require('../models/Position');
const matchingEngine = require('../matching-engine/MatchingEngine');
const { updateCandlesForTrade } = require('../services/candleService');
const routingService = require('../services/routingService');
const walletService = require('../services/walletService');
const Trade = require('../models/Trade');
const { sendSuccess, asyncHandler, AppError } = require('../utils/errors');
const { ORDER_TYPE, ORDER_SIDE, ORDER_STATUS, POSITION_STATUS } = require('../config/constants');
const { gt, lt, mul, div, sub, eq } = require('../utils/decimal');

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

const placeOrder = asyncHandler(async (req, res) => {
  const {
    accountId,
    symbol,
    side,
    type,
    quantity,
    price,
    stopPrice,
    stopLoss,
    takeProfit,
    leverage,
    idempotencyKey,
  } = req.body;

  // Idempotency check
  if (idempotencyKey) {
    const existing = await Order.findOne({ idempotencyKey });
    if (existing) return sendSuccess(res, existing);
  }

  // Required-field validation BEFORE any string method calls so a missing
  // symbol/side/type doesn't throw a generic TypeError.
  if (!symbol || typeof symbol !== 'string') throw new AppError('symbol required', 400);
  if (!accountId) throw new AppError('accountId required', 400);
  if (!Object.values(ORDER_SIDE).includes(side)) throw new AppError('Invalid side', 400);
  if (!Object.values(ORDER_TYPE).includes(type)) throw new AppError('Invalid type', 400);
  if (quantity === undefined || quantity === null || quantity === '') {
    throw new AppError('Quantity required', 400);
  }
  if (!gt(quantity, '0')) throw new AppError('Quantity must be > 0', 400);
  if (type !== 'MARKET' && !price) throw new AppError('Price required for non-market orders', 400);
  if (type === 'STOP' && !stopPrice) throw new AppError('Stop price required for stop orders', 400);

  const account = await TradingAccount.findOne({ _id: accountId, userId: req.userId, isActive: true });
  if (!account) throw new AppError('Account not found', 404);

  const instrument = await Instrument.findOne({ symbol: symbol.toUpperCase(), isActive: true });
  if (!instrument) throw new AppError('Instrument not active', 404);

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

  // Resolve leverage:
  //   - If user explicitly sent a leverage value: must respect instrument's max (reject if exceeded)
  //   - If not specified: auto-use min(account default, instrument max) so the order isn't rejected
  //     just because the account default happens to exceed this instrument's cap.
  let orderLeverage;
  if (leverage != null) {
    orderLeverage = Number(leverage);
    if (orderLeverage > instrument.maxLeverage) {
      throw new AppError(
        `Leverage 1:${orderLeverage} exceeds max for ${instrument.symbol} (1:${instrument.maxLeverage})`,
        400
      );
    }
  } else {
    orderLeverage = Math.min(Number(account.leverage || 1), instrument.maxLeverage);
  }
  if (orderLeverage < 1) orderLeverage = 1;

  // Routing decision (A-book / B-book / external)
  const routing = await routingService.decideRouting({
    userId: req.userId,
    instrument,
    order: { quantity, price, side },
  });

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

  const order = await Order.create({
    userId: req.userId,
    accountId,
    instrumentId: instrument._id,
    symbol: instrument.symbol,
    side,
    type,
    quantity: String(quantity),
    price: price ? String(price) : undefined,
    stopPrice: stopPrice ? String(stopPrice) : undefined,
    stopLoss: stopLoss ? String(stopLoss) : undefined,
    takeProfit: takeProfit ? String(takeProfit) : undefined,
    leverage: orderLeverage,
    routing,
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

  // STOP orders are not submitted to the engine until triggered.
  // Here we submit MARKET and LIMIT directly. STOP triggering is left as a TODO (price monitor).
  if (type === ORDER_TYPE.STOP) {
    return sendSuccess(res, order, 201);
  }

  const result = await matchingEngine.submit(order);

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

  sendSuccess(res, result, 201);
});

const cancelOrder = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.userId });
  if (!order) throw new AppError('Order not found', 404);
  if (![ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED].includes(order.status)) {
    throw new AppError('Order cannot be cancelled', 400);
  }
  await matchingEngine.cancel(order);

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
  sendSuccess(res, orders);
});

const listHistory = asyncHandler(async (req, res) => {
  const orders = await Order.find({
    userId: req.userId,
    status: { $in: [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED] },
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
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
const positionHistory = asyncHandler(async (req, res) => {
  const {
    accountId,
    symbol,
    side,
    from,
    to,
    page: pageRaw = '1',
    limit: limitRaw = '30',
  } = req.query;

  const filter = { userId: req.userId, status: POSITION_STATUS.CLOSED };
  if (accountId) filter.accountId = accountId;
  if (symbol) filter.symbol = String(symbol).toUpperCase();
  if (side && (side === 'BUY' || side === 'SELL')) filter.side = side;
  if (from || to) {
    filter.closedAt = {};
    if (from) filter.closedAt.$gte = new Date(from);
    if (to) filter.closedAt.$lte = new Date(to);
  }

  const page = Math.max(1, parseInt(pageRaw, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 30));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Position.find(filter).sort({ closedAt: -1 }).skip(skip).limit(limit).lean(),
    Position.countDocuments(filter),
  ]);

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

  // Place opposite-side market order. Route through routingService so a B-book
  // instrument's closing fill goes through the broker counterparty path —
  // INTERNAL-only routing would reject when there's no resting liquidity.
  const oppositeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
  const instrument = await Instrument.findById(position.instrumentId);
  const routing = await routingService.decideRouting({
    userId: req.userId,
    instrument,
    order: { quantity: position.quantity, side: oppositeSide },
  });
  const order = await Order.create({
    userId: req.userId,
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    symbol: position.symbol,
    side: oppositeSide,
    type: ORDER_TYPE.MARKET,
    quantity: position.quantity,
    leverage: position.leverage,
    status: ORDER_STATUS.PENDING,
    routing,
    // closeOnly tells the engine to never let this order open a flip leg
    // — if the position has already been reduced by a concurrent settle,
    // we cap the close qty at the remaining position size.
    closeOnly: true,
  });

  // If the engine throws (broken state, route misconfig, etc.) we MUST
  // roll the CLOSING status back to OPEN — otherwise the position is
  // stuck and the user can't retry. The engine's settle path is already
  // idempotent (dedupeKey), so re-submitting is safe.
  let result;
  try {
    result = await matchingEngine.submit(order);
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
    // Re-submit through engine so it can match against the book at the new price
    await matchingEngine.submit(order);
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
    const instrument = await Instrument.findById(position.instrumentId);
    const routing = await routingService.decideRouting({
      userId: req.userId,
      instrument,
      order: { quantity: String(quantity), side: oppositeSide },
    });
    const order = await Order.create({
      userId: req.userId,
      accountId: position.accountId,
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      side: oppositeSide,
      type: ORDER_TYPE.MARKET,
      quantity: String(quantity),
      leverage: position.leverage,
      status: ORDER_STATUS.PENDING,
      routing,
      closeOnly: true,
    });
    const result = await matchingEngine.submit(order);
    return sendSuccess(res, result);
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

  let cappedLeverage = Math.min(Number(leverage || account.leverage || 1), instrument.maxLeverage);
  if (cappedLeverage < 1) cappedLeverage = 1;

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

  // Submit limit order to the matching engine immediately;
  // stop order waits for price trigger via background worker.
  await matchingEngine.submit(limitOrder);

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

module.exports = {
  placeOrder,
  cancelOrder,
  listOpen,
  listHistory,
  listPositions,
  positionHistory,
  closePosition,
  modifyOrder,
  modifyPosition,
  partialClose,
  placeOcoOrder,
  setTrailingStop,
};
