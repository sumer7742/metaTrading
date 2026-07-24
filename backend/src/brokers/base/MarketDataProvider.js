/**
 * MarketDataProvider — market data is decoupled from execution.
 *
 * Why this exists as its own interface rather than "just use the broker":
 * a user may execute through Dhan while the platform sources prices from
 * TrueData, GlobalDataFeeds, Polygon or Finnhub. Charts must not care.
 *
 * Consequences enforced by this design:
 *   - The TradingView Lightweight Charts pipeline (candleService / feed
 *     services / ws `ticker:` + `candles:` channels) is UNTOUCHED by the
 *     broker module. Broker data can feed it later by registering a provider,
 *     but the chart contract never changes.
 *   - Swapping providers is a registry change, not a frontend change.
 *
 * Implementations live next to their source: `brokers/dhan/marketdata/…` for
 * the Dhan feed, `services/marketdata/…` for non-broker vendors.
 */

const { BrokerError } = require('./BrokerError');

class MarketDataProvider {
  /**
   * @param {object} ctx
   * @param {string} ctx.name  provider code, e.g. 'DHAN', 'TRUEDATA', 'POLYGON'
   */
  constructor(ctx = {}) {
    if (new.target === MarketDataProvider) throw new Error('MarketDataProvider is abstract — subclass it.');
    this.name = ctx.name;
    this.config = ctx.config || {};
    this.logger = ctx.logger || require('../../utils/logger');
  }

  /** What this provider can serve. */
  capabilities() {
    return { quotes: false, ohlc: false, historical: false, stream: false, marketStatus: false };
  }

  supports(capability) { return !!this.capabilities()[capability]; }

  /**
   * @param {Array<{symbol, exchange, securityId?}>} instruments
   * @returns {Promise<Array<object>>} normalize.quote(...)[]
   */
  async quotes(instruments) { throw BrokerError.unsupported('quotes', this.name); }

  /**
   * @param {object} req { symbol, exchange, securityId?, interval, from, to }
   *   interval: '1'|'5'|'15'|'25'|'60'|'D'
   * @returns {Promise<Array<object>>} normalize.candle(...)[]
   */
  async historical(req) { throw BrokerError.unsupported('historical', this.name); }

  /**
   * @param {string} [exchange]
   * @returns {Promise<Array<object>>} normalize.marketStatus(...)[]
   */
  async marketStatus(exchange) { throw BrokerError.unsupported('marketStatus', this.name); }

  /**
   * Live tick stream. Optional — polling providers simply don't declare it.
   * @param {Array} instruments
   * @param {(tick: object) => void} handler
   * @returns {Promise<{stop: () => Promise<void>}>}
   */
  async subscribe(instruments, handler) { throw BrokerError.unsupported('stream', this.name); }

  async health() { return { provider: this.name, ok: true }; }
}

module.exports = MarketDataProvider;
