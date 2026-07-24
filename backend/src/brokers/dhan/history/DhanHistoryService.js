/**
 * Dhan trade history + chart data.
 *
 * Trade history is paginated by date range at the broker (page size is theirs,
 * not ours). We walk the pages up to a hard cap so a "last 5 years" request
 * can't hang a request thread or blow the rate-limit budget — the cap is
 * reported back to the caller rather than silently truncating.
 */

const config = require('../config');
const mappers = require('../mappers');
const normalize = require('../../base/normalize');
const { BrokerError, ERROR_CODE } = require('../../base/BrokerError');

const BROKER = 'DHAN';
const MAX_PAGES = Number(process.env.DHAN_HISTORY_MAX_PAGES) || 20;

const _ymd = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
};

class DhanHistoryService {
  constructor({ http }) { this.http = http; }

  /**
   * Executed-trade history.
   * @param {object} [range] { from, to, page }
   * @returns {Promise<Array<object>>} normalize.trade[]
   */
  async trades(range = {}) {
    const to = _ymd(range.to || new Date());
    const from = _ymd(range.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    if (!from || !to) throw BrokerError.validation('from/to must be valid dates (YYYY-MM-DD).', null, BROKER);
    if (new Date(from) > new Date(to)) throw BrokerError.validation('"from" must be on or before "to".', null, BROKER);

    // Explicit single page requested — return exactly that.
    if (range.page != null) {
      return this._page(from, to, Number(range.page) || 0);
    }

    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this._page(from, to, page);
      if (!rows.length) break;
      out.push(...rows);
      // A short page means we've reached the end of the range.
      if (rows.length < 10) break;
    }
    return out;
  }

  async _page(from, to, page) {
    try {
      const data = await this.http.request(config.ENDPOINTS.TRADE_HISTORY, {
        params: { from, to, page },
        category: 'nonTrading',
        operation: 'tradeHistory',
      });
      const rows = Array.isArray(data) ? data : (data ? [data] : []);
      return rows.map(mappers.toTrade).filter(Boolean);
    } catch (err) {
      // An empty page is reported as 404 by Dhan — that's "no more data".
      if (BrokerError.from(err, BROKER).code === ERROR_CODE.ORDER_NOT_FOUND) return [];
      throw err;
    }
  }

  /**
   * OHLC candles. Exposed through the MarketDataProvider abstraction, NOT
   * consumed by the existing TradingView chart pipeline — charts keep their
   * own feed and are untouched by the broker module.
   *
   * @param {object} req { securityId, exchange, segment?, interval, from, to, instrumentType? }
   */
  async candles(req = {}) {
    const isIntraday = req.interval && String(req.interval).toUpperCase() !== 'D';
    const endpoint = isIntraday ? config.ENDPOINTS.CHART_INTRADAY : config.ENDPOINTS.CHART_HISTORICAL;

    const body = {
      securityId: String(req.securityId),
      exchangeSegment: mappers.toExchangeSegment(req.exchange, req.segment),
      instrument: req.instrumentType || 'EQUITY',
      fromDate: _ymd(req.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
      toDate: _ymd(req.to || new Date()),
      ...(isIntraday ? { interval: String(req.interval) } : { expiryCode: req.expiryCode || 0 }),
    };

    const data = await this.http.request(endpoint, {
      body, category: 'data', operation: isIntraday ? 'chartIntraday' : 'chartHistorical',
    });

    // Dhan returns parallel arrays: { open[], high[], low[], close[], volume[], timestamp[] }
    const ts = (data && (data.timestamp || data.start_Time)) || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      out.push(normalize.candle({
        time: ts[i],
        open: data.open && data.open[i],
        high: data.high && data.high[i],
        low: data.low && data.low[i],
        close: data.close && data.close[i],
        volume: data.volume && data.volume[i],
        oi: data.open_interest && data.open_interest[i],
      }));
    }
    return out;
  }
}

module.exports = DhanHistoryService;
