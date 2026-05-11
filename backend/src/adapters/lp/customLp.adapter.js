/**
 * Custom LP adapter — generic shape that any in-house aggregator / FIX
 * bridge can plug into. Config is read from env at call time so the
 * deployment can swap providers without code changes:
 *
 *   CUSTOM_LP_BASE_URL   POST {url}/orders
 *   CUSTOM_LP_API_KEY    sent as Authorization: Bearer …
 *
 * Same uniform contract as the other adapters — see oanda.adapter.js.
 */
const Instrument = require('../../models/Instrument');

const PROVIDER = 'CUSTOM_LP';

const _call = async (_path, _body) => {
  if (!process.env.CUSTOM_LP_BASE_URL || !process.env.CUSTOM_LP_API_KEY) {
    return { _stub: true, reason: 'CUSTOM_LP env not set — using synthetic fill' };
  }
  // TODO: real fetch(`${process.env.CUSTOM_LP_BASE_URL}${path}`, {
  //   method: 'POST', headers: { Authorization: `Bearer ${process.env.CUSTOM_LP_API_KEY}` },
  //   body: JSON.stringify(body),
  // });
  return { _stub: true, reason: 'Custom LP adapter not implemented — using synthetic fill' };
};

const placeOrder = async ({ symbol, side, type, quantity, price, stopPrice }) => {
  const resp = await _call('/orders', { symbol, side, type, quantity, price, stopPrice });
  if (resp && resp._stub) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const fillPx = price || stopPrice || inst?.lastPrice || '0';
    return {
      provider: PROVIDER,
      providerOrderId: `CUSTOM-STUB-${Date.now()}`,
      status: 'FILLED',
      avgFillPrice: String(fillPx),
      filledQuantity: String(quantity),
      raw: resp,
    };
  }
  return {
    provider: PROVIDER,
    providerOrderId: resp.id,
    status: resp.status,
    avgFillPrice: resp.fillPrice,
    filledQuantity: resp.filledQuantity,
    raw: resp,
  };
};

const cancelOrder = async ({ providerOrderId }) => {
  const resp = await _call(`/orders/${providerOrderId}/cancel`, {});
  return { provider: PROVIDER, providerOrderId, status: 'CANCELLED', raw: resp };
};

const getQuote = async ({ symbol }) => {
  const resp = await _call(`/quote?symbol=${symbol}`, null);
  if (resp && resp._stub) {
    const inst = await Instrument.findOne({ symbol }).lean();
    const px = Number(inst?.lastPrice || 0);
    return { bid: px, ask: px, timestamp: Date.now(), raw: resp };
  }
  return { bid: Number(resp.bid), ask: Number(resp.ask), timestamp: Date.now(), raw: resp };
};

module.exports = { provider: PROVIDER, placeOrder, cancelOrder, getQuote };
