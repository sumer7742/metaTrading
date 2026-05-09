const { D, gt, lt, gte, lte, eq, sub, add } = require('../utils/decimal');

/**
 * In-memory order book for one instrument.
 * BUY side sorted: highest price first.
 * SELL side sorted: lowest price first.
 * Within price level: oldest first (FIFO).
 *
 * NOTE: This is an MVP single-process implementation.
 * For production: persist to Redis sorted sets, use a single-writer process per instrument.
 */
class OrderBook {
  constructor(symbol) {
    this.symbol = symbol;
    // Each entry: { price, orders: [{ id, accountId, userId, qty, remaining, ts }] }
    this.bids = []; // BUY (sorted high -> low)
    this.asks = []; // SELL (sorted low -> high)
  }

  /** Insert a resting order into the book. */
  add(order) {
    // Dedupe: if this order is already in the book (e.g. modify-then-revert
    // path that calls add a second time), drop the stale entry first so we
    // don't end up with two book rows for the same order id.
    const id = String(order._id);
    this.remove(id, order.side);

    const side = order.side === 'BUY' ? this.bids : this.asks;
    const idx = this._findOrInsertLevel(side, order.price, order.side);
    side[idx].orders.push({
      id,
      accountId: String(order.accountId),
      userId: String(order.userId),
      qty: order.quantity,
      remaining: sub(order.quantity, order.filledQuantity || '0'),
      ts: order.createdAt ? order.createdAt.getTime() : Date.now(),
    });
  }

  _findOrInsertLevel(side, price, orderSide) {
    // For BUY: descending by price. For SELL: ascending.
    const cmp = orderSide === 'BUY'
      ? (a, b) => (gt(a, b) ? -1 : lt(a, b) ? 1 : 0)
      : (a, b) => (lt(a, b) ? -1 : gt(a, b) ? 1 : 0);

    for (let i = 0; i < side.length; i++) {
      const c = cmp(price, side[i].price);
      if (c === 0) return i;
      if (c < 0) {
        side.splice(i, 0, { price, orders: [] });
        return i;
      }
    }
    side.push({ price, orders: [] });
    return side.length - 1;
  }

  /** Best bid (highest price someone wants to buy at). */
  bestBid() {
    for (const lvl of this.bids) if (lvl.orders.length) return lvl;
    return null;
  }

  /** Best ask (lowest price someone wants to sell at). */
  bestAsk() {
    for (const lvl of this.asks) if (lvl.orders.length) return lvl;
    return null;
  }

  /**
   * Match an incoming order against the book.
   * Returns { fills: [{makerOrderId, makerAccountId, makerUserId, price, qty}], remaining }.
   * The caller is responsible for persisting trades + updating orders/positions/wallets.
   */
  match(incoming) {
    const fills = [];
    let remaining = sub(incoming.quantity, incoming.filledQuantity || '0');

    const oppositeSide = incoming.side === 'BUY' ? this.asks : this.bids;

    while (gt(remaining, '0') && oppositeSide.length) {
      const level = oppositeSide[0];
      if (!level || !level.orders.length) {
        oppositeSide.shift();
        continue;
      }
      // Price compatibility check
      if (incoming.type === 'LIMIT') {
        if (incoming.side === 'BUY' && lt(incoming.price, level.price)) break; // best ask too high
        if (incoming.side === 'SELL' && gt(incoming.price, level.price)) break; // best bid too low
      }
      // For MARKET: cross at any available price.

      const makerOrder = level.orders[0];
      const fillQty = lte(remaining, makerOrder.remaining) ? remaining : makerOrder.remaining;

      fills.push({
        makerOrderId: makerOrder.id,
        makerAccountId: makerOrder.accountId,
        makerUserId: makerOrder.userId,
        price: level.price,
        qty: fillQty,
      });

      makerOrder.remaining = sub(makerOrder.remaining, fillQty);
      remaining = sub(remaining, fillQty);

      if (eq(makerOrder.remaining, '0')) level.orders.shift();
      if (level.orders.length === 0) oppositeSide.shift();
    }

    return { fills, remaining };
  }

  /** Remove an order by id (e.g. on cancel). */
  remove(orderId, side) {
    const list = side === 'BUY' ? this.bids : this.asks;
    for (let i = 0; i < list.length; i++) {
      const idx = list[i].orders.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        list[i].orders.splice(idx, 1);
        if (!list[i].orders.length) list.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  /** Snapshot for WebSocket / API. Limit depth to top N levels. */
  snapshot(depth = 25) {
    const aggregateLevel = (lvl) => ({
      price: lvl.price,
      quantity: lvl.orders.reduce((sum, o) => add(sum, o.remaining), '0'),
      count: lvl.orders.length,
    });
    return {
      symbol: this.symbol,
      bids: this.bids.slice(0, depth).map(aggregateLevel),
      asks: this.asks.slice(0, depth).map(aggregateLevel),
      ts: Date.now(),
    };
  }
}

module.exports = OrderBook;
