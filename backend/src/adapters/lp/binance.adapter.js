/**
 * Binance Spot LP adapter — same contract as oanda.adapter.js.
 *
 * Real implementation uses HMAC-SHA256 signing on every authenticated
 * request (POST /api/v3/order, DELETE /api/v3/order). Falls back to a
 * synthetic fill if credentials aren't configured.
 *
 * Configuration (env):
 *   BINANCE_API_KEY        Public API key from binance.com
 *   BINANCE_API_SECRET     HMAC signing secret (NEVER log)
 *   BINANCE_BASE_URL       https://api.binance.com (live, default)
 *                          https://testnet.binance.vision (testnet)
 *   BINANCE_TIMEOUT_MS     Request timeout (default 5000).
 *
 * NOTE: Binance symbols are usually like BTCUSDT (without the slash).
 * We store our instruments as BTCUSD; the adapter maps BTCUSD → BTCUSDT
 * when calling. Override via `instrument.externalFeedSymbol`.
 */
const crypto = require('crypto');
const Instrument = require('../../models/Instrument');
const logger = require('../../utils/logger');

const PROVIDER = 'BINANCE';
const DEFAULT_BASE = 'https://api.binance.com';
const TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS) || 5000;

const _credsPresent = () => !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
const _baseUrl = () => (process.env.BINANCE_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');

const _sign = (qs) =>
  crypto.createHmac('sha256', process.env.BINANCE_API_SECRET).update(qs).digest('hex');

// Authenticated request: appends timestamp + signature to query string.
const _signedRequest = async (method, path, params = {}) => {
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  const signature = _sign(query);
  const url = `${_baseUrl()}${path}?${query}&signature=${signature}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY },
      signal: ctl.signal,
    });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : {};
    if (!resp.ok) {
      throw new Error(`Binance ${resp.status} ${json.code}: ${json.msg || text || resp.statusText}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
};

// Public request — no signing needed for /ticker/bookTicker etc.
const _publicRequest = async (path) => {
  const url = `${_baseUrl()}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    const text = await resp.text();
    const json = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(`Binance ${resp.status}: ${text || resp.statusText}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
};

const _binanceSymbol = async (symbol) => {
  const inst = await Instrument.findOne({ symbol }).lean();
  // Prefer the explicit mapping the admin set on the instrument.
  if (inst?.externalFeedSymbol) return inst.externalFeedSymbol;
  // Common case: BTCUSD → BTCUSDT (since Binance lists vs USDT).
  if (/^[A-Z]{3,5}USD$/.test(symbol)) return symbol.replace(/USD$/, 'USDT');
  return symbol;
};

const placeOrder = async ({ symbol, side, type, quantity, price, stopPrice }) => {
  if (!_credsPresent()) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const fillPx = price || stopPrice || inst?.lastPrice || '0';
    logger.warn('Binance stub fill', { symbol, side, qty: quantity, reason: 'BINANCE_API_KEY not set' });
    return {
      provider: PROVIDER,
      providerOrderId: `BINANCE-STUB-${Date.now()}`,
      status: 'FILLED',
      avgFillPrice: String(fillPx),
      filledQuantity: String(quantity),
      raw: { _stub: true },
    };
  }

  const sym = await _binanceSymbol(symbol);
  const params = {
    symbol: sym,
    side,
    type: type === 'LIMIT' ? 'LIMIT' : type === 'STOP' ? 'STOP_LOSS' : 'MARKET',
    quantity: String(quantity),
  };
  if (params.type === 'LIMIT') {
    params.price = String(price);
    params.timeInForce = 'GTC';
  } else if (params.type === 'STOP_LOSS') {
    params.stopPrice = String(stopPrice || price);
  }

  const resp = await _signedRequest('POST', '/api/v3/order', params);
  // Binance returns fills[] for filled orders. avg = Σ(price×qty)/qty.
  let avgFillPrice = String(resp.price || price || '0');
  if (Array.isArray(resp.fills) && resp.fills.length) {
    let notional = 0;
    let qtySum = 0;
    for (const f of resp.fills) {
      notional += Number(f.price) * Number(f.qty);
      qtySum += Number(f.qty);
    }
    avgFillPrice = qtySum > 0 ? String(notional / qtySum) : avgFillPrice;
  }
  return {
    provider: PROVIDER,
    providerOrderId: String(resp.orderId),
    status: resp.status === 'FILLED' ? 'FILLED' : resp.status,
    avgFillPrice,
    filledQuantity: String(resp.executedQty || quantity),
    raw: resp,
  };
};

const cancelOrder = async ({ providerOrderId, symbol }) => {
  if (!_credsPresent()) {
    return { provider: PROVIDER, providerOrderId, status: 'CANCELLED', raw: { _stub: true } };
  }
  const sym = await _binanceSymbol(symbol);
  const resp = await _signedRequest('DELETE', '/api/v3/order', {
    symbol: sym,
    orderId: providerOrderId,
  });
  return { provider: PROVIDER, providerOrderId, status: 'CANCELLED', raw: resp };
};

const getQuote = async ({ symbol }) => {
  if (!_credsPresent()) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const px = Number(inst?.lastPrice || 0);
    return { bid: px, ask: px, timestamp: Date.now(), raw: { _stub: true } };
  }
  const sym = await _binanceSymbol(symbol);
  const resp = await _publicRequest(`/api/v3/ticker/bookTicker?symbol=${sym}`);
  return {
    bid: Number(resp.bidPrice),
    ask: Number(resp.askPrice),
    timestamp: Date.now(),
    raw: resp,
  };
};

module.exports = { provider: PROVIDER, placeOrder, cancelOrder, getQuote };
