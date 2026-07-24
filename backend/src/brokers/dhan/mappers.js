/**
 * Dhan ⇄ platform translation.
 *
 * Every value that crosses the Dhan boundary is converted here — enums in one
 * direction, payload rows in the other. Two consequences that matter:
 *   - The rest of the platform speaks ONLY `brokers/constants.js`.
 *   - When Dhan renames an enum, exactly one file changes.
 */

const cfg = require('./config');
const normalize = require('../base/normalize');
const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const {
  ORDER_SIDE, ORDER_TYPE, PRODUCT_TYPE, VALIDITY, EXCHANGE, ORDER_STATUS,
} = require('../constants');

const BROKER = 'DHAN';

// ─── Exchange segment ────────────────────────────────────────────────
// Dhan keys instruments by exchangeSegment. Cash vs derivatives on the same
// exchange are different segments, so we use our `exchange` + optional
// `segment` hint to pick the right one.
const SEGMENT_BY_EXCHANGE = {
  [EXCHANGE.NSE]: cfg.EXCHANGE_SEGMENT.NSE_EQ,
  [EXCHANGE.BSE]: cfg.EXCHANGE_SEGMENT.BSE_EQ,
  [EXCHANGE.NFO]: cfg.EXCHANGE_SEGMENT.NSE_FNO,
  [EXCHANGE.BFO]: cfg.EXCHANGE_SEGMENT.BSE_FNO,
  [EXCHANGE.MCX]: cfg.EXCHANGE_SEGMENT.MCX_COMM,
  [EXCHANGE.CDS]: cfg.EXCHANGE_SEGMENT.NSE_CURRENCY,
  [EXCHANGE.BCD]: cfg.EXCHANGE_SEGMENT.BSE_CURRENCY,
};

const EXCHANGE_BY_SEGMENT = Object.entries(SEGMENT_BY_EXCHANGE)
  .reduce((acc, [exch, seg]) => { acc[seg] = exch; return acc; }, {
    [cfg.EXCHANGE_SEGMENT.IDX_I]: EXCHANGE.NSE,
  });

function toExchangeSegment(exchange, segment) {
  const ex = String(exchange || '').toUpperCase();
  // An INDEX instrument on NSE lives in IDX_I, not NSE_EQ.
  if (String(segment || '').toUpperCase() === 'INDEX') return cfg.EXCHANGE_SEGMENT.IDX_I;
  const seg = SEGMENT_BY_EXCHANGE[ex];
  if (!seg) {
    throw BrokerError.validation(`Dhan does not support the "${exchange}" exchange.`, { exchange }, BROKER);
  }
  return seg;
}

const fromExchangeSegment = (seg) => EXCHANGE_BY_SEGMENT[String(seg || '').toUpperCase()] || null;

// ─── Side ────────────────────────────────────────────────────────────
const toTransactionType = (side) => {
  const s = String(side || '').toUpperCase();
  if (s === ORDER_SIDE.BUY) return cfg.TRANSACTION_TYPE.BUY;
  if (s === ORDER_SIDE.SELL) return cfg.TRANSACTION_TYPE.SELL;
  throw BrokerError.validation(`Invalid order side "${side}".`, { side }, BROKER);
};

const fromTransactionType = (t) => (String(t || '').toUpperCase() === 'SELL' ? ORDER_SIDE.SELL : ORDER_SIDE.BUY);

// ─── Product type ────────────────────────────────────────────────────
const PRODUCT_TO_DHAN = {
  [PRODUCT_TYPE.INTRADAY]: cfg.PRODUCT_TYPE.INTRADAY,
  [PRODUCT_TYPE.DELIVERY]: cfg.PRODUCT_TYPE.CNC,     // "cash and carry" == delivery
  [PRODUCT_TYPE.MARGIN]: cfg.PRODUCT_TYPE.MARGIN,
  [PRODUCT_TYPE.MTF]: cfg.PRODUCT_TYPE.MTF,
  [PRODUCT_TYPE.CO]: cfg.PRODUCT_TYPE.CO,
  [PRODUCT_TYPE.BO]: cfg.PRODUCT_TYPE.BO,
};

const PRODUCT_FROM_DHAN = {
  [cfg.PRODUCT_TYPE.INTRADAY]: PRODUCT_TYPE.INTRADAY,
  [cfg.PRODUCT_TYPE.CNC]: PRODUCT_TYPE.DELIVERY,
  [cfg.PRODUCT_TYPE.MARGIN]: PRODUCT_TYPE.MARGIN,
  [cfg.PRODUCT_TYPE.MTF]: PRODUCT_TYPE.MTF,
  [cfg.PRODUCT_TYPE.CO]: PRODUCT_TYPE.CO,
  [cfg.PRODUCT_TYPE.BO]: PRODUCT_TYPE.BO,
};

