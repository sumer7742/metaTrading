/**
 * Dhan broker descriptor — everything the registry needs to know.
 *
 * This file IS the contract for adding a broker. To add Upstox tomorrow:
 * create `brokers/upstox/` with the same shape and add one `register()` line
 * in `brokers/index.js`. No route, controller, service, model or frontend
 * change.
 */

const DhanAdapter = require('./DhanAdapter');
const DhanManualTokenAuthProvider = require('./auth/DhanManualTokenAuthProvider');
const DhanOAuthAuthProvider = require('./auth/DhanOAuthAuthProvider');
const config = require('./config');
const { BROKER, AUTH_MODE, CAPABILITY } = require('../constants');

// Whether the OAuth provider is offered at all. Registering it while
// unconfigured would advertise a mode that immediately 501s, so it's opt-in.
const _oauthEnabled = !!(process.env.DHAN_OAUTH_CLIENT_ID && process.env.DHAN_OAUTH_CLIENT_SECRET);

module.exports = {
  code: BROKER.DHAN,
  name: 'Dhan',
  website: 'https://dhan.co',
  description: 'Trade NSE, BSE, NFO, BFO and MCX through your own Dhan account.',

  createAdapter: (ctx) => new DhanAdapter(ctx),

  authProviders: {
    [AUTH_MODE.MANUAL]: (ctx) => new DhanManualTokenAuthProvider(ctx),
    ...(_oauthEnabled ? { [AUTH_MODE.OAUTH]: (ctx) => new DhanOAuthAuthProvider(ctx) } : {}),
  },

  // Advertised to the frontend so the UI can hide unsupported actions.
  capabilities: {
    [CAPABILITY.PLACE_ORDER]: true,
    [CAPABILITY.MODIFY_ORDER]: true,
    [CAPABILITY.CANCEL_ORDER]: true,
    [CAPABILITY.POSITIONS]: true,
    [CAPABILITY.HOLDINGS]: true,
    [CAPABILITY.FUNDS]: true,
    [CAPABILITY.ORDERS]: true,
    [CAPABILITY.HISTORY]: true,
    [CAPABILITY.QUOTES]: true,
    [CAPABILITY.MARKET_STATUS]: true,
    [CAPABILITY.ORDER_STREAM]: true,
    [CAPABILITY.TICK_STREAM]: false,
    [CAPABILITY.OAUTH]: _oauthEnabled,
  },

  rateLimits: config.RATE_LIMITS,

  createMarketDataProvider: (ctx) => {
    const DhanMarketDataProvider = require('./marketdata/DhanMarketDataProvider');
    const DhanHttpClient = require('./DhanHttpClient');
    const DhanHistoryService = require('./history/DhanHistoryService');
    const http = new DhanHttpClient(ctx);
    return new DhanMarketDataProvider({ http, history: new DhanHistoryService({ http }) });
  },

  config: {
    supportedExchanges: ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'],
    supportedProducts: ['INTRADAY', 'DELIVERY', 'MARGIN', 'MTF', 'CO', 'BO'],
    tokenValidityNote: 'Dhan access tokens are generated in the DhanHQ dashboard and are valid for up to 30 days.',
  },
};
