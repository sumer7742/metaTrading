/**
 * Feed Provider Orchestrator with Health Monitoring + Auto-Failover.
 *
 * Manages multiple price providers in priority order:
 *   1. OANDA (primary, real-time streaming)
 *   2. Twelve Data (backup, REST polling)
 *   3. Price Simulator (last resort, synthetic prices)
 *
 * Behavior:
 *   - Health-check each provider every 30s
 *   - If primary unhealthy: automatic switch to next
 *   - If primary recovers: optional fallback to it
 *   - Logs all state transitions
 *   - Emits admin notifications on failover events
 *
 * Detection rules per provider:
 *   - HEALTHY: Connected + last tick within 60s
 *   - DEGRADED: Connected but last tick > 60s ago
 *   - DOWN: Disconnected or 3+ consecutive errors
 */

const Instrument = require('../models/Instrument');

const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;     // 30 sec
const STALE_TICK_THRESHOLD_MS = 60 * 1000;      // 60 sec — provider stale if no tick
const FAILOVER_COOLDOWN_MS = 60 * 1000;         // 60 sec — prevent flapping

// Track each provider's status
const providerState = {
  FINNHUB: {
    name: 'Finnhub',
    priority: 1,
    status: 'INIT',
    lastTickAt: null,
    consecutiveErrors: 0,
    activeSince: null,
  },
  OANDA: {
    name: 'OANDA',
    priority: 2,
    status: 'INIT',           // INIT | HEALTHY | DEGRADED | DOWN
    lastTickAt: null,
    consecutiveErrors: 0,
    activeSince: null,
  },
  TWELVE_DATA: {
    name: 'Twelve Data',
    priority: 3,
    status: 'INIT',
    lastTickAt: null,
    consecutiveErrors: 0,
    activeSince: null,
  },
  ANGEL: {
    name: 'Angel One SmartAPI',
    priority: 4,
    status: 'INIT',           // Indian NSE/BSE cash feed (session-gated)
    lastTickAt: null,
    consecutiveErrors: 0,
    activeSince: null,
  },
  SIMULATOR: {
    name: 'Price Simulator',
    priority: 99,
    status: 'INIT',
    lastTickAt: null,
    consecutiveErrors: 0,
    activeSince: null,
  },
};

let activeProvider = null;       // Current chosen provider for forex
let lastSwitchAt = 0;             // Timestamp of last failover (for cooldown)
let healthCheckTimer = null;
const eventLog = [];              // Recent failover events for admin dashboard

/**
 * Public: providers report their tick events here.
 * Called from oandaFeed.js, twelveDataFeed.js, priceSimulator.js
 */
const recordTick = (providerName) => {
  if (!providerState[providerName]) return;
  const p = providerState[providerName];
  p.lastTickAt = Date.now();
  p.consecutiveErrors = 0;
  if (p.status !== 'HEALTHY') {
    _setStatus(providerName, 'HEALTHY');
  }
};

/**
 * Public: providers report errors here.
 */
const recordError = (providerName, error) => {
  if (!providerState[providerName]) return;
  const p = providerState[providerName];
  p.consecutiveErrors += 1;
  if (p.consecutiveErrors >= 3 && p.status !== 'DOWN') {
    _setStatus(providerName, 'DOWN');
    _logEvent(`${providerName} marked DOWN after 3 consecutive errors: ${error?.message || error}`);
    _maybeFailover();
  }
};

/**
 * Public: provider connection state changes (websocket open/close).
 */
const recordConnection = (providerName, connected) => {
  if (!providerState[providerName]) return;
  const p = providerState[providerName];
  if (connected) {
    if (p.status === 'DOWN' || p.status === 'INIT') {
      _setStatus(providerName, 'HEALTHY');
      _logEvent(`${providerName} reconnected`);
      _maybeFailback();
    }
  } else {
    if (p.status === 'HEALTHY' || p.status === 'DEGRADED') {
      _setStatus(providerName, 'DOWN');
      _logEvent(`${providerName} disconnected`);
      _maybeFailover();
    }
  }
};

const _setStatus = (providerName, newStatus) => {
  const p = providerState[providerName];
  const oldStatus = p.status;
  p.status = newStatus;
  if (newStatus === 'HEALTHY' && oldStatus !== 'HEALTHY') {
    p.activeSince = Date.now();
  }
  console.log(`[FeedOrch] ${providerName}: ${oldStatus} -> ${newStatus}`);
};

