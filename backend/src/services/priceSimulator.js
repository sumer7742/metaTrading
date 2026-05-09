/**
 * Price Simulator Service.
 *
 * For instruments where:
 *   - No external feed is configured
 *   - No real users are providing liquidity yet
 *
 * This generates synthetic price ticks via a Geometric Brownian Motion-style random walk.
 * Updates the instrument's lastPrice, aggregates into candles, broadcasts to WS subscribers.
 *
 * Per-instrument config in Instrument.priceSimulator:
 *   - enabled (boolean)
 *   - volatilityPct (e.g. 0.05 = 0.05% move per tick)
 *   - intervalMs (default 3000)
 *   - driftPct (slight upward/downward bias)
 *   - minPrice, maxPrice (optional clamps)
 *
 * IMPORTANT: This is for DEMO / DEV use. NEVER run with real money instruments
 * — synthetic prices = fake market = regulatory and ethical disaster.
 */

const Instrument = require('../models/Instrument');
const { updateCandlesForTrade } = require('./candleService');

let broadcaster = null;
const timers = new Map(); // instrumentId -> timer handle

const setBroadcaster = (b) => { broadcaster = b; };

/**
 * Generate one tick for a single instrument and update DB + broadcast.
 */
const _tick = async (instrumentId) => {
  const inst = await Instrument.findById(instrumentId);
  if (!inst || !inst.isActive || !inst.priceSimulator?.enabled) {
    // Simulator was disabled or instrument removed - clean up timer
    const t = timers.get(String(instrumentId));
    if (t) { clearInterval(t); timers.delete(String(instrumentId)); }
    return;
  }

  const cur = Number(inst.lastPrice) || 100;
  const vol = Number(inst.priceSimulator.volatilityPct || 0.05) / 100; // convert % to decimal
  const drift = Number(inst.priceSimulator.driftPct || 0) / 100;

  // Random walk: next = current * (1 + drift + (random in [-vol, +vol]))
  const shock = (Math.random() * 2 - 1) * vol;
  let next = cur * (1 + drift + shock);

  // Clamp to min/max if configured
  if (inst.priceSimulator.minPrice && next < Number(inst.priceSimulator.minPrice)) {
    next = Number(inst.priceSimulator.minPrice);
  }
  if (inst.priceSimulator.maxPrice && next > Number(inst.priceSimulator.maxPrice)) {
    next = Number(inst.priceSimulator.maxPrice);
  }
  if (next <= 0) next = cur; // never go to zero

  const newPrice = next.toFixed(inst.pricePrecision || 2);

  inst.lastPrice = newPrice;
  inst.lastPriceUpdatedAt = new Date();
  await inst.save();

  // Aggregate into candles using a small synthetic volume
  try {
    await updateCandlesForTrade({
      symbol: inst.symbol,
      price: newPrice,
      quantity: '0', // no real volume, synthetic tick
      ts: Date.now(),
    });
  } catch (e) { /* ignore */ }

  // Broadcast ticker so the frontend updates
  if (broadcaster) {
    broadcaster.publish(`ticker:${inst.symbol}`, { lastPrice: newPrice, ts: Date.now() });
  }
};

/**
 * Scan instruments and start/stop simulator timers based on their config.
 * Call this periodically (every 30s) to pick up admin changes.
 */
const reconcile = async () => {
  const enabledInsts = await Instrument.find({
    'priceSimulator.enabled': true,
    isActive: true,
  }).select('_id symbol priceSimulator').lean();

  const enabledIds = new Set(enabledInsts.map((i) => String(i._id)));

  // Stop timers for instruments that are no longer enabled
  for (const [id, timer] of timers.entries()) {
    if (!enabledIds.has(id)) {
      clearInterval(timer);
      timers.delete(id);
      console.log(`[PriceSim] Stopped simulator for ${id}`);
    }
  }

  // Start timers for newly enabled instruments
  for (const inst of enabledInsts) {
    const id = String(inst._id);
    if (timers.has(id)) continue;
    const intervalMs = Math.max(500, Number(inst.priceSimulator.intervalMs || 3000));
    const handle = setInterval(() => _tick(inst._id), intervalMs);
    timers.set(id, handle);
    console.log(`[PriceSim] Started simulator for ${inst.symbol} (every ${intervalMs}ms, vol ±${inst.priceSimulator.volatilityPct}%)`);
  }
};

const start = async () => {
  // SAFETY: Never run synthetic prices in production unless explicitly opted-in.
  // Doc warning: synthetic prices on real-money instruments = regulatory disaster.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRICE_SIMULATOR !== 'true') {
    console.log('[PriceSim] DISABLED in production. Set ALLOW_PRICE_SIMULATOR=true to override (NOT recommended).');
    return;
  }
  await reconcile();
  // Re-check every 30s to pick up admin changes
  setInterval(reconcile, 30 * 1000);
};

const stop = () => {
  for (const t of timers.values()) clearInterval(t);
  timers.clear();
};

module.exports = { start, stop, setBroadcaster, reconcile };
