const mongoose = require('mongoose');
const OrderBook = require('./OrderBook');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const Instrument = require('../models/Instrument');
const Position = require('../models/Position');
const TradingAccount = require('../models/TradingAccount');
const { ORDER_STATUS, ORDER_SIDE, POSITION_STATUS, ROUTING } = require('../config/constants');
const { add, sub, mul, div, eq, gt, lte, D } = require('../utils/decimal');
const { computeInstrumentCommission } = require('../utils/commission');

// Which book an order's resulting position belongs to: A_BOOK = forwarded to
// LP; everything else (B_BOOK, internal matching) = broker is the counterparty.
const bookOf = (o) => (String(o?.routingResult || '').toUpperCase() === 'A_BOOK' ? 'A_BOOK' : 'B_BOOK');

/**
 * In-process Matching Engine.
 * - One OrderBook per symbol.
 * - Process incoming orders sequentially per symbol (single-writer principle).
 *
 * Limitation: This is for MVP/dev only. For production:
 *   - Move state to Redis sorted sets
 *   - Use BullMQ / Redis Streams for serialized intake per symbol
 *   - Port hot path to Rust/Go when >1000 orders/sec/instrument
 */
class MatchingEngine {
  constructor() {
    this.books = new Map(); // symbol -> OrderBook
    this.queues = new Map(); // symbol -> Promise (serializer)
    this.broadcaster = null; // injected: WebSocket broadcaster
    // Phase 0 throughput: short-TTL instrument cache so the per-order intake
    // read + the per-settle read don't both hit Mongo every order. Safe under
    // the per-symbol single-writer model (no concurrent mutation within a
    // symbol). TTL bounds price staleness for B-book fills.
    this._instrCache = new Map(); // instrumentId -> { doc, exp }
    this._instrCacheMs = Number(process.env.MATCHING_INSTRUMENT_CACHE_MS) || 50;
    // Account META cache (baseCurrency + accountType ONLY — both static). Never
    // caches balance/locked; those are always read/written fresh by the wallet
    // service. Used to drop the per-settle account read.
    this._acctCache = new Map(); // accountId -> { doc, exp }
  }

  setBroadcaster(broadcaster) {
    this.broadcaster = broadcaster;
  }

  getBook(symbol) {
    if (!this.books.has(symbol)) this.books.set(symbol, new OrderBook(symbol));
    return this.books.get(symbol);
  }

  // Short-TTL instrument fetch (Phase 0). Returns the cached Mongoose doc when
  // fresh, else reloads. Removes the redundant intake + settle reads per order.
  async _getInstrument(instrumentId) {
    const key = String(instrumentId);
    const hit = this._instrCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.doc;
    const doc = await Instrument.findById(instrumentId);
    if (doc) this._instrCache.set(key, { doc, exp: Date.now() + this._instrCacheMs });
    return doc;
  }

  // Static account fields (baseCurrency + accountType) for fee/currency
  // resolution at settle. Balance/locked are NEVER taken from here.
  async _getAccountMeta(accountId) {
    const key = String(accountId);
    const hit = this._acctCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.doc;
    const doc = await TradingAccount.findById(accountId).select('baseCurrency accountType').lean();
    if (doc) this._acctCache.set(key, { doc, exp: Date.now() + this._instrCacheMs });
    return doc;
  }

  // Persist a new lastPrice WITHOUT a full doc.save() — updateOne avoids
  // Mongoose version conflicts when the same cached doc is reused across orders,
  // and stays fire-and-forget (off the hot path). Also updates the cached doc
  // so the next order in the TTL window sees the latest price.
  _persistLastPrice(instrument, price) {
    if (!instrument || price == null) return;
    instrument.lastPrice = price;
    instrument.lastPriceUpdatedAt = new Date();
    Instrument.updateOne(
      { _id: instrument._id },
      { $set: { lastPrice: price, lastPriceUpdatedAt: instrument.lastPriceUpdatedAt } }
    ).catch(() => {});
  }

  /** Rebuild order books from open orders on engine start (crash recovery). */
  async hydrateFromDB() {
    const openOrders = await Order.find({
      status: { $in: [ORDER_STATUS.PENDING, ORDER_STATUS.PARTIALLY_FILLED] },
      type: { $in: ['LIMIT', 'STOP'] },
    }).sort({ createdAt: 1 });

    let restored = 0;
    for (const o of openOrders) {
      // LIMIT orders go in immediately. A STOP that has already been triggered
      // and turned into a STOP-LIMIT (triggeredAt set + price present) ALSO
      // lives on the book; pre-fix it would be orphaned across a restart and
      // never fill.
      if (o.type === 'LIMIT') {
        this.getBook(o.symbol).add(o);
        restored++;
      } else if (o.type === 'STOP' && o.triggeredAt && o.price) {
        this.getBook(o.symbol).add(o);
        restored++;
      }
      // Untriggered STOP and STOP-MARKET (no limit price after trigger) stay
      // off-book; the worker handles their lifecycle.
    }
    console.log(`[ME] Hydrated ${restored}/${openOrders.length} open orders into order books`);
  }

  /**
   * Serialization key for an order.
   *   • Book-matched orders (internal LIMIT/STOP) mutate the SHARED per-symbol
   *     order book → must serialize per SYMBOL.
   *   • B-book / EXTERNAL fills are synthetic: they never touch the order book,
   *     and they only mutate their OWN position + (atomically) their OWN wallet.
   *     So they serialize per (account, symbol) — which lets DIFFERENT accounts
   *     trade the SAME symbol fully in parallel (the real-market case, and the
   *     key lever for per-symbol throughput).
   */
  _queueKey(order) {
    const r = String(order.routing || '').toUpperCase();
    if (r === 'B_BOOK' || r === 'EXTERNAL') return `pos:${order.accountId}:${order.symbol}`;
    return `sym:${order.symbol}`;
  }

