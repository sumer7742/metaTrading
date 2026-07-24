/**
 * idempotency.service.js — exactly-once order submission.
 *
 * THE PROBLEM
 *   A user taps BUY, the phone loses signal, the app retries. Or our queue
 *   retries a request that actually reached the broker but whose response was
 *   lost. Either way a naive system places two orders.
 *
 * THE MECHANISM
 *   Every order carries a clientOrderId: `PX-YYYYMMDD-XXXXXXXX`
 *     PX        platform prefix
 *     YYYYMMDD  IST date (matches the broker's trading day, which is what
 *               support and the broker's own order book are keyed by)
 *     XXXXXXXX  8 crypto-random hex chars (~4.3e9 per day; a collision loses
 *               to the unique index rather than placing a wrong order)
 *
 *   `reserve()` inserts an OrderSync row keyed by that id. The unique index on
 *   clientOrderId is the authority — not an application-level "check then
 *   insert", which races. If the insert throws E11000 the order already
 *   exists, and we replay the stored response instead of calling the broker.
 *
 *   The id is also sent to the broker (Dhan `correlationId`), so even a
 *   double-send is traceable and reconcilable at the broker's end.
 *
 * CLIENT-SUPPLIED IDS
 *   A caller may pass its own clientOrderId (or the `Idempotency-Key` header)
 *   to make its own retries safe. It is validated against the same format so a
 *   malicious client can't collide with another user's key — and every lookup
 *   is additionally scoped by userId.
 */

const crypto = require('crypto');
const OrderSync = require('../../models/OrderSync');
const { BrokerError, ERROR_CODE } = require('../../brokers/base/BrokerError');
const { ORDER_STATUS, STATUS_TIMELINE_FIELD, UPDATE_SOURCE } = require('../../brokers/constants');

const PREFIX = process.env.BROKER_ORDER_ID_PREFIX || 'PX';
const FORMAT = /^[A-Z]{2,4}-\d{8}-[0-9A-F]{8}$/;

const _istDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** IST trading date as YYYYMMDD — matches the broker's order-book day. */
function tradingDate(at = new Date()) {
  return _istDateFmt.format(at).replace(/-/g, '');
}

/** `PX-20260718-9F3A21C4` */
function generateClientOrderId(at = new Date()) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${PREFIX}-${tradingDate(at)}-${rand}`;
}

function isValidClientOrderId(id) {
  return typeof id === 'string' && FORMAT.test(id);
}

/**
 * Validate a caller-supplied id, or mint one.
 * @throws {BrokerError} VALIDATION_ERROR on a malformed client id
 */
function resolveClientOrderId(supplied) {
  if (supplied === undefined || supplied === null || supplied === '') return generateClientOrderId();
  const id = String(supplied).trim().toUpperCase();
  if (!isValidClientOrderId(id)) {
    throw BrokerError.validation(
      `clientOrderId must look like ${PREFIX}-YYYYMMDD-XXXXXXXX.`,
      { received: id.slice(0, 40) }
    );
  }
  return id;
}

/**
 * Atomically claim a clientOrderId.
 *
 * @returns {Promise<{created: boolean, doc: object}>}
 *   created=true  → this call owns the order; proceed to the broker.
 *   created=false → a previous request owns it; replay `doc`.
 */
async function reserve({ userId, broker, connectionId, clientOrderId, request, requestId }) {
  const now = new Date();
  try {
    const doc = await OrderSync.create({
      userId,
      broker,
      connectionId: connectionId || null,
      clientOrderId,
      request,
      status: ORDER_STATUS.CREATED,
      pendingQty: request.qty,
      requestId: requestId || null,
      lastUpdateSource: UPDATE_SOURCE.API,
      timeline: { [STATUS_TIMELINE_FIELD[ORDER_STATUS.CREATED]]: now },
    });
    return { created: true, doc };
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await OrderSync.findOne({ clientOrderId }).lean();
      if (!existing) throw BrokerError.from(err, broker);

      // Scope check: an id minted by another user must never resolve here.
      // Report it as a plain duplicate — enumeration must not be possible.
      if (String(existing.userId) !== String(userId)) {
        throw new BrokerError(ERROR_CODE.DUPLICATE_ORDER, 'This order reference is already in use.', { broker });
      }
      return { created: false, doc: existing };
    }
    throw err;
  }
}

/**
 * The replay answer for a duplicate submission.
 *
 * A previous attempt that FAILED before reaching the broker is retryable: the
 * user pressed retry precisely because nothing happened. Anything that DID
 * reach the broker replays its stored ack.
 */
function replayDecision(doc) {
  if (!doc) return { replay: false };
  if (doc.status === ORDER_STATUS.FAILED) return { replay: false, retryable: true };
  return {
    replay: true,
    ack: {
      success: doc.response && doc.response.success !== false,
      broker: doc.broker,
      orderId: doc.brokerOrderId || null,
      clientOrderId: doc.clientOrderId,
      status: doc.status,
      message: (doc.response && doc.response.message)
        || (doc.error && doc.error.message)
        || 'Order already submitted (idempotent replay).',
      timestamp: (doc.response && doc.response.at) || doc.updatedAt || doc.createdAt,
      duplicate: true,
    },
  };
}

/** Look up an order the caller owns. */
async function findOwned(userId, clientOrderId) {
  const doc = await OrderSync.findOne({ userId, clientOrderId });
  if (!doc) {
    throw new BrokerError(ERROR_CODE.ORDER_NOT_FOUND, `No order found for ${clientOrderId}.`);
  }
  return doc;
}

module.exports = {
  generateClientOrderId,
  isValidClientOrderId,
  resolveClientOrderId,
  tradingDate,
  reserve,
  replayDecision,
  findOwned,
  FORMAT,
};
