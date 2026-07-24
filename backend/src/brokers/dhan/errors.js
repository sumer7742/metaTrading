/**
 * Dhan → normalized error translation.
 *
 * This is where every Dhan-specific failure string dies. Outside this file the
 * platform only ever sees ERROR_CODE values, which is what lets a second
 * broker be added without touching a single error branch elsewhere.
 *
 * Dhan reports failures two ways, often together:
 *   - HTTP status (401/429/500…)
 *   - a body carrying `errorCode` ('DH-901'), `errorType`, `errorMessage`,
 *     or for order rejections `omsErrorCode` / `omsErrorDescription`.
 * Order rejections in particular arrive as HTTP 200 with a REJECTED status, so
 * status alone is never enough.
 */

const { BrokerError, ERROR_CODE } = require('../base/BrokerError');

const BROKER = 'DHAN';

// Documented DhanHQ error codes.
const CODE_MAP = {
  'DH-901': ERROR_CODE.INVALID_TOKEN,        // Invalid Authentication
  'DH-902': ERROR_CODE.BROKER_UNAUTHORIZED,  // Invalid Access (segment not enabled)
  'DH-903': ERROR_CODE.BROKER_UNAUTHORIZED,  // User Account (KYC/permissions)
  'DH-904': ERROR_CODE.RATE_LIMIT,           // Too many requests
  'DH-905': ERROR_CODE.VALIDATION_ERROR,     // Input exception
  'DH-906': ERROR_CODE.BROKER_REJECTED,      // Order error
  'DH-907': ERROR_CODE.BROKER_REJECTED,      // Data error
  'DH-908': ERROR_CODE.BROKER_OFFLINE,       // Internal server error
  'DH-909': ERROR_CODE.NETWORK_FAILURE,      // Network error
  'DH-910': ERROR_CODE.INTERNAL_ERROR,       // Others
  'RS-9001': ERROR_CODE.INVALID_TOKEN,
  'RS-9002': ERROR_CODE.INVALID_TOKEN,
  'RS-9005': ERROR_CODE.BROKER_OFFLINE,
};

// Message heuristics for rejections Dhan reports as free text. Ordered —
// first match wins, so the specific patterns come before the generic ones.
const MESSAGE_RULES = [
  { re: /insufficient|not enough|margin shortfall|inadequate balance|available balance/i, code: ERROR_CODE.MARGIN_ERROR },
  { re: /freeze|quantity.*(exceed|invalid|multiple|limit)|lot size|market lot|qty/i, code: ERROR_CODE.QUANTITY_ERROR },
  { re: /price.*(band|range|circuit|invalid|tick)|tick size|dpr/i, code: ERROR_CODE.PRICE_ERROR },
  { re: /market.*(closed|not open)|outside.*(market|trading) hours|trading.*not.*allowed.*time/i, code: ERROR_CODE.MARKET_CLOSED },
  { re: /exchange.*(closed|down|not available)|session closed|holiday/i, code: ERROR_CODE.EXCHANGE_CLOSED },
  { re: /duplicate|already (placed|exists)/i, code: ERROR_CODE.DUPLICATE_ORDER },
  { re: /order.*not found|invalid order id|no such order/i, code: ERROR_CODE.ORDER_NOT_FOUND },
  { re: /token.*(invalid|expired)|unauthor|authentication fail|invalid access/i, code: ERROR_CODE.INVALID_TOKEN },
  { re: /rate limit|too many request|throttl/i, code: ERROR_CODE.RATE_LIMIT },
  { re: /timed? ?out/i, code: ERROR_CODE.TIMEOUT },
];

const STATUS_MAP = {
  400: ERROR_CODE.VALIDATION_ERROR,
  401: ERROR_CODE.INVALID_TOKEN,
  403: ERROR_CODE.BROKER_UNAUTHORIZED,
  404: ERROR_CODE.ORDER_NOT_FOUND,
  408: ERROR_CODE.TIMEOUT,
  429: ERROR_CODE.RATE_LIMIT,
  500: ERROR_CODE.BROKER_OFFLINE,
  502: ERROR_CODE.BROKER_OFFLINE,
  503: ERROR_CODE.BROKER_OFFLINE,
  504: ERROR_CODE.TIMEOUT,
};

/** Pull the various fields Dhan uses for its own error identifier. */
function extract(body) {
  if (!body || typeof body !== 'object') return { code: null, message: null };
  const code = body.errorCode || body.error_code || body.omsErrorCode || body.internalErrorCode || null;
  const message = body.errorMessage || body.error_message || body.omsErrorDescription
    || body.internalErrorMessage || body.message || body.error || body.remarks || null;
  return { code: code ? String(code) : null, message: message ? String(message) : null };
}

/**
 * Build a normalized BrokerError from a Dhan HTTP response.
 *
 * @param {number} status  HTTP status
 * @param {object} body    parsed JSON body (may be {})
 * @param {object} [meta]  { operation, path } for audit context
 */
function fromResponse(status, body, meta = {}) {
  const { code: brokerCode, message: brokerMessage } = extract(body);

  // 1. Dhan's own code is the most reliable signal.
  let code = brokerCode ? CODE_MAP[brokerCode] : null;

  // 2. Then the message text (order rejections carry the real reason here).
  if (!code && brokerMessage) {
    const rule = MESSAGE_RULES.find((r) => r.re.test(brokerMessage));
    if (rule) code = rule.code;
  }

  // 3. Finally the HTTP status.
  if (!code) code = STATUS_MAP[status] || (status >= 500 ? ERROR_CODE.BROKER_OFFLINE : ERROR_CODE.BROKER_REJECTED);

  // Dhan's message is more useful to the user than our generic text, as long
  // as it's short and human — otherwise fall back to the default copy.
  const useBrokerMessage = brokerMessage && brokerMessage.length < 300 && !/^\s*<|html/i.test(brokerMessage);

  return new BrokerError(code, useBrokerMessage ? brokerMessage : null, {
    broker: BROKER,
    details: {
      brokerCode: brokerCode || null,
      brokerMessage: brokerMessage || null,
      ...(meta.operation ? { operation: meta.operation } : {}),
    },
  });
}

/**
 * Classify an order the broker accepted over HTTP but REJECTED at the OMS —
 * i.e. HTTP 200 with orderStatus REJECTED.
 */
function fromRejection(orderRow, meta = {}) {
  const message = orderRow && (orderRow.omsErrorDescription || orderRow.remarks || orderRow.errorMessage || orderRow.text);
  const rule = message ? MESSAGE_RULES.find((r) => r.re.test(String(message))) : null;
  return new BrokerError(rule ? rule.code : ERROR_CODE.BROKER_REJECTED, message ? String(message) : null, {
    broker: BROKER,
    details: {
      brokerCode: (orderRow && (orderRow.omsErrorCode || orderRow.errorCode)) || null,
      brokerMessage: message ? String(message) : null,
      ...(meta.operation ? { operation: meta.operation } : {}),
    },
  });
}

module.exports = { fromResponse, fromRejection, extract, CODE_MAP, MESSAGE_RULES };