  /** Serialize processing per queue key (see _queueKey). */
  async submit(order) {
    const key = this._queueKey(order);
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(() => this._processOrder(order)).catch((e) => {
      console.error('[ME] processOrder error:', e);
      throw e;
    });
    const tracked = next.catch(() => {}); // chain even on error
    this.queues.set(key, tracked);
    // Drop the key once its chain fully drains (prevents unbounded growth of
    // per-account keys), but only if no newer order has chained onto it.
    tracked.finally(() => { if (this.queues.get(key) === tracked) this.queues.delete(key); });
    return next;
  }

  async _processOrder(order) {
    const instrument = await this._getInstrument(order.instrumentId);
    if (!instrument || !instrument.isActive) {
      order.status = ORDER_STATUS.REJECTED;
      order.rejectionReason = 'Instrument inactive';
      await order.save();
      return order;
    }

    // A triggered STOP order is processed as STOP-LIMIT (when price set) or
    // STOP-MARKET (when not). The original type stays 'STOP' for the audit
    // trail; we use this local alias for the matching logic below.
    const effectiveType =
      order.type === 'STOP' && order.triggeredAt
        ? (order.price ? 'LIMIT' : 'MARKET')
        : order.type;

    // B-book route: broker is counterparty. Fill at last price (or quote price for limits).
    // No matching against the order book - this is a separate execution path.
    if (order.routing === 'B_BOOK') {
      return this._processBBookOrder(order, instrument);
    }

    // EXTERNAL route: in production this would forward to a real LP / Binance via API.
    // For MVP without a real LP integration, we simulate the fill at last price so
    // the platform stays functional. Trade is marked routing='EXTERNAL' for the audit
    // trail. PROFITABLE traders end up here so the broker doesn't take their flow.
    //
    // TODO: wire to a real LP adapter (Binance trading API, LMAX FIX, etc.) for true STP.
    if (order.routing === 'EXTERNAL') {
      return this._processExternalOrder(order, instrument);
    }

    const book = this.getBook(order.symbol);
    // For triggered STOP we feed the matcher a view with the effective type
    // (so STOP-LIMIT respects price compatibility, STOP-MARKET crosses freely),
    // while the persisted order keeps type='STOP'.
    const matchView = effectiveType !== order.type ? { ...order.toObject?.() ?? order, type: effectiveType } : order;
    const { fills, remaining } = book.match(matchView);

    let avgFillPrice = '0';
    let totalFilled = '0';

    if (fills.length) {
      // Persist trades and update orders/positions
      let weightedSum = '0';
      for (const f of fills) {
        // Update maker order
        const maker = await Order.findById(f.makerOrderId);
        if (maker) {
          maker.filledQuantity = add(maker.filledQuantity, f.qty);
          if (eq(maker.filledQuantity, maker.quantity)) {
            maker.status = ORDER_STATUS.FILLED;
            maker.filledAt = new Date();
          } else {
            maker.status = ORDER_STATUS.PARTIALLY_FILLED;
          }
          // Update avg fill on maker
          const prevAvg = maker.avgFillPrice || '0';
          const prevQty = sub(maker.filledQuantity, f.qty);
          const newAvg =
            eq(maker.filledQuantity, '0')
              ? f.price
              : div(add(mul(prevAvg, prevQty), mul(f.price, f.qty)), maker.filledQuantity);
          maker.avgFillPrice = newAvg;
          await maker.save();
        }

        // Create Trade
      const isIncomingBuy = order.side === ORDER_SIDE.BUY;
        const newTrade = await Trade.create({
          instrumentId: order.instrumentId,
          symbol: order.symbol,
          buyOrderId: isIncomingBuy ? order._id : f.makerOrderId,
          sellOrderId: isIncomingBuy ? f.makerOrderId : order._id,
          buyUserId: isIncomingBuy ? order.userId : f.makerUserId,
          sellUserId: isIncomingBuy ? f.makerUserId : order.userId,
          buyAccountId: isIncomingBuy ? order.accountId : f.makerAccountId,
          sellAccountId: isIncomingBuy ? f.makerAccountId : order.accountId,
          price: f.price,
          quantity: f.qty,
          // A real user↔user match in INTERNAL_MATCHING mode is tagged as
          // such so reports can split true peer matching from legacy
          // internalised fills. Buyer and seller are distinct users.
          routing: order.routing === ROUTING.INTERNAL_MATCHING ? ROUTING.INTERNAL_MATCHING : ROUTING.INTERNAL,
        });

        // Distribute affiliate commissions on the spread/fee.
        // For INTERNAL trades, fee is approximated as (instrument.commissionPercent * notional).
        // Affiliate commission — non-critical; runs after the fill (off the
        // hot path) so it never adds latency to matching/settlement.
        setImmediate(async () => {
          try {
            const affiliateService = require('../services/affiliateService');
            const subscriptionService = require('../services/subscriptionService');
            const notional = mul(f.price, f.qty);
            let feeAmount = computeInstrumentCommission(instrument, notional);
            feeAmount = await subscriptionService.applyFeeDiscount(order.userId, feeAmount);
            if (gt(feeAmount, '0')) {
              await affiliateService.distributeCommissions({
                tradeId: newTrade._id,
                userId: order.userId,
                feeAmount,
                currency: instrument.quoteCurrency,
              });
            }
          } catch (e) {
            console.error('[ME] Affiliate commission error:', e.message);
          }
        });

        // Update positions for both sides. Same tradeId is passed to both
        // sides so each derives its own dedupeKey of "TRADE_SETTLE:<tradeId>".
        // (Idempotency is per (wallet, dedupeKey) so taker and maker each
        // get one settle on their own wallet.)
        await this._updatePosition(order.accountId, order.userId, order.instrumentId, order.symbol, order.side, f.qty, f.price, order.leverage, newTrade._id, order.closeOnly, order.stopLoss, order.takeProfit, order.positionSide, bookOf(order));

        // Maker side: skip the position update if we couldn't load the maker
        // doc (deleted out from under us, etc.). Defaulting leverage to 1
        // would distort their margin calc; better to log loudly and rely on
        // the worker's reconciliation pass than silently corrupt state.
        if (maker) {
          await this._updatePosition(
            f.makerAccountId,
            f.makerUserId,
            order.instrumentId,
            order.symbol,
            maker.side,
            f.qty,
            f.price,
            maker.leverage || 1,
            newTrade._id,
            maker.closeOnly,
            maker.stopLoss,
            maker.takeProfit,
            maker.positionSide,
            bookOf(maker)
          );
        } else {
          console.error(
            `[ME] Maker order ${f.makerOrderId} not found while settling trade ${newTrade._id} — maker-side position not updated`
          );
        }

        weightedSum = add(weightedSum, mul(f.price, f.qty));
        totalFilled = add(totalFilled, f.qty);

        // Broadcast trade
        if (this.broadcaster) {
          this.broadcaster.broadcastTrade({
            symbol: order.symbol,
            price: f.price,
            quantity: f.qty,
            side: order.side,
            ts: Date.now(),
          });
        }
      }
      avgFillPrice = eq(totalFilled, '0') ? '0' : div(weightedSum, totalFilled);

      // Update last price on instrument
      this._persistLastPrice(instrument, fills[fills.length - 1].price);
    }

    // Update incoming order
    order.filledQuantity = add(order.filledQuantity, totalFilled);
    if (gt(totalFilled, '0')) {
      // weighted avg with prior avgFillPrice
      const priorFilled = sub(order.filledQuantity, totalFilled);
      const priorAvg = order.avgFillPrice || '0';
      order.avgFillPrice = eq(order.filledQuantity, '0')
        ? '0'
        : div(add(mul(priorAvg, priorFilled), mul(avgFillPrice, totalFilled)), order.filledQuantity);
    }

    if (eq(remaining, '0')) {
      order.status = ORDER_STATUS.FILLED;
      order.filledAt = new Date();
    } else if (gt(order.filledQuantity, '0')) {
      order.status = ORDER_STATUS.PARTIALLY_FILLED;
    } else if (effectiveType === 'MARKET' && !(order.routing === ROUTING.INTERNAL_MATCHING && !order.closeOnly)) {
      // MARKET (or triggered STOP-MARKET) with no resting liquidity.
      // B-book, legacy internal, and INTERNAL_MATCHING *closes* internalise
      // at last price so the user can always be filled / always exit.
      //
      // Pre-fix behavior: reject with "No liquidity for market order" — which
      // left positions stuck OPEN whenever a user tried to close them on a
      // thin/empty book, so PnL never settled and the wallet never moved.
      // Real brokers don't do that — they internalize at last-traded price.
      //
      // Fallback: synthetic fill at instrument.lastPrice (with side-adjusted
      // spread). The trade is tagged routing='INTERNAL_FALLBACK' so audit
      // logs distinguish it from a true book match. _updatePosition then
      // settles PnL through walletService.settleTradeClose as usual.
      const refPrice = instrument.lastPrice;
      if (refPrice && !eq(refPrice, '0')) {
        const remainingQty = remaining;
        // Half-spread per side — matches the quoted bid/ask (see B-book note).
        const halfSpread = D(instrument.spreadValue || '0').times(D('0.5'));
        let executed = D(refPrice);
        if (instrument.spreadType === 'PERCENTAGE') {
          executed = order.side === 'BUY'
            ? executed.times(D('1').plus(halfSpread))
            : executed.times(D('1').minus(halfSpread));
        } else {
          executed = order.side === 'BUY' ? executed.plus(halfSpread) : executed.minus(halfSpread);
        }
        const fillPx = executed.toString();

        // Persist a synthetic Trade so the audit trail and reports are correct.
        const fbTrade = await Trade.create({
          instrumentId: order.instrumentId,
          symbol: order.symbol,
          buyOrderId: order._id,
          sellOrderId: order._id,
          buyUserId: order.userId,
          sellUserId: order.userId,
          buyAccountId: order.accountId,
          sellAccountId: order.accountId,
          price: fillPx,
          quantity: remainingQty,
          routing: 'INTERNAL', // fallback still counts as internalized
        });

        // Settle the position (this is where the user's wallet PnL lands).
        // tradeId enables idempotent settle via dedupeKey.
        await this._updatePosition(
          order.accountId,
          order.userId,
          order.instrumentId,
          order.symbol,
          order.side,
          remainingQty,
          fillPx,
          order.leverage,
          fbTrade._id,
          order.closeOnly,
          order.stopLoss,
          order.takeProfit,
          order.positionSide,
          bookOf(order)
        );

        order.filledQuantity = add(order.filledQuantity, remainingQty);
        order.avgFillPrice = fillPx;
        order.status = ORDER_STATUS.FILLED;
        order.filledAt = new Date();
        order.rejectionReason = undefined;

        // Update instrument last-price + broadcast tape so the chart & UI
        // reflect this fill, same as a real match would.
        this._persistLastPrice(instrument, fillPx);
        {
          const { updateCandlesForTrade } = require('../services/candleService');
          updateCandlesForTrade({
            symbol: order.symbol,
            price: fillPx,
            quantity: remainingQty,
            ts: Date.now(),
          }).catch(() => {}); // fire-and-forget: candle aggregation off the hot path
        }

        if (this.broadcaster) {
          this.broadcaster.broadcastTrade({
            symbol: order.symbol,
            price: fillPx,
            quantity: remainingQty,
            side: order.side,
            ts: Date.now(),
          });
          // Without these, the wallet/positions panels stay stale until the
          // next polling tick — user wouldn't see their PnL credit/debit
          // immediately after closing through the fallback path.
          this.broadcaster.notifyUser(String(order.userId), 'orders', {
            event: 'FILLED',
            orderId: String(order._id),
            symbol: order.symbol,
            avgPrice: fillPx,
          });
          this.broadcaster.notifyUser(String(order.userId), 'positions', { event: 'UPDATED' });
          this.broadcaster.notifyUser(String(order.userId), 'wallet', { event: 'UPDATED' });
        }

        console.log(`[ME] INTERNAL fallback fill: ${order.symbol} ${order.side} ${remainingQty} @ ${fillPx} (no book liquidity)`);
      } else {
        // Genuine zero-data state — no last price to fill against.
        order.status = ORDER_STATUS.REJECTED;
        order.rejectionReason = 'No reference price for market order';
      }
    } else if (effectiveType === 'MARKET') {
      // INTERNAL_MATCHING *opening* market order with no opposing book
      // liquidity. This is a pure user↔user venue — the broker is NOT the
      // counterparty — so we reject the unmatched remainder rather than
      // synthesising a broker fill. (Closes are handled by the branch above.)
      order.status = ORDER_STATUS.REJECTED;
      order.rejectionReason = 'No matching liquidity (internal matching)';
    }

    // Rest-on-book applies to LIMIT orders, including a triggered STOP-LIMIT.
    if (effectiveType === 'LIMIT' && gt(remaining, '0') && order.status !== ORDER_STATUS.REJECTED) {
      book.add(order);
    }

    await order.save();

    // Broadcast updated order book snapshot
    if (this.broadcaster) {
      this.broadcaster.broadcastOrderBook(order.symbol, book.snapshot(25));
    }

    // Notify the order owner privately on fills
    if (this.broadcaster && fills.length) {
      this.broadcaster.notifyUser(String(order.userId), 'orders', {
        event: order.status === ORDER_STATUS.FILLED ? 'FILLED' : 'PARTIAL_FILL',
        orderId: String(order._id),
        symbol: order.symbol,
        side: order.side,
        filled: order.filledQuantity,
        avgPrice: order.avgFillPrice,
      });
      this.broadcaster.notifyUser(String(order.userId), 'positions', { event: 'UPDATED' });
      this.broadcaster.notifyUser(String(order.userId), 'wallet', { event: 'UPDATED' });
      // Notify makers (uniquely)
      const notifiedMakers = new Set();
      for (const f of fills) {
        if (!notifiedMakers.has(f.makerUserId)) {
          this.broadcaster.notifyUser(f.makerUserId, 'orders', {
            event: 'FILLED',
            orderId: f.makerOrderId,
            symbol: order.symbol,
          });
          this.broadcaster.notifyUser(f.makerUserId, 'positions', { event: 'UPDATED' });
          this.broadcaster.notifyUser(f.makerUserId, 'wallet', { event: 'UPDATED' });
          notifiedMakers.add(f.makerUserId);
        }
      }
    }

    return order;
  }

