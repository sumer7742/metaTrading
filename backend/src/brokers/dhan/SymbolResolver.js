/**
 * SymbolResolver — platform symbol → Dhan securityId.
 *
 * Dhan (like every Indian broker) keys orders by a numeric security id rather
 * than a trading symbol. The instrument catalogue already carries that id: the
 * existing Dhan scrip-master import stores it as `Instrument.instrumentToken`
 * on rows with `externalProvider: 'DHAN'`.
 *
 * This resolver is the DHAN-SPECIFIC half of symbol resolution — turning the
 * catalogue's provider token into Dhan's `securityId` and picking the right
 * exchange segment. The broker-neutral half (lot size, freeze qty, circuits)
 * lives in `services/broker/instrumentCatalog.service.js` so that pre-trade
 * validation stays identical no matter which broker executes the order.
 *
 * Resolution order:
 *   1. Caller-supplied securityId — always wins (advanced clients, replays).
 *   2. Catalogue row imported FROM Dhan (its token IS a Dhan security id).
 *   3. Any catalogue row for that symbol/exchange carrying a token.
 *   → otherwise SYMBOL_NOT_FOUND, surfaced as "not tradable through Dhan".
 */

const catalog = require('../../services/broker/instrumentCatalog.service');
const { BrokerError, ERROR_CODE } = require('../base/BrokerError');
const { EXCHANGE } = require('../constants');

const BROKER = 'DHAN';
const PROVIDER = 'DHAN';

/**
 * @param {{symbol: string, exchange?: string, securityId?: string|number}} req
 * @returns {Promise<{securityId, symbol, exchange, segment, lotSize, tickSize,
 *                    freezeQty, upperCircuit, lowerCircuit}>}
 * @throws {BrokerError} SYMBOL_NOT_FOUND
 */
async function resolve(req = {}) {
  const symbol = String(req.symbol || '').trim().toUpperCase();
  const exchange = req.exchange ? String(req.exchange).toUpperCase() : null;
  const explicitId = req.securityId !== undefined && req.securityId !== null && String(req.securityId).trim() !== ''
    ? String(req.securityId).trim()
    : null;

  if (!symbol && !explicitId) throw BrokerError.validation('symbol is required.', null, BROKER);

  // Enrich from the catalogue whenever we have a symbol — even with an
  // explicit id, the lot size and circuits are worth carrying.
  const inst = symbol ? await catalog.lookup({ symbol, exchange, provider: PROVIDER }) : null;

  // A Dhan order needs a Dhan SECURITY_ID. Only a row imported FROM Dhan
  // (externalProvider === 'DHAN') carries one — another provider's
  // instrumentToken (Angel/Finnhub/…) is a DIFFERENT id space and must never be
  // sent to Dhan as a security id, or the order could hit the wrong instrument.
  // An explicit caller-supplied securityId always wins.
  const dhanToken = inst && inst.provider === PROVIDER ? inst.instrumentToken : null;
  const securityId = explicitId || dhanToken || null;
  if (!securityId) {
    // Distinguish "we have the symbol, just not mapped for Dhan" from "unknown
    // symbol" — the fix for the former is importing the Dhan scrip master.
    const message = inst
      ? `"${symbol}" is in the catalogue but not mapped for Dhan yet (mapped via ${inst.provider || 'another feed'}). Import it from the Dhan scrip master: node scripts/import-dhan-instruments.js`
      : `"${symbol}"${exchange ? ` on ${exchange}` : ''} is not available for trading through Dhan.`;
    throw new BrokerError(ERROR_CODE.SYMBOL_NOT_FOUND, message, {
      broker: BROKER,
      details: { symbol, exchange, mappedProvider: inst ? inst.provider : null },
    });
  }

  return {
    securityId: String(securityId),
    symbol: symbol || (inst && inst.symbol) || null,
    exchange: exchange || (inst && inst.exchange) || EXCHANGE.NSE,
    // An INDEX row maps to Dhan's IDX_I segment (see mappers.toExchangeSegment).
    segment: inst && inst.category === 'INDEX' ? 'INDEX' : (inst && inst.segment) || null,
    category: (inst && inst.category) || null,
    lotSize: inst ? inst.lotSize : null,
    tickSize: inst ? inst.tickSize : null,
    freezeQty: inst ? inst.freezeQty : null,
    upperCircuit: inst ? inst.upperCircuit : null,
    lowerCircuit: inst ? inst.lowerCircuit : null,
  };
}

/** Resolve many (quotes). Unresolvable entries are reported, never thrown. */
async function resolveMany(list = []) {
  const out = [];
  for (const item of list) {
    try {
      out.push({ ok: true, ...(await resolve(item)) });
    } catch (err) {
      out.push({
        ok: false,
        symbol: item && item.symbol,
        exchange: item && item.exchange,
        error: BrokerError.from(err, BROKER).message,
      });
    }
  }
  return out;
}

const clearCache = () => catalog.clearCache();

module.exports = { resolve, resolveMany, clearCache };
