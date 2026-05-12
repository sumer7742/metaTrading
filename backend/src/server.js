require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { connectDB } = require('./config/db');
const { assertSecrets } = require('./utils/jwt');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const requestId = require('./middleware/requestId');
const logger = require('./utils/logger');

// Fail-fast on misconfigured JWT secrets so a bad deployment crashes at
// boot instead of returning 500s once the first user tries to log in.
assertSecrets();
const matchingEngine = require('./matching-engine/MatchingEngine');
const wsBroadcaster = require('./websocket/server');
const backgroundWorker = require('./services/backgroundWorker');
const externalFeed = require('./services/externalFeedService');
const twelveDataFeed = require('./services/twelveDataFeed');
const oandaFeed = require('./services/oandaFeed');
const finnhubFeed = require('./services/finnhubFeed');
const priceSimulator = require('./services/priceSimulator');
const feedOrchestrator = require('./services/feedOrchestrator');
const emailService = require('./services/emailService');
const smsService = require('./services/smsService');
const pushService = require('./services/pushService');
const paymentService = require('./services/paymentService');
const observability = require('./services/observability');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const walletRoutes = require('./routes/wallet');
const instrumentRoutes = require('./routes/instrument');
const tradingRoutes = require('./routes/trading');
const adminRoutes = require('./routes/admin');
const complianceRoutes = require('./routes/compliance');
const reportsRoutes = require('./routes/reports');
const subscriptionRoutes = require('./routes/subscription');

const app = express();

// Sentry must be initialized BEFORE any other middleware
observability.initSentry(app);

// Security & general middleware. Helmet adds the standard secure-default
// response headers; we also enable a strict CSP that only allows our own
// origin + the inline scripts/styles emitted by Vite. Tighten further once
// every script source is enumerable.
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production'
    ? {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'wss:', 'https:'],
          frameAncestors: ["'none'"],
        },
      }
    : false, // dev: allow Vite HMR + inline scripts without manual nonce wiring
  crossOriginEmbedderPolicy: false,
}));

// Request ID + a thin morgan replacement that emits one JSON line per
// request via our logger. The reqId is echoed into every log entry so a
// frontend bug report ("request id abc123 returned 500") maps directly
// to the matching server log line.
app.use(requestId);

// CORS — env-driven allowlist. Comma-separated list in CORS_ORIGINS, falls
// back to CLIENT_URL + ADMIN_URL + their localhost defaults. Production
// MUST set CORS_ORIGINS explicitly.
const _corsOrigins = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      process.env.CLIENT_URL || 'http://localhost:5173',
      process.env.ADMIN_URL || 'http://localhost:5174',
    ]
);
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin / curl (no Origin header).
      if (!origin) return cb(null, true);
      if (_corsOrigins.includes(origin)) return cb(null, true);
      logger.warn('CORS blocked', { origin, allowed: _corsOrigins });
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
// 15mb global limit to accommodate KYC document uploads (compliance route
// previously mounted its own 15mb parser, but Express only runs the FIRST
// matching json parser, so a 2mb global cap meant KYC uploads >2MB would
// 413 before reaching the per-route parser). Most other endpoints have
// their own size validation downstream.
app.use(express.json({ limit: '15mb' }));
app.use(morgan('dev'));

// Prometheus metrics (after parsing, before routes — so it captures all routes)
observability.initPrometheus(app);

// Rate limits
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });
const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use('/api/auth', authLimiter);
app.use('/api/trading/orders', orderLimiter);

// Liveness — cheap process-alive probe (k8s `livenessProbe`). Returns OK
// as long as Node is responsive; doesn't validate DB / dependencies.
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() })
);

// Readiness — used by k8s/load-balancers to decide whether to send traffic.
// Pings DB; if it fails we return 503 so the LB drains us until recovery.
// Cheap and frequent — keep it under ~100ms.
const mongoose = require('mongoose');
app.get('/api/ready', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ status: 'not-ready', reason: 'db-disconnected' });
    }
    await mongoose.connection.db.admin().ping();
    res.json({ status: 'ready', uptime: process.uptime() });
  } catch (e) {
    logger.warn('Readiness check failed', { err: e });
    res.status(503).json({ status: 'not-ready', reason: e.message });
  }
});

// Routes
// Razorpay webhook is unauthenticated (HMAC-signed) and lives OUTSIDE
// the wallet router so it doesn't run the JWT middleware.
if (walletRoutes.razorpayWebhookHandler) {
  app.post('/api/webhooks/razorpay', walletRoutes.razorpayWebhookHandler);
}

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/instruments', instrumentRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