  /**
   * B-book execution: broker becomes the counterparty.
   * Fills the order at instrument's last price (with spread if configured).
   * Trader's PnL is the broker's PnL inverted - so broker keeps losing trades.
   *
   * Per doc §9.3: B-book is enabled per-instrument and for specific user groups,
   * never in INTERNAL-Only mode (validated upstream).
   */
  async _processBBookOrder(order, instrument) {
    const fillPrice = order.price || instrument.lastPrice;
    if (!fillPrice || eq(fillPrice, '0')) {
      order.status = ORDER_STATUS.REJECTED;
      order.rejectionReason = 'No reference price for B-book fill';
      await order.save();
      return order;
    }

    // Apply broker spread (markup) on B-book fills. HALF the spread per side so
    // the executed fill matches the quoted bid/ask (ask = mid + spread/2,
    // bid = mid − spread/2). `spreadValue` is the total bid-ask width.
    const halfSpread = D(instrument.spreadValue || '0').times(D('0.5'));
    let executedPrice = D(fillPrice);
    if (instrument.spreadType === 'PERCENTAGE') {
      executedPrice = order.side === 'BUY'
        ? executedPrice.times(D('1').plus(halfSpread))
        : executedPrice.times(D('1').minus(halfSpread));
    } else {
      executedPrice = order.side === 'BUY' ? executedPrice.plus(halfSpread) : executedPrice.minus(halfSpread);
    }
    const finalPrice = executedPrice.toString();

    // Record a Trade with the broker as the synthetic counterparty.
    // We use the user as both buyer and seller (with B_BOOK routing flag) for simplicity;
    // real systems use a "broker account" entity. Either way, the trail is in the routing field.
    // Pre-generate the trade id so the trade record and the position settle can
    // be persisted IN PARALLEL — the settle only needs the id (for its
    // idempotent dedupeKey), not the persisted Trade doc.
    const tradeId = new mongoose.Types.ObjectId();

    // Update instrument lastPrice (version-safe) + aggregate into candles.
    this._persistLastPrice(instrument, finalPrice);
    {
      const { updateCandlesForTrade } = require('../services/candleService');
      updateCandlesForTrade({
        symbol: order.symbol,
        price: finalPrice,
        quantity: order.quantity,
        ts: Date.now(),
      }).catch((e) => console.error('[ME] B-book candle update failed:', e.message)); // fire-and-forget
    }

    // Trade record + position settle are independent writes → run in parallel.
    await Promise.all([
      Trade.create({
        _id: tradeId,
        instrumentId: order.instrumentId,
        symbol: order.symbol,
        buyOrderId: order._id,
        sellOrderId: order._id,
        buyUserId: order.userId,
        sellUserId: order.userId,
        buyAccountId: order.accountId,
        sellAccountId: order.accountId,
        price: finalPrice,
        quantity: order.quantity,
        routing: 'B_BOOK',
      }),
      this._updatePosition(
        order.accountId,
        order.userId,
        order.instrumentId,
        order.symbol,
        order.side,
        order.quantity,
        finalPrice,
        order.leverage,
        tradeId,
        order.closeOnly,
        order.stopLoss,
        order.takeProfit,
        order.positionSide,
        bookOf(order)
      ),
    ]);

    order.status = ORDER_STATUS.FILLED;
    order.filledQuantity = order.quantity;
    order.avgFillPrice = finalPrice;
    order.filledAt = new Date();
    await order.save();

    // Distribute affiliate commissions (B-book also pays referrers based on
    // spread captured). Non-critical → runs after the fill (off the hot path).
    setImmediate(async () => {
      try {
        const affiliateService = require('../services/affiliateService');
        const subscriptionService = require('../services/subscriptionService');
        const notional = mul(finalPrice, order.quantity);
        let feeAmount = computeInstrumentCommission(instrument, notional);
        feeAmount = await subscriptionService.applyFeeDiscount(order.userId, feeAmount);
        if (gt(feeAmount, '0')) {
          await affiliateService.distributeCommissions({
            tradeId,
            userId: order.userId,
            feeAmount,
            currency: instrument.quoteCurrency,
          });
        }
      } catch (e) {
        console.error('[ME] B-book commission error:', e.message);
      }
    });

    // Broadcast ticker and trade tape so chart and last-price update
    if (this.broadcaster) {
      this.broadcaster.broadcastTrade({
        symbol: order.symbol,
        price: finalPrice,
        quantity: order.quantity,
        side: order.side,
        ts: Date.now(),
      });
      this.broadcaster.notifyUser(String(order.userId), 'orders', {
        event: 'FILLED',
        orderId: String(order._id),
        symbol: order.symbol,
        routing: 'B_BOOK',
        avgPrice: finalPrice,
      });
      this.broadcaster.notifyUser(String(order.userId), 'positions', { event: 'UPDATED' });
      this.broadcaster.notifyUser(String(order.userId), 'wallet', { event: 'UPDATED' });
    }

    return order;
  }

