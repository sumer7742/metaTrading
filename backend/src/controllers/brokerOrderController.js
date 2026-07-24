/**
 * Broker order endpoints — the CQRS command surface.
 *
 * The frontend always calls the SAME url regardless of broker:
 *
 *   POST   /api/orders                    place
 *   PUT    /api/orders/:clientOrderId     modify
 *   DELETE /api/orders/:clientOrderId     cancel
 *   GET    /api/orders                    order book
 *   GET    /api/orders/history            trade history
 *   GET    /api/orders/:clientOrderId     one order
 *
 * Controllers stay thin on purpose: resolve the caller, hand off to the
 * service, shape the response. No broker knowledge, no business rules.
 */

const orderService = require('../services/broker/brokerOrder.service');
const portfolioService = require('../services/broker/brokerPortfolio.service');
const audit = require('../services/broker/brokerAudit.service');
const { asyncHandler, sendSuccess } = require('../utils/errors');

/**
 * POST /api/orders
 *
 * Body: { symbol, exchange, qty, side, orderType, productType, broker?, ... }
 * Returns the normalized ack: { success, broker, orderId, status, message }
 */
const place = asyncHandler(async (req, res) => {
  const ack = await orderService.placeOrder(req.brokerCtx, req.body);
  // 202 Accepted is the honest status: the broker has the order, the exchange
  // has not necessarily filled it. 200 would imply a completed trade.
  sendSuccess(res, ack, 202);
});

/** PUT /api/orders/:clientOrderId */
const modify = asyncHandler(async (req, res) => {
  const ack = await orderService.modifyOrder(req.brokerCtx, {
    ...req.body,
    clientOrderId: String(req.params.clientOrderId).toUpperCase(),
  });
  sendSuccess(res, ack);
});

/** DELETE /api/orders/:clientOrderId */
const cancel = asyncHandler(async (req, res) => {
  const ack = await orderService.cancelOrder(req.brokerCtx, {
    clientOrderId: String(req.params.clientOrderId).toUpperCase(),
  });
  sendSuccess(res, ack);
});

/**
 * GET /api/orders
 *   ?source=broker (default) — live order book from the broker
 *   ?source=local            — our own OrderSync records (no broker call)
 */
const list = asyncHandler(async (req, res) => {
  const { broker, source, status, symbol, limit, skip, force } = req.query;

  if (source === 'local') {
    const result = await orderService.listLocalOrders({
      userId: req.brokerCtx.userId,
      broker,
      status: status ? String(status).toUpperCase().split(',') : undefined,
      symbol,
      limit,
      skip,
    });
    return sendSuccess(res, { source: 'local', ...result });
  }

  const result = await portfolioService.orders({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, force,
  });
  return sendSuccess(res, { source: 'broker', ...result });
});

/** GET /api/orders/history */
const history = asyncHandler(async (req, res) => {
  const { broker, from, to, page, today, force } = req.query;
  const result = await portfolioService.history({
    userId: req.brokerCtx.userId,
    broker,
    requestId: req.brokerCtx.requestId,
    force,
    range: { from, to, page, today },
  });
  sendSuccess(res, result);
});

/**
 * GET /api/orders/:clientOrderId
 * Our record plus the broker's live view of the same order.
 */
const getOne = asyncHandler(async (req, res) => {
  const clientOrderId = String(req.params.clientOrderId).toUpperCase();
  const idempotency = require('../services/broker/idempotency.service');
  const doc = await idempotency.findOwned(req.brokerCtx.userId, clientOrderId);

  let live = null;
  if (req.query.live !== 'false' && doc.brokerOrderId) {
    try {
      const result = await portfolioService.orders({
        userId: req.brokerCtx.userId,
        broker: doc.broker,
        requestId: req.brokerCtx.requestId,
        filter: { orderId: doc.brokerOrderId },
      });
      live = (result.orders || [])[0] || null;
    } catch (_) {
      // A broker hiccup must not hide our own record of the order.
    }
  }

  sendSuccess(res, { order: doc.toClientJSON(), live });
});

/**
 * GET /api/orders/:clientOrderId/audit
 * Full lifecycle trail — request → queue → broker → exchange → response.
 */
const trail = asyncHandler(async (req, res) => {
  const clientOrderId = String(req.params.clientOrderId).toUpperCase();
  const idempotency = require('../services/broker/idempotency.service');
  await idempotency.findOwned(req.brokerCtx.userId, clientOrderId); // ownership check
  sendSuccess(res, await audit.trail(clientOrderId));
});

module.exports = { place, modify, cancel, list, history, getOne, trail };
