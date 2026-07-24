/**
 * Dhan (DhanHQ v2) wire configuration.
 *
 * Every broker-specific URL, header name, enum value and limit lives in this
 * one file so an API change is a config edit, not a code hunt. Nothing outside
 * `brokers/dhan/` may import it.
 *
 * All values are env-overridable: when DhanHQ ships v3, point the base URL at
 * it in staging without a deploy.
 */

const BASE_URL = process.env.DHAN_API_BASE || 'https://api.dhan.co/v2';

module.exports = {
  BASE_URL,

  // Live order-update socket (separate host from the REST API).
  ORDER_WS_URL: process.env.DHAN_ORDER_WS_URL || 'wss://api-order-update.dhan.co',

  // Header names Dhan expects. `access-token` carries the token; `client-id`
  // is required on market-data endpoints.
  HEADERS: {
    TOKEN: 'access-token',
    CLIENT_ID: 'client-id',
  },

  ENDPOINTS: {
    // Orders
    PLACE_ORDER: { method: 'POST', path: '/orders' },
    MODIFY_ORDER: { method: 'PUT', path: '/orders/:orderId' },
    CANCEL_ORDER: { method: 'DELETE', path: '/orders/:orderId' },
    ORDER_BOOK: { method: 'GET', path: '/orders' },
    ORDER_BY_ID: { method: 'GET', path: '/orders/:orderId' },
    // Look an order up by OUR clientOrderId (sent as correlationId) — the
    // reconciliation path after a timeout.
    ORDER_BY_CORRELATION: { method: 'GET', path: '/orders/external/:correlationId' },

    // Portfolio
    TRADE_BOOK: { method: 'GET', path: '/trades' },
    TRADE_HISTORY: { method: 'GET', path: '/trades/:from/:to/:page' },
    POSITIONS: { method: 'GET', path: '/positions' },
    HOLDINGS: { method: 'GET', path: '/holdings' },
    FUNDS: { method: 'GET', path: '/fundlimit' },
    PROFILE: { method: 'GET', path: '/profile' },

    // Market data
    QUOTE_LTP: { method: 'POST', path: '/marketfeed/ltp' },
    QUOTE_OHLC: { method: 'POST', path: '/marketfeed/ohlc' },
    QUOTE_FULL: { method: 'POST', path: '/marketfeed/quote' },
    CHART_INTRADAY: { method: 'POST', path: '/charts/intraday' },
    CHART_HISTORICAL: { method: 'POST', path: '/charts/historical' },
  },

  TIMEOUTS: {
    // Orders get the shortest budget: a slow order is worse than a failed one
    // because the user is staring at a spinner while the market moves.
    order: Number(process.env.DHAN_ORDER_TIMEOUT_MS) || 8000,
    data: Number(process.env.DHAN_DATA_TIMEOUT_MS) || 7000,
    default: Number(process.env.DHAN_TIMEOUT_MS) || 10000,
  },

  // Published DhanHQ limits (per second unless stated). Kept slightly under
  // the documented ceiling so a burst never trips the broker's own counter.
  RATE_LIMITS: {
    orders: { perSecond: 20, perMinute: 240, perHour: 4500, perDay: 6500 },
    data: { perSecond: 4, perMinute: 900, perHour: 4500, perDay: 90000 },
    nonTrading: { perSecond: 18, perMinute: 900, perHour: 4500, perDay: 90000 },
    default: { perSecond: 4, perMinute: 240 },
  },

  // Max instruments per market-feed request (Dhan caps at 1000).
  QUOTE_BATCH_SIZE: 1000,

  // ── Enum vocabulary (Dhan side) ──
  EXCHANGE_SEGMENT: {
    NSE_EQ: 'NSE_EQ',
    NSE_FNO: 'NSE_FNO',
    NSE_CURRENCY: 'NSE_CURRENCY',
    BSE_EQ: 'BSE_EQ',
    BSE_FNO: 'BSE_FNO',
    BSE_CURRENCY: 'BSE_CURRENCY',
    MCX_COMM: 'MCX_COMM',
    IDX_I: 'IDX_I',
  },

  TRANSACTION_TYPE: { BUY: 'BUY', SELL: 'SELL' },

  PRODUCT_TYPE: {
    CNC: 'CNC',
    INTRADAY: 'INTRADAY',
    MARGIN: 'MARGIN',
    MTF: 'MTF',
    CO: 'CO',
    BO: 'BO',
  },

  ORDER_TYPE: {
    LIMIT: 'LIMIT',
    MARKET: 'MARKET',
    STOP_LOSS: 'STOP_LOSS',
    STOP_LOSS_MARKET: 'STOP_LOSS_MARKET',
  },

  VALIDITY: { DAY: 'DAY', IOC: 'IOC' },

  ORDER_STATUS: {
    TRANSIT: 'TRANSIT',
    PENDING: 'PENDING',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    PART_TRADED: 'PART_TRADED',
    TRADED: 'TRADED',
    EXPIRED: 'EXPIRED',
    CONFIRM: 'CONFIRM',
    TRIGGERED: 'TRIGGERED',
    CLOSED: 'CLOSED',
    MODIFIED: 'MODIFIED',
  },

  // Order-update socket login frame.
  WS: {
    LOGIN_MSG_CODE: 42,
    USER_TYPE: 'SELF',
    HEARTBEAT_MS: Number(process.env.DHAN_WS_HEARTBEAT_MS) || 25000,
    // No traffic at all for this long ⇒ assume a half-open socket, reconnect.
    IDLE_TIMEOUT_MS: Number(process.env.DHAN_WS_IDLE_MS) || 70000,
    RECONNECT_BASE_MS: 1000,
    RECONNECT_MAX_MS: 30000,
  },
};
