/**
 * brokerOrder.service.js — CQRS COMMAND side.
 *
 * Commands: Place Order · Modify · Cancel
 *
 * The full path of a single order:
 *
 *   Created → Validated → Queued → Broker Accepted → Exchange Accepted →
 *   Partially Filled → Filled | Cancelled | Rejected
 *
 * Each arrow writes a timestamp on OrderSync and an immutable OrderAudit row,
 * so the lifecycle is reconstructable after the fact.
 *
 * Guarantees:
 *   - IDEMPOTENT. A clientOrderId is claimed via a unique index before the
 *     broker is called. A repeat submission replays the stored ack.
 *   - RECONCILED. If a place times out we don't guess: we ask the broker
 *     whether it saw our clientOrderId (Dhan indexes it as correlationId)
 *     before deciding the order failed.
 *   - VALIDATED. Market hours, quantity, price and product rules are checked
 *     before the request is queued, so obviously-doomed orders never consume
 *     rate-limit budget.
 */

const OrderSync = require('../../models/OrderSync');
const router = require('../../brokers/BrokerRouter');
const idempotency = require('./idempotency.service');
const audit = require('./brokerAudit.service');
const cache = require('./cache');
const marketHours = require('../marketHours');
const catalog = require('./instrumentCatalog.service');
const { BrokerError, ERROR_CODE } = require('../../brokers/base/BrokerError');
const {
  ORDER_STATUS, STATUS_RANK, STATUS_TIMELINE_FIELD, TERMINAL_STATUSES, isTerminal,
  ORDER_SIDE, ORDER_TYPE, PRODUCT_TYPE, VALIDITY, EXCHANGE_SESSION_KEY,
  UPDATE_SOURCE, PRIORITY,
} = require('../../brokers/constants');

const STAGE = audit.STAGE;

// ─── Lifecycle helper ────────────────────────────────────────────────
/**
 * Move an order to a new status, stamping the timeline and writing the audit
 * row. Refuses to move backwards: a late EXCHANGE_ACCEPTED arriving after a
 * FILLED (out-of-order websocket delivery is normal) is dropped.
 */
async function transition(doc, toStatus, opts = {}) {
  const from = doc.status;
  if (from === toStatus && !opts.force) return doc;
  if (isTerminal(from) && !opts.force) return doc;                 // terminal is final
  if ((STATUS_RANK[toStatus] || 0) < (STATUS_RANK[from] || 0) && !opts.force) return doc;

  const now = new Date();
  const set = {
    status: toStatus,
    previousStatus: from,
    [`timeline.${STATUS_TIMELINE_FIELD[toStatus]}`]: now,
    lastUpdateSource: opts.source || UPDATE_SOURCE.API,
  };
  if (opts.statusMessage !== undefined) set.statusMessage = opts.statusMessage;
  if (opts.brokerOrderId) set.brokerOrderId = opts.brokerOrderId;
  if (opts.exchangeOrderId) set.exchangeOrderId = opts.exchangeOrderId;
  if (opts.filledQty != null) set.filledQty = opts.filledQty;
  if (opts.pendingQty != null) set.pendingQty = opts.pendingQty;
  if (opts.averagePrice != null) set.averagePrice = opts.averagePrice;
  if (opts.response) set.response = { ...opts.response, at: now };
  if (opts.error) set.error = { ...opts.error, at: now };
  if (opts.extra) Object.assign(set, opts.extra);

  // Guard the write itself so two concurrent updates (REST ack + websocket)
  // can't both apply — whichever lands first wins, the other no-ops.
  const updated = await OrderSync.findOneAndUpdate(
    { _id: doc._id, status: from },
    { $set: set },
    { new: true }
  );
  const result = updated || doc;

  audit.transition({
    clientOrderId: doc.clientOrderId,
    orderSyncId: doc._id,
    userId: doc.userId,
    broker: doc.broker,
    brokerOrderId: opts.brokerOrderId || doc.brokerOrderId,
    fromStatus: from,
    toStatus,
    source: opts.source || UPDATE_SOURCE.API,
    actor: opts.actor || 'SYSTEM',
    message: opts.statusMessage || null,
    snapshot: opts.snapshot || null,
    requestId: opts.requestId || doc.requestId,
    latencyMs: opts.latencyMs,
  });

  return result;
}

