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
const financeRoutes = require('./routes/finance');
const auditRoutes = require('./routes/audit');
const complianceRoutes = require('./routes/compliance');
const partnerRoutes = require('./routes/partner');
const reportsRoutes = require('./routes/reports');
const subscriptionRoutes = require('./routes/subscription');
const subscriptionWalletRoutes = require('./routes/subscriptionWallet');
const accountPlansRoutes = require('./routes/accountPlans');
const copyTradingRoutes = require('./routes/copyTrading');
const fxRoutes = require('./routes/fx');
const watchlistRoutes = require('./routes/watchlist');
const bonusWalletRoutes = require('./routes/bonusWallet');
const hierarchyRoutes = require('./routes/hierarchy');
const chatRoutes = require('./routes/chat');
const adminOrdersRoutes = require('./routes/adminOrders');
const cmsRoutes = require('./routes/cms');
const globalAlertRoutes = require('./routes/globalAlerts');

const app = express();
app.set('trust proxy', 1);

// TEMPORARY: event loop lag monitor — logs whenever Node's event loop
// stalls beyond 200ms. Remove after diagnosis.
{
  let _last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const lag = now - _last - 500;
    if (lag > 200) console.log('[EVENTLOOP] lag_ms=', lag, 'at', new Date().toISOString());
    _last = now;
  }, 500).unref();
}
// Sentry must be initialized BEFORE any other middleware
observability.initSentry(app);

