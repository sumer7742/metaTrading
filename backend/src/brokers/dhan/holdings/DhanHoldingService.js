/**
 * Dhan holdings (demat / T1 stock).
 */

const config = require('../config');
const mappers = require('../mappers');

class DhanHoldingService {
  constructor({ http }) { this.http = http; }

  /** @returns {Promise<Array<object>>} normalize.holding[] */
  async list() {
    const data = await this.http.request(config.ENDPOINTS.HOLDINGS, {
      category: 'nonTrading', operation: 'holdings',
    });
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    return rows
      .map(mappers.toHolding)
      .filter(Boolean)
      // Fully-sold holdings linger with quantity 0 until settlement.
      .filter((h) => h.quantity > 0 || h.t1Qty > 0);
  }
}

module.exports = DhanHoldingService;