function toProductType(product) {
  const p = PRODUCT_TO_DHAN[String(product || '').toUpperCase()];
  if (!p) throw BrokerError.validation(`Dhan does not support the "${product}" product type.`, { product }, BROKER);
  return p;
}

const fromProductType = (p) => PRODUCT_FROM_DHAN[String(p || '').toUpperCase()] || null;

// ─── Order type ──────────────────────────────────────────────────────
const ORDER_TYPE_TO_DHAN = {
  [ORDER_TYPE.MARKET]: cfg.ORDER_TYPE.MARKET,
  [ORDER_TYPE.LIMIT]: cfg.ORDER_TYPE.LIMIT,
  [ORDER_TYPE.SL]: cfg.ORDER_TYPE.STOP_LOSS,
  [ORDER_TYPE.SL_M]: cfg.ORDER_TYPE.STOP_LOSS_MARKET,
};

const ORDER_TYPE_FROM_DHAN = {
  [cfg.ORDER_TYPE.MARKET]: ORDER_TYPE.MARKET,
  [cfg.ORDER_TYPE.LIMIT]: ORDER_TYPE.LIMIT,
  [cfg.ORDER_TYPE.STOP_LOSS]: ORDER_TYPE.SL,
  [cfg.ORDER_TYPE.STOP_LOSS_MARKET]: ORDER_TYPE.SL_M,
};

function toOrderType(orderType) {
  const t = ORDER_TYPE_TO_DHAN[String(orderType || '').toUpperCase()];
  if (!t) throw BrokerError.validation(`Dhan does not support the "${orderType}" order type.`, { orderType }, BROKER);
  return t;
}

const fromOrderType = (t) => ORDER_TYPE_FROM_DHAN[String(t || '').toUpperCase()] || null;

const toValidity = (v) => (String(v || '').toUpperCase() === VALIDITY.IOC ? cfg.VALIDITY.IOC : cfg.VALIDITY.DAY);
const fromValidity = (v) => (String(v || '').toUpperCase() === 'IOC' ? VALIDITY.IOC : VALIDITY.DAY);

// ─── Order status ────────────────────────────────────────────────────
// Dhan's status vocabulary mapped onto our lifecycle. TRANSIT means "we have
// it, it hasn't reached the exchange"; PENDING means "the exchange has it".
const STATUS_FROM_DHAN = {
  [cfg.ORDER_STATUS.TRANSIT]: ORDER_STATUS.BROKER_ACCEPTED,
  [cfg.ORDER_STATUS.CONFIRM]: ORDER_STATUS.EXCHANGE_ACCEPTED,
  [cfg.ORDER_STATUS.PENDING]: ORDER_STATUS.EXCHANGE_ACCEPTED,
  [cfg.ORDER_STATUS.TRIGGERED]: ORDER_STATUS.EXCHANGE_ACCEPTED,
  [cfg.ORDER_STATUS.MODIFIED]: ORDER_STATUS.EXCHANGE_ACCEPTED,
  [cfg.ORDER_STATUS.PART_TRADED]: ORDER_STATUS.PARTIALLY_FILLED,
  [cfg.ORDER_STATUS.TRADED]: ORDER_STATUS.FILLED,
  [cfg.ORDER_STATUS.CLOSED]: ORDER_STATUS.FILLED,
  [cfg.ORDER_STATUS.CANCELLED]: ORDER_STATUS.CANCELLED,
  [cfg.ORDER_STATUS.REJECTED]: ORDER_STATUS.REJECTED,
  [cfg.ORDER_STATUS.EXPIRED]: ORDER_STATUS.EXPIRED,
};

function fromOrderStatus(status) {
  const s = String(status || '').toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS_FROM_DHAN[s] || ORDER_STATUS.BROKER_ACCEPTED;
}

// ─── Row normalizers ─────────────────────────────────────────────────
const n = normalize.coerce.num;
const s = normalize.coerce.str;

