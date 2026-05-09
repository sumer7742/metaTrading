/**
 * Observability — Sentry (errors) + Prometheus (metrics).
 *
 * Both are OPTIONAL — fall back to no-ops if not configured.
 *
 * .env vars:
 *   SENTRY_DSN=https://...@sentry.io/123
 *   SENTRY_ENVIRONMENT=production
 *   PROMETHEUS_ENABLED=true       # exposes /metrics endpoint
 *
 * To install:
 *   npm i @sentry/node prom-client
 */

let Sentry = null;
let promClient = null;
let metrics = {};

const initSentry = (app) => {
  if (!process.env.SENTRY_DSN) {
    console.log('[Observability] Sentry: not configured (set SENTRY_DSN to enable)');
    return;
  }
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      tracesSampleRate: Number(process.env.SENTRY_TRACES_RATE || 0.1),
    });
    // Express middleware
    app.use(Sentry.Handlers.requestHandler());
    app.use(Sentry.Handlers.tracingHandler());
    console.log('[Observability] Sentry initialized');
  } catch (e) {
    console.warn('[Observability] Sentry SDK not installed (npm i @sentry/node) - skipping');
  }
};

const sentryErrorHandler = () => {
  if (Sentry) return Sentry.Handlers.errorHandler();
  return (err, req, res, next) => next(err);
};

const captureException = (err, context) => {
  if (Sentry) Sentry.captureException(err, context ? { extra: context } : undefined);
};

// =========== Prometheus ===========

const initPrometheus = (app) => {
  if (process.env.PROMETHEUS_ENABLED !== 'true') {
    console.log('[Observability] Prometheus: disabled (set PROMETHEUS_ENABLED=true to enable)');
    return;
  }
  try {
    promClient = require('prom-client');
    promClient.collectDefaultMetrics();

    metrics.httpRequestsTotal = new promClient.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status'],
    });
    metrics.httpRequestDuration = new promClient.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    });
    metrics.ordersPlacedTotal = new promClient.Counter({
      name: 'orders_placed_total',
      help: 'Total orders placed',
      labelNames: ['symbol', 'side', 'type', 'routing'],
    });
    metrics.tradesExecutedTotal = new promClient.Counter({
      name: 'trades_executed_total',
      help: 'Total trades executed',
      labelNames: ['symbol', 'routing'],
    });
    metrics.openPositionsGauge = new promClient.Gauge({
      name: 'open_positions',
      help: 'Number of currently open positions',
    });
    metrics.activeUsersGauge = new promClient.Gauge({
      name: 'active_users',
      help: 'Users with at least one login in the past 24h',
    });
    metrics.bbookExposureGauge = new promClient.Gauge({
      name: 'bbook_net_exposure',
      help: 'Broker B-book net exposure per symbol',
      labelNames: ['symbol'],
    });

    // Middleware to record HTTP request metrics
    app.use((req, res, next) => {
      const end = metrics.httpRequestDuration.startTimer();
      res.on('finish', () => {
        const route = req.route?.path || req.path || 'unknown';
        const labels = { method: req.method, route, status: res.statusCode };
        metrics.httpRequestsTotal.inc(labels);
        end(labels);
      });
      next();
    });

    // /metrics endpoint
    app.get('/metrics', async (req, res) => {
      res.set('Content-Type', promClient.register.contentType);
      res.end(await promClient.register.metrics());
    });

    console.log('[Observability] Prometheus initialized at /metrics');

    // Background updater for gauges (every 30s)
    setInterval(async () => {
      try {
        const Position = require('../models/Position');
        const User = require('../models/User');
        const open = await Position.countDocuments({ status: 'OPEN' });
        metrics.openPositionsGauge.set(open);
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const active = await User.countDocuments({ lastLoginAt: { $gte: dayAgo } });
        metrics.activeUsersGauge.set(active);
      } catch (e) { /* ignore */ }
    }, 30 * 1000);
  } catch (e) {
    console.warn('[Observability] prom-client not installed (npm i prom-client) - skipping');
  }
};

// Helpers controllers can call without depending on prom-client directly
const incOrderPlaced = (symbol, side, type, routing) => {
  if (metrics.ordersPlacedTotal) metrics.ordersPlacedTotal.inc({ symbol, side, type, routing });
};
const incTradeExecuted = (symbol, routing) => {
  if (metrics.tradesExecutedTotal) metrics.tradesExecutedTotal.inc({ symbol, routing });
};
const setBookExposure = (symbol, value) => {
  if (metrics.bbookExposureGauge) metrics.bbookExposureGauge.set({ symbol }, value);
};

module.exports = {
  initSentry,
  sentryErrorHandler,
  captureException,
  initPrometheus,
  incOrderPlaced,
  incTradeExecuted,
  setBookExposure,
};
