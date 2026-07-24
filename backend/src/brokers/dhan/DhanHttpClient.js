/**
 * DhanHttpClient — the single outbound HTTP surface for Dhan.
 *
 * Responsibilities kept HERE (so no service duplicates them):
 *   - auth headers (the only place the token is read)
 *   - per-category timeouts with hard abort
 *   - JSON parse tolerance (Dhan sometimes returns an empty body or text/html
 *     from its edge on a 5xx)
 *   - translation of every non-2xx into a normalized BrokerError
 *   - latency + audit logging with the token redacted
 *
 * Explicitly NOT here: retries and rate limiting. Those belong to the
 * OrderQueue/RateLimiter so behaviour is identical for every broker. A client
 * that retried internally would double-count against the limiter.
 */

const config = require('./config');
const dhanErrors = require('./errors');
const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const audit = require('../../services/broker/brokerAudit.service');

const BROKER = 'DHAN';

class DhanHttpClient {
  /**
   * @param {object} ctx
   * @param {{accessToken: string, brokerClientId: string}} ctx.credentials
   * @param {string} [ctx.userId] [ctx.requestId]
   */
  constructor({ credentials, userId, requestId, logger } = {}) {
    if (!credentials || !credentials.accessToken) {
      throw new BrokerError(ERROR_CODE.NOT_CONNECTED, 'Dhan access token missing.', { broker: BROKER });
    }
    // Non-enumerable: an accidental spread/stringify of the client can't leak.
    Object.defineProperty(this, '_creds', { value: credentials, enumerable: false });
    this.userId = userId || null;
    this.requestId = requestId || null;
    this.logger = logger || require('../../utils/logger');
  }

  get clientId() { return this._creds.brokerClientId || null; }

  _url(path, params) {
    let p = path;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        p = p.replace(`:${k}`, encodeURIComponent(String(v)));
      }
    }
    return `${config.BASE_URL}${p}`;
  }

  /**
   * Per DhanHQ v2: the TRADING APIs (orders, positions, holdings, funds,
   * profile, trades) authenticate with `access-token` ALONE — the client id
   * travels in the request body as `dhanClientId`. Only the DATA APIs (market
   * feed + charts) additionally require the `client-id` header.
   *
   * So we send `client-id` for the `data` category only. Sending it on trading
   * calls is off-spec (harmless historically, but this keeps requests exactly
   * as Dhan documents them).
   */
  _headers(category) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      [config.HEADERS.TOKEN]: this._creds.accessToken,
    };
    if (category === 'data' && this.clientId) {
      headers[config.HEADERS.CLIENT_ID] = String(this.clientId);
    }
    return headers;
  }

  /**
   * @param {{method: string, path: string}} endpoint from config.ENDPOINTS
   * @param {object} [opts] { params, query, body, category, operation, clientOrderId, timeoutMs }
   * @returns {Promise<any>} parsed JSON body
   * @throws {BrokerError}
   */
  async request(endpoint, opts = {}) {
    const { method, path } = endpoint;
    const operation = opts.operation || `${method} ${path}`;
    const category = opts.category || 'default';
    const timeoutMs = opts.timeoutMs || config.TIMEOUTS[category] || config.TIMEOUTS.default;

    let url = this._url(path, opts.params);
    if (opts.query && Object.keys(opts.query).length) {
      const qs = new URLSearchParams(
        Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null)
      ).toString();
      if (qs) url += `?${qs}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let res;
    let text = '';

    try {
      res = await fetch(url, {
        method,
        headers: this._headers(category),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      clearTimeout(timer);
      const normalized = controller.signal.aborted
        ? new BrokerError(ERROR_CODE.TIMEOUT, `Dhan did not respond within ${timeoutMs}ms.`, { broker: BROKER, details: { operation } })
        : BrokerError.from(err, BROKER);
      audit.log({
        userId: this.userId, broker: BROKER, stage: audit.STAGE.BROKER, action: operation,
        level: 'error', requestId: this.requestId, clientOrderId: opts.clientOrderId || null,
        message: normalized.message, durationMs: Date.now() - startedAt, success: false,
        payload: { url: this._safeUrl(url), code: normalized.code },
      });
      throw normalized;
    }
    clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 500) }; }
    }

    audit.log({
      userId: this.userId, broker: BROKER, stage: audit.STAGE.BROKER, action: operation,
      level: res.ok ? 'info' : 'warn', requestId: this.requestId,
      clientOrderId: opts.clientOrderId || null,
      httpStatus: res.status, durationMs, success: res.ok,
      // Request bodies are logged for order forensics; the audit service
      // redacts anything credential-shaped before it touches the DB.
      payload: { url: this._safeUrl(url), request: opts.body || null, response: res.ok ? _summarize(body) : body },
    });

    if (!res.ok) {
      throw dhanErrors.fromResponse(res.status, body, { operation, path });
    }

    // Some Dhan endpoints wrap results in { status, data, remarks }; others
    // return the array/object directly. Unwrap only when the envelope is
    // unambiguous, so a genuine `data` field on a payload isn't eaten.
    if (body && typeof body === 'object' && !Array.isArray(body)
      && Object.prototype.hasOwnProperty.call(body, 'data')
      && (body.status !== undefined || body.remarks !== undefined)) {
      if (String(body.status).toLowerCase() === 'failed' || body.status === false) {
        throw dhanErrors.fromResponse(res.status, body, { operation, path });
      }
      return body.data;
    }
    return body;
  }

  /** URLs never carry the token (Dhan uses headers), but strip query auth defensively. */
  _safeUrl(url) {
    return String(url).replace(/([?&](token|access[-_]?token|api[-_]?key)=)[^&]*/gi, '$1[REDACTED]');
  }
}

/** Trim a large response down to something worth keeping in the audit log. */
function _summarize(body) {
  if (Array.isArray(body)) return { count: body.length, sample: body.slice(0, 3) };
  return body;
}

module.exports = DhanHttpClient;