/** Dhan order-book row / order-update payload → normalize.order */
function toOrder(row) {
  if (!row) return null;
  const exchange = fromExchangeSegment(row.exchangeSegment);
  return normalize.order({
    orderId: row.orderId || row.orderNo,
    clientOrderId: row.correlationId || row.correlation_id,
    exchangeOrderId: row.exchangeOrderId,
    symbol: row.tradingSymbol || row.symbol || row.displayName,
    exchange,
    side: fromTransactionType(row.transactionType),
    qty: n(row.quantity),
    filledQty: n(row.filledQty != null ? row.filledQty : row.tradedQty),
    pendingQty: row.remainingQuantity != null ? n(row.remainingQuantity) : undefined,
    price: n(row.price),
    triggerPrice: n(row.triggerPrice),
    averagePrice: n(row.averageTradedPrice != null ? row.averageTradedPrice : row.tradedPrice),
    orderType: fromOrderType(row.orderType),
    productType: fromProductType(row.productType),
    validity: fromValidity(row.validity),
    status: fromOrderStatus(row.orderStatus || row.status),
    statusMessage: s(row.omsErrorDescription || row.remarks || row.text),
    securityId: s(row.securityId),
    createdAt: row.createTime || row.createdAt || row.orderDateTime,
    updatedAt: row.updateTime || row.exchangeTime || row.updatedAt,
    raw: row,
  });
}

/** Dhan position row → normalize.position */
function toPosition(row) {
  if (!row) return null;
  const net = n(row.netQty);
  const buyQty = n(row.buyQty);
  const sellQty = n(row.sellQty);
  // Dhan reports a signed net quantity; positionType is DHAN's own label
  // (LONG/SHORT/CLOSED) which we translate into our BUY/SELL/FLAT vocabulary.
  const type = String(row.positionType || '').toUpperCase();
  const side = type === 'LONG' || net > 0 ? ORDER_SIDE.BUY
    : (type === 'SHORT' || net < 0 ? ORDER_SIDE.SELL : 'FLAT');

  const avg = n(row.costPrice) || (net > 0 ? n(row.buyAvg) : n(row.sellAvg));
  return normalize.position({
    symbol: row.tradingSymbol || row.symbol,
    exchange: fromExchangeSegment(row.exchangeSegment),
    side,
    qty: Math.abs(net),
    averagePrice: avg,
    pnl: n(row.realizedProfit) + n(row.unrealizedProfit),
    product: fromProductType(row.productType),
    securityId: s(row.securityId),
    lastPrice: n(row.lastTradedPrice ?? row.ltp),
    realizedPnl: n(row.realizedProfit),
    unrealizedPnl: n(row.unrealizedProfit),
    buyQty,
    sellQty,
    multiplier: n(row.multiplier, 1),
    raw: row,
  });
}

/** Dhan holding row → normalize.holding */
function toHolding(row) {
  if (!row) return null;
  const qty = n(row.totalQty != null ? row.totalQty : row.availableQty);
  const avg = n(row.avgCostPrice);
  const ltp = n(row.lastTradedPrice ?? row.ltp);
  return normalize.holding({
    symbol: row.tradingSymbol || row.symbol,
    quantity: qty,
    averagePrice: avg,
    currentPrice: ltp,
    // Dhan doesn't return holding P&L; derive it from qty × (ltp − avg).
    pnl: ltp ? (ltp - avg) * qty : 0,
    exchange: fromExchangeSegment(row.exchange || row.exchangeSegment) || row.exchange || null,
    isin: s(row.isin),
    securityId: s(row.securityId),
    availableQty: n(row.availableQty, qty),
    collateralQty: n(row.collateralQty),
    t1Qty: n(row.t1Qty),
    raw: row,
  });
}

/** Dhan fund-limit payload → normalize.funds */
function toFunds(row) {
  if (!row) return normalize.funds({});
  const available = n(row.availabelBalance ?? row.availableBalance); // Dhan's spelling
  return normalize.funds({
    availableCash: available,
    utilizedMargin: n(row.utilizedAmount),
    totalBalance: n(row.sodLimit) || available + n(row.utilizedAmount),
    openingBalance: n(row.sodLimit),
    collateral: n(row.collateralAmount),
    withdrawableBalance: n(row.withdrawableBalance),
    realizedPnl: n(row.realizedProfitAndLoss ?? row.realisedProfitAndLoss),
    unrealizedPnl: n(row.unrealizedProfitAndLoss ?? row.unrealisedProfitAndLoss),
    exposureMargin: n(row.exposureMarginPresent ?? row.exposureMargin),
    spanMargin: n(row.spanMargin),
    currency: 'INR',
    raw: row,
  });
}

