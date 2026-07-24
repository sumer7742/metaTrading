/**
 * Dhan market data — quotes, candles and session status.
 *
 * Implements the broker-agnostic MarketDataProvider, so the same code path
 * serves TrueData / GlobalDataFeeds / Polygon later without a frontend change.
 *
 * IMPORTANT: this does NOT feed the existing TradingView Lightweight Charts
 * pipeline. Charts continue to run on `services/dhanFeed.js` +
 * `candleService` + the `ticker:` / `candles:` websocket channels, untouched.
 * This provider serves the broker terminal's own quote needs (order pad LTP,
 * position marks) and is available as a chart source in future — a decision
 * that stays on the backend.
 */

const MarketDataProvider = require('../../base/MarketDataProvider');
const config = require('../config');
const mappers = require('../mappers');
const symbolResolver = require('../SymbolResolver');
const normalize = require('../../base/normalize');
const marketHours = require('../../../services/marketHours');
const { EXCHANGE, EXCHANGE_SESSION_KEY } = require('../../constants');

const PROVIDER = 'DHAN';

class DhanMarketDataProvider extends MarketDataProvider {
  /** @param {{http: import('../DhanHttpClient'), history: import('../history/DhanHistoryService')}} ctx */
  constructor({ http, history } = {}) {
    super({ name: PROVIDER });
    this.http = http;
    this.history = history;
  }

  capabilities() {
    return { quotes: true, ohlc: true, historical: true, stream: false, marketStatus: true };
  }

  /**
   * @param {Array<{symbol, exchange, securityId?}>} instruments
   * @param {object} [opts] { mode: 'LTP' | 'OHLC' | 'FULL' }
   * @returns {Promise<Array<object>>} normalize.quote[]
   */
  async quotes(instruments = [], opts = {}) {
    if (!Array.isArray(instruments) || !instruments.length) return [];

    const mode = String(opts.mode || 'FULL').toUpperCase();
    const endpoint = mode === 'LTP' ? config.ENDPOINTS.QUOTE_LTP
      : (mode === 'OHLC' ? config.ENDPOINTS.QUOTE_OHLC : config.ENDPOINTS.QUOTE_FULL);

    const resolved = await symbolResolver.resolveMany(instruments);

    // Group by Dhan exchange segment — the feed body is keyed that way.
    const bySegment = new Map();
    const contextById = new Map();
    for (const r of resolved) {
      if (!r.ok) continue;
      const segment = mappers.toExchangeSegment(r.exchange, r.segment);
      if (!bySegment.has(segment)) bySegment.set(segment, []);
      bySegment.get(segment).push(Number(r.securityId));
      contextById.set(`${segment}:${r.securityId}`, r);
    }
    if (!bySegment.size) return [];

    const out = [];
    // Dhan caps a feed request at QUOTE_BATCH_SIZE ids.
    for (const [segment, ids] of bySegment) {
      for (let i = 0; i < ids.length; i += config.QUOTE_BATCH_SIZE) {
        const chunk = ids.slice(i, i + config.QUOTE_BATCH_SIZE);
        const data = await this.http.request(endpoint, {
          body: { [segment]: chunk },
          category: 'data',
          operation: `quotes:${mode}`,
        });
        const rows = (data && (data[segment] || (data.data && data.data[segment]))) || {};
        for (const [securityId, row] of Object.entries(rows)) {
          const ctx = contextById.get(`${segment}:${securityId}`) || {};
          out.push(mappers.toQuote(row, {
            symbol: ctx.symbol, exchange: ctx.exchange || mappers.fromExchangeSegment(segment), securityId,
          }));
        }
      }
    }
    return out;
  }

  /** @param {object} req { symbol, exchange, securityId?, interval, from, to } */
  async historical(req = {}) {
    const resolved = await symbolResolver.resolve(req);
    return this.history.candles({
      securityId: resolved.securityId,
      exchange: resolved.exchange,
      segment: resolved.segment,
      interval: req.interval || 'D',
      from: req.from,
      to: req.to,
      instrumentType: req.instrumentType,
    });
  }

  /**
   * Session status.
   *
   * Dhan has no market-status endpoint, so this is computed from the
   * platform's OWN exchange calendar (`services/marketHours.js`) — the same
   * source the forex/crypto engine already trusts. One calendar, one answer,
   * no drift between "the chart says closed" and "the broker says open".
   */
  async marketStatus(exchange) {
    const list = exchange ? [String(exchange).toUpperCase()] : [
      EXCHANGE.NSE, EXCHANGE.BSE, EXCHANGE.NFO, EXCHANGE.BFO, EXCHANGE.MCX,
    ];
    return list.map((ex) => {
      const session = marketHours.getSession(EXCHANGE_SESSION_KEY[ex] || ex);
      return normalize.marketStatus({
        exchange: ex,
        state: session.state,
        isOpen: session.isOpen,
        opensAt: session.opensAt,
        closesAt: session.closesAt,
        reason: session.reason,
        timezone: 'Asia/Kolkata',
      });
    });
  }
}

module.exports = DhanMarketDataProvider;
