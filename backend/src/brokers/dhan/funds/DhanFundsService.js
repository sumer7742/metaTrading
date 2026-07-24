/**
 * Dhan funds / margin limits.
 */

const config = require('../config');
const mappers = require('../mappers');

class DhanFundsService {
  constructor({ http }) { this.http = http; }

  /** @returns {Promise<object>} normalize.funds */
  async get() {
    const data = await this.http.request(config.ENDPOINTS.FUNDS, {
      category: 'nonTrading', operation: 'funds',
    });
    // Dhan returns a single object; some deployments wrap it in a 1-element array.
    return mappers.toFunds(Array.isArray(data) ? data[0] : data);
  }
}

module.exports = DhanFundsService;