// ─── Validation ──────────────────────────────────────────────────────
/**
 * Pre-trade validation. Runs BEFORE the queue so a bad order costs nothing.
 * Schema shape is already guaranteed by the zod layer at the route; this is
 * the business layer: market session, lot size, circuits, price sanity.
 */
async function validateOrder(req, { broker }) {
  const errors = [];

  if (!Object.values(ORDER_SIDE).includes(req.side)) errors.push('side must be BUY or SELL');
  if (!Object.values(ORDER_TYPE).includes(req.orderType)) errors.push('invalid orderType');
  if (!Object.values(PRODUCT_TYPE).includes(req.productType)) errors.push('invalid productType');
  if (req.validity && !Object.values(VALIDITY).includes(req.validity)) errors.push('invalid validity');

  const qty = Number(req.qty);
  if (!Number.isFinite(qty) || qty <= 0 || Math.trunc(qty) !== qty) errors.push('qty must be a positive whole number');

  // LIMIT/SL need a price; SL/SL_M need a trigger.
  if ([ORDER_TYPE.LIMIT, ORDER_TYPE.SL].includes(req.orderType) && !(Number(req.price) > 0)) {
    errors.push(`${req.orderType} orders need a price`);
  }
  if ([ORDER_TYPE.SL, ORDER_TYPE.SL_M].includes(req.orderType) && !(Number(req.triggerPrice) > 0)) {
    errors.push(`${req.orderType} orders need a triggerPrice`);
  }
  if (req.disclosedQty != null && Number(req.disclosedQty) > qty) {
    errors.push('disclosedQty cannot exceed qty');
  }
  if (errors.length) throw BrokerError.validation(errors[0], { errors }, broker);

  // Instrument rules from the platform catalogue — broker-neutral on purpose:
  // lot size and circuits are exchange properties, so switching broker must
  // not change what we accept. Symbol → broker token happens in the adapter.
  // Best-effort: these checks run only when we actually have catalogue
  // metadata. A missing row is NOT fatal here — the broker adapter's symbol
  // resolver is the single authority on whether the symbol is tradable through
  // this broker, and it raises a precise SYMBOL_NOT_FOUND (with import
  // guidance) if it can't map the symbol to a broker security id. Blocking
  // here too would surface a vaguer "not in catalogue" first.
  const instrument = await catalog.lookup({ symbol: req.symbol, exchange: req.exchange, provider: broker });

  if (instrument && instrument.lotSize && instrument.lotSize > 1 && qty % instrument.lotSize !== 0) {
    throw new BrokerError(
      ERROR_CODE.QUANTITY_ERROR,
      `${req.symbol} trades in lots of ${instrument.lotSize}. Order quantity must be a multiple of ${instrument.lotSize}.`,
      { broker, details: { lotSize: instrument.lotSize, qty } }
    );
  }
  if (instrument && instrument.freezeQty && qty > instrument.freezeQty) {
    throw new BrokerError(
      ERROR_CODE.QUANTITY_ERROR,
      `${req.symbol} has an exchange freeze limit of ${instrument.freezeQty} per order. Split the order.`,
      { broker, details: { freezeQty: instrument.freezeQty, qty } }
    );
  }
  const price = Number(req.price) || 0;
  if (instrument && price > 0) {
    if (instrument.upperCircuit && price > instrument.upperCircuit) {
      throw new BrokerError(ERROR_CODE.PRICE_ERROR, `Price is above today's upper circuit (${instrument.upperCircuit}).`, { broker });
    }
    if (instrument.lowerCircuit && price < instrument.lowerCircuit) {
      throw new BrokerError(ERROR_CODE.PRICE_ERROR, `Price is below today's lower circuit (${instrument.lowerCircuit}).`, { broker });
    }
  }

  const exchange = req.exchange || (instrument && instrument.exchange);
  if (!exchange) {
    throw BrokerError.validation(`Specify the exchange for ${req.symbol} (it is listed on more than one).`, null, broker);
  }

  // Market session — AMO orders are explicitly allowed outside hours.
  // Uses the platform's own exchange calendar (services/marketHours.js), the
  // same one the forex/crypto engine trusts, so there is a single answer to
  // "is NSE open?" across the whole product.
  if (!req.amo) {
    const session = marketHours.getSession(EXCHANGE_SESSION_KEY[exchange] || exchange);
    if (!session.isOpen) {
      throw new BrokerError(
        session.state === 'HOLIDAY' || session.state === 'WEEKEND' ? ERROR_CODE.EXCHANGE_CLOSED : ERROR_CODE.MARKET_CLOSED,
        `${exchange} is ${String(session.state).toLowerCase().replace('_', '-')} (${session.reason}). Place an AMO order instead.`,
        { broker, details: { exchange, session } }
      );
    }
  }

  return {
    ...req,
    qty,
    exchange,
    // Pass-through only. The adapter resolves the broker's own instrument id;
    // this service must never learn what a "securityId" means to a broker.
    securityId: req.securityId || null,
    price: Number(req.price) || 0,
    triggerPrice: Number(req.triggerPrice) || 0,
    validity: req.validity || VALIDITY.DAY,
    disclosedQty: Number(req.disclosedQty) || 0,
    amo: !!req.amo,
  };
}