  /**
   * EXTERNAL execution path.
   *
   * In a real STP/A-book broker, this would call the LP/exchange API to place
   * the order externally. For MVP, we simulate the fill at last price so:
   *   - Profitable traders' orders don't sit pending forever
   *   - The audit trail is preserved (trade.routing = 'EXTERNAL')
   *   - Broker accounting can later show "this should have been hedged externally"
   *
   * Production TODO: replace simulated fill with real LP adapter:
   *   - Binance: place a corresponding spot/futures order via authenticated API
   *   - LMAX/Refinitiv: forward via FIX protocol
   *   - cTrader: route via OpenAPI
   * The broker's hedge position lives on the LP side, P&L is netted off-platform.
   */
  async _processExternalOrder(order, instrument) {
    const refPrice = order.type === 'LIMIT' && order.price ? order.price : instrument.lastPrice;
    if (!refPrice || lte(refPrice, '0')) {
      order.status = ORDER_STATUS.REJECTED;
      order.rejectionReason = 'No reference price available for external routing';
      await order.save();
      return order;
    }

    // Apply spread (broker still earns even on STP - usually a small commission/markup).
    // Honor PERCENTAGE vs FIXED spread the same way B-book does, so EXTERNAL
    // fills aren't silently mispriced when an instrument is configured with a
    // percent spread.
    // Half-spread per side — matches the quoted bid/ask (see B-book note).
    const halfSpreadD = D(instrument.spreadValue || '0').times(D('0.5'));
    let executedExt = D(refPrice);
    if (instrument.spreadType === 'PERCENTAGE') {
      executedExt = order.side === 'BUY'
        ? executedExt.times(D('1').plus(halfSpreadD))
        : executedExt.times(D('1').minus(halfSpreadD));
    } else {
      executedExt = order.side === 'BUY'
        ? executedExt.plus(halfSpreadD)
        : executedExt.minus(halfSpreadD);
    }
    const finalPrice = executedExt.toString();

    // Record the trade with EXTERNAL routing
    const externalTrade = await Trade.create({
      instrumentId: order.instrumentId,
      symbol: order.symbol,
      buyOrderId: order._id,
      sellOrderId: order._id,
      buyUserId: order.userId,
      sellUserId: order.userId,
      buyAccountId: order.accountId,
      sellAccountId: order.accountId,
      price: finalPrice,
      quantity: order.quantity,
      routing: 'EXTERNAL',
    });

    // Update lastPrice + candles so chart reflects the activity
    this._persistLastPrice(instrument, finalPrice);
    {
      const { updateCandlesForTrade } = require('../services/candleService');
      updateCandlesForTrade({
        symbol: order.symbol,
        price: finalPrice,
        quantity: order.quantity,
        ts: Date.now(),
      }).catch(() => {}); // fire-and-forget: candle aggregation off the hot path
    }

    // Update trader's position (broker has no position - it's "hedged" externally)
    await this._updatePosition(
      order.accountId,
      order.userId,
      order.instrumentId,
      order.symbol,
      order.side,
      order.quantity,
      finalPrice,
      order.leverage,
      externalTrade._id,
      order.closeOnly,
      order.stopLoss,
      order.takeProfit,
      order.positionSide,
      bookOf(order)
    );

    order.status = ORDER_STATUS.FILLED;
    order.filledQuantity = order.quantity;
    order.avgFillPrice = finalPrice;
    order.filledAt = new Date();
    await order.save();

    // Distribute affiliate commissions on the spread. Non-critical → runs
    // after the fill (off the hot path).
    setImmediate(async () => {
      try {
        const affiliateService = require('../services/affiliateService');
        const subscriptionService = require('../services/subscriptionService');
        const notional = mul(finalPrice, order.quantity);
        let feeAmount = computeInstrumentCommission(instrument, notional);
        feeAmount = await subscriptionService.applyFeeDiscount(order.userId, feeAmount);
        if (gt(feeAmount, '0')) {
          await affiliateService.distributeCommissions({
            tradeId: externalTrade._id,
            userId: order.userId,
            feeAmount,
            currency: instrument.quoteCurrency,
          });
        }
      } catch (e) {
        console.error('[ME] EXTERNAL commission error:', e.message);
      }
    });

    // Broadcast
    if (this.broadcaster) {
      this.broadcaster.broadcastTrade({
        symbol: order.symbol,
        price: finalPrice,
        quantity: order.quantity,
        side: order.side,
        ts: Date.now(),
      });
      this.broadcaster.notifyUser(String(order.userId), 'orders', {
        event: 'FILLED',
        orderId: String(order._id),
        symbol: order.symbol,
        routing: 'EXTERNAL',
        avgPrice: finalPrice,
      });
      this.broadcaster.notifyUser(String(order.userId), 'positions', { event: 'UPDATED' });
      this.broadcaster.notifyUser(String(order.userId), 'wallet', { event: 'UPDATED' });
    }

    return order;
  }

