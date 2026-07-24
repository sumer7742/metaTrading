/**
 * Normalized response contracts.
 *
 * These builders are the ONLY way a value leaves an adapter. Each one emits a
 * fixed, declared set of keys — anything the broker sent that isn't in the
 * contract is dropped, which is what makes "never expose a broker-specific
 * response to the frontend" structurally true rather than a code-review rule.
 *
 * The broker's raw payload is still attached, but under a Symbol:
 * `JSON.stringify` and object spread both ignore Symbol keys, so it can never
 * leak through an HTTP response — while `getRaw(obj)` still lets the audit
 * layer persist it for support/debugging.
 */

const RAW = Symbol('brokerRawPayload');

const attachRaw = (obj, raw) => {
  if (raw !== undefined) Object.defineProperty(obj, RAW, { value: raw, enumerable: false });
  return obj;
};

const getRaw = (obj) => (obj && obj[RAW] !== undefined ? obj[RAW] : null);

// ── Coercion helpers ────────────────────────────────────────────────
// Broker JSON is inconsistent: numbers arrive as strings, missing fields as
// null/''/'NA'. Normalizing here means downstream code never guards types.
const num = (v, fallback = 0) => {
  if (v === null || v === undefined || v === '' || v === 'NA') return fallback;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

const str = (v, fallback = null) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s === '' ? fallback : s;
};

const upper = (v, fallback = null) => {
  const s = str(v, null);
  return s === null ? fallback : s.toUpperCase();
};

const iso = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Order acknowledgement — the required contract for placeOrder / modifyOrder /
 * cancelOrder:
 *   { success, broker, orderId, status, message }
 *
 * `clientOrderId` and `timestamp` are OURS (not broker-specific) and are
 * included so the frontend can correlate an ack with the order it submitted
 * and with subsequent websocket updates.
 */
const orderAck = ({ success = true, broker, orderId, clientOrderId = null, status, message = null, raw } = {}) =>
  attachRaw({
    success: !!success,
    broker: upper(broker),
    orderId: str(orderId),
    clientOrderId: str(clientOrderId),
    status: upper(status),
    message: str(message, success ? 'Order submitted' : 'Order failed'),
    timestamp: new Date().toISOString(),
  }, raw);

/**
 * Normalized position:
 *   { symbol, exchange, side, qty, averagePrice, pnl, product }
 * Extra fields below are additive and broker-neutral (every Indian broker
 * reports them); nothing here is Dhan-shaped.
 */
const position = ({
  symbol, exchange, side, qty, averagePrice, pnl, product,
  securityId, lastPrice, realizedPnl, unrealizedPnl, buyQty, sellQty, multiplier, raw,
} = {}) =>
  attachRaw({
    symbol: upper(symbol),
    exchange: upper(exchange),
    side: upper(side),                  // BUY (long) | SELL (short) | FLAT
    qty: num(qty),
    averagePrice: num(averagePrice),
    pnl: num(pnl),
    product: upper(product),
    // additive, broker-neutral
    securityId: str(securityId),
    lastPrice: num(lastPrice),
    realizedPnl: num(realizedPnl),
    unrealizedPnl: num(unrealizedPnl),
    buyQty: num(buyQty),
    sellQty: num(sellQty),
    multiplier: num(multiplier, 1),
  }, raw);

/**
 * Normalized holding:
 *   { symbol, quantity, averagePrice, currentPrice, pnl }
 */
const holding = ({
  symbol, quantity, averagePrice, currentPrice, pnl,
  exchange, isin, securityId, availableQty, collateralQty, t1Qty, investedValue, currentValue, pnlPercent, raw,
} = {}) => {
  const invested = investedValue != null ? num(investedValue) : num(quantity) * num(averagePrice);
  const current = currentValue != null ? num(currentValue) : num(quantity) * num(currentPrice);
  const profit = pnl != null ? num(pnl) : current - invested;
  return attachRaw({
    symbol: upper(symbol),
    quantity: num(quantity),
    averagePrice: num(averagePrice),
    currentPrice: num(currentPrice),
    pnl: profit,
    // additive, broker-neutral
    exchange: upper(exchange),
    isin: str(isin),
    securityId: str(securityId),
    availableQty: num(availableQty, num(quantity)),
    collateralQty: num(collateralQty),
    t1Qty: num(t1Qty),
    investedValue: invested,
    currentValue: current,
    pnlPercent: pnlPercent != null ? num(pnlPercent) : (invested ? +((profit / invested) * 100).toFixed(4) : 0),
  }, raw);
};

/**
 * Normalized funds:
 *   { availableCash, utilizedMargin, totalBalance }
 */
