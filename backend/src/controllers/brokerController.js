/**
 * Broker connection, portfolio and market-data endpoints.
 *
 * Every response here is broker-agnostic. The frontend renders the same
 * screens for Dhan, Upstox or FYERS; the broker catalogue (`GET /brokers`)
 * tells it which actions to show and which credential fields to collect.
 */

const connectionService = require('../services/broker/brokerConnection.service');
const portfolioService = require('../services/broker/brokerPortfolio.service');
const syncService = require('../services/broker/brokerSync.service');
const brokerModule = require('../brokers');
const manager = require('../brokers/BrokerManager');
const registry = require('../brokers/registry');
const schemas = require('../brokers/validation/schemas');
const { BrokerError, ERROR_CODE } = require('../brokers/base/BrokerError');
const { AUTH_MODE } = require('../brokers/constants');
const { asyncHandler, sendSuccess } = require('../utils/errors');

// ─── Catalogue ───────────────────────────────────────────────────────
/**
 * GET /api/broker/brokers
 * What this platform supports + the credential fields each broker needs.
 * Driven entirely by the registry, so a new broker appears here with no
 * frontend change.
 */
const listBrokers = asyncHandler(async (req, res) => {
  sendSuccess(res, { brokers: registry.list() });
});

// ─── Connections ─────────────────────────────────────────────────────
/** GET /api/broker/connections */
const listConnections = asyncHandler(async (req, res) => {
  sendSuccess(res, { connections: await connectionService.list(req.brokerCtx.userId) });
});

/**
 * POST /api/broker/connections
 * Body: { broker, authMode?, label?, credentials: { clientId, accessToken } }
 *
 * The token is validated with the broker and encrypted before storage. It is
 * never returned, never logged, and never leaves the backend.
 */
const connect = asyncHandler(async (req, res) => {
  const { broker, authMode, label, credentials } = req.body;
  const connection = await connectionService.connect({
    userId: req.brokerCtx.userId,
    broker,
    authMode,
    label,
    credentials,
    ip: req.brokerCtx.ip,
    userAgent: req.brokerCtx.userAgent,
    requestId: req.brokerCtx.requestId,
  });

  // Open the live order stream immediately (best effort — a socket failure
  // must not fail the connect; the polling reconciler covers it).
  manager.startStream({ userId: req.brokerCtx.userId, broker: connection.broker, connection })
    .catch(() => { /* logged inside the manager */ });

  sendSuccess(res, { connection }, 201);
});

/** DELETE /api/broker/connections/:broker */
const disconnect = asyncHandler(async (req, res) => {
  const result = await connectionService.disconnect({
    userId: req.brokerCtx.userId,
    broker: req.params.broker,
    requestId: req.brokerCtx.requestId,
  });
  sendSuccess(res, result);
});

/** POST /api/broker/connections/:broker/verify — re-check a stored token now. */
const verify = asyncHandler(async (req, res) => {
  sendSuccess(res, await connectionService.verify({
    userId: req.brokerCtx.userId,
    broker: req.params.broker,
    requestId: req.brokerCtx.requestId,
  }));
});

/** PATCH /api/broker/connections/:broker/default */
const setDefault = asyncHandler(async (req, res) => {
  sendSuccess(res, {
    connection: await connectionService.setDefault({ userId: req.brokerCtx.userId, broker: req.params.broker }),
  });
});

/** POST /api/broker/connections/:broker/stream — start/restart the order stream. */
const startStream = asyncHandler(async (req, res) => {
  const broker = String(req.params.broker).toUpperCase();
  const connection = await connectionService.resolveForRequest(req.brokerCtx.userId, broker);
  sendSuccess(res, await manager.startStream({ userId: req.brokerCtx.userId, broker, connection }));
});

/** DELETE /api/broker/connections/:broker/stream */
const stopStream = asyncHandler(async (req, res) => {
  sendSuccess(res, await manager.stopStream(req.brokerCtx.userId, req.params.broker));
});

// ─── OAuth (MODE 2 plug point) ───────────────────────────────────────
/**
 * GET /api/broker/oauth/:broker/authorize
 *
 * Returns 501 until a broker registers an OAuth provider. The frontend can
 * call this today; the day a partner integration lands it starts returning a
 * URL and the SAME UI works — no frontend release needed.
 */
