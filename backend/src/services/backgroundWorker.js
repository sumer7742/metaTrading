/**
 * Background worker that runs every few seconds to:
 *   1. Trigger STOP orders when their stopPrice is crossed
 *   2. Update unrealized PnL on open positions (for snapshots)
 *   3. Detect margin-call and stop-out conditions
 *   4. Auto-liquidate positions on stop-out (largest losing first)
 *   5. Auto-close positions when SL or TP is hit
 *
 * Single-process MVP. For production, run this as a separate worker process
 * with leader election if you scale the API horizontally.
 */
const Order = require('../models/Order');
const Position = require('../models/Position');
const Instrument = require('../models/Instrument');
const TradingAccount = require('../models/TradingAccount');
const Trade = require('../models/Trade');
const MarginCall = require('../models/MarginCall');
const { Notification } = require('../models/index');
const matchingEngine = require('../matching-engine/MatchingEngine');
const orderRouter = require('./orderRouter.service');
const riskService = require('./riskService');

// Worker-triggered orders (STOP fires, LIMIT fills, SL/TP closes, stop-out
// liquidations) should respect the per-account bookType just like manual
// orders. _submit() routes through orderRouter.
//
// Fallback policy: silent fallback to direct engine submit is ONLY safe for
// pure B-book accounts (which would have ended up there anyway). For A/HYBRID
// accounts a routing failure means we couldn't reach the LP — falling back
// to internal execution would mis-route the trade and stamp the wrong
// executionSource. In that case we mark the order REJECTED, leave the caller
// to roll back position state on the next tick, and propagate the error.
const _submit = async (order) => {
  try {
    const { settledOrder } = await orderRouter.routeOrder({ order, userId: order.userId });
    return settledOrder;
  } catch (err) {
    const TradingAccount = require('../models/TradingAccount');
    const { BOOK_TYPE } = require('../config/constants');
    const account = await TradingAccount.findById(order.accountId).lean();
    const bookType = account?.bookType || BOOK_TYPE.B_BOOK;
    if (bookType === BOOK_TYPE.B_BOOK) {
      console.warn(`[worker] orderRouter failed for B-book order ${order._id}: ${err.message} — falling back to engine`);
      return matchingEngine.submit(order);
    }
    console.error(`[worker] orderRouter failed for ${bookType} order ${order._id}: ${err.message} — refusing internal fallback`);
    order.status = ORDER_STATUS.REJECTED;
    order.rejectionReason = `Worker route failed: ${err.message}`;
    try { await order.save(); } catch (_) {}
    throw err;
  }
};
const { add, sub, mul, gt, lt, gte, lte, eq, D } = require('../utils/decimal');
const { ORDER_STATUS, ORDER_TYPE, POSITION_STATUS } = require('../config/constants');

let broadcaster = null;
let running = false;

const setBroadcaster = (b) => {
  broadcaster = b;
};

const notifyUser = (userId, channel, data) => {
  if (broadcaster) broadcaster.notifyUser(userId, channel, data);
};

/**
 * Check pending STOP orders. If the stopPrice has been crossed by lastPrice,
 * convert the order to MARKET and send it to the matching engine.
 */
const triggerStopOrders = async () => {
  // Only consider stops that haven't fired yet. triggeredAt=null is the gate.
  const stopOrders = await Order.find({
    type: ORDER_TYPE.STOP,
    status: ORDER_STATUS.PENDING,
    triggeredAt: null,
  }).limit(200);

  for (const order of stopOrders) {
    const inst = await Instrument.findById(order.instrumentId).lean();
    if (!inst || !inst.lastPrice) continue;
    // Staleness guard: a frozen feed can otherwise fire stops at an outdated
    // tick. 60s matches the slowest data feed cadence we run.
    if (inst.lastPriceUpdatedAt && Date.now() - new Date(inst.lastPriceUpdatedAt).getTime() > 60_000) continue;
    const lastPrice = inst.lastPrice;

    // For trigger evaluation we use the side-appropriate quote — a BUY
    // STOP fires when the ask reaches the trigger (that's what you'd pay),
    // and a SELL STOP fires when the bid reaches the trigger (that's what
    // you'd receive). lastPrice ≈ mid was an approximation that fired
    // stops slightly early/late depending on spread direction.
    const last = Number(lastPrice);
    const half = Number(inst.spreadValue || 0) / 2;
    const ask = inst.spreadType === 'PERCENTAGE' ? last * (1 + half) : last + half;
    const bid = inst.spreadType === 'PERCENTAGE' ? last * (1 - half) : last - half;

    // BUY STOP triggers when ask >= stopPrice (breakout up)
    // SELL STOP triggers when bid <= stopPrice (breakdown)
    const triggered =
      (order.side === 'BUY' && gte(String(ask), order.stopPrice)) ||
      (order.side === 'SELL' && lte(String(bid), order.stopPrice));

    if (triggered) {
      // Mark as fired BEFORE submitting so a concurrent tick can't double-submit.
      // Keep type=STOP for the audit trail; matching engine reads price/stopPrice
      // to decide STOP-MARKET vs STOP-LIMIT execution.
      order.triggeredAt = new Date();
      order.triggeredPrice = String(lastPrice);
      await order.save();
      try {
        await _submit(order);
        notifyUser(String(order.userId), 'orders', {
          event: 'STOP_TRIGGERED',
          orderId: String(order._id),
          symbol: order.symbol,
          stopPrice: order.stopPrice,
          triggerPrice: lastPrice,
        });
      } catch (e) {
        // If the engine throws, clear triggeredAt so the next tick can retry —
        // pre-fix the stamped triggeredAt would permanently disqualify the
        // order from re-evaluation, leaving it stuck PENDING forever.
        try {
          await Order.updateOne(
            { _id: order._id, status: ORDER_STATUS.PENDING },
            { $set: { triggeredAt: null, triggeredPrice: null } }
          );
        } catch (_) { /* best-effort */ }
        console.error('[Worker] STOP trigger failed:', e.message);
      }
    }
  }
};