// ─── COMMAND: place ──────────────────────────────────────────────────
/**
 * @param {object} ctx  { userId, requestId, actor? }
 * @param {object} input normalized order request from the controller
 * @returns {Promise<object>} normalized ack { success, broker, orderId, status, message }
 */
async function placeOrder(ctx, input) {
  const { userId, requestId } = ctx;
  const startedAt = Date.now();

  // 1. WHICH BROKER — explicit, or the user's default.
  const connection = await router.resolve({ userId, broker: input.broker });
  const broker = connection.broker;

  audit.log({
    userId, broker, stage: STAGE.REQUEST, action: 'placeOrder', requestId,
    message: `${input.side} ${input.qty} ${input.symbol}`,
    payload: { request: input },
  });

  // 2. IDEMPOTENCY — claim the id before anything else can happen.
  const clientOrderId = idempotency.resolveClientOrderId(input.clientOrderId);

  // 3. VALIDATE.
  let validated;
  try {
    validated = await validateOrder({ ...input, clientOrderId }, { broker });
  } catch (err) {
    const e = BrokerError.from(err, broker);
    audit.recordError(e, { userId, broker, operation: 'placeOrder', requestId, clientOrderId, context: { input } });
    throw e;
  }

  const request = {
    symbol: validated.symbol,
    exchange: validated.exchange,
    securityId: validated.securityId,
    side: validated.side,
    qty: validated.qty,
    orderType: validated.orderType,
    productType: validated.productType,
    price: validated.price,
    triggerPrice: validated.triggerPrice,
    validity: validated.validity,
    disclosedQty: validated.disclosedQty,
    amo: validated.amo,
    tag: validated.tag || null,
  };

  const { created, doc } = await idempotency.reserve({
    userId, broker, connectionId: connection.id, clientOrderId, request, requestId,
  });

  if (!created) {
    const decision = idempotency.replayDecision(doc);
    if (decision.replay) {
      audit.log({
        userId, broker, stage: STAGE.RESPONSE, action: 'placeOrder:duplicate', requestId, clientOrderId,
        message: 'Idempotent replay — order not resent',
      });
      return decision.ack;
    }
    // Previous attempt never reached the broker: allow this one to proceed on
    // the same row instead of minting a new (untracked) order id.
  }

  let order = created ? doc : await OrderSync.findById(doc._id);

  // Re-driving a FAILED row: FAILED is terminal, and `transition()` refuses to
  // leave a terminal state — so without an explicit reset the retry would be
  // sent to the broker while the record stayed stuck on FAILED. Reset it to
  // CREATED first; the attempt counter and the audit trail preserve the
  // history of the failed try.
  if (!created && order.status === ORDER_STATUS.FAILED) {
    order = await transition(order, ORDER_STATUS.CREATED, {
      force: true,
      requestId,
      actor: ctx.actor || 'USER',
      source: UPDATE_SOURCE.API,
      statusMessage: 'Retrying an order that never reached the broker.',
      error: { code: null, message: null },
    });
  }

  // 4. Created → Validated → Queued
  order = await transition(order, ORDER_STATUS.VALIDATED, { requestId, actor: ctx.actor || 'USER', source: UPDATE_SOURCE.API });
  order = await transition(order, ORDER_STATUS.QUEUED, { requestId, actor: 'SYSTEM', source: UPDATE_SOURCE.API });

  // 5. Queue → Rate limiter → Adapter.
  //    maxRetries is 0 for place: a retried place after an ambiguous timeout
  //    risks a duplicate live order. We reconcile by clientOrderId instead.
  try {
    const ack = await router.commands.placeOrder(
      { userId, broker, connection, requestId },
      { ...request, clientOrderId }
    );

    const brokerLatencyMs = Date.now() - startedAt;
    order = await transition(order, ack.status || ORDER_STATUS.BROKER_ACCEPTED, {
      brokerOrderId: ack.orderId,
      statusMessage: ack.message,
      response: { success: true, orderId: ack.orderId, status: ack.status, message: ack.message },
      requestId,
      source: UPDATE_SOURCE.API,
      actor: 'BROKER',
      latencyMs: brokerLatencyMs,
      extra: { brokerLatencyMs, attempts: (order.attempts || 0) + 1 },
    });

    await cache.invalidateUser(userId, broker);
    audit.log({
      userId, broker, stage: STAGE.RESPONSE, action: 'placeOrder', requestId, clientOrderId,
      brokerOrderId: ack.orderId, success: true, durationMs: brokerLatencyMs,
      message: `Order accepted by ${broker}`,
    });

    _pushToClient(userId, order);
    return { ...ack, clientOrderId, status: order.status };
  } catch (rawErr) {
    const err = BrokerError.from(rawErr, broker);

    // 6. AMBIGUOUS FAILURE → RECONCILE, never assume.
    // A timeout/network error means we don't know whether the broker got it.
    // Ask, using our clientOrderId. Only if the broker has never heard of it
    // do we call the order FAILED.
    if ([ERROR_CODE.TIMEOUT, ERROR_CODE.NETWORK_FAILURE].includes(err.code)) {
      const recovered = await _reconcileAfterAmbiguity({ userId, broker, connection, clientOrderId, requestId, order });
      if (recovered) return recovered;
    }

    const terminal = err.code === ERROR_CODE.BROKER_REJECTED ? ORDER_STATUS.REJECTED : ORDER_STATUS.FAILED;
    order = await transition(order, terminal, {
      statusMessage: err.message,
      error: { code: err.code, message: err.message },
      response: { success: false, orderId: null, status: terminal, message: err.message },
      requestId,
      source: UPDATE_SOURCE.API,
      actor: 'BROKER',
      extra: { attempts: (order.attempts || 0) + 1 },
    });

    audit.recordError(err, { userId, broker, operation: 'placeOrder', requestId, clientOrderId, context: { request } });
    _pushToClient(userId, order);
    throw err;
  }
}

