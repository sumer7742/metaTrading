/**
 * Dhan order operations.
 *
 * Split out of the adapter so each concern is independently testable and the
 * adapter stays a thin composition root (Single Responsibility). Everything
 * here takes normalized inputs and returns normalized outputs.
 */

const config = require('../config');
const mappers = require('../mappers');
const dhanErrors = require('../errors');
const symbolResolver = require('../SymbolResolver');
const normalize = require('../../base/normalize');
const { BrokerError, ERROR_CODE } = require('../../base/BrokerError');
const { ORDER_STATUS } = require('../../constants');

const BROKER = 'DHAN';

class DhanOrderService {
  /** @param {import('../DhanHttpClient')} http */
  constructor({ http, clientId }) {
    this.http = http;
    // Non-enumerable: the Dhan client id identifies the user's brokerage
    // account, so it must not appear in a stringified service/adapter.
    Object.defineProperty(this, 'clientId', { value: clientId || null, enumerable: false });
  }

  _assertClientId() {
    if (!this.clientId) {
      throw new BrokerError(ERROR_CODE.NOT_CONNECTED, 'Dhan client id missing — reconnect your Dhan account.', { broker: BROKER });
    }
  }

  /**
   * Place an order.
   * @param {object} req normalized order request (must carry clientOrderId)
   * @returns {Promise<object>} normalize.orderAck
   */
  async place(req) {
    this._assertClientId();

    // Resolve symbol → securityId unless the caller already did.
    const resolved = await symbolResolver.resolve({
      symbol: req.symbol, exchange: req.exchange, securityId: req.securityId,
    });

    const body = mappers.toPlaceOrderBody({ ...req, securityId: resolved.securityId, segment: resolved.segment }, this.clientId);

    const data = await this.http.request(config.ENDPOINTS.PLACE_ORDER, {
      body, category: 'order', operation: 'placeOrder', clientOrderId: req.clientOrderId,
    });

    const orderId = data && (data.orderId || data.order_id);
    const dhanStatus = data && (data.orderStatus || data.status);

    if (!orderId) {
      throw dhanErrors.fromResponse(200, data, { operation: 'placeOrder' });
    }
    // Dhan can accept the HTTP call and still reject the order at its OMS.
    if (String(dhanStatus || '').toUpperCase() === config.ORDER_STATUS.REJECTED) {
      throw dhanErrors.fromRejection({ ...data, orderId }, { operation: 'placeOrder' });
    }

    return normalize.orderAck({
      success: true,
      broker: BROKER,
      orderId,
      clientOrderId: req.clientOrderId,
      status: mappers.fromOrderStatus(dhanStatus) || ORDER_STATUS.BROKER_ACCEPTED,
      message: 'Order submitted to Dhan',
      raw: data,
    });
  }

  /**
   * Modify a live order.
   * @param {object} req { orderId, clientOrderId?, qty?, price?, triggerPrice?, orderType?, validity?, legName? }
   */
  async modify(req) {
    this._assertClientId();
    if (!req.orderId) throw BrokerError.validation('orderId is required to modify an order.', null, BROKER);

    const body = mappers.toModifyOrderBody(req, this.clientId);
    const data = await this.http.request(config.ENDPOINTS.MODIFY_ORDER, {
      params: { orderId: req.orderId }, body,
      category: 'order', operation: 'modifyOrder', clientOrderId: req.clientOrderId,
    });

    const dhanStatus = data && (data.orderStatus || data.status);
    if (String(dhanStatus || '').toUpperCase() === config.ORDER_STATUS.REJECTED) {
      throw dhanErrors.fromRejection(data, { operation: 'modifyOrder' });
    }

    return normalize.orderAck({
      success: true,
      broker: BROKER,
      orderId: (data && (data.orderId || data.order_id)) || req.orderId,
      clientOrderId: req.clientOrderId,
      status: mappers.fromOrderStatus(dhanStatus) || ORDER_STATUS.EXCHANGE_ACCEPTED,
      message: 'Order modification submitted',
      raw: data,
    });
  }

  /** Cancel a live order. */
  async cancel(req) {
    this._assertClientId();
    if (!req.orderId) throw BrokerError.validation('orderId is required to cancel an order.', null, BROKER);

    const data = await this.http.request(config.ENDPOINTS.CANCEL_ORDER, {
      params: { orderId: req.orderId },
      category: 'order', operation: 'cancelOrder', clientOrderId: req.clientOrderId,
    });

    const dhanStatus = data && (data.orderStatus || data.status);
    return normalize.orderAck({
      success: true,
      broker: BROKER,
      orderId: (data && (data.orderId || data.order_id)) || req.orderId,
      clientOrderId: req.clientOrderId,
      status: dhanStatus ? mappers.fromOrderStatus(dhanStatus) : ORDER_STATUS.CANCELLED,
      message: 'Cancellation submitted',
      raw: data,
    });
  }

  /**
   * Order book, or a single order.
   * @param {object} [filter] { orderId?, clientOrderId? }
   * @returns {Promise<Array<object>>} normalize.order[]
   */
  async list(filter = {}) {
    if (filter.orderId) {
      const row = await this.http.request(config.ENDPOINTS.ORDER_BY_ID, {
        params: { orderId: filter.orderId }, category: 'nonTrading', operation: 'orderById',
      });
      return _rows(row).map(mappers.toOrder).filter(Boolean);
    }

    if (filter.clientOrderId) {
      // Dhan indexes our clientOrderId as correlationId. This is the
      // reconciliation path after a timeout: "did my order actually land?"
      try {
        const row = await this.http.request(config.ENDPOINTS.ORDER_BY_CORRELATION, {
          params: { correlationId: filter.clientOrderId }, category: 'nonTrading', operation: 'orderByCorrelation',
        });
        return _rows(row).map(mappers.toOrder).filter(Boolean);
      } catch (err) {
        // "Not found" is a legitimate answer here (the order never landed),
        // not an error the caller should have to catch.
        if (BrokerError.from(err, BROKER).code === ERROR_CODE.ORDER_NOT_FOUND) return [];
        throw err;
      }
    }

    const data = await this.http.request(config.ENDPOINTS.ORDER_BOOK, {
      category: 'nonTrading', operation: 'orderBook',
    });
    return _rows(data).map(mappers.toOrder).filter(Boolean);
  }

  /** Today's executed trades. */
  async trades() {
    const data = await this.http.request(config.ENDPOINTS.TRADE_BOOK, {
      category: 'nonTrading', operation: 'tradeBook',
    });
    return _rows(data).map(mappers.toTrade).filter(Boolean);
  }
}

/** Dhan returns either an array or a single object depending on the endpoint. */
function _rows(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  return [data];
}

module.exports = DhanOrderService;