  /**
   * Apply a fill to the user's net position for one symbol.
   *
   * Same-side fill → grow position with weighted-average entry.
   * Opposite-side fill → reduce / fully close / flip, settling PnL via
   * walletService.settleTradeClose. Settle path uses tradeId-derived
   * dedupeKey for idempotency, and Position.findOneAndUpdate (NOT
   * doc.save) for the CLOSED transition so concurrent SL+TP+manual
   * closes can't double-settle.
   */
  async _updatePosition(accountId, userId, instrumentId, symbol, side, qty, price, leverage, tradeId, closeOnly = false, stopLoss = null, takeProfit = null, positionSide = null, book = 'B_BOOK') {
    // HEDGE MODE — LONG and SHORT positions on the same instrument coexist.
    // Position identity is (accountId, symbol, positionSide), so a BUY fill
    // never auto-closes a SHORT position and vice versa.
    //
    // For OPENING fills (closeOnly=false): the position side comes from the
    // order's `side` — BUY opens/grows the LONG bucket, SELL opens/grows the
    // SHORT bucket. The opposite-side bucket is untouched.
    //
    // For CLOSE fills (closeOnly=true): the controller stamps the order's
    // `positionSide` from the source position so the engine targets the
    // correct bucket. The order's `side` is the opposite of the position
    // (a SELL closes the LONG, a BUY closes the SHORT) but its
    // `positionSide` still points at the bucket being reduced.
    const targetPositionSide = positionSide
      || (closeOnly
        ? (side === 'SELL' ? 'LONG' : 'SHORT')  // legacy fallback: opposite of close side
        : (side === 'BUY'  ? 'LONG' : 'SHORT'));

    // Accept both OPEN and CLOSING — controller may have stamped the
    // position to CLOSING as an atomic claim, but the engine still needs
    // to settle it.
    let pos = await Position.findOne({
      accountId,
      symbol,
      positionSide: targetPositionSide,
      status: { $in: [POSITION_STATUS.OPEN, POSITION_STATUS.CLOSING] },
    });

    // Legacy fallback — if no position matches by positionSide (old docs
    // written before the field existed), fall back to a side-only lookup
    // and on-the-fly attach the derived positionSide before we update it.
    if (!pos) {
      const legacy = await Position.findOne({
        accountId,
        symbol,
        positionSide: { $exists: false },
        status: { $in: [POSITION_STATUS.OPEN, POSITION_STATUS.CLOSING] },
      });
      if (legacy) {
        const derived = legacy.side === 'BUY' ? 'LONG' : 'SHORT';
        if (derived === targetPositionSide) {
          legacy.positionSide = derived;
          await legacy.save();
          pos = legacy;
        }
      }
    }

    // closeOnly orders must NOT open a new position. They were generated
    // for the express purpose of closing existing exposure (manual close,
    // partial close, SL/TP, stop-out, trailing). If no matching-side
    // position exists, skip.
    if (closeOnly) {
      if (!pos) {
        console.warn(
          `[ME] closeOnly order arrived but no open ${targetPositionSide} position exists for ${symbol} acc=${accountId} — skipping`
        );
        return null;
      }
      if (gt(qty, pos.quantity)) {
        console.log(
          `[ME] closeOnly capping qty: requested ${qty}, position has ${pos.quantity} (${symbol} ${targetPositionSide})`
        );
        qty = pos.quantity;
      }
    }

    const margin = div(mul(qty, price), leverage || 1);

    if (!pos) {
      // Open a new position on the target side. Side is the order's side
      // (BUY for LONG, SELL for SHORT) — never the opposite, because we
      // arrived here only if no matching-side position existed AND this is
      // not a closeOnly order.
      pos = await Position.create({
        userId,
        accountId,
        instrumentId,
        symbol,
        side,
        positionSide: targetPositionSide,
        book: book === 'A_BOOK' ? 'A_BOOK' : 'B_BOOK',
        quantity: qty,
        entryPrice: price,
        leverage: leverage || 1,
        margin,
        // Carry SL/TP from the opening order onto the new position. Without
        // this, the order-time inputs were stored on the Order doc but
        // never on Position, so backgroundWorker never tripped them — the
        // user had to re-enter them via the modify endpoint after fill.
        ...(stopLoss   ? { stopLoss:   String(stopLoss)   } : {}),
        ...(takeProfit ? { takeProfit: String(takeProfit) } : {}),
      });
      return pos;
    }

    // SAME-SIDE OPENING FILL — grow the existing position (weighted-avg
    // entry). In hedge mode this happens when the new order's side matches
    // the position's open side (e.g. another BUY adds to LONG). No
    // settlement; just lock more margin (already locked at placeOrder).
    if (!closeOnly && pos.side === side) {
      const newQty = add(pos.quantity, qty);
      const newEntry = div(add(mul(pos.entryPrice, pos.quantity), mul(price, qty)), newQty);
      pos.quantity = newQty;
      pos.entryPrice = newEntry;
      pos.margin = add(pos.margin, margin);
      await pos.save();
      return pos;
    }

    // From here on we're either:
    //   (a) a closeOnly fill against the target-side position, OR
    //   (b) (legacy) an opposite-side fill that found a same-positionSide
    //       position via the fallback lookup above
    // Both cases reduce the position. In hedge mode we no longer "flip" —
    // an opposite-side opening order opens a separate position on the
    // other positionSide, which is handled by the targetPositionSide
    // calculation at the top.
    const Instrument = require('../models/Instrument');
    const TradingAccount = require('../models/TradingAccount');
    const walletService = require('../services/walletService');
    const subscriptionService = require('../services/subscriptionService');

    const instrument = await this._getInstrument(instrumentId);
    const account = await this._getAccountMeta(accountId);
    const currency = account?.baseCurrency || 'USD';

    // Reduce qty caps at remaining size — no flip leg in hedge mode.
    const closeQty = (gt(pos.quantity, qty) || eq(pos.quantity, qty)) ? qty : pos.quantity;
    const closePnl = pos.side === 'BUY'
      ? mul(sub(price, pos.entryPrice), closeQty)
      : mul(sub(pos.entryPrice, price), closeQty);

    // Commission: account-tier driven (STANDARD/PRO/FREE + IC variants).
    // accountFeeService dispatches on the tier's fee model:
    //   STANDARD/_IC  → 0.005% of closing notional
    //   PRO/_IC       → flat $0.10 per close
    //   FREE/_IC      → 1% of profit, $0 on losing closes (lossWaive)
    // Legacy accounts (REAL/DEMO/VIRTUAL) fall through to STANDARD via
    // getAccountTypeDef. Subscription discount was removed when the
    // app subscription tier system was retired.
    const accountFeeService = require('../services/accountFeeService');
    let fee = await accountFeeService.computeCloseFee({
      account,
      instrument,
      closeQty,
      closePrice: price,
      closePnl,
    });
    try { fee = await subscriptionService.applyFeeDiscount(userId, fee); } catch (_) { /* keep raw fee */ }

    // Profit-share fee (doc §5): only charged when this close leg is in
    // profit. Folded into the same `fee` line so the wallet ledger shows
    // one consolidated trading fee. profitSharePercent stored as a
    // percent (e.g. "2" = 2% of profit), default 0 = disabled.
    const profitShareRate = instrument?.profitSharePercent || '0';
    if (gt(profitShareRate, '0') && gt(closePnl, '0')) {
      const shareFee = mul(closePnl, div(profitShareRate, '100'));
      fee = add(fee, shareFee);
    }

    // dedupeKey scopes the settle to (this fill, this user) — both sides of
    // an internal match share a tradeId but are credited to different
    // wallets, so we include userId to avoid the maker's settle colliding
    // with the taker's. When no tradeId (B-book/external/fallback paths
    // that pass tradeId, OR worker calls without one), fall back to a
    // positionId+timestamp key — fine because those paths are 1 settle each.
    const dedupeKey = tradeId
      ? `TRADE_SETTLE:${tradeId}:${userId}`
      : `POSITION_PARTIAL_SETTLE:${pos._id}:${Date.now()}`;

    if (gt(pos.quantity, qty)) {
      // Reduce only — keep position open, release proportional margin.
      // Atomic Position update via findOneAndUpdate (no doc.save) so a
      // concurrent close can't overwrite our reduction with stale qty.
      const marginToRelease = div(mul(pos.margin, qty), pos.quantity);
      const newQty = sub(pos.quantity, qty);
      const newMargin = sub(pos.margin, marginToRelease);
      const newRealizedPnl = add(pos.realizedPnl, closePnl);
      const newCommission = add(pos.commission || '0', fee);
      await Position.findOneAndUpdate(
        { _id: pos._id, status: { $in: [POSITION_STATUS.OPEN, POSITION_STATUS.CLOSING] } },
        {
          $set: {
            quantity: newQty,
            margin: newMargin,
            realizedPnl: newRealizedPnl,
            commission: newCommission,
            closedQuantity: add(pos.closedQuantity || '0', closeQty),
          },
        }
      );
      await walletService.settleTradeClose({
        userId, accountId, currency,
        marginToRelease, pnl: closePnl, fee,
        positionId: pos._id, tradeId,
        dedupeKey,
      });
      return pos;
    }

    if (eq(pos.quantity, qty)) {
      // Fully closed — settled flag + status transition done atomically.
      // The {settled: {$ne: true}} guard means a duplicate settle attempt
      // (e.g. SL fired then user clicked close before SL completed) is a
      // no-op at the position level, complementing the wallet-level
      // dedupeKey idempotency.
      const marginToRelease = pos.margin;
      const newRealizedPnl = add(pos.realizedPnl, closePnl);
      const newCommission = add(pos.commission || '0', fee);
      const settlementAmount = D(marginToRelease).plus(D(closePnl)).minus(D(fee || '0')).toString();
      const updated = await Position.findOneAndUpdate(
        { _id: pos._id, settled: { $ne: true } },
        {
          $set: {
            status: POSITION_STATUS.CLOSED,
            closedAt: new Date(),
            closePrice: price,
            realizedPnl: newRealizedPnl,
            commission: newCommission,
            closedQuantity: add(pos.closedQuantity || '0', closeQty),
            quantity: '0',
            margin: '0',
            settled: true,
            settledAt: new Date(),
            settlementAmount,
            // closeReason may have been set by the worker before this fill.
            // Preserve it; only default to MANUAL when still empty.
            ...(pos.closeReason ? {} : { closeReason: 'MANUAL' }),
          },
        },
        { new: true }
      );
      if (!updated) {
        // Already settled by a concurrent path — short-circuit. Wallet
        // settle is also idempotent (same dedupeKey), so calling it would
        // be a safe no-op anyway, but skipping saves a roundtrip.
        return pos;
      }
      await walletService.settleTradeClose({
        userId, accountId, currency,
        marginToRelease, pnl: closePnl, fee,
        positionId: pos._id, tradeId,
        dedupeKey,
      });
      return updated;
    }

    // HEDGE MODE — no flip leg. If a closeOnly fill exceeds the position
    // size, the engine has already capped qty above. If a (legacy) opening
    // fill from the wrong side somehow reached here, fully close the
    // existing position and stop — do NOT open a new opposite-side bucket
    // here, because the hedge-mode lookup at the top routes opposite-side
    // opens to their own positionSide bucket already.
    const marginToRelease = pos.margin;
    const newRealizedPnl = add(pos.realizedPnl, closePnl);
    const newCommission = add(pos.commission || '0', fee);
    const settlementAmount = D(marginToRelease).plus(D(closePnl)).minus(D(fee || '0')).toString();
    const updated = await Position.findOneAndUpdate(
      { _id: pos._id, settled: { $ne: true } },
      {
        $set: {
          status: POSITION_STATUS.CLOSED,
          closedAt: new Date(),
          closePrice: price,
          realizedPnl: newRealizedPnl,
          commission: newCommission,
          quantity: '0',
          margin: '0',
          settled: true,
          settledAt: new Date(),
          settlementAmount,
          ...(pos.closeReason ? {} : { closeReason: 'MANUAL' }),
        },
      },
      { new: true }
    );
    if (updated) {
      await walletService.settleTradeClose({
        userId, accountId, currency,
        marginToRelease, pnl: closePnl, fee,
        positionId: pos._id, tradeId,
        dedupeKey,
      });
    }
    return updated || pos;
  }

