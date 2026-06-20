/**
 * loadtest-engine.js — END-TO-END matching-engine throughput test.
 *
 * Unlike bench-ledger.js (which measures each layer in isolation), this drives
 * REAL B-book orders through matchingEngine.submit() against MongoDB and reports
 * the integrated open+close throughput + latency. It exercises the full hot
 * path: Order insert → match → Trade → Position open/close → Wallet settle.
 *
 * This is the gate that validates the 1b/1c cutover on real hardware: run it
 * with MATCHING_WRITE_BEHIND unset (synchronous baseline) and again with =on
 * (cutover) on the SAME box and compare orders/sec.
 *
 * SAFETY: runs against an ISOLATED database (<dbname>_loadtest) and DROPS it at
 * the end. It refuses to drop anything whose name doesn't contain "loadtest".
 *
 * Usage (inside the backend container):
 *   docker compose exec backend node scripts/loadtest-engine.js
 *   docker compose exec -e LT_N=20000 -e LT_CONC=200 backend node scripts/loadtest-engine.js
 *
 * Env knobs:
 *   LT_N        cycles (each = 1 open + 1 close = 2 orders).   default 10000
 *   LT_ACCOUNTS distinct accounts to spread across.           default 500
 *   LT_SYMBOLS  distinct symbols.                             default 20
 *   LT_CONC     in-flight cycles (concurrency).               default 200
 */
const mongoose = require('mongoose');

const N        = Number(process.env.LT_N)        || 10000;
const ACCOUNTS = Number(process.env.LT_ACCOUNTS) || 500;
const SYMBOLS  = Number(process.env.LT_SYMBOLS)  || 20;
const CONC     = Math.min(Number(process.env.LT_CONC) || 200, ACCOUNTS);

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms
const fmt = (n) => Math.round(n).toLocaleString();
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// Derive an isolated <db>_loadtest URI from the app's connection string.
function toTestUri(uri) {
  const [base, query] = uri.split('?');
  const m = base.match(/^(mongodb(?:\+srv)?:\/\/[^/]+\/)([^/?]*)$/);
  let out;
  if (m) out = `${m[1]}${(m[2] || 'trading')}_loadtest`;
  else   out = base.replace(/\/?$/, '/') + 'loadtest_db';
  return query ? `${out}?${query}` : out;
}

(async () => {
  const APP_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!APP_URI) { console.error('Set MONGODB_URI (or MONGO_URI).'); process.exit(1); }
  const URI = toTestUri(APP_URI);

  await mongoose.connect(URI);
  const dbName = mongoose.connection.name || '';
  if (!/loadtest/i.test(dbName)) {
    console.error(`Refusing to run: test DB name "${dbName}" doesn't contain "loadtest".`);
    process.exit(1);
  }
  // Clean slate.
  await mongoose.connection.dropDatabase();

  const Order          = require('../src/models/Order');
  const Instrument     = require('../src/models/Instrument');
  const TradingAccount = require('../src/models/TradingAccount');
  const { Wallet }     = require('../src/models/Wallet');
  const engine         = require('../src/matching-engine/MatchingEngine');

  const mode = String(process.env.MATCHING_WRITE_BEHIND || 'off').toLowerCase();
  console.log(`\nloadtest-engine — DB=${dbName}  mode=${mode}`);
  console.log(`  N=${fmt(N)} cycles (${fmt(N * 2)} orders) · accounts=${ACCOUNTS} · symbols=${SYMBOLS} · concurrency=${CONC}\n`);

  // ── Seed ──────────────────────────────────────────────────────────────
  const userId = new mongoose.Types.ObjectId();
  const stamp = Date.now();

  const accounts = Array.from({ length: ACCOUNTS }, () => new mongoose.Types.ObjectId());
  await TradingAccount.insertMany(accounts.map((id, i) => ({
    _id: id, userId, accountNumber: `LT${stamp}_${i}`, type: 'STANDARD',
    baseCurrency: 'USD', leverage: 100, isActive: true, isTradingEnabled: true,
  })));
  // Pre-fund balance AND locked huge so settle's margin-release never underflows
  // (we bypass placeOrder's margin lock — throughput is what we're measuring).
  await Wallet.insertMany(accounts.map((id) => ({
    userId, accountId: id, currency: 'USD', balance: '1000000000', locked: '1000000000',
  })));

  const symbols = [], instrIds = [];
  const instrDocs = [];
  for (let s = 0; s < SYMBOLS; s++) {
    const id = new mongoose.Types.ObjectId();
    const symbol = `LT${stamp % 100000}S${s}`;
    symbols.push(symbol); instrIds.push(id);
    instrDocs.push({
      _id: id, symbol, name: `LoadTest ${s}`, baseCurrency: 'LT', quoteCurrency: 'USD',
      category: 'CRYPTO', isActive: true, lastPrice: '100',
      spreadType: 'FIXED', spreadValue: '0', pricePrecision: 2, quantityPrecision: 4,
    });
  }
  await Instrument.insertMany(instrDocs);

  if (engine.startWriteBehind) await engine.startWriteBehind(); // no-op unless cutover on

  // ── Drive ─────────────────────────────────────────────────────────────
  const lat = [];
  let next = 0, ok = 0, failed = 0;
  const t0 = now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= N) return;
      const acc = accounts[i % ACCOUNTS];
      const instrumentId = instrIds[i % SYMBOLS];
      const symbol = symbols[i % SYMBOLS];
      const s = now();
      try {
        const open = await Order.create({
          userId, accountId: acc, instrumentId, symbol, side: 'BUY',
          positionSide: 'LONG', type: 'MARKET', quantity: '1', price: '100',
          leverage: 100, routing: 'B_BOOK', status: 'PENDING',
        });
        await engine.submit(open);
        const close = await Order.create({
          userId, accountId: acc, instrumentId, symbol, side: 'SELL',
          positionSide: 'LONG', type: 'MARKET', quantity: '1', price: '101',
          leverage: 100, routing: 'B_BOOK', status: 'PENDING',
          closeOnly: true, reduceOnly: true,
        });
        await engine.submit(close);
        ok++;
      } catch (e) {
        failed++;
        if (failed <= 3) console.error('  cycle error:', e.message);
      }
      lat.push(now() - s);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  if (engine.drainWriteBehind) await engine.drainWriteBehind();
  const ms = now() - t0;

  // ── Report ────────────────────────────────────────────────────────────
  const orders = ok * 2;
  console.log('── RESULT ─────────────────────────────────────────');
  console.log(`  cycles ok/failed : ${fmt(ok)} / ${failed}`);
  console.log(`  wall time        : ${(ms / 1000).toFixed(1)} s`);
  console.log(`  THROUGHPUT       : ${fmt(orders / (ms / 1000))} orders/sec   (${fmt(ok / (ms / 1000))} open+close cycles/sec)`);
  console.log(`  latency / cycle  : p50 ${pct(lat, 50).toFixed(1)} ms · p99 ${pct(lat, 99).toFixed(1)} ms · max ${Math.max(...lat).toFixed(1)} ms`);
  console.log(`  mode             : MATCHING_WRITE_BEHIND=${mode}`);
  console.log('───────────────────────────────────────────────────');
  console.log('  → orders/sec is the integrated capacity. Compare mode=off vs mode=on');
  console.log('    on the SAME box to see the 1b/1c cutover gain.\n');

  // Cleanup — drop the isolated test DB.
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