const funds = ({
  availableCash, utilizedMargin, totalBalance,
  openingBalance, collateral, withdrawableBalance, realizedPnl, unrealizedPnl, exposureMargin, spanMargin, currency, raw,
} = {}) =>
  attachRaw({
    availableCash: num(availableCash),
    utilizedMargin: num(utilizedMargin),
    totalBalance: num(totalBalance),
    // additive, broker-neutral
    openingBalance: num(openingBalance),
    collateral: num(collateral),
    withdrawableBalance: num(withdrawableBalance),
    realizedPnl: num(realizedPnl),
    unrealizedPnl: num(unrealizedPnl),
    exposureMargin: num(exposureMargin),
    spanMargin: num(spanMargin),
    currency: upper(currency, 'INR'),
  }, raw);

/**
 * Normalized order (order book row / order status).
 */
const order = ({
  orderId, clientOrderId, exchangeOrderId, symbol, exchange, side, qty, filledQty, pendingQty,
  price, triggerPrice, averagePrice, orderType, productType, validity, status, statusMessage,
  securityId, createdAt, updatedAt, raw,
} = {}) =>
  attachRaw({
    orderId: str(orderId),
    clientOrderId: str(clientOrderId),
    exchangeOrderId: str(exchangeOrderId),
    symbol: upper(symbol),
    exchange: upper(exchange),
    side: upper(side),
    qty: num(qty),
    filledQty: num(filledQty),
    pendingQty: pendingQty != null ? num(pendingQty) : Math.max(0, num(qty) - num(filledQty)),
    price: num(price),
    triggerPrice: num(triggerPrice),
    averagePrice: num(averagePrice),
    orderType: upper(orderType),
    productType: upper(productType),
    validity: upper(validity),
    status: upper(status),              // platform lifecycle status
    statusMessage: str(statusMessage),
    securityId: str(securityId),
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt),
  }, raw);

/**
 * Normalized trade / execution (history rows).
 */
const trade = ({
  tradeId, orderId, clientOrderId, exchangeOrderId, symbol, exchange, side, qty, price,
  productType, tradedAt, charges, securityId, raw,
} = {}) =>
  attachRaw({
    tradeId: str(tradeId),
    orderId: str(orderId),
    clientOrderId: str(clientOrderId),
    exchangeOrderId: str(exchangeOrderId),
    symbol: upper(symbol),
    exchange: upper(exchange),
    side: upper(side),
    qty: num(qty),
    price: num(price),
    value: num(qty) * num(price),
    productType: upper(productType),
    charges: num(charges),
    securityId: str(securityId),
    tradedAt: iso(tradedAt),
  }, raw);

/**
 * Normalized quote. Depth is optional — brokers that only expose LTP simply
 * return zeros for the rest, so the frontend never has to feature-detect.
 */
const quote = ({
  symbol, exchange, lastPrice, open, high, low, close, change, changePercent,
  bid, ask, volume, oi, securityId, timestamp, raw,
} = {}) => {
  const c = num(close);
  const ltp = num(lastPrice);
  return attachRaw({
    symbol: upper(symbol),
    exchange: upper(exchange),
    lastPrice: ltp,
    open: num(open),
    high: num(high),
    low: num(low),
    close: c,
    change: change != null ? num(change) : +(ltp - c).toFixed(4),
    changePercent: changePercent != null ? num(changePercent) : (c ? +(((ltp - c) / c) * 100).toFixed(4) : 0),
    bid: num(bid),
    ask: num(ask),
    volume: num(volume),
    oi: num(oi),
    securityId: str(securityId),
    timestamp: iso(timestamp) || new Date().toISOString(),
  }, raw);
};

/**
 * Normalized market status per exchange segment.
 */
const marketStatus = ({ exchange, state, isOpen, opensAt, closesAt, reason, timezone, raw } = {}) =>
  attachRaw({
    exchange: upper(exchange),
    state: upper(state),                // OPEN | PRE_OPEN | CLOSED | HOLIDAY | WEEKEND
    isOpen: !!isOpen,
    opensAt: str(opensAt),
    closesAt: str(closesAt),
    reason: str(reason),
    timezone: str(timezone, 'Asia/Kolkata'),
    timestamp: new Date().toISOString(),
  }, raw);

/**
 * Normalized OHLC candle (used by the market-data abstraction, NOT by the
 * existing TradingView chart pipeline — charts stay on their own feed).
 */
const candle = ({ time, open, high, low, close, volume, oi } = {}) => ({
  time: typeof time === 'number' ? time : Math.floor(new Date(time).getTime() / 1000),
  open: num(open),
  high: num(high),
  low: num(low),
  close: num(close),
  volume: num(volume),
  oi: num(oi),
});

module.exports = {
  RAW,
  getRaw,
  attachRaw,
  orderAck,
  position,
  holding,
  funds,
  order,
  trade,
  quote,
  marketStatus,
  candle,
  // coercion helpers reused by adapters
  coerce: { num, str, upper, iso },
};