  /** Cancel an order from the book. Routed through the per-symbol queue so we
   * don't mutate the book while another order on the same symbol is mid-match. */
  async cancel(order) {
    const symbol = order.symbol;
    const prev = this.queues.get(symbol) || Promise.resolve();
    const next = prev.then(async () => {
      const book = this.getBook(symbol);
      book.remove(String(order._id), order.side);
      order.status = ORDER_STATUS.CANCELLED;
      order.cancelledAt = new Date();
      await order.save();
      if (this.broadcaster) this.broadcaster.broadcastOrderBook(symbol, book.snapshot(25));
      return order;
    });
    this.queues.set(symbol, next.catch(() => {}));
    return next;
  }

  /**
   * Queued book.remove without persisting CANCELLED status. Used by the
   * modify flow to take an order out of the book temporarily before
   * re-inserting it under new params (or restoring originals on failure).
   */
  async removeFromBook(symbol, orderId, side) {
    const prev = this.queues.get(symbol) || Promise.resolve();
    const next = prev.then(() => {
      const book = this.getBook(symbol);
      const removed = book.remove(orderId, side);
      if (this.broadcaster) this.broadcaster.broadcastOrderBook(symbol, book.snapshot(25));
      return removed;
    });
    this.queues.set(symbol, next.catch(() => {}));
    return next;
  }

  /**
   * Queued book.add. Used by the modify-revert path to put an order back on
   * the book WITHOUT re-running the matcher (which would risk surprise fills
   * at the original price after a failed margin top-up).
   */
  async addToBook(order) {
    const symbol = order.symbol;
    const prev = this.queues.get(symbol) || Promise.resolve();
    const next = prev.then(() => {
      const book = this.getBook(symbol);
      book.add(order);
      if (this.broadcaster) this.broadcaster.broadcastOrderBook(symbol, book.snapshot(25));
      return order;
    });
    this.queues.set(symbol, next.catch(() => {}));
    return next;
  }

  getSnapshot(symbol, depth = 25) {
    return this.getBook(symbol).snapshot(depth);
  }
}

module.exports = new MatchingEngine();