/**
 * Periodic health check — detects stale ticks (provider connected but not delivering).
 */
const _healthCheck = () => {
  const now = Date.now();
  for (const [name, p] of Object.entries(providerState)) {
    if (p.status !== 'HEALTHY') continue;
    if (p.lastTickAt && now - p.lastTickAt > STALE_TICK_THRESHOLD_MS) {
      _setStatus(name, 'DEGRADED');
      _logEvent(`${name} marked DEGRADED — no ticks for ${Math.round((now - p.lastTickAt) / 1000)}s`);
      _maybeFailover();
    }
  }
};

/**
 * Decide whether to failover to next-best provider.
 */
const _maybeFailover = () => {
  // Cooldown to prevent flapping
  if (Date.now() - lastSwitchAt < FAILOVER_COOLDOWN_MS) return;

  const sorted = Object.values(providerState).sort((a, b) => a.priority - b.priority);
  const newActive = sorted.find((p) => p.status === 'HEALTHY' || p.status === 'INIT');

  if (!newActive) {
    if (activeProvider !== null) {
      _logEvent(`⚠️ NO HEALTHY PROVIDERS — emergency mode, all instruments may be paused`);
      activeProvider = null;
    }
    return;
  }

  if (activeProvider !== newActive.name) {
    const previous = activeProvider;
    activeProvider = newActive.name;
    lastSwitchAt = Date.now();
    _logEvent(`Failover: ${previous || 'none'} -> ${newActive.name}`);
  }
};

/**
 * If a higher-priority provider is healthy again, optionally fail back.
 * Currently keeps using the working backup until it fails — to avoid flapping.
 * Set FEED_ORCH_AUTO_FAILBACK=true in env to enable automatic failback.
 */
const _maybeFailback = () => {
  if (process.env.FEED_ORCH_AUTO_FAILBACK !== 'true') return;
  const sorted = Object.values(providerState).sort((a, b) => a.priority - b.priority);
  const bestHealthy = sorted.find((p) => p.status === 'HEALTHY');
  if (bestHealthy && activeProvider && bestHealthy.name !== activeProvider) {
    const current = providerState[activeProvider];
    if (bestHealthy.priority < current.priority) {
      _logEvent(`Auto-failback: ${activeProvider} -> ${bestHealthy.name}`);
      activeProvider = bestHealthy.name;
      lastSwitchAt = Date.now();
    }
  }
};

const _logEvent = (msg) => {
  const event = { timestamp: new Date().toISOString(), message: msg };
  eventLog.unshift(event);
  if (eventLog.length > 50) eventLog.pop();
  console.log(`[FeedOrch] ${msg}`);
};

/**
 * Public: get current orchestrator status (for admin dashboard).
 */
const getStatus = () => ({
  activeProvider,
  providers: Object.values(providerState).map((p) => ({
    name: p.name,
    priority: p.priority,
    status: p.status,
    lastTickAt: p.lastTickAt,
    lastTickAge: p.lastTickAt ? Math.round((Date.now() - p.lastTickAt) / 1000) + 's' : null,
    activeSince: p.activeSince,
    consecutiveErrors: p.consecutiveErrors,
  })),
  recentEvents: eventLog.slice(0, 20),
});

/**
 * Public: admin can manually force switch to a specific provider.
 */
const forceSwitch = (providerName) => {
  if (!providerState[providerName]) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  if (providerState[providerName].status !== 'HEALTHY') {
    throw new Error(`Provider ${providerName} is not healthy (${providerState[providerName].status})`);
  }
  const previous = activeProvider;
  activeProvider = providerName;
  lastSwitchAt = Date.now();
  _logEvent(`Manual switch: ${previous || 'none'} -> ${providerName} (admin override)`);
  return getStatus();
};

const start = () => {
  console.log('[FeedOrch] Started — monitoring providers every 30s');
  // Initial check
  _maybeFailover();
  // Periodic checks
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(_healthCheck, HEALTH_CHECK_INTERVAL_MS);
};

const stop = () => {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = null;
};

module.exports = {
  start,
  stop,
  recordTick,
  recordError,
  recordConnection,
  getStatus,
  forceSwitch,
  providerState,
};
