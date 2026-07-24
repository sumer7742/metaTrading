/**
 * Dhan positions (intraday + carry-forward net positions).
 */

const config = require('../config');
const mappers = require('../mappers');

class DhanPositionService {
  constructor({ http }) { this.http = http; }

  /**
   * @param {object} [opts] { includeClosed = false }
   * @returns {Promise<Array<object>>} normalize.position[]
   */
  async list({ includeClosed = false } = {}) {
    const data = await this.http.request(config.ENDPOINTS.POSITIONS, {
      category: 'nonTrading', operation: 'positions',
    });
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    return rows
      .map(mappers.toPosition)
      .filter(Boolean)
      // A squared-off position stays in Dhan's response with netQty 0. It is
      // noise on a positions screen, but it carries the day's realized P&L —
      // so it's filtered by default and available on request.
      .filter((p) => (includeClosed ? true : p.qty !== 0));
  }
}

module.exports = DhanPositionService;
