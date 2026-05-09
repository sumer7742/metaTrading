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

// Security & general middleware
app.use(helmet());
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL || 'http://localhost:5173',
      process.env.ADMIN_URL || 'http://localhost:5174',
    ],
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

// Health
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', uptime: process.uptime(), ts: new Date().toISOString() })
);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/instruments', instrumentRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

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
    console.log(`[Server] HTTP+WS running on http://localhost:${PORT}`);
    console.log(`[Server] WebSocket on ws://localhost:${PORT}/ws`);
  });
};

start().catch((e) => {
  console.error('[FATAL] Server failed to start:', e);
  process.exit(1);
});
