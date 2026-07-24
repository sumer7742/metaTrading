/**
 * Broker-module constants — the platform-neutral vocabulary.
 *
 * NOTHING broker-specific belongs here. Every adapter translates between
 * these values and its own wire format inside `brokers/<broker>/mappers.js`.
 * The frontend, controllers, services and DB only ever see these.
 *
 * Deliberately separate from `config/constants.js` (the forex/crypto engine's
 * vocabulary) so the two never collide and neither can break the other.
 */

// ─── Supported brokers ───────────────────────────────────────────────
// A code listed here is NOT automatically available — it must also be
// registered in `brokers/registry.js` via an adapter descriptor. This map
// exists so routes/models can validate a broker code before the registry
// is consulted, and so future brokers have a canonical spelling.
const BROKER = {
  DHAN: 'DHAN',
  UPSTOX: 'UPSTOX',
  FYERS: 'FYERS',
  ANGEL_ONE: 'ANGEL_ONE',
  ZERODHA: 'ZERODHA',
  SHOONYA: 'SHOONYA',
};

const BROKER_CODES = Object.values(BROKER);

// ─── Authentication modes ────────────────────────────────────────────
// MANUAL — the user generates an access token in the broker's own dashboard
//          and pastes it into our platform (Dhan today).
// OAUTH  — the broker's official partner/OAuth flow issues the token to us.
//          Architecture supports it; no adapter has to implement it yet.
const AUTH_MODE = {
  MANUAL: 'MANUAL',
  OAUTH: 'OAUTH',
};

// ─── Connection status ───────────────────────────────────────────────
const CONNECTION_STATUS = {
  PENDING: 'PENDING',           // created, token not yet validated
  ACTIVE: 'ACTIVE',             // validated, usable
  EXPIRED: 'EXPIRED',           // token past expiresAt
  INVALID: 'INVALID',           // broker rejected the token
  REVOKED: 'REVOKED',           // user/broker revoked access
  DISCONNECTED: 'DISCONNECTED', // user disconnected from our UI
  ERROR: 'ERROR',               // repeated broker failures
};

const USABLE_CONNECTION_STATUSES = [CONNECTION_STATUS.ACTIVE, CONNECTION_STATUS.PENDING];

// ─── Order lifecycle ─────────────────────────────────────────────────
// Created → Validated → Queued → Broker Accepted → Exchange Accepted →
// Partially Filled → Filled | Cancelled | Rejected
//
// Every transition stamps a timestamp on OrderSync.timeline.
const ORDER_STATUS = {
  CREATED: 'CREATED',
  VALIDATED: 'VALIDATED',
  QUEUED: 'QUEUED',
  BROKER_ACCEPTED: 'BROKER_ACCEPTED',
  EXCHANGE_ACCEPTED: 'EXCHANGE_ACCEPTED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED', // never reached the broker (network/queue/validation failure)
};

const ORDER_STATUSES = Object.values(ORDER_STATUS);

// Ordinal rank — used to reject out-of-order updates (a late-arriving
// EXCHANGE_ACCEPTED must never overwrite a FILLED). Terminal states all
// share the top rank; the first terminal state to land wins.
const STATUS_RANK = {
  [ORDER_STATUS.CREATED]: 0,
  [ORDER_STATUS.VALIDATED]: 1,
  [ORDER_STATUS.QUEUED]: 2,
  [ORDER_STATUS.BROKER_ACCEPTED]: 3,
  [ORDER_STATUS.EXCHANGE_ACCEPTED]: 4,
  [ORDER_STATUS.PARTIALLY_FILLED]: 5,
  [ORDER_STATUS.FILLED]: 9,
  [ORDER_STATUS.CANCELLED]: 9,
  [ORDER_STATUS.REJECTED]: 9,
  [ORDER_STATUS.EXPIRED]: 9,
  [ORDER_STATUS.FAILED]: 9,
};

const TERMINAL_STATUSES = [
  ORDER_STATUS.FILLED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.REJECTED,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.FAILED,
];

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

// OrderSync.timeline field written when the order reaches each status.
const STATUS_TIMELINE_FIELD = {
  [ORDER_STATUS.CREATED]: 'created',
  [ORDER_STATUS.VALIDATED]: 'validated',
  [ORDER_STATUS.QUEUED]: 'queued',
  [ORDER_STATUS.BROKER_ACCEPTED]: 'brokerAccepted',
  [ORDER_STATUS.EXCHANGE_ACCEPTED]: 'exchangeAccepted',
  [ORDER_STATUS.PARTIALLY_FILLED]: 'partiallyFilled',
  [ORDER_STATUS.FILLED]: 'filled',
  [ORDER_STATUS.CANCELLED]: 'cancelled',
  [ORDER_STATUS.REJECTED]: 'rejected',
  [ORDER_STATUS.EXPIRED]: 'expired',
  [ORDER_STATUS.FAILED]: 'failed',
};

