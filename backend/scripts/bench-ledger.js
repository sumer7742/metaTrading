/**
 * bench-ledger.js — throughput proof for the Phase 1 architecture.
 *
 * Establishes WHERE the ceiling is. The 40–50k/sec target rests on one claim
 * (MATCHING_ENGINE_PHASE1.md §1): the matching itself is microseconds; the
 * per-order Mongo write is the wall. This bench measures each layer in
 * isolation so that claim is a number, not an assertion.
 *
 *   A) LEDGER  — pure in-memory applyFill (open+close loop). No DB, no journal.
 *                This is the raw matching/settlement speed. Expect millions/sec.
 *   B) JOURNAL — append + group-commit (requires MONGO_URI). This is the REAL
 *                durability ceiling: how many ACKs/sec one fsync-amortized WAL
 *                sustains. This is the number that must clear 40–50k.
 *   C) WRITE-BEHIND — batched bulkWrite of derived docs (requires MONGO_URI).
 *                Off the hot path, but must keep up on average.
 *
 * Usage:
 *   node scripts/bench-ledger.js                 # A only (no DB needed)
 *   MONGO_URI=... node scripts/bench-ledger.js   # A + B + C
 *
 * Env knobs:
 *   BENCH_N=200000   total fills to push through each layer
 *   JOURNAL_COMMIT_MS=5   WRITEBEHIND_FLUSH_MS=25   *_MAX_BATCH=1000
 */
const LedgerCache = require('../src/matching-engine/LedgerCache');

const N = Number(process.env.BENCH_N) || 200000;
const hr = (label) => console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`);
const rate = (n, ms) => `${Math.round(n / (ms / 1000)).toLocaleString()} /sec  (${ms.toFixed(1)} ms total, ${(ms * 1000 / n).toFixed(2)} µs/op)`;

async function benchLedger() {
  hr('A) LEDGER — pure in-memory matching + settlement');
  const ledger = new LedgerCache();
  // Spread fills across accounts so balances/positions Maps grow realistically.
  const ACCOUNTS = 1000;
  for (let i = 0; i < ACCOUNTS; i++) ledger.loadBalance(`a${i}`, { balance: '1000000', currency: 'USD' });
  const computeFee = async () => '0.5';

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const acc = `a${i % ACCOUNTS}`;
    const sym = `S${i % 50}`;
    // open then immediately close — exercises both code paths each iteration
    await ledger.applyFill({ accountId: acc, symbol: sym, side: 'BUY', quantity: '1', price: '100', leverage: 10, computeFee });
    await ledger.applyFill({ accountId: acc, symbol: sym, side: 'SELL', quantity: '1', price: '101', leverage: 10, closeOnly: true, positionSide: 'LONG', computeFee });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  fills: ${(N * 2).toLocaleString()} (${N} open + ${N} close)`);
  console.log(`  rate : ${rate(N * 2, ms)}`);
  console.log('  → matching/settlement is NOT the ceiling. Persistence is.');
}

async function benchDurability() {
  // Accept the app's MONGODB_URI too, so it "just works" inside the container.
  const MONGO = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO) {
    hr('B/C) JOURNAL + WRITE-BEHIND — SKIPPED (set MONGO_URI / MONGODB_URI to measure)');
    console.log('  These layers are the real 40–50k gate. Run against a capable');
    console.log('  instance (NVMe, MongoDB local/replica) to get the durability number.');
    return;
  }
  const mongoose = require('mongoose');
  const { Journal } = require('../src/matching-engine/Journal');
  const WriteBehind = require('../src/matching-engine/WriteBehind');
  await mongoose.connect(MONGO);

  // B) Journal group-commit
  hr('B) JOURNAL — WAL append + group-commit (durable ACK rate)');
  const journal = new Journal({
    commitMs: Number(process.env.JOURNAL_COMMIT_MS) || 5,
    maxBatch: Number(process.env.JOURNAL_MAX_BATCH) || 1000,
  });
  journal.start();
  let t0 = process.hrtime.bigint();
  const appends = [];
  for (let i = 0; i < N; i++) {
    appends.push(journal.append({ symbol: `S${i % 50}`, type: 'BBOOK_FILL', payload: { i, q: '1', p: '100' } }));
  }
  await Promise.all(appends);   // every ACK is durable here
  let ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  durable ACKs: ${N.toLocaleString()}`);
  console.log(`  rate        : ${rate(N, ms)}`);
  console.log(`  → THIS is the number that must clear 40–50k/sec.`);
  // Diagnostics: where did the time go? commits / docs-per-commit / DB ms.
  const st = journal.stats;
  console.log(`  commits     : ${st.commits}  ·  avg docs/commit: ${st.commits ? Math.round(st.docs / st.commits) : 0}`);
  console.log(`  in DB write : ${st.dbMs.toFixed(0)} ms of ${ms.toFixed(0)} ms total  (${ms ? Math.round((st.dbMs / ms) * 100) : 0}% in Mongo, rest = orchestration)`);
  await journal.drain();
  journal.stop();

  // C) Write-behind batched bulkWrite (use the journal collection as a stand-in target)
  hr('C) WRITE-BEHIND — batched bulkWrite throughput');
  const { JournalEntry } = require('../src/matching-engine/Journal');
  const wb = new WriteBehind({
    flushMs: Number(process.env.WRITEBEHIND_FLUSH_MS) || 25,
    maxBatch: Number(process.env.WRITEBEHIND_MAX_BATCH) || 1000,
  });
  wb.start();
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    wb.enqueue(JournalEntry, { insertOne: { document: { seq: -i - 1, symbol: 'WB', type: 'WB_TEST', payload: { i }, applied: true, ts: new Date() } } });
  }
  await wb.drain();
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  derived writes: ${N.toLocaleString()}`);
  console.log(`  rate          : ${rate(N, ms)}`);
  wb.stop();

  // cleanup test docs
  await JournalEntry.deleteMany({ type: { $in: ['BBOOK_FILL', 'WB_TEST'] } });
  await mongoose.disconnect();
}

(async () => {
  console.log(`bench-ledger — N=${N.toLocaleString()} per layer\n`);
  await benchLedger();
  await benchDurability();
  console.log('\nDone.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
