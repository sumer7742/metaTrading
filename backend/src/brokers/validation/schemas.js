/**
 * Request validation schemas (zod).
 *
 * Validation runs at the edge so nothing malformed reaches the order service,
 * the queue or a broker. Two rules that matter:
 *
 *   - `.strict()` on order payloads: an unknown field is a REJECTION, not a
 *     silently-ignored key. A typo'd "quantity" must not become a market order
 *     for the default quantity.
 *   - Enums come from `brokers/constants.js`, so a new product type is added
 *     in one place and every route accepts it.
 */

const { z } = require('zod');
const {
  BROKER_CODES, ORDER_SIDE, ORDER_TYPE, PRODUCT_TYPE, VALIDITY, EXCHANGES, AUTH_MODE,
} = require('../constants');

const upper = (s) => z.string().trim().transform((v) => v.toUpperCase()).pipe(s);

const brokerCode = upper(z.enum(BROKER_CODES));
const optionalBroker = brokerCode.optional();

const symbol = z.string().trim().min(1).max(64).transform((v) => v.toUpperCase());
const exchange = upper(z.enum(EXCHANGES));
const side = upper(z.enum(Object.values(ORDER_SIDE)));
const orderType = upper(z.enum(Object.values(ORDER_TYPE)));
const productType = upper(z.enum(Object.values(PRODUCT_TYPE)));
const validity = upper(z.enum(Object.values(VALIDITY)));

// Quantities are whole numbers of shares/contracts. The 1e7 ceiling is a
// fat-finger guard, not an exchange rule — the broker enforces the real caps.
const qty = z.coerce.number().int().positive().max(10_000_000);
const price = z.coerce.number().nonnegative().max(100_000_000);

const clientOrderId = z.string().trim().regex(/^[A-Z]{2,4}-\d{8}-[0-9A-F]{8}$/i, 'clientOrderId must look like PX-YYYYMMDD-XXXXXXXX');

// Query-string booleans. Deliberately NOT `z.coerce.boolean()`: that is
// `Boolean(value)`, so the STRING "false" becomes TRUE — `?force=false` would
// silently bypass the cache and `amo=false` would become an after-market order.
const boolish = z.union([z.boolean(), z.string(), z.number()]).transform((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
});

// ─── Orders ──────────────────────────────────────────────────────────
const placeOrder = z.object({
  broker: optionalBroker,
  clientOrderId: clientOrderId.optional(),
  symbol,
  exchange,
  // Advanced clients may pass the broker's instrument id directly and skip
  // catalogue resolution.
  securityId: z.union([z.string().trim().max(32), z.number()]).optional(),
  side,
  qty,
  orderType,
  productType,
  price: price.optional().default(0),
  triggerPrice: price.optional().default(0),
  validity: validity.optional().default(VALIDITY.DAY),
  disclosedQty: z.coerce.number().int().nonnegative().optional().default(0),
  amo: boolish.optional().default(false),
  amoTime: z.enum(['OPEN', 'OPEN_30', 'OPEN_60', 'PRE_OPEN']).optional(),
  // Bracket-order legs.
  targetPrice: price.optional(),
  stopLossPrice: price.optional(),
  tag: z.string().trim().max(64).optional(),
}).strict();

const modifyOrder = z.object({
  qty: qty.optional(),
  price: price.optional(),
  triggerPrice: price.optional(),
  orderType: orderType.optional(),
  validity: validity.optional(),
  disclosedQty: z.coerce.number().int().nonnegative().optional(),
  legName: z.string().trim().max(32).optional(),
}).strict().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: 'Provide at least one field to modify.' }
);

const listOrders = z.object({
  broker: optionalBroker,
  source: z.enum(['broker', 'local']).optional().default('broker'),
  status: z.string().trim().optional(),
  symbol: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  skip: z.coerce.number().int().min(0).optional().default(0),
  force: boolish.optional().default(false),
}).passthrough();

const historyQuery = z.object({
  broker: optionalBroker,
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(0).optional(),
  today: boolish.optional().default(false),
  force: boolish.optional().default(false),
}).passthrough();

// ─── Connections ─────────────────────────────────────────────────────
const connectBroker = z.object({
  broker: brokerCode,
  authMode: upper(z.enum(Object.values(AUTH_MODE))).optional().default(AUTH_MODE.MANUAL),
  label: z.string().trim().max(64).optional(),
  // Credential fields are broker-defined (the auth provider declares them), so
  // this is a free-form record of strings — validated by the provider itself.
  // Values are capped to keep an oversized paste out of the logs and DB.
  credentials: z.record(z.string().trim().max(4096)).optional().default({}),
}).strict();

const brokerParam = z.object({ broker: brokerCode });

// ─── Market data ─────────────────────────────────────────────────────
const quotesQuery = z.object({
  broker: optionalBroker,
  // 'RELIANCE:NSE,TCS:NSE' or just 'RELIANCE,TCS'
  symbols: z.string().trim().min(1).max(4000),
  exchange: exchange.optional(),
  mode: z.enum(['LTP', 'OHLC', 'FULL']).optional().default('FULL'),
}).passthrough();

const marketStatusQuery = z.object({
  broker: optionalBroker,
  exchange: exchange.optional(),
  force: boolish.optional().default(false),
}).passthrough();

const portfolioQuery = z.object({
  broker: optionalBroker,
  force: boolish.optional().default(false),
  includeClosed: boolish.optional().default(false),
}).passthrough();

/** 'RELIANCE:NSE,TCS' → [{symbol:'RELIANCE', exchange:'NSE'}, {symbol:'TCS', exchange:<default>}] */
function parseSymbolList(raw, defaultExchange) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 500)
    .map((entry) => {
      const [sym, ex] = entry.split(':');
      return { symbol: String(sym).toUpperCase(), exchange: (ex || defaultExchange || 'NSE').toUpperCase() };
    });
}

module.exports = {
  placeOrder,
  modifyOrder,
  listOrders,
  historyQuery,
  connectBroker,
  brokerParam,
  quotesQuery,
  marketStatusQuery,
  portfolioQuery,
  clientOrderId,
  parseSymbolList,
};