/**
 * Check pending LIMIT orders. If the market has crossed the limit price
 * (ask <= BUY limit, OR bid >= SELL limit), submit the order to the engine
 * which then fills at the favorable price.
 *
 * Pre-fix LIMIT orders went straight to the engine on placement, where the
 * B-book / external fallback paths filled them at last price regardless of
 * the limit constraint. Now placeOrder() saves LIMITs as PENDING and this
 * worker tick is the only path that submits them — guaranteeing the limit
 * condition is honored before a position is opened.
 */
const triggerLimitOrders = async () => {
  // PENDING + no triggeredAt yet = waiting for price to cross.
  const limitOrders = await Order.find({
    type: ORDER_TYPE.LIMIT,
    status: ORDER_STATUS.PENDING,
    triggeredAt: null,
  }).limit(200);

  if (!limitOrders.length) return;

  // Cache instruments per symbol so we don't fetch the same one N times.
  const symbolCache = new Map();
  const fetchInst = async (id) => {
    const key = String(id);
    if (symbolCache.has(key)) return symbolCache.get(key);
    const inst = await Instrument.findById(id).lean();
    symbolCache.set(key, inst || null);
    return inst;
  };

  for (const order of limitOrders) {
    const inst = await fetchInst(order.instrumentId);
    if (!inst || !inst.lastPrice) continue;
    // Staleness guard — same 60s window the STOP trigger uses.
    if (inst.lastPriceUpdatedAt && Date.now() - new Date(inst.lastPriceUpdatedAt).getTime() > 60_000) continue;

    const last = Number(inst.lastPrice);
    const spread = Number(inst.spreadValue || 0);
    const half = spread / 2;
    const ask = inst.spreadType === 'PERCENTAGE' ? last * (1 + half) : last + half;
    const bid = inst.spreadType === 'PERCENTAGE' ? last * (1 - half) : last - half;
    const limitPx = Number(order.price);

    // BUY LIMIT triggers when ask drops to or below the limit (buyer's
    // entry condition met). SELL LIMIT triggers when bid rises to or
    // above the limit. Equality counts so on-the-dot prints fire too.
    const triggered =
      (order.side === 'BUY' && Number.isFinite(ask) && ask <= limitPx) ||
      (order.side === 'SELL' && Number.isFinite(bid) && bid >= limitPx);

    if (!triggered) continue;

    // Stamp triggeredAt BEFORE submitting so a concurrent tick can't
    // double-submit. Cleared on engine failure so the next tick can retry.
    order.triggeredAt = new Date();
    order.triggeredPrice = String(last);
    await order.save();
    try {
      await _submit(order);
      notifyUser(String(order.userId), 'orders', {
        event: 'LIMIT_TRIGGERED',
        orderId: String(order._id),
        symbol: order.symbol,
        limitPrice: order.price,
        triggerPrice: last,
      });
    } catch (e) {
      try {
        await Order.updateOne(
          { _id: order._id, status: ORDER_STATUS.PENDING },
          { $set: { triggeredAt: null, triggeredPrice: null } }
        );
      } catch (_) { /* best-effort */ }
      console.error('[Worker] LIMIT trigger failed:', e.message);
    }
  }
};

/**
 * Check open positions for SL/TP hits using current lastPrice.
 * Closes the position via opposite-side market order.
 */
const checkSlTp = async () => {
  const positions = await Position.find({
    status: POSITION_STATUS.OPEN,
    $or: [{ stopLoss: { $ne: null } }, { takeProfit: { $ne: null } }],
  });

  for (const pos of positions) {
    const inst = await Instrument.findById(pos.instrumentId).lean();
    if (!inst || !inst.lastPrice) continue;
    const price = inst.lastPrice;

    let shouldClose = false;
    let reason = null;

    if (pos.side === 'BUY') {
      if (pos.stopLoss && lte(price, pos.stopLoss)) (shouldClose = true), (reason = 'STOP_LOSS');
      else if (pos.takeProfit && gte(price, pos.takeProfit)) (shouldClose = true), (reason = 'TAKE_PROFIT');
    } else {
      if (pos.stopLoss && gte(price, pos.stopLoss)) (shouldClose = true), (reason = 'STOP_LOSS');
      else if (pos.takeProfit && lte(price, pos.takeProfit)) (shouldClose = true), (reason = 'TAKE_PROFIT');
    }

    if (shouldClose) {
      // Atomic OPEN → CLOSING claim — same idempotency guard the manual
      // close controller uses. If two consecutive ticks evaluate the same
      // SL/TP at the same time, only one wins this update and proceeds.
      // Also stamps closeReason so the trade-history view shows the right
      // remark ("PROFIT TAKEN" vs "STOP LOSS HIT").
      const claimed = await Position.findOneAndUpdate(
        { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: reason } },
        { new: true }
      );
      if (!claimed) continue; // Another tick / manual close beat us — skip.

      // routing + executionSource stamped by orderRouter inside _submit().
      // Hedge mode: positionSide echoes the source so the close targets
      // the right bucket (LONG/SHORT) and doesn't accidentally hit the
      // user's opposite-side position on the same symbol.
      const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
      const closingOrder = await Order.create({
        userId: pos.userId,
        accountId: pos.accountId,
        instrumentId: pos.instrumentId,
        symbol: pos.symbol,
        side: oppositeSide,
        positionSide: sourcePositionSide,
        type: 'MARKET',
        quantity: pos.quantity,
        leverage: pos.leverage,
        status: 'PENDING',
        closeOnly: true,
        reduceOnly: true,
      });
      try {
        await _submit(closingOrder);
        notifyUser(String(pos.userId), 'positions', {
          event: reason,
          positionId: String(pos._id),
          symbol: pos.symbol,
          price,
        });
      } catch (e) {
        // Engine failed — release the CLOSING claim so the next tick can retry.
        await Position.updateOne(
          { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
          { $set: { status: POSITION_STATUS.OPEN } }
        );
        console.error('[Worker] SL/TP close failed:', e.message);
      }
    }
  }
};