/**
 * After a timeout, ask the broker whether it actually received our order.
 * @returns {Promise<object|null>} the ack if the order exists at the broker
 */
async function _reconcileAfterAmbiguity({ userId, broker, connection, clientOrderId, requestId, order }) {
  try {
    const rows = await router.queries.orders({ userId, broker, connection, requestId }, { clientOrderId });
    const found = (rows || []).find((r) => r && (r.clientOrderId === clientOrderId || r.orderId));
    if (!found) return null;

    const updated = await transition(order, found.status || ORDER_STATUS.BROKER_ACCEPTED, {
      brokerOrderId: found.orderId,
      exchangeOrderId: found.exchangeOrderId,
      statusMessage: 'Recovered after a network timeout — the broker did receive this order.',
      response: { success: true, orderId: found.orderId, status: found.status, message: 'Order confirmed at broker' },
      filledQty: found.filledQty,
      pendingQty: found.pendingQty,
      averagePrice: found.averagePrice,
      requestId,
      source: UPDATE_SOURCE.POLL,
      actor: 'SYSTEM',
    });

    audit.log({
      userId, broker, stage: STAGE.SYNC, action: 'placeOrder:reconciled', requestId, clientOrderId,
      brokerOrderId: found.orderId, level: 'warn',
      message: 'Order timed out locally but exists at the broker — no duplicate placed.',
    });

    _pushToClient(userId, updated);
    return {
      success: true, broker, orderId: found.orderId, clientOrderId,
      status: updated.status, message: 'Order confirmed with the broker after a timeout.',
      timestamp: new Date().toISOString(), reconciled: true,
    };
  } catch (e) {
    audit.log({
      userId, broker, stage: STAGE.SYNC, action: 'placeOrder:reconcileFailed', requestId, clientOrderId,
      level: 'warn', message: `Could not reconcile after timeout: ${e.message}`,
    });
    return null;
  }
}