// ─── Order attributes ────────────────────────────────────────────────
const ORDER_SIDE = { BUY: 'BUY', SELL: 'SELL' };

const ORDER_TYPE = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  SL: 'SL',     // stop-loss limit
  SL_M: 'SL_M', // stop-loss market
};

// Platform-neutral product types. Adapters map these onto broker names
// (Dhan: DELIVERY→CNC, INTRADAY→INTRADAY, …).
const PRODUCT_TYPE = {
  INTRADAY: 'INTRADAY',
  DELIVERY: 'DELIVERY',
  MARGIN: 'MARGIN',
  MTF: 'MTF',
  CO: 'CO', // cover order
  BO: 'BO', // bracket order
};

const VALIDITY = { DAY: 'DAY', IOC: 'IOC' };

// Indian exchange segments we route to.
const EXCHANGE = {
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO', // NSE F&O
  BFO: 'BFO', // BSE F&O
  MCX: 'MCX',
  CDS: 'CDS', // NSE currency
  BCD: 'BCD', // BSE currency
};

const EXCHANGES = Object.values(EXCHANGE);

// Which exchange's session gates an order on this segment. Used by the
// pre-trade market-hours check (reuses services/marketHours.js).
const EXCHANGE_SESSION_KEY = {
  [EXCHANGE.NSE]: 'NSE',
  [EXCHANGE.BSE]: 'BSE',
  [EXCHANGE.NFO]: 'NFO',
  [EXCHANGE.BFO]: 'BFO',
  [EXCHANGE.MCX]: 'MCX',
  [EXCHANGE.CDS]: 'NSE',
  [EXCHANGE.BCD]: 'BSE',
};

// ─── Adapter capability keys ─────────────────────────────────────────
// A broker declares what it can actually do. The router/controller checks
// the capability before dispatching so an unsupported call fails fast with
// UNSUPPORTED_OPERATION instead of a confusing broker error.
const CAPABILITY = {
  PLACE_ORDER: 'placeOrder',
  MODIFY_ORDER: 'modifyOrder',
  CANCEL_ORDER: 'cancelOrder',
  POSITIONS: 'positions',
  HOLDINGS: 'holdings',
  FUNDS: 'funds',
  ORDERS: 'orders',
  HISTORY: 'history',
  QUOTES: 'quotes',
  MARKET_STATUS: 'marketStatus',
  ORDER_STREAM: 'orderStream',   // live order-update websocket
  TICK_STREAM: 'tickStream',     // live market-data websocket
  OAUTH: 'oauth',
};

// ─── Queue priorities ────────────────────────────────────────────────
// Cancels/modifies outrank new orders: a user trying to get OUT of a
// position must never queue behind a burst of entries.
const PRIORITY = {
  CRITICAL: 100, // square-off / risk-driven exits
  HIGH: 75,      // cancel + modify
  NORMAL: 50,    // place order
  LOW: 25,       // portfolio reads, reconciliation
};

// Rate-limiter buckets. Brokers publish different limits per class of API.
const RATE_CATEGORY = {
  ORDERS: 'orders',
  DATA: 'data',
  NON_TRADING: 'nonTrading',
  DEFAULT: 'default',
};

// Where an order update came from — useful when reconciling.
const UPDATE_SOURCE = {
  API: 'API',
  WEBSOCKET: 'WEBSOCKET',
  POLL: 'POLL',
  SYSTEM: 'SYSTEM',
};

module.exports = {
  BROKER,
  BROKER_CODES,
  AUTH_MODE,
  CONNECTION_STATUS,
  USABLE_CONNECTION_STATUSES,
  ORDER_STATUS,
  ORDER_STATUSES,
  STATUS_RANK,
  TERMINAL_STATUSES,
  STATUS_TIMELINE_FIELD,
  isTerminal,
  ORDER_SIDE,
  ORDER_TYPE,
  PRODUCT_TYPE,
  VALIDITY,
  EXCHANGE,
  EXCHANGES,
  EXCHANGE_SESSION_KEY,
  CAPABILITY,
  PRIORITY,
  RATE_CATEGORY,
  UPDATE_SOURCE,
};
