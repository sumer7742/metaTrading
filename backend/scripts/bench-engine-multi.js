/**
 * Multi-account matching-engine benchmark — measures PER-SYMBOL throughput
 * under the realistic case: MANY accounts trading the SAME symbol concurrently.
 *
 * The single-account bench (bench-engine.js) is serialized per (account,symbol)
 * so it shows ~one order at a time. This one fires A accounts' orders CONCURRENTLY
 * on one symbol, so it exercises the cross-account parallelism (B-book fills
 * don't touch the shared order book → different accounts run in parallel).
 *
 *   node scripts/bench-engine-multi.js
 *   BENCH_ACCOUNTS=80 BENCH_PER=40 node scripts/bench-engine-multi.js
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

const SYMBOL = 'LOADTESTM';
const ACCOUNTS = Number(process.env.BENCH_ACCOUNTS) || 50;
const PER = Number(process.env.BENCH_PER) || 30; // orders per account
const EMAIL_RE = /^bench_multi_\d+@local$/;

async function cleanup() {
  const users = await User.find({ email: EMAIL_RE }).select('_id').lean();
  const ids = users.map((u) => u._id);
  const tasks = [
    Order.deleteMany({ symbol: SYMBOL }),
    Instrument.deleteMany({ symbol: SYMBOL }),
  ];
  for (const m of ['Trade', 'Position', 'RoutingDecision', 'Candle', 'WalletLedger']) {
    try { tasks.push(mongoose.model(m).deleteMany({ symbol: SYMBOL })); } catch (_) {}
  }
  if (ids.length) {
    tasks.push(TradingAccount.deleteMany({ userId: { $in: ids } }));
    tasks.push(Wallet.deleteMany({ userId: { $in: ids } }));
    tasks.push(User.deleteMany({ _id: { $in: ids } }));
  }
  await Promise.allSettled(tasks);
}

async function main() {
  await connectDB();
  console.log(`\n⚙  Multi-account engine benchmark — ${ACCOUNTS} accounts × ${PER} orders on ${SYMBOL}\n`);
  await cleanup();

  const instrument = await Instrument.create({
    symbol: SYMBOL, name: 'Load Test Multi', baseCurrency: 'LTM', quoteCurrency: 'USD',
    category: 'CRYPTO', isActive: true, routingOverride: 'B_BOOK',
    pricePrecision: 2, quantityPrecision: 6, minOrderSize: '0.0001', maxOrderSize: '1000000',
    spreadType: 'FIXED', spreadValue: '0', commissionPercent: '0', commissionPerTrade: '0',
    lastPrice: '100', maxLeverage: 500,
  });

  // ── Build A throwaway accounts (funded) ──
  console.log(`Creating ${ACCOUNTS} accounts…`);
  const accounts = [];
  await Promise.all(Array.from({ length: ACCOUNTS }, async (_, i) => {
    const user = await User.create({
      email: `bench_multi_${i}@local`, passwordHash: 'x', role: 'USER', isActive: true,
      firstName: 'BenchMulti', lastName: String(i),
    });
    const account = await TradingAccount.create({
      userId: user._id, accountNumber: `BM${Date.now()}${i}`, accountType: 'STANDARD',
      baseCurrency: 'USD', leverage: 100, isActive: true, isTradingEnabled: true,
      status: 'ACTIVE', bookType: 'B_BOOK',
    });
    await Wallet.create({ userId: user._id, accountId: account._id, currency: 'USD', balance: '100000000', locked: '0' });
    accounts[i] = { user, account };
  }));

  const place = async (acc, side) => {
    const order = await Order.create({
      userId: acc.user._id, accountId: acc.account._id, instrumentId: instrument._id, symbol: SYMBOL,
      side, type: 'MARKET', quantity: '0.001', leverage: 100, status: 'PENDING',
    });
    await orderRouter.routeOrder({ order, userId: acc.user._id });
  };

  // ── Warm-up ──
  console.log('Warming up…');
  await Promise.all(accounts.map((a, i) => place(a, i % 2 ? 'SELL' : 'BUY')));

  // ── Measured run: PER rounds, each round fires 1 order per account CONCURRENTLY ──
  console.log(`Running ${ACCOUNTS * PER} orders (${PER} concurrent waves of ${ACCOUNTS})…`);
  let ok = 0, fail = 0;
  const wall0 = Date.now();
  for (let round = 0; round < PER; round++) {
    const res = await Promise.allSettled(
      accounts.map((a, i) => place(a, (round + i) % 2 ? 'SELL' : 'BUY'))
    );
    for (const r of res) (r.status === 'fulfilled' ? ok++ : fail++);
  }
  const wallSec = (Date.now() - wall0) / 1000;

  console.log('\n────────── RESULTS ──────────');
  console.log(`Accounts         : ${ACCOUNTS}  (concurrency per wave)`);
  console.log(`Orders OK        : ${ok}  (failed ${fail})`);
  console.log(`Wall time        : ${wallSec.toFixed(2)} s`);
  console.log(`Throughput       : ${(ok / wallSec).toFixed(1)} orders/sec  (single symbol, ${ACCOUNTS} accounts in parallel)`);
  console.log('─────────────────────────────\n');

  await new Promise((r) => setTimeout(r, 800));
  await cleanup();
  console.log('✓ cleaned up test data');
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => { console.error('BENCH FAILED:', e); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
