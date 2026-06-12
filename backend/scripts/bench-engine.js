/**
 * In-process matching-engine micro-benchmark.
 *
 * Measures PURE engine throughput (no HTTP, no auth, no rate limiter) by
 * routing N opening MARKET orders straight through orderRouter.routeOrder →
 * MatchingEngine, on a THROWAWAY instrument/account so real data is never
 * touched and everything is cleaned up at the end.
 *
 *   node scripts/bench-engine.js            # default 500 orders
 *   BENCH_N=2000 node scripts/bench-engine.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const dbMod = require('../src/config/db');
const connectDB = dbMod.connectDB || dbMod;

const User = require('../src/models/User');
const Instrument = require('../src/models/Instrument');
const TradingAccount = require('../src/models/TradingAccount');
const { Wallet } = require('../src/models/Wallet');
const Order = require('../src/models/Order');
const orderRouter = require('../src/services/orderRouter.service');

const SYMBOL = 'LOADTESTX';
const N = Number(process.env.BENCH_N) || 500;
const WARMUP = 30;

const pctile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function cleanup(ids = {}) {
  const tasks = [
    Order.deleteMany({ symbol: SYMBOL }),
    Instrument.deleteMany({ symbol: SYMBOL }),
  ];
  // best-effort deletes for derived collections
  for (const m of ['Trade', 'Position', 'RoutingDecision', 'Candle']) {
    try { tasks.push(mongoose.model(m).deleteMany({ symbol: SYMBOL })); } catch (_) {}
  }
  if (ids.userId) {
    tasks.push(TradingAccount.deleteMany({ userId: ids.userId }));
    tasks.push(Wallet.deleteMany({ userId: ids.userId }));
    tasks.push(User.deleteOne({ _id: ids.userId }));
  }
  await Promise.allSettled(tasks);
}

async function main() {
  await connectDB();
  console.log(`\n⚙  Engine benchmark — ${N} orders on throwaway ${SYMBOL}\n`);

  // Pre-clean any leftovers from a previous run.
  const stale = await User.findOne({ email: 'bench_engine@local' }).select('_id').lean();
  await cleanup({ userId: stale?._id });

  // ── Throwaway instrument (B-book forced via routingOverride) ──
  const instrument = await Instrument.create({
    symbol: SYMBOL, name: 'Load Test', baseCurrency: 'LTX', quoteCurrency: 'USD',
    category: 'CRYPTO', isActive: true, routingOverride: 'B_BOOK',
    pricePrecision: 2, quantityPrecision: 6, minOrderSize: '0.0001', maxOrderSize: '1000000',
    spreadType: 'FIXED', spreadValue: '0', commissionPercent: '0', commissionPerTrade: '0',
    lastPrice: '100', maxLeverage: 500,
  });

  // ── Throwaway user + account + funded wallet ──
  const user = await User.create({
    email: 'bench_engine@local', passwordHash: 'x', role: 'USER', isActive: true,
    firstName: 'Bench', lastName: 'Engine',
  });
  const account = await TradingAccount.create({
    userId: user._id, accountNumber: `BENCH${Date.now()}`, accountType: 'STANDARD',
    baseCurrency: 'USD', leverage: 100, isActive: true, isTradingEnabled: true,
    status: 'ACTIVE', bookType: 'B_BOOK',
  });
  await Wallet.create({ userId: user._id, accountId: account._id, currency: 'USD', balance: '100000000', locked: '0' });

  const place = async (side) => {
    const order = await Order.create({
      userId: user._id, accountId: account._id, instrumentId: instrument._id, symbol: SYMBOL,
      side, type: 'MARKET', quantity: '0.001', leverage: 100, status: 'PENDING',
    });
    const t0 = process.hrtime.bigint();
    await orderRouter.routeOrder({ order, userId: user._id });
    return Number(process.hrtime.bigint() - t0) / 1e6; // ms
  };

  // ── Warm-up (JIT, connection pool, indexes) ──
  console.log(`Warming up (${WARMUP})…`);
  for (let i = 0; i < WARMUP; i++) await place(i % 2 ? 'SELL' : 'BUY');

  // ── Measured run ──
  console.log(`Running ${N} orders…`);
  const lat = [];
  let ok = 0, fail = 0;
  const wall0 = Date.now();
  for (let i = 0; i < N; i++) {
    try { lat.push(await place(i % 2 ? 'SELL' : 'BUY')); ok++; }
    catch (e) { fail++; if (fail <= 3) console.log('  err:', e.message); }
  }
  const wallSec = (Date.now() - wall0) / 1000;

  console.log('\n────────── RESULTS ──────────');
  console.log(`Orders OK        : ${ok}  (failed ${fail})`);
  console.log(`Wall time        : ${wallSec.toFixed(2)} s`);
  console.log(`Throughput       : ${(ok / wallSec).toFixed(1)} orders/sec  (single symbol, serialized)`);
  console.log(`Latency p50/p95/p99/max ms : ${pctile(lat, 50).toFixed(1)} / ${pctile(lat, 95).toFixed(1)} / ${pctile(lat, 99).toFixed(1)} / ${Math.max(...lat).toFixed(1)}`);
  console.log('─────────────────────────────\n');

  // give deferred setImmediate side-effects a moment, then clean up
  await new Promise((r) => setTimeout(r, 500));
  await cleanup({ userId: user._id });
  console.log('✓ cleaned up test data');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => { console.error('BENCH FAILED:', e); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