// ─── Serve frontend SPAs out of backend/public ─────────────────────
// Production flow: `vite build` in client/ + admin/ produces dist/
// folders, which the Dockerfile copies into:
//   backend/public/client/  ← served at /*
//   backend/public/admin/   ← served at /admin/*
// Express falls back to the right index.html for any non-API path so
// SPA client-side routing works on deep links.
//
// We check for the actual `index.html` (not just the folder) — that way
// an empty `public/` directory in dev mode doesn't break unrelated
// routes with ENOENT. If frontend hasn't been built/copied yet, the
// block is a no-op and non-API requests hit the 404 handler.
const path = require('path');
const fs = require('fs');
const publicDir = path.join(__dirname, '..', 'public');
const clientDir = path.join(publicDir, 'client');
const adminDir = path.join(publicDir, 'admin');
const clientIndex = path.join(clientDir, 'index.html');
const adminIndex = path.join(adminDir, 'index.html');

// Admin SPA at /admin/* — mounted FIRST so it doesn't get shadowed
// by the root catch-all below.
if (fs.existsSync(adminIndex)) {
  app.use('/admin', express.static(adminDir, { maxAge: '1y', index: false }));
  app.get('/admin/*', (req, res) => {
    res.sendFile(adminIndex);
  });
  logger.info('Admin SPA mounted at /admin');
}

// Client SPA at /*
if (fs.existsSync(clientIndex)) {
  app.use(express.static(clientDir, { maxAge: '1y', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(clientIndex);
  });
  logger.info('Client SPA mounted at /');
} else {
  logger.info('No frontend build found in backend/public — running API-only');
}

// 404 + error handler (Sentry catches errors before our handler)
app.use(notFound);
app.use(observability.sentryErrorHandler());
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  emailService.initEmail();
  smsService.init();
  pushService.init();
  paymentService.init();

  // Warm the system-settings cache so the first order doesn't pay the
  // cache-miss cost on `routingMode` lookup.
  const systemSettings = require('./services/systemSettings.service');
  await systemSettings.warmCache();
  logger.info('System settings cache warmed', { settings: await systemSettings.getAllSettings() });

  const server = http.createServer(app);
  // Attach WebSocket and wire the engine's broadcaster BEFORE hydrating from
  // DB. hydrateFromDB doesn't currently broadcast, but the engine's book.add
  // path can; doing this in the right order makes it safe to refactor later
  // and avoids a null-broadcaster surprise.
  wsBroadcaster.attach(server);
  matchingEngine.setBroadcaster(wsBroadcaster);
  await matchingEngine.hydrateFromDB();

  backgroundWorker.setBroadcaster(wsBroadcaster);
  backgroundWorker.start(5000);
  externalFeed.setBroadcaster(wsBroadcaster);
  externalFeed.start().catch((e) => console.error('[ExternalFeed] failed:', e.message));
  twelveDataFeed.setBroadcaster(wsBroadcaster);
  twelveDataFeed.start();
  oandaFeed.setBroadcaster(wsBroadcaster);
  oandaFeed.start();
  finnhubFeed.setBroadcaster(wsBroadcaster);
  finnhubFeed.start();
  priceSimulator.setBroadcaster(wsBroadcaster);
  priceSimulator.start().catch((e) => console.error('[PriceSim] failed:', e.message));
  feedOrchestrator.start();

  server.listen(PORT, () => {
    logger.info('Server listening', { port: PORT, ws: `ws://localhost:${PORT}/ws` });
  });

  // Graceful shutdown — production orchestrators (k8s, Render, Railway)
  // send SIGTERM before SIGKILL. We have ~10s to:
  //   1. Stop accepting new HTTP connections
  //   2. Stop the background worker (no new orders created)
  //   3. Drain WS clients
  //   4. Close the DB pool
  // Beyond ~25s the orchestrator force-kills us, so we exit early if
  // shutdown completes faster.
  const _shutdown = async (signal) => {
    logger.info('Shutdown signal received', { signal });
    let exitCode = 0;
    server.close((err) => {
      if (err) { logger.error('HTTP close error', { err }); exitCode = 1; }
    });
    try { backgroundWorker.stop && backgroundWorker.stop(); } catch (e) { logger.warn('Worker stop failed', { err: e }); }
    try { wsBroadcaster.close && wsBroadcaster.close(); } catch (e) { logger.warn('WS close failed', { err: e }); }
    try { await require('mongoose').disconnect(); } catch (e) { logger.warn('DB disconnect failed', { err: e }); }
    setTimeout(() => process.exit(exitCode), 500).unref();
  };
  process.on('SIGTERM', () => _shutdown('SIGTERM'));
  process.on('SIGINT',  () => _shutdown('SIGINT'));
};

start().catch((e) => {
  logger.error('Server failed to start', { err: e });
  process.exit(1);
});
