/**
 * OANDA REST v20 LP adapter.
 *
 * Contract (every adapter implements the same shape):
 *
 *   placeOrder({ accountRef, symbol, side, type, quantity, price, stopPrice })
 *       → { providerOrderId, status, avgFillPrice, filledQuantity, raw }
 *
 *   cancelOrder({ accountRef, providerOrderId })
 *       → { providerOrderId, status, raw }
 *
 *   getQuote({ symbol })
 *       → { bid, ask, timestamp, raw }
 *
 * Configuration (env):
 *   OANDA_API_KEY          Bearer token from OANDA's developer portal.
 *   OANDA_ACCOUNT_ID       The funded account whose flow we hedge.
 *   OANDA_BASE_URL         https://api-fxtrade.oanda.com (live)
 *                          https://api-fxpractice.oanda.com (demo)
 *                          Defaults to demo for safety.
 *   OANDA_TIMEOUT_MS       Request timeout (default 5000).
 *
 * Behavior:
 *   - If OANDA_API_KEY is set, real HTTP calls go to OANDA.
 *   - Otherwise we return a synthetic fill at the instrument's `lastPrice`
 *     so end-to-end dev flow works without credentials.
 *   - All errors thrown — caller (lpExecution.service) marks the order
 *     REJECTED and releases the margin lock.
 */
const Instrument = require('../../models/Instrument');
const logger = require('../../utils/logger');

const PROVIDER = 'OANDA';
const DEFAULT_BASE = 'https://api-fxpractice.oanda.com';
const TIMEOUT_MS = Number(process.env.OANDA_TIMEOUT_MS) || 5000;

const _credsPresent = () => !!(process.env.OANDA_API_KEY && process.env.OANDA_ACCOUNT_ID);

const _baseUrl = () => (process.env.OANDA_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');

const _http = async (method, path, body) => {
  const url = `${_baseUrl()}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${process.env.OANDA_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'RFC3339',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      const msg = json.errorMessage || json.message || text || resp.statusText;
      throw new Error(`OANDA ${resp.status}: ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
};

// OANDA quotes prices as separate bid/ask; convert our LIMIT/STOP order
// type to OANDA's MARKET / LIMIT / STOP_LOSS conventions. Quantities on
// OANDA are signed (positive=BUY, negative=SELL).
const _signedUnits = (side, qty) => (side === 'SELL' ? '-' : '') + String(qty);

const placeOrder = async ({ symbol, side, type, quantity, price, stopPrice }) => {
  if (!_credsPresent()) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const fillPx = price || stopPrice || inst?.lastPrice || '0';
    logger.warn('OANDA stub fill', { symbol, side, qty: quantity, reason: 'OANDA_API_KEY not set' });
    return {
      provider: PROVIDER,
      providerOrderId: `OANDA-STUB-${Date.now()}`,
      status: 'FILLED',
      avgFillPrice: String(fillPx),
      filledQuantity: String(quantity),
      raw: { _stub: true },
    };
  }

  // Symbol mapping: most forex instruments stored as e.g. EURUSD; OANDA
  // expects EUR_USD. Allow caller-provided externalFeedSymbol via the
  // instrument doc if present.
  const inst = await Instrument.findOne({ symbol }).lean();
  const oandaSymbol = inst?.externalFeedSymbol?.replace('OANDA:', '') ||
                      symbol.replace(/^(\w{3})(\w{3})$/, '$1_$2');

  const body = {
    order: {
      instrument: oandaSymbol,
      units: _signedUnits(side, quantity),
      timeInForce: 'FOK',
      positionFill: 'DEFAULT',
      type: type === 'LIMIT' ? 'LIMIT' : type === 'STOP' ? 'STOP' : 'MARKET',
    },
  };
  if (type === 'LIMIT' && price) body.order.price = String(price);
  if (type === 'STOP' && (stopPrice || price)) body.order.priceBound = String(stopPrice || price);

  const path = `/v3/accounts/${process.env.OANDA_ACCOUNT_ID}/orders`;
  const resp = await _http('POST', path, body);

  const fill = resp.orderFillTransaction;
  if (!fill) {
    throw new Error(`OANDA did not fill order: ${JSON.stringify(resp).slice(0, 300)}`);
  }
  return {
    provider: PROVIDER,
    providerOrderId: String(fill.id || resp.orderCreateTransaction?.id),
    status: 'FILLED',
    avgFillPrice: String(fill.price),
    filledQuantity: String(Math.abs(Number(fill.units))),
    raw: resp,
  };
};

const cancelOrder = async ({ providerOrderId }) => {
  if (!_credsPresent()) {
    return { provider: PROVIDER, providerOrderId, status: 'CANCELLED', raw: { _stub: true } };
  }
  const path = `/v3/accounts/${process.env.OANDA_ACCOUNT_ID}/orders/${providerOrderId}/cancel`;
  const resp = await _http('PUT', path, {});
  return { provider: PROVIDER, providerOrderId, status: 'CANCELLED', raw: resp };
};

const getQuote = async ({ symbol }) => {
  if (!_credsPresent()) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const px = Number(inst?.lastPrice || 0);
    return { bid: px, ask: px, timestamp: Date.now(), raw: { _stub: true } };
  }
  const inst = await Instrument.findOne({ symbol }).lean();
  const oandaSymbol = inst?.externalFeedSymbol?.replace('OANDA:', '') ||
                      symbol.replace(/^(\w{3})(\w{3})$/, '$1_$2');
  const path = `/v3/accounts/${process.env.OANDA_ACCOUNT_ID}/pricing?instruments=${oandaSymbol}`;
  const resp = await _http('GET', path);
  const price = resp.prices?.[0];
  if (!price) throw new Error('OANDA returned no pricing data');
  const bid = Number(price.bids?.[0]?.price);
  const ask = Number(price.asks?.[0]?.price);
  return { bid, ask, timestamp: Date.now(), raw: resp };
};

module.exports = { provider: PROVIDER, placeOrder, cancelOrder, getQuote };