// ─── COMMAND: modify ─────────────────────────────────────────────────
async function modifyOrder(ctx, input) {
  const { userId, requestId } = ctx;
  const order = await idempotency.findOwned(userId, input.clientOrderId);

  if (isTerminal(order.status)) {
    throw new BrokerError(ERROR_CODE.BROKER_REJECTED, `This order is already ${order.status.toLowerCase()} and cannot be modified.`, { broker: order.broker });
  }
  if (!order.brokerOrderId) {
    throw new BrokerError(ERROR_CODE.ORDER_NOT_FOUND, 'This order has no broker reference yet — wait for it to be accepted.', { broker: order.broker });
  }

  const connection = await router.resolve({ userId, broker: order.broker });
  const changes = {
    qty: input.qty != null ? Number(input.qty) : undefined,
    price: input.price != null ? Number(input.price) : undefined,
    triggerPrice: input.triggerPrice != null ? Number(input.triggerPrice) : undefined,
    orderType: input.orderType || undefined,
    validity: input.validity || undefined,
    disclosedQty: input.disclosedQty != null ? Number(input.disclosedQty) : undefined,
  };
  if (Object.values(changes).every((v) => v === undefined)) {
    throw BrokerError.validation('Nothing to modify — provide at least one field.', null, order.broker);
  }
  if (changes.qty != null && (!Number.isFinite(changes.qty) || changes.qty <= 0)) {
    throw BrokerError.validation('qty must be a positive whole number', null, order.broker);
  }

  audit.log({
    userId, broker: order.broker, stage: STAGE.REQUEST, action: 'modifyOrder', requestId,
    clientOrderId: order.clientOrderId, brokerOrderId: order.brokerOrderId, payload: { changes },
  });

  try {
    const ack = await router.commands.modifyOrder(
      { userId, broker: order.broker, connection, requestId },
      { ...changes, orderId: order.brokerOrderId, clientOrderId: order.clientOrderId }
    );

    await OrderSync.updateOne({ _id: order._id }, {
      $set: {
        ...(changes.qty != null ? { 'request.qty': changes.qty } : {}),
        ...(changes.price != null ? { 'request.price': changes.price } : {}),
        ...(changes.triggerPrice != null ? { 'request.triggerPrice': changes.triggerPrice } : {}),
        ...(changes.orderType ? { 'request.orderType': changes.orderType } : {}),
        ...(changes.validity ? { 'request.validity': changes.validity } : {}),
        statusMessage: ack.message,
      },
      $push: { revisions: { action: 'MODIFY', at: new Date(), changes, result: ack.status } },
    });

    audit.transition({
      clientOrderId: order.clientOrderId, orderSyncId: order._id, userId, broker: order.broker,
      brokerOrderId: order.brokerOrderId, fromStatus: order.status, toStatus: order.status,
      source: UPDATE_SOURCE.API, actor: ctx.actor || 'USER', message: 'Order modified', snapshot: changes, requestId,
    });

    await cache.invalidateUser(userId, order.broker);
    const fresh = await OrderSync.findById(order._id);
    _pushToClient(userId, fresh);
    return { ...ack, clientOrderId: order.clientOrderId };
  } catch (rawErr) {
    const err = BrokerError.from(rawErr, order.broker);
    audit.recordError(err, { userId, broker: order.broker, operation: 'modifyOrder', requestId, clientOrderId: order.clientOrderId });
    throw err;
  }
}