/**
 * Check every account with open positions for margin call (80%) and stop-out (50%).
 * On stop-out: liquidate largest losing position first until margin level recovers.
 */
const checkMarginAndStopOut = async () => {
  const callLevel = Number(process.env.DEFAULT_MARGIN_CALL_LEVEL || 80);
  const stopLevel = Number(process.env.DEFAULT_STOP_OUT_LEVEL || 50);

  // Get all accounts that currently have open positions
  const accountIds = await Position.distinct('accountId', { status: POSITION_STATUS.OPEN });

  for (const accId of accountIds) {
    const account = await TradingAccount.findById(accId);
    if (!account) continue;

    const metrics = await riskService.calculateAccountMetrics(account.userId, accId, account.baseCurrency);
    const lvl = Number(metrics.marginLevel);

    // Use lvl >= 0 (not > 0) so accounts whose equity has collapsed to 0%
    // also get evaluated for stop-out — pre-fix they would silently slip
    // through the gate and never get liquidated.
    if (gt(metrics.usedMargin, '0') && lvl >= 0) {
      // MARGIN CALL
      if (lvl <= callLevel && lvl > stopLevel) {
        // Avoid duplicate calls within 5 minutes
        const recent = await MarginCall.findOne({
          accountId: accId,
          type: 'MARGIN_CALL',
          triggeredAt: { $gt: new Date(Date.now() - 5 * 60 * 1000) },
        });
        if (!recent) {
          await MarginCall.create({
            userId: account.userId,
            accountId: accId,
            type: 'MARGIN_CALL',
            marginLevel: metrics.marginLevel,
            equity: metrics.equity,
            usedMargin: metrics.usedMargin,
            actionTaken: 'NOTIFICATION_SENT',
          });
          await Notification.create({
            userId: account.userId,
            type: 'MARGIN_CALL',
            title: 'Margin Call',
            message: `Account ${account.accountNumber}: margin level at ${Number(metrics.marginLevel).toFixed(1)}%. Add funds or close positions.`,
            channels: ['IN_APP', 'EMAIL'],
          });
          notifyUser(String(account.userId), 'notifications', {
            type: 'MARGIN_CALL',
            accountId: String(accId),
            marginLevel: metrics.marginLevel,
          });
          // Email
          try {
            const User = require('../models/User');
            const userDoc = await User.findById(account.userId).select('email').lean();
            if (userDoc) {
              const emailSvc = require('./emailService');
              await emailSvc.sendMarginCallAlert({
                to: userDoc.email,
                accountNumber: account.accountNumber,
                marginLevel: metrics.marginLevel,
              });
            }
          } catch (e) { /* non-fatal */ }
        }
      }

      // STOP OUT
      // Loop: keep liquidating largest losers until margin level recovers
      // above stopLevel (or we run out of positions). Pre-fix only one
      // position closed per tick, so accounts with multiple losers needed
      // many ticks to recover, during which more drawdown could occur.
      if (lvl <= stopLevel) {
        const closedPositionIds = [];
        const MAX_LIQUIDATIONS_PER_TICK = 10; // bound the loop
        let curLvl = lvl;
        let curMetrics = metrics;
        let iteration = 0;

        while (curLvl <= stopLevel && iteration < MAX_LIQUIDATIONS_PER_TICK) {
          iteration++;
          const positions = await Position.find({ accountId: accId, status: POSITION_STATUS.OPEN });
          if (!positions.length) break;

          let worst = null;
          let worstPnl = null;
          for (const p of positions) {
            const inst = await Instrument.findById(p.instrumentId).lean();
            const mark = inst?.lastPrice || p.entryPrice;
            const pnl =
              p.side === 'BUY'
                ? mul(sub(mark, p.entryPrice), p.quantity)
                : mul(sub(p.entryPrice, mark), p.quantity);
            if (worst === null || lt(pnl, worstPnl)) {
              worst = p;
              worstPnl = pnl;
            }
          }
          if (!worst) break;

          // Atomic OPEN → CLOSING claim. If we lose the race (manual close
          // or SL/TP got there first), skip and re-evaluate.
          const claimed = await Position.findOneAndUpdate(
            { _id: worst._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
            { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'MARGIN_STOPOUT' } },
            { new: true }
          );
          if (!claimed) {
            // Recompute and continue — another path may have already closed.
            curMetrics = await riskService.calculateAccountMetrics(account.userId, accId, account.baseCurrency);
            curLvl = Number(curMetrics.marginLevel);
            continue;
          }

          // routing + executionSource stamped by orderRouter inside _submit().
          // Hedge mode: stamp positionSide so margin-stopout closes hit
          // the specific LONG/SHORT bucket and leave the opposite side alone.
          const oppositeSide = worst.side === 'BUY' ? 'SELL' : 'BUY';
          const sourcePositionSide = worst.positionSide || (worst.side === 'BUY' ? 'LONG' : 'SHORT');
          const closingOrder = await Order.create({
            userId: worst.userId,
            accountId: worst.accountId,
            instrumentId: worst.instrumentId,
            symbol: worst.symbol,
            side: oppositeSide,
            positionSide: sourcePositionSide,
            type: 'MARKET',
            quantity: worst.quantity,
            leverage: worst.leverage,
            status: 'PENDING',
            closeOnly: true,
            reduceOnly: true,
          });
          try {
            await _submit(closingOrder);
            closedPositionIds.push(worst._id);
          } catch (e) {
            await Position.updateOne(
              { _id: worst._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
              { $set: { status: POSITION_STATUS.OPEN } }
            );
            console.error('[Worker] Stop-out close failed:', e.message);
            break; // engine breakage — defer to next tick rather than spin
          }

          // Re-evaluate margin level after the liquidation.
          curMetrics = await riskService.calculateAccountMetrics(account.userId, accId, account.baseCurrency);
          curLvl = Number(curMetrics.marginLevel);
          // If usedMargin is now 0 we're done regardless of margin level math.
          if (!gt(curMetrics.usedMargin, '0')) break;
        }

        if (closedPositionIds.length) {
          await MarginCall.create({
            userId: account.userId,
            accountId: accId,
            type: 'STOP_OUT',
            marginLevel: curMetrics.marginLevel,
            equity: curMetrics.equity,
            usedMargin: curMetrics.usedMargin,
            actionTaken: 'POSITION_LIQUIDATED',
            closedPositionIds,
          });
          notifyUser(String(account.userId), 'notifications', {
            type: 'STOP_OUT',
            accountId: String(accId),
            liquidatedCount: closedPositionIds.length,
            marginLevel: curMetrics.marginLevel,
          });
        }
      }
    }
  }
};

/**
 * Negative balance protection (doc §7.10).
 * When equity (balance + unrealized PnL) <= 0:
 *   1. Close all open positions on the account at last price
 *   2. Floor the wallet balance at 0 (broker absorbs the loss)
 *   3. Log event as MarginCall with type=NEGATIVE_BALANCE
 * Only runs for accounts where TradingAccount.negativeBalanceProtection === true.
 */
const checkNegativeBalanceProtection = async () => {
  const accountIds = await Position.distinct('accountId', { status: POSITION_STATUS.OPEN });
  for (const accId of accountIds) {
    const account = await TradingAccount.findById(accId);
    if (!account || !account.negativeBalanceProtection) continue;

    const metrics = await riskService.calculateAccountMetrics(account.userId, accId, account.baseCurrency);
    if (lte(metrics.equity, '0')) {
      // Close all open positions
      const positions = await Position.find({ accountId: accId, status: POSITION_STATUS.OPEN });
      const closedIds = [];
      for (const p of positions) {
        // Atomic claim. If another path already settled this position,
        // skip — negative-balance protection is just a safety net.
        const claimed = await Position.findOneAndUpdate(
          { _id: p._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
          { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'NEGATIVE_BALANCE' } },
          { new: true }
        );
        if (!claimed) continue;

        // routing + executionSource stamped by orderRouter inside _submit().
        const oppositeSide = p.side === 'BUY' ? 'SELL' : 'BUY';
        const closingOrder = await Order.create({
          userId: p.userId,
          accountId: p.accountId,
          instrumentId: p.instrumentId,
          symbol: p.symbol,
          side: oppositeSide,
          type: 'MARKET',
          quantity: p.quantity,
          leverage: p.leverage,
          status: 'PENDING',
          closeOnly: true,
        });
        try {
          await _submit(closingOrder);
          closedIds.push(p._id);
        } catch (e) {
          await Position.updateOne(
            { _id: p._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
            { $set: { status: POSITION_STATUS.OPEN } }
          );
          console.error('[Worker] negative balance close failed:', e.message);
        }
      }

      // Floor the wallet balance at 0 atomically. Pre-fix the read-then-save
      // pattern would race with a settle running on the other side and the
      // broker would absorb more than the actual deficit.
      const { Wallet, WalletLedger } = require('../models/Wallet');
      const floored = await Wallet.findOneAndUpdate(
        {
          userId: account.userId,
          accountId: accId,
          currency: account.baseCurrency,
          // Precondition: only act if balance is genuinely negative right now.
          $expr: { $lt: [{ $toDouble: '$balance' }, 0] },
        },
        [{ $set: { balance: '0' } }],
        { new: false } // return doc PRE-update so we can log the absorbed amount
      );
      if (floored) {
        const absorbed = Math.abs(Number(floored.balance)).toFixed(2);
        // Audit ledger row so reports show the broker-absorbed loss.
        try {
          await WalletLedger.create({
            walletId: floored._id,
            userId: account.userId,
            accountId: accId,
            type: 'ADJUSTMENT',
            currency: account.baseCurrency,
            amount: '+' + absorbed,
            balanceAfter: '0',
            referenceType: 'NEGATIVE_BALANCE_PROTECTION',
            note: `Broker absorbed ${absorbed} ${account.baseCurrency} (negative balance protection)`,
          });
        } catch (lErr) {
          console.warn('[Worker] negative-balance ledger insert failed:', lErr.message);
        }
        console.log(
          `[Worker] Negative balance protection: zeroed account ${account.accountNumber}, broker absorbed ${absorbed}`
        );
      }

      await MarginCall.create({
        userId: account.userId,
        accountId: accId,
        type: 'NEGATIVE_BALANCE',
        marginLevel: metrics.marginLevel,
        equity: metrics.equity,
        usedMargin: metrics.usedMargin,
        actionTaken: 'BALANCE_RESET',
        closedPositionIds: closedIds,
      });
      notifyUser(String(account.userId), 'notifications', {
        type: 'NEGATIVE_BALANCE_PROTECTION',
        accountId: String(accId),
        message: 'All positions closed; account balance reset to zero.',
      });
    }
  }
};

/**
 * Auto mode-switching for instruments (doc §4.4).
 * Per-instrument autoSwitchRules:
 *   - internalWhenMarketClosed: switch to INTERNAL when outside tradingHours
 *   - internalVolumeThreshold: switch to INTERNAL when 24h internal volume crosses threshold
 *   - externalVolatilityThresholdPct: switch to EXTERNAL when 5min price change exceeds %
 *
 * Decisions are mutually exclusive (volatility wins over volume wins over hours).
 * Only flips the mode if it would actually change to avoid noisy DB writes.
 */
const checkAutoModeSwitch = async () => {
  const instruments = await Instrument.find({
    isActive: true,
    'autoSwitchRules.enabled': true,
  });
  if (!instruments.length) return;

  const now = new Date();
  for (const inst of instruments) {
    let targetMode = inst.mode;
    let reason = null;

    // Rule 1 (highest priority): volatility-based switch to EXTERNAL
    if (inst.autoSwitchRules.externalVolatilityThresholdPct != null) {
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const recent = await Trade.find({ symbol: inst.symbol, executedAt: { $gte: fiveMinAgo } })
        .sort({ executedAt: 1 })
        .lean();
      if (recent.length >= 2) {
        const first = Number(recent[0].price);
        const last = Number(recent[recent.length - 1].price);
        if (first > 0) {
          const pctChange = Math.abs(((last - first) / first) * 100);
          if (pctChange >= inst.autoSwitchRules.externalVolatilityThresholdPct) {
            targetMode = 'EXTERNAL';
            reason = `volatility ${pctChange.toFixed(2)}% >= threshold`;
          }
        }
      }
    }

    // Rule 2: liquidity-based graduation Hybrid -> Internal
    if (!reason && inst.autoSwitchRules.internalVolumeThreshold) {
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const trades = await Trade.find({ symbol: inst.symbol, routing: 'INTERNAL', executedAt: { $gte: dayAgo } }).lean();
      let totalVolume = 0;
      for (const t of trades) totalVolume += Number(t.quantity);
      if (totalVolume >= Number(inst.autoSwitchRules.internalVolumeThreshold)) {
        targetMode = 'INTERNAL';
        reason = `24h internal volume ${totalVolume.toFixed(2)} >= threshold`;
      }
    }

    // Rule 3: market-hours fallback (lowest priority)
    if (!reason && inst.autoSwitchRules.internalWhenMarketClosed && inst.tradingHours) {
      const day = now.getUTCDay();
      const utcHm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
      const inDay = !inst.tradingHours.days || inst.tradingHours.days.includes(day);
      const start = inst.tradingHours.start;
      const end = inst.tradingHours.end;
      // Handle windows that wrap midnight (e.g. start='22:00', end='06:00')
      const inWindow = start <= end
        ? utcHm >= start && utcHm <= end
        : utcHm >= start || utcHm <= end;
      const marketOpen = inDay && inWindow;
      if (!marketOpen) {
        targetMode = 'INTERNAL';
        reason = 'external market closed';
      }
    }

    // Apply if changed
    if (targetMode !== inst.mode) {
      console.log(`[Worker] Auto mode-switch ${inst.symbol}: ${inst.mode} -> ${targetMode} (${reason})`);
      inst.mode = targetMode;
      // Safety: if switching to INTERNAL, force-disable B-book
      if (targetMode === 'INTERNAL' && inst.bBookEnabled) {
        inst.bBookEnabled = false;
      }
      await inst.save();
    }
  }
};

/**
 * OCO sibling cancellation (doc Phase 8).
 * For every order group: if any leg is FILLED, cancel all sibling legs that are still PENDING.
 * If any leg is CANCELLED by user/admin, also cancel siblings (so the group always exits cleanly).
 */
const processOcoGroups = async () => {
  const PriceAlert = require('../models/PriceAlert'); // (loaded once for this tick block)
  // Find recently completed orders that have an ocoGroupId
  const completedSinceLast = await Order.find({
    ocoGroupId: { $ne: null },
    status: { $in: [ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED] },
    updatedAt: { $gte: new Date(Date.now() - 30 * 1000) }, // last 30s
  }).select('ocoGroupId _id').lean();

  const groups = new Set(completedSinceLast.map((o) => `${o.ocoGroupId}|${o._id}`));
  const seenGroups = new Set();

  for (const key of groups) {
    const [ocoGroupId, completedId] = key.split('|');
    if (seenGroups.has(ocoGroupId)) continue;
    seenGroups.add(ocoGroupId);

    const siblings = await Order.find({
      ocoGroupId,
      _id: { $ne: completedId },
      status: ORDER_STATUS.PENDING,
    });
    for (const sib of siblings) {
      try {
        // Route the cancel so an A-book sibling is also cancelled on the LP.
        await orderRouter.routeCancel({ order: sib });
        notifyUser(String(sib.userId), 'orders', {
          event: 'OCO_CANCELLED',
          orderId: String(sib._id),
          symbol: sib.symbol,
        });
      } catch (e) {
        console.error('[Worker] OCO sibling cancel failed:', e.message);
      }
    }
  }
};

/**
 * Trailing stop loss update.
 * For each open position with trailingDistance:
 *   1. Update high-watermark when price moves favorably
 *   2. Compute effective SL = watermark ± distance
 *   3. If price has retraced past effective SL, close position
 */
const updateTrailingStops = async () => {
  const positions = await Position.find({
    status: POSITION_STATUS.OPEN,
    trailingDistance: { $ne: null },
  });
  for (const pos of positions) {
    const inst = await Instrument.findById(pos.instrumentId).lean();
    if (!inst || !inst.lastPrice) continue;
    const price = inst.lastPrice;

    // Update watermark and check exit
    let watermark = pos.trailingHighWatermark || pos.entryPrice;
    let effectiveSl;
    let triggered = false;
    if (pos.side === 'BUY') {
      // For longs: watermark is highest seen price; SL trails behind
      if (gt(price, watermark)) watermark = price;
      effectiveSl = sub(watermark, pos.trailingDistance);
      if (lte(price, effectiveSl)) triggered = true;
    } else {
      if (lt(price, watermark)) watermark = price;
      effectiveSl = add(watermark, pos.trailingDistance);
      if (gte(price, effectiveSl)) triggered = true;
    }

    // Only persist the watermark when it actually moved — pre-fix every
    // tick wrote N positions to the DB regardless of whether anything
    // changed (5s × N positions = a lot of useless write traffic).
    const prevWatermark = pos.trailingHighWatermark;
    if (String(prevWatermark) !== String(watermark)) {
      pos.trailingHighWatermark = watermark;
      await pos.save();
    }

    if (triggered) {
      // Atomic claim — same idempotency contract as manual close + SL/TP.
      const claimed = await Position.findOneAndUpdate(
        { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'TRAILING_STOP' } },
        { new: true }
      );
      if (!claimed) continue;

      // routing + executionSource stamped by orderRouter inside _submit().
      // Hedge mode: positionSide echoes the source so the close targets
      // the right bucket (LONG/SHORT) and doesn't accidentally hit the
      // user's opposite-side position on the same symbol.
      const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
      const closingOrder = await Order.create({
        userId: pos.userId,
        accountId: pos.accountId,
        instrumentId: pos.instrumentId,
        symbol: pos.symbol,
        side: oppositeSide,
        positionSide: sourcePositionSide,
        type: 'MARKET',
        quantity: pos.quantity,
        leverage: pos.leverage,
        status: 'PENDING',
        closeOnly: true,
        reduceOnly: true,
      });
      try {
        await _submit(closingOrder);
        notifyUser(String(pos.userId), 'positions', {
          event: 'TRAILING_STOP_HIT',
          positionId: String(pos._id),
          symbol: pos.symbol,
          price,
        });
      } catch (e) {
        // Release claim so next tick can retry.
        await Position.updateOne(
          { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
          { $set: { status: POSITION_STATUS.OPEN } }
        );
        console.error('[Worker] Trailing stop close failed:', e.message);
      }
    }
  }
};

/**
 * Price alert check (doc §7.14).
 * For each active alert, compare instrument's lastPrice against target.
 * If triggered: notify user, send email, mark inactive (or re-arm if repeatable).
 */
const checkPriceAlerts = async () => {
  const PriceAlert = require('../models/PriceAlert');
  const alerts = await PriceAlert.find({ isActive: true }).limit(500);
  if (!alerts.length) return;

  // Cache last prices per symbol for the tick
  const priceCache = new Map();
  for (const alert of alerts) {
    let price = priceCache.get(alert.symbol);
    if (price == null) {
      const inst = await Instrument.findOne({ symbol: alert.symbol }).select('lastPrice').lean();
      price = inst?.lastPrice;
      priceCache.set(alert.symbol, price);
    }
    if (!price) continue;

    const triggered =
      (alert.direction === 'ABOVE' && gte(price, alert.targetPrice)) ||
      (alert.direction === 'BELOW' && lte(price, alert.targetPrice));

    if (triggered) {
      alert.triggeredAt = new Date();
      alert.triggeredPrice = String(price);
      if (!alert.repeatable) alert.isActive = false;
      await alert.save();

      notifyUser(String(alert.userId), 'notifications', {
        type: 'PRICE_ALERT',
        symbol: alert.symbol,
        direction: alert.direction,
        targetPrice: alert.targetPrice,
        currentPrice: String(price),
      });

      try {
        const User = require('../models/User');
        const userDoc = await User.findById(alert.userId).select('email').lean();
        if (userDoc) {
          const emailSvc = require('./emailService');
          await emailSvc.sendPriceAlert({
            to: userDoc.email,
            symbol: alert.symbol,
            direction: alert.direction,
            targetPrice: alert.targetPrice,
            currentPrice: String(price),
          });
        }
      } catch (e) { /* non-fatal */ }
    }
  }
};

/**
 * Futures/options EXPIRY square-off. Any OPEN position whose instrument has
 * passed its expiryDate is force-closed (cash-settled at the last price for
 * B-book). Uses the same atomic OPEN→CLOSING claim + closeOnly route as SL/TP,
 * so the normal engine + wallet settlement runs. The closeOnly order goes via
 * orderRouter (not the HTTP controller), so the market-closed gate doesn't
 * block settlement at expiry time.
 */
const checkExpiry = async () => {
  const expired = await Instrument.find({
    segment: { $in: ['FUT', 'OPT'] },
    expiryDate: { $ne: null, $lte: new Date() },
  }).select('symbol segment optionType strike underlying').lean();
  if (!expired.length) return;

  // Options settle at INTRINSIC value, not the last traded premium. Stamp the
  // intrinsic price (from the underlying spot) as lastPrice so the B-book
  // square-off below fills there. CE = max(spot−K,0), PE = max(K−spot,0).
  for (const inst of expired) {
    if (inst.segment !== 'OPT' || !inst.optionType || inst.strike == null || !inst.underlying) continue;
    const spotDoc = await Instrument.findOne({ symbol: inst.underlying }).select('lastPrice').lean();
    const spot = spotDoc ? Number(spotDoc.lastPrice) : NaN;
    if (!Number.isFinite(spot)) continue; // no spot → fall back to last premium
    const K = Number(inst.strike);
    const intrinsic = inst.optionType === 'CE' ? Math.max(spot - K, 0) : Math.max(K - spot, 0);
    await Instrument.updateOne({ symbol: inst.symbol }, { $set: { lastPrice: String(intrinsic) } });
  }

  const symbols = expired.map((i) => i.symbol);
  const positions = await Position.find({
    symbol: { $in: symbols }, status: POSITION_STATUS.OPEN, settled: { $ne: true },
  });
  for (const pos of positions) {
    const claimed = await Position.findOneAndUpdate(
      { _id: pos._id, status: POSITION_STATUS.OPEN, settled: { $ne: true } },
      { $set: { status: POSITION_STATUS.CLOSING, closeReason: 'EXPIRY' } },
      { new: true }
    );
    if (!claimed) continue;
    const oppositeSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const sourcePositionSide = pos.positionSide || (pos.side === 'BUY' ? 'LONG' : 'SHORT');
    const closingOrder = await Order.create({
      userId: pos.userId, accountId: pos.accountId, instrumentId: pos.instrumentId,
      symbol: pos.symbol, side: oppositeSide, positionSide: sourcePositionSide,
      type: ORDER_TYPE.MARKET, quantity: pos.quantity, leverage: pos.leverage,
      status: ORDER_STATUS.PENDING, closeOnly: true, reduceOnly: true,
    });
    try {
      await _submit(closingOrder);
      notifyUser(String(pos.userId), 'positions', { event: 'EXPIRY', positionId: String(pos._id), symbol: pos.symbol });
    } catch (e) {
      await Position.updateOne(
        { _id: pos._id, status: POSITION_STATUS.CLOSING, settled: { $ne: true } },
        { $set: { status: POSITION_STATUS.OPEN } }
      );
      console.error('[Worker] expiry square-off failed:', e.message);
    }
  }
};

const tick = async () => {
  if (running) return;
  running = true;
  try {
    await triggerStopOrders();
    await triggerLimitOrders();
    await checkSlTp();
    await updateTrailingStops();
    await processOcoGroups();
    await checkMarginAndStopOut();
    await checkNegativeBalanceProtection();
    await checkPriceAlerts();
    await checkAutoModeSwitch();
    await checkExpiry();
  } catch (e) {
    console.error('[Worker] tick error:', e.message);
  } finally {
    running = false;
  }
};

/**
 * Subscription expiry sweep (low-cadence — runs hourly).
 *
 * A subscription whose `expiresAt` is in the past is treated as a
 * payment failure: the user is moved to the FREE plan and their
 * trading accounts are re-enforced (excess accounts get suspended).
 *
 * Suspended accounts can still WITHDRAW and view 3 months of history —
 * those rules live in the orderRouter and history endpoints, not here.
 */
const sweepExpiredSubscriptions = async () => {
  const { Subscription, Plan } = require('../models/Subscription');
  const subscriptionService = require('./subscriptionService');

  const now = new Date();
  // Only act on subs that are ACTIVE/TRIAL on a paid plan with a past
  // expiry. CANCELLED rows already had their downgrade applied on cancel.
  const expired = await Subscription.find({
    status: { $in: ['ACTIVE', 'TRIAL'] },
    expiresAt: { $ne: null, $lt: now },
    planCode: { $ne: 'FREE' },
  }).limit(200);

  if (!expired.length) return;
  console.log(`[Worker] subscription expiry sweep: ${expired.length} subscription(s) to downgrade`);

  for (const sub of expired) {
    try {
      // ── Auto-renew attempt — Main Wallet, then Trading if enabled.
      //    The Bonus Wallet is NEVER charged. Only runs when the user
      //    enabled auto-renew on their Main Wallet. On success we renew the
      //    same plan and skip the downgrade; on failure the account enters a
      //    grace period (soft downgrade keeps withdrawals + history).
      try {
        const subscriptionWalletService = require('./subscriptionWalletService');
        const mainW = await subscriptionWalletService.getOrCreate(sub.userId);
        if (mainW.autoRenew) {
          const plan = await Plan.findOne({ code: sub.planCode, isActive: true }).lean();
          const cycle = sub.billingCycle || 'MONTHLY';
          const price = plan ? (cycle === 'YEARLY' ? Number(plan.yearlyPrice || 0) : Number(plan.monthlyPrice || 0)) : 0;
          if (plan && price > 0) {
            const ref = await subscriptionService.chargePlan({
              userId: sub.userId, amount: price,
              note: `Auto-renew · ${plan.name} (${cycle.toLowerCase()})`,
            });
            await subscriptionService.subscribe({ userId: sub.userId, planCode: sub.planCode, billingCycle: cycle, paymentRef: ref });
            try {
              const { AuditLog, Notification } = require('../models/index');
              await AuditLog.create({ actorId: sub.userId, actorRole: 'SYSTEM', action: 'SUBSCRIPTION_AUTO_RENEW', targetType: 'SUBSCRIPTION', targetId: String(sub._id), metadata: { planCode: sub.planCode, amount: String(price), source: ref?.provider } });
              await Notification.create({ userId: sub.userId, type: 'SUBSCRIPTION_RENEWED', title: 'Subscription renewed', message: `Your ${plan.name} plan was auto-renewed from your Main Wallet.`, channels: ['IN_APP', 'EMAIL'] });
            } catch (_) { /* best-effort */ }
            notifyUser(String(sub.userId), 'subscription', { event: 'AUTO_RENEWED', plan: sub.planCode });
            continue; // renewed — skip downgrade
          }
        }
      } catch (renewErr) {
        // Insufficient Main (+Trading) balance → grace period + notify.
        // NEVER fall back to the Bonus Wallet.
        try {
          const { Notification } = require('../models/index');
          await Notification.create({
            userId: sub.userId, type: 'SUBSCRIPTION_RENEW_FAILED',
            title: 'Auto-renew failed — top up your Main Wallet',
            message: `We couldn't auto-renew your ${sub.planCode} plan: insufficient Main Wallet balance. Top up your Main Wallet and re-subscribe to keep your plan. You can still withdraw funds.`,
            channels: ['IN_APP', 'EMAIL'],
          });
        } catch (_) { /* best-effort */ }
      }

      // Mark the failed sub EXPIRED so we don't re-process it. The
      // subsequent subscribe() to FREE will overwrite the same row.
      sub.status = 'EXPIRED';
      sub.cancelledAt = now;
      sub.cancelReason = 'Payment failed / subscription expired — auto-downgraded to FREE';
      await sub.save();

      // Re-subscribe to FREE. This triggers leverage + plan-enforcement
      // hooks inside subscriptionService.subscribe (suspends excess).
      await subscriptionService.subscribe({
        userId: sub.userId,
        planCode: 'FREE',
        billingCycle: 'MONTHLY',
        paymentRef: {
          provider: 'AUTO',
          transactionId: `auto-downgrade-${sub._id}`,
          amount: '0',
          paidAt: now,
        },
      });

      // Notify the user (best-effort).
      try {
        const { Notification } = require('../models/index');
        await Notification.create({
          userId: sub.userId,
          type: 'SUBSCRIPTION_DOWNGRADED',
          title: 'Subscription downgraded to Free',
          message: 'Your paid subscription has expired or payment failed. You are now on the Free plan. Some accounts may be suspended until you re-subscribe — you can still withdraw funds and view 3 months of history.',
          channels: ['IN_APP', 'EMAIL'],
        });
      } catch (_) { /* notifications are best-effort */ }

      notifyUser(String(sub.userId), 'subscription', {
        event: 'AUTO_DOWNGRADED',
        from: sub.planCode,
        to: 'FREE',
        reason: 'expired',
      });
    } catch (e) {
      console.error(`[Worker] subscription downgrade failed for sub ${sub._id}:`, e.message);
    }
  }
};

// ─── Monthly partner-tier recalculation ──────────────────────────────
// Partner tiers are driven by the PREVIOUS calendar month's referral
// trading volume and must be recomputed on the 1st of each month, then
// held fixed for the whole month. We pigg-back on the hourly slow-tick:
// when the calendar month changes (or on first boot) we refresh every
// partner's tier snapshot. Reads also self-heal lazily, so this is a
// proactive sweep — even a missed run is corrected on the next read.
let _lastTierMonth = null;
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const recalcPartnerTiersIfNewMonth = async () => {
  const m = monthKey(new Date());
  if (_lastTierMonth === m) return;
  try {
    const partnerService = require('./partnerService');
    const n = await partnerService.recalcAllPartnerTiers();
    _lastTierMonth = m;
    console.log(`[Worker] partner tier monthly recalculation done for ${m} (${n} partners)`);
  } catch (e) {
    console.error('[Worker] partner tier recalculation failed:', e.message);
  }
};

// Daily pre-market refresh of Dhan instruments (F&O tokens roll each series +
// new expiries appear). Runs once/day in the 07:00–09:59 IST window. No-op
// unless Dhan is configured. Idempotent via the IST day guard.
let _lastDhanSyncDay = null;
const syncDhanDaily = async () => {
  if (!(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN)) return;
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  });
  const p = {}; for (const x of f.formatToParts(new Date())) p[x.type] = x.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
  if (hour < 7 || hour >= 10) return;          // pre-market window only
  if (_lastDhanSyncDay === day) return;        // already synced today
  _lastDhanSyncDay = day;
  try {
    const r = await require('./dhanInstrumentSync').syncAll();
    console.log(`[Worker] Dhan instrument sync: ${r.ops} contracts (upserted ${r.upserted}, modified ${r.modified})`);
  } catch (e) {
    console.error('[Worker] Dhan instrument sync failed:', e.message);
    _lastDhanSyncDay = null;                    // retry next slow-tick
  }
};