const oauthAuthorize = asyncHandler(async (req, res) => {
  const broker = String(req.params.broker).toUpperCase();
  const provider = registry.createAuthProvider(broker, AUTH_MODE.OAUTH);
  const redirectUri = process.env.BROKER_OAUTH_REDIRECT_URI
    || `${req.protocol}://${req.get('host')}/api/broker/oauth/${broker}/callback`;
  const result = await provider.getAuthorizationUrl({ userId: req.brokerCtx.userId, redirectUri });
  sendSuccess(res, result);
});

/** GET /api/broker/oauth/:broker/callback */
const oauthCallback = asyncHandler(async (req, res) => {
  const broker = String(req.params.broker).toUpperCase();
  const provider = registry.createAuthProvider(broker, AUTH_MODE.OAUTH);
  const redirectUri = process.env.BROKER_OAUTH_REDIRECT_URI
    || `${req.protocol}://${req.get('host')}/api/broker/oauth/${broker}/callback`;

  const tokens = await provider.handleCallback({
    code: req.query.code, state: req.query.state, redirectUri, userId: req.brokerCtx.userId,
  });

  const connection = await connectionService.connect({
    userId: req.brokerCtx.userId,
    broker,
    authMode: AUTH_MODE.OAUTH,
    credentials: tokens,
    ip: req.brokerCtx.ip,
    userAgent: req.brokerCtx.userAgent,
    requestId: req.brokerCtx.requestId,
  });
  sendSuccess(res, { connection });
});

// ─── Portfolio (CQRS query side) ─────────────────────────────────────
const positions = asyncHandler(async (req, res) => {
  const { broker, force, includeClosed } = req.query;
  sendSuccess(res, await portfolioService.positions({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, force, includeClosed,
  }));
});

const holdings = asyncHandler(async (req, res) => {
  const { broker, force } = req.query;
  sendSuccess(res, await portfolioService.holdings({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, force,
  }));
});

const funds = asyncHandler(async (req, res) => {
  const { broker, force } = req.query;
  sendSuccess(res, await portfolioService.funds({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, force,
  }));
});

/** GET /api/broker/portfolio/summary — funds + positions + holdings + totals. */
const summary = asyncHandler(async (req, res) => {
  const { broker, force } = req.query;
  sendSuccess(res, await portfolioService.summary({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, force,
  }));
});

/** POST /api/broker/portfolio/sync — force a reconciliation against the broker. */
const sync = asyncHandler(async (req, res) => {
  const connection = await connectionService.resolveForRequest(req.brokerCtx.userId, req.body && req.body.broker);
  sendSuccess(res, await syncService.reconcileUser({
    userId: req.brokerCtx.userId, broker: connection.broker, reason: 'manual',
  }));
});

// ─── Market data ─────────────────────────────────────────────────────
/** GET /api/broker/market/quotes?symbols=RELIANCE:NSE,TCS:NSE */
const quotes = asyncHandler(async (req, res) => {
  const { broker, symbols, exchange, mode } = req.query;
  const instruments = schemas.parseSymbolList(symbols, exchange);
  if (!instruments.length) {
    throw new BrokerError(ERROR_CODE.VALIDATION_ERROR, 'Provide at least one symbol.');
  }
  sendSuccess(res, await portfolioService.quotes({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, instruments, mode,
  }));
});

/** GET /api/broker/market/status */
const marketStatus = asyncHandler(async (req, res) => {
  const { broker, exchange, force } = req.query;
  sendSuccess(res, await portfolioService.marketStatus({
    userId: req.brokerCtx.userId, broker, requestId: req.brokerCtx.requestId, exchange, force,
  }));
});

// ─── Health (admin) ──────────────────────────────────────────────────
/**
 * GET /api/broker/health
 * Queues, rate limiters, adapter pool, sockets, cache, encryption status.
 * Contains no user data and no credentials.
 */
const health = asyncHandler(async (req, res) => {
  sendSuccess(res, brokerModule.health());
});

module.exports = {
  listBrokers,
  listConnections,
  connect,
  disconnect,
  verify,
  setDefault,
  startStream,
  stopStream,
  oauthAuthorize,
  oauthCallback,
  positions,
  holdings,
  funds,
  summary,
  sync,
  quotes,
  marketStatus,
  health,
};