// ─── COMMAND: cancel ─────────────────────────────────────────────────
async function cancelOrder(ctx, input) {
  const { userId, requestId } = ctx;
  const order = await idempotency.findOwned(userId, input.clientOrderId);

  // Cancelling an already-cancelled order is a no-op, not an error: the user
  // tapped twice, or a fill raced the cancel.
  if (order.status === ORDER_STATUS.CANCELLED) {
    return {
      success: true, broker: order.broker, orderId: order.brokerOrderId,
      clientOrderId: order.clientOrderId, status: order.status,
      message: 'Order was already cancelled.', timestamp: new Date().toISOString(), duplicate: true,
    };
  }
  if (isTerminal(order.status)) {
    throw new BrokerError(ERROR_CODE.BROKER_REJECTED, `This order is already ${order.status.toLowerCase()} and cannot be cancelled.`, { broker: order.broker });
  }
  if (!order.brokerOrderId) {
    throw new BrokerError(ERROR_CODE.ORDER_NOT_FOUND, 'This order has no broker reference yet.', { broker: order.broker });
  }

  const connection = await router.resolve({ userId, broker: order.broker });
  audit.log({
    userId, broker: order.broker, stage: STAGE.REQUEST, action: 'cancelOrder', requestId,
    clientOrderId: order.clientOrderId, brokerOrderId: order.brokerOrderId,
  });

  try {
    const ack = await router.commands.cancelOrder(
      { userId, broker: order.broker, connection, requestId, priority: PRIORITY.HIGH },
      { orderId: order.brokerOrderId, clientOrderId: order.clientOrderId }
    );

    const updated = await transition(order, ack.status || ORDER_STATUS.CANCELLED, {
      statusMessage: ack.message,
      response: { success: true, orderId: order.brokerOrderId, status: ack.status, message: ack.message },
      requestId, source: UPDATE_SOURCE.API, actor: ctx.actor || 'USER',
    });
    await OrderSync.updateOne({ _id: order._id }, {
      $push: { revisions: { action: 'CANCEL', at: new Date(), changes: null, result: ack.status } },
    });

    await cache.invalidateUser(userId, order.broker);
    _pushToClient(userId, updated);
    return { ...ack, clientOrderId: order.clientOrderId };
  } catch (rawErr) {
    const err = BrokerError.from(rawErr, order.broker);
    audit.recordError(err, { userId, broker: order.broker, operation: 'cancelOrder', requestId, clientOrderId: order.clientOrderId });
    throw err;
  }
}

// ─── Inbound updates (websocket / polling) ───────────────────────────
/**
 * Apply a broker-originated order update to our system of record.
 * Matched by clientOrderId when the broker echoes it, else by brokerOrderId.
 *
 * @param {object} p { userId, broker, update (normalize.order), source }
 * @returns {Promise<object|null>} the client-facing order view
 */
async function applyBrokerUpdate({ userId, broker, update, source = UPDATE_SOURCE.WEBSOCKET }) {
  if (!update) return null;

  const query = update.clientOrderId
    ? { clientOrderId: update.clientOrderId }
    : { userId, broker, brokerOrderId: update.orderId };
  const order = await OrderSync.findOne(query);

  if (!order) {
    // An order placed outside our platform (Dhan app, another terminal). We do
    // NOT synthesize an OrderSync row for it — this collection records OUR
    // requests. It's still forwarded to the UI so the blotter stays complete.
    audit.log({
      userId, broker, stage: STAGE.WEBSOCKET, action: 'orderUpdate:external', level: 'debug',
      brokerOrderId: update.orderId, message: 'Update for an order not placed through this platform',
    });
    return { ...update, external: true };
  }
  if (String(order.userId) !== String(userId)) return null; // defensive

  const updated = await transition(order, update.status, {
    brokerOrderId: update.orderId || order.brokerOrderId,
    exchangeOrderId: update.exchangeOrderId,
    statusMessage: update.statusMessage,
    filledQty: update.filledQty,
    pendingQty: update.pendingQty,
    averagePrice: update.averagePrice,
    source,
    actor: 'BROKER',
    extra: { lastSyncedAt: new Date() },
  });

  if (TERMINAL_STATUSES.includes(update.status)) {
    await cache.invalidateUser(userId, broker);
  }
  return updated.toClientJSON ? updated.toClientJSON() : updated;
}

/** Push an order update on the user's private WebSocket channel. */
function _pushToClient(userId, order) {
  if (!order) return;
  try {
    const manager = require('../../brokers/BrokerManager');
    manager.publishOrder(String(userId), order.toClientJSON ? order.toClientJSON() : order);
  } catch (_) { /* the REST response already carries the truth */ }
}

/** Our own order records (fast, no broker call). */
async function listLocalOrders({ userId, broker, status, symbol, limit = 100, skip = 0 }) {
  const q = { userId };
  if (broker) q.broker = String(broker).toUpperCase();
  if (status) q.status = Array.isArray(status) ? { $in: status } : status;
  if (symbol) q['request.symbol'] = String(symbol).toUpperCase();

  const [rows, total] = await Promise.all([
    OrderSync.find(q).sort({ createdAt: -1 }).skip(Number(skip) || 0).limit(Math.min(Number(limit) || 100, 500)),
    OrderSync.countDocuments(q),
  ]);
  return { total, orders: rows.map((r) => r.toClientJSON()) };
}

module.exports = {
  placeOrder,
  modifyOrder,
  cancelOrder,
  applyBrokerUpdate,
  listLocalOrders,
  validateOrder,
  transition,
};