let _tickHandle = null;
let _slowTickHandle = null;
const start = (intervalMs = 5000) => {
  if (_tickHandle) return; // already running — idempotent for hot-reload safety
  console.log('[Worker] Background worker started (STOP, LIMIT, SL/TP, trailing, OCO, margin, neg-balance, alerts, auto-switch every 5s)');
  _tickHandle = setInterval(tick, intervalMs);

  // Hourly low-cadence sweep for subscription expiry. Runs once on boot
  // (5s delay so DB is ready) then every hour. Separate handle so a
  // long-running expiry sweep can't starve the fast tick.
  const slowTick = async () => {
    try {
      await sweepExpiredSubscriptions();
      await recalcPartnerTiersIfNewMonth();
      await syncDhanDaily();
    } catch (e) {
      console.error('[Worker] slow-tick error:', e.message);
    }
  };
  setTimeout(slowTick, 5000);
  _slowTickHandle = setInterval(slowTick, 60 * 60 * 1000);
};

// Called from server.js on graceful shutdown — stops scheduling new ticks.
// An in-flight tick is allowed to complete (closing orders mid-flight
// must finish so we don't strand a position in CLOSING state).
const stop = () => {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
    console.log('[Worker] Background worker stopped');
  }
  if (_slowTickHandle) {
    clearInterval(_slowTickHandle);
    _slowTickHandle = null;
  }
};

module.exports = { start, stop, setBroadcaster };