/** Dhan trade row → normalize.trade */
function toTrade(row) {
  if (!row) return null;
  return normalize.trade({
    tradeId: row.exchangeTradeId || row.tradeId,
    orderId: row.orderId,
    clientOrderId: row.correlationId,
    exchangeOrderId: row.exchangeOrderId,
    symbol: row.tradingSymbol || row.customSymbol || row.symbol,
    exchange: fromExchangeSegment(row.exchangeSegment),
    side: fromTransactionType(row.transactionType),
    qty: n(row.tradedQuantity ?? row.quantity),
    price: n(row.tradedPrice ?? row.price),
    productType: fromProductType(row.productType),
    charges: n(row.brokerageCharges) + n(row.stt) + n(row.exchangeTransactionCharges)
      + n(row.sebiTax) + n(row.gst) + n(row.stampDuty),
    securityId: s(row.securityId),
    tradedAt: row.exchangeTime || row.createTime || row.tradeDate,
    raw: row,
  });
}

/**
 * Dhan market-feed quote → normalize.quote.
 * The feed returns a map keyed by securityId per segment, so the caller passes
 * the instrument context back in.
 */
function toQuote(row, context = {}) {
  const ohlc = (row && row.ohlc) || {};
  const depth = (row && row.depth) || {};
  const bestBid = (depth.buy && depth.buy[0]) || {};
  const bestAsk = (depth.sell && depth.sell[0]) || {};
  return normalize.quote({
    symbol: context.symbol,
    exchange: context.exchange,
    securityId: context.securityId,
    lastPrice: n(row && (row.last_price ?? row.ltp ?? row.lastPrice)),
    open: n(ohlc.open),
    high: n(ohlc.high),
    low: n(ohlc.low),
    close: n(ohlc.close),
    bid: n(bestBid.price),
    ask: n(bestAsk.price),
    volume: n(row && (row.volume ?? row.last_quantity)),
    oi: n(row && row.oi),
    timestamp: row && (row.last_trade_time || row.LTT),
    raw: row,
  });
}

/**
 * Build the Dhan place-order body from a normalized request.
 * `securityId` must already be resolved (see SymbolResolver).
 */
function toPlaceOrderBody(req, dhanClientId) {
  if (!req.securityId) {
    throw new BrokerError(ERROR_CODE.SYMBOL_NOT_FOUND, `Could not resolve "${req.symbol}" to a Dhan security id.`, {
      broker: BROKER, details: { symbol: req.symbol, exchange: req.exchange },
    });
  }
  const body = {
    dhanClientId: String(dhanClientId),
    // Our clientOrderId travels as Dhan's correlationId — this is what makes
    // a post-timeout reconciliation (GET /orders/external/:id) possible.
    correlationId: req.clientOrderId,
    transactionType: toTransactionType(req.side),
    exchangeSegment: toExchangeSegment(req.exchange, req.segment),
    productType: toProductType(req.productType),
    orderType: toOrderType(req.orderType),
    validity: toValidity(req.validity),
    securityId: String(req.securityId),
    quantity: Math.trunc(n(req.qty)),
    disclosedQuantity: Math.trunc(n(req.disclosedQty)),
    price: n(req.price),
    triggerPrice: n(req.triggerPrice),
    afterMarketOrder: !!req.amo,
  };
  if (req.amo && req.amoTime) body.amoTime = req.amoTime;
  if (String(req.productType).toUpperCase() === PRODUCT_TYPE.BO) {
    body.boProfitValue = n(req.targetPrice);
    body.boStopLossValue = n(req.stopLossPrice);
  }
  return body;
}

/** Build the Dhan modify-order body. */
function toModifyOrderBody(req, dhanClientId) {
  const body = {
    dhanClientId: String(dhanClientId),
    orderId: String(req.orderId),
    orderType: req.orderType ? toOrderType(req.orderType) : undefined,
    legName: req.legName || undefined,
    quantity: req.qty != null ? Math.trunc(n(req.qty)) : undefined,
    price: req.price != null ? n(req.price) : undefined,
    disclosedQuantity: req.disclosedQty != null ? Math.trunc(n(req.disclosedQty)) : undefined,
    triggerPrice: req.triggerPrice != null ? n(req.triggerPrice) : undefined,
    validity: req.validity ? toValidity(req.validity) : undefined,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

module.exports = {
  toExchangeSegment,
  fromExchangeSegment,
  toTransactionType,
  fromTransactionType,
  toProductType,
  fromProductType,
  toOrderType,
  fromOrderType,
  toValidity,
  fromValidity,
  fromOrderStatus,
  toOrder,
  toPosition,
  toHolding,
  toFunds,
  toTrade,
  toQuote,
  toPlaceOrderBody,
  toModifyOrderBody,
};