// Security & general middleware. Helmet adds the standard secure-default
// response headers; we also enable a strict CSP that only allows our own
// origin + the inline scripts/styles emitted by Vite. Tighten further once
// every script source is enumerable.
// HTTPS posture is env-driven, NOT NODE_ENV-driven. A production NODE_ENV
// box behind plain HTTP (e.g. EC2 IP without TLS yet) would break under
// HSTS + upgrade-insecure-requests: browsers refuse to load static assets
// on the only working scheme. Gate both behind HTTPS_ENABLED=true so the
// app works on bare HTTP during initial rollout, then flip when you add
// CloudFlare / ALB / nginx in front.
const _httpsEnabled = (process.env.HTTPS_ENABLED || 'false').toLowerCase() === 'true';
app.use(helmet({
  // Disable HSTS entirely when we're not actually serving HTTPS.
  hsts: _httpsEnabled,
  // CSP is tricky on HTTP: `useDefaults` auto-injects upgrade-insecure-
  // requests which forces every JS/CSS fetch to https://, then they
  // fail because the box doesn't serve TLS. Only ship CSP when HTTPS
  // is genuinely available. Otherwise rely on the rest of helmet's
  // defaults (X-Content-Type-Options, X-Frame-Options, etc).
  contentSecurityPolicy: _httpsEnabled
    ? {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Google Fonts CDN — stylesheet ref + actual woff2 fetches.
          // `'unsafe-inline'` is required because the SPAs inject some
          // CSS via JS (toast styles, chart theme); tightening this
          // needs a nonce/hash workflow we don't have yet.
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'wss:', 'https:'],
          frameAncestors: ["'none'"],
        },
      }
    : false,
  crossOriginEmbedderPolicy: false,
  // Origin-Agent-Cluster header also misbehaves on plain HTTP origins —
  // browser complains and won't keep it on subsequent requests.
  originAgentCluster: _httpsEnabled,
  // COOP needs HTTPS; turn off until TLS is live.
  crossOriginOpenerPolicy: _httpsEnabled,
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
const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.RATE_LIMIT_ORDERS_PER_MIN) || 60 });
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
console.log('[server] mounting /api/wallet · type:', typeof walletRoutes, '· has .use?', typeof walletRoutes.use === 'function');
app.use('/api/wallet', walletRoutes);
app.use('/api/instruments', instrumentRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/partner', partnerRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/subscription-wallet', subscriptionWalletRoutes);
app.use('/api/account-plans', accountPlansRoutes);
app.use('/api/copy-trading', copyTradingRoutes);
app.use('/api/fx', fxRoutes);
app.use('/api/watchlists', watchlistRoutes);
app.use('/api/bonus-wallet', bonusWalletRoutes);
// Mounted at /api/hierarchy (NOT under /api/admin) so it doesn't inherit
// the admin router's blanket requireAdmin (2FA + admin-only) gate — that
// would lock MANAGERs out of their scoped read endpoints.
app.use('/api/hierarchy', hierarchyRoutes);
app.use('/api/chat', chatRoutes);
// Mounted OUTSIDE /api/admin so MANAGERs (blocked by requireAdmin) can reach
// their scoped, view-only Orders Management endpoints. Role gating is inside.
app.use('/api/order-management', adminOrdersRoutes);
// Public CMS — footer pages + Daily News Updates. No auth (optional inside).
app.use('/api/cms', cmsRoutes);
// Global Alert Popups — user pending/ack (any authed user) + admin management.
app.use('/api/alerts', globalAlertRoutes);

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

  // ── Server-side SEO meta injection for public CMS content ──────────
  // Crawlers + social link-preview bots (WhatsApp/Twitter/FB) don't run JS,
  // so client-side <head> updates aren't enough. For /page/:slug and
  // /news/:slug we inject the real <title> + description/keywords/OG tags
  // into index.html before serving — guaranteeing correct SEO + previews.
  let _indexHtml = null;
  const indexHtml = () => (_indexHtml == null ? (_indexHtml = fs.readFileSync(clientIndex, 'utf8')) : _indexHtml);
  const escA = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const injectMeta = (html, m) => {
    const t = [];
    if (m.title) t.push(`<meta property="og:title" content="${escA(m.title)}">`, `<meta name="twitter:title" content="${escA(m.title)}">`);
    if (m.description) t.push(`<meta name="description" content="${escA(m.description)}">`, `<meta property="og:description" content="${escA(m.description)}">`, `<meta name="twitter:description" content="${escA(m.description)}">`);
    if (m.keywords) t.push(`<meta name="keywords" content="${escA(m.keywords)}">`);
    if (m.image) t.push(`<meta property="og:image" content="${escA(m.image)}">`, `<meta name="twitter:image" content="${escA(m.image)}">`);
    if (m.url) t.push(`<meta property="og:url" content="${escA(m.url)}">`);
    t.push(`<meta property="og:type" content="article">`, `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}">`);
    let out = m.title ? html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escH(m.title)}</title>`) : html;
    return out.replace('</head>', `${t.join('')}</head>`);
  };
  const serveWithMeta = (res, meta) => res.set('Content-Type', 'text/html; charset=utf-8').send(injectMeta(indexHtml(), meta));

  app.get('/page/:slug', async (req, res, next) => {
    try {
      const CmsPage = require('./models/CmsPage');
      const p = await CmsPage.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'PUBLISHED' }).lean();
      if (!p) return res.sendFile(clientIndex);
      return serveWithMeta(res, {
        title: p.seoTitle || p.title,
        description: p.seoDescription,
        keywords: (p.metaKeywords || []).join(', '),
        image: p.featuredImageUrl,
        url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      });
    } catch (_) { return next(); }
  });

  app.get('/news/:slug', async (req, res, next) => {
    try {
      const CmsNews = require('./models/CmsNews');
      const a = await CmsNews.findOne({ slug: String(req.params.slug).toLowerCase(), status: 'PUBLISHED' }).lean();
      if (!a) return res.sendFile(clientIndex);
      return serveWithMeta(res, {
        title: `${a.title} · TradePro`,
        description: a.excerpt,
        keywords: (a.tags || []).join(', '),
        image: a.featuredImageUrl,
        url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      });
    } catch (_) { return next(); }
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(clientIndex);
  });
  logger.info('Client SPA mounted at / (with SEO meta injection for /page/:slug & /news/:slug)');
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

  // Ensure canonical subscription plans exist (idempotent). Adds any
  // plan that's missing from the DB without touching existing rows.
  try {
    const { ensureDefaultPlans } = require('./services/planBootstrap');
    await ensureDefaultPlans();
  } catch (e) {
    logger.error('Plan bootstrap failed', { err: e });
  }

  // Ensure canonical trading-account tiers (Standard / IC / Pro / etc)
  // exist in the AccountPlan collection. Idempotent — admin edits to
  // existing tiers survive restarts; only missing codes are inserted.
  try {
    const accountPlansService = require('./services/accountPlansService');
    await accountPlansService.ensureDefaultPlans();
  } catch (e) {
    logger.error('AccountPlan bootstrap failed', { err: e });
  }

  // One-time backfill: any instrument still carrying the legacy
  // maxLeverage=100 (or null/0/undefined) gets bumped to the Unlimited
  // sentinel (999999). Admin-set caps (anything ≥1 and ≠100) are left
  // alone. Runs every boot but only touches rows that need lifting.
  try {
    const Instrument = require('./models/Instrument');
    const UNLIMITED = 999999;
    const res = await Instrument.updateMany(
      { $or: [
        { maxLeverage: { $exists: false } },
        { maxLeverage: null },
        { maxLeverage: 0 },
        { maxLeverage: 100 },
      ]},
      { $set: { maxLeverage: UNLIMITED } }
    );
    if (res.modifiedCount) {
      logger.info(`Instrument leverage backfill: ${res.modifiedCount} instrument(s) lifted to Unlimited`);
    }
  } catch (e) {
    logger.error('Instrument leverage backfill failed', { err: e });
  }

  // One-time backfill: stamp commissionType on instruments missing it.
  // A non-zero commissionPercent ⇒ PERCENTAGE, otherwise FIXED. Also zeroes
  // the inactive field so the two methods can never both charge.
  try {
    const Instrument = require('./models/Instrument');
    const needType = { $or: [{ commissionType: { $exists: false } }, { commissionType: null }] };
    const [toPct, toFixed] = await Promise.all([
      Instrument.updateMany(
        { ...needType, $expr: { $gt: [{ $toDouble: { $ifNull: ['$commissionPercent', '0'] } }, 0] } },
        { $set: { commissionType: 'PERCENTAGE', commissionPerTrade: '0' } }
      ),
      Instrument.updateMany(
        { ...needType, $expr: { $lte: [{ $toDouble: { $ifNull: ['$commissionPercent', '0'] } }, 0] } },
        { $set: { commissionType: 'FIXED', commissionPercent: '0' } }
      ),
    ]);
    const n = (toPct.modifiedCount || 0) + (toFixed.modifiedCount || 0);
    if (n) logger.info(`Instrument commissionType backfill: ${n} instrument(s) migrated`);
  } catch (e) {
    logger.error('Instrument commissionType backfill failed', { err: e });
  }

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
