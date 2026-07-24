/**
 * Normalized broker error.
 *
 * Every failure that crosses an adapter boundary — HTTP 500 from Dhan, a
 * socket timeout, a margin shortfall, a rate-limit rejection — is converted
 * into ONE of the codes below before it leaves `brokers/`. Callers (services,
 * controllers, the frontend) branch on `code`, never on a broker's own error
 * string, so adding a broker never changes error-handling code.
 *
 * Wire format (what the frontend sees):
 *   {
 *     success: false,
 *     broker: 'DHAN',
 *     code: 'MARGIN_ERROR',
 *     message: 'Insufficient margin for this order',
 *     retryable: false
 *   }
 */

const ERROR_CODE = {
  // ── Auth / connection ──
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  NOT_CONNECTED: 'NOT_CONNECTED',
  BROKER_UNAUTHORIZED: 'BROKER_UNAUTHORIZED', // authenticated but not permitted (segment/KYC)

  // ── Availability ──
  BROKER_OFFLINE: 'BROKER_OFFLINE',
  EXCHANGE_CLOSED: 'EXCHANGE_CLOSED',
  MARKET_CLOSED: 'MARKET_CLOSED',

  // ── Order rejections ──
  MARGIN_ERROR: 'MARGIN_ERROR',
  QUANTITY_ERROR: 'QUANTITY_ERROR',
  PRICE_ERROR: 'PRICE_ERROR',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  BROKER_REJECTED: 'BROKER_REJECTED',

  // ── Transport ──
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  NETWORK_FAILURE: 'NETWORK_FAILURE',

  // ── Ours ──
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SYMBOL_NOT_FOUND: 'SYMBOL_NOT_FOUND',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  UNKNOWN_BROKER: 'UNKNOWN_BROKER',
  BROKER_REQUIRED: 'BROKER_REQUIRED',
  QUEUE_OVERFLOW: 'QUEUE_OVERFLOW',
  ENCRYPTION_ERROR: 'ENCRYPTION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

// HTTP status the API layer returns for each code. Keeps controllers free of
// status-code decisions.
const HTTP_STATUS = {
  [ERROR_CODE.INVALID_TOKEN]: 401,
  [ERROR_CODE.TOKEN_EXPIRED]: 401,
  [ERROR_CODE.NOT_CONNECTED]: 428,          // Precondition Required — connect a broker first
  [ERROR_CODE.BROKER_UNAUTHORIZED]: 403,
  [ERROR_CODE.BROKER_OFFLINE]: 502,
  [ERROR_CODE.EXCHANGE_CLOSED]: 409,
  [ERROR_CODE.MARKET_CLOSED]: 409,
  [ERROR_CODE.MARGIN_ERROR]: 402,
  [ERROR_CODE.QUANTITY_ERROR]: 400,
  [ERROR_CODE.PRICE_ERROR]: 400,
  [ERROR_CODE.ORDER_NOT_FOUND]: 404,
  [ERROR_CODE.DUPLICATE_ORDER]: 409,
  [ERROR_CODE.BROKER_REJECTED]: 422,
  [ERROR_CODE.RATE_LIMIT]: 429,
  [ERROR_CODE.TIMEOUT]: 504,
  [ERROR_CODE.NETWORK_FAILURE]: 502,
  [ERROR_CODE.VALIDATION_ERROR]: 400,
  [ERROR_CODE.SYMBOL_NOT_FOUND]: 404,
  [ERROR_CODE.UNSUPPORTED_OPERATION]: 501,
  [ERROR_CODE.UNKNOWN_BROKER]: 400,
  [ERROR_CODE.BROKER_REQUIRED]: 400,
  [ERROR_CODE.QUEUE_OVERFLOW]: 503,
  [ERROR_CODE.ENCRYPTION_ERROR]: 500,
  [ERROR_CODE.INTERNAL_ERROR]: 500,
};

// Codes worth retrying automatically inside the OrderQueue. Everything else
// is a deterministic rejection — retrying just burns rate-limit budget.
//
// NOTE: retrying a PLACE order is only safe because every request carries a
// clientOrderId that the broker echoes back (correlationId on Dhan), so a
// retry after a timeout can be de-duplicated. See OrderQueue.
const RETRYABLE = new Set([
  ERROR_CODE.RATE_LIMIT,
  ERROR_CODE.TIMEOUT,
  ERROR_CODE.NETWORK_FAILURE,
  ERROR_CODE.BROKER_OFFLINE,
]);

// User-facing default text. Adapters usually pass the broker's own message
// through (it's more specific), but never a raw stack/payload.
const DEFAULT_MESSAGE = {
  [ERROR_CODE.INVALID_TOKEN]: 'Your broker access token is invalid. Reconnect your broker account.',
  [ERROR_CODE.TOKEN_EXPIRED]: 'Your broker access token has expired. Generate a new one and reconnect.',
  [ERROR_CODE.NOT_CONNECTED]: 'No active broker connection. Connect a broker account first.',
  [ERROR_CODE.BROKER_UNAUTHORIZED]: 'Your broker account is not permitted to perform this action.',
  [ERROR_CODE.BROKER_OFFLINE]: 'The broker service is temporarily unavailable. Try again shortly.',
  [ERROR_CODE.EXCHANGE_CLOSED]: 'The exchange is closed for this segment.',
  [ERROR_CODE.MARKET_CLOSED]: 'The market is closed right now.',
  [ERROR_CODE.MARGIN_ERROR]: 'Insufficient margin for this order.',
  [ERROR_CODE.QUANTITY_ERROR]: 'Invalid order quantity for this instrument.',
  [ERROR_CODE.PRICE_ERROR]: 'Invalid price for this instrument.',
  [ERROR_CODE.ORDER_NOT_FOUND]: 'Order not found.',
  [ERROR_CODE.DUPLICATE_ORDER]: 'This order has already been submitted.',
  [ERROR_CODE.BROKER_REJECTED]: 'The broker rejected this order.',
  [ERROR_CODE.RATE_LIMIT]: 'Too many requests to the broker. Please slow down.',
  [ERROR_CODE.TIMEOUT]: 'The broker did not respond in time.',
  [ERROR_CODE.NETWORK_FAILURE]: 'Could not reach the broker.',
  [ERROR_CODE.VALIDATION_ERROR]: 'Invalid request.',
  [ERROR_CODE.SYMBOL_NOT_FOUND]: 'Symbol is not tradable through this broker.',
  [ERROR_CODE.UNSUPPORTED_OPERATION]: 'This broker does not support that operation.',
  [ERROR_CODE.UNKNOWN_BROKER]: 'Unknown broker.',
  [ERROR_CODE.BROKER_REQUIRED]: 'Specify which broker to use.',
  [ERROR_CODE.QUEUE_OVERFLOW]: 'The broker request queue is saturated. Try again shortly.',
  [ERROR_CODE.ENCRYPTION_ERROR]: 'Credential storage is misconfigured. Contact support.',
  [ERROR_CODE.INTERNAL_ERROR]: 'Something went wrong while talking to the broker.',
};

class BrokerError extends Error {
  /**
   * @param {string} code    one of ERROR_CODE
   * @param {string} [message] user-safe message (never include tokens/PII)
   * @param {object} [opts]
   * @param {string} [opts.broker]     broker code the failure came from
   * @param {number} [opts.statusCode] override HTTP status
   * @param {boolean} [opts.retryable] override retryability
   * @param {object} [opts.details]    structured, user-safe extras
   * @param {Error}  [opts.cause]      original error (server-side logs only)
   */
  constructor(code, message, opts = {}) {
    const finalCode = ERROR_CODE[code] ? code : ERROR_CODE.INTERNAL_ERROR;
    super(message || DEFAULT_MESSAGE[finalCode] || 'Broker error');
    this.name = 'BrokerError';
    this.code = finalCode;
    this.broker = opts.broker || null;
    this.statusCode = opts.statusCode || HTTP_STATUS[finalCode] || 500;
    this.retryable = opts.retryable != null ? !!opts.retryable : RETRYABLE.has(finalCode);
    this.details = opts.details || null;
    this.cause = opts.cause || null;
    // Marks this as a deliberate, user-safe failure so the global express
    // error handler prints `message` instead of "Internal server error".
    this.isOperational = true;
    this.isBrokerError = true;
    if (Error.captureStackTrace) Error.captureStackTrace(this, BrokerError);
  }

  /** Shape returned to the frontend. Contains no broker-native payload. */
  toResponse() {
    return {
      success: false,
      broker: this.broker,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }

  /**
   * Coerce anything thrown into a BrokerError. Native fetch/undici failures
   * are classified by their `name`/`code` so transport problems become
   * TIMEOUT / NETWORK_FAILURE rather than a generic 500.
   */
  static from(err, broker = null) {
    if (err instanceof BrokerError) {
      if (!err.broker && broker) err.broker = broker;
      return err;
    }
    if (err && err.isBrokerError) return err; // cross-realm instance

    const name = (err && err.name) || '';
    const sysCode = (err && err.code) || '';
    const msg = (err && err.message) || '';

    if (name === 'AbortError' || name === 'TimeoutError' || sysCode === 'ETIMEDOUT' || /timed?\s?out/i.test(msg)) {
      return new BrokerError(ERROR_CODE.TIMEOUT, null, { broker, cause: err });
    }
    if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(sysCode)
      || name === 'FetchError' || /fetch failed|socket hang up|network/i.test(msg)) {
      return new BrokerError(ERROR_CODE.NETWORK_FAILURE, null, { broker, cause: err });
    }
    // Mongo duplicate key on clientOrderId → idempotency collision.
    if (err && err.code === 11000) {
      return new BrokerError(ERROR_CODE.DUPLICATE_ORDER, null, { broker, cause: err });
    }
    return new BrokerError(ERROR_CODE.INTERNAL_ERROR, null, { broker, cause: err });
  }

  /** Convenience factories for the codes adapters raise most. */
  static unsupported(operation, broker) {
    return new BrokerError(
      ERROR_CODE.UNSUPPORTED_OPERATION,
      `${broker || 'This broker'} does not support "${operation}".`,
      { broker, details: { operation } }
    );
  }

  static notConnected(broker) {
    return new BrokerError(ERROR_CODE.NOT_CONNECTED, null, { broker });
  }

  static validation(message, details, broker) {
    return new BrokerError(ERROR_CODE.VALIDATION_ERROR, message, { broker, details });
  }
}

module.exports = {
  BrokerError,
  ERROR_CODE,
  HTTP_STATUS,
  RETRYABLE,
  DEFAULT_MESSAGE,
  isRetryableCode: (code) => RETRYABLE.has(code),
};
