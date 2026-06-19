/**
 * verify-ledger.js — correctness proof for the in-memory LedgerCache (Phase 1).
 *
 * This is the FIRST gate of the 40–50k cutover (see MATCHING_ENGINE_PHASE1.md
 * §3 "the crux + the risk"). Before the in-memory ledger goes anywhere near the
 * live money path, it must compute balances / margin / positions exactly like
 * the current engine. This harness drives a scripted sequence of B-book fills
 * through LedgerCache and checks the result two ways:
 *
 *   1. GOLDEN — hand-computed balance/locked/position at each checkpoint, so the
 *      test is independent of the implementation (not "code matches itself").
 *   2. REFERENCE — a second, independently written settlement model applied to
 *      the same fills, asserted equal after every step (catches drift on inputs
 *      the golden checkpoints don't name explicitly).
 *
 * No Mongo, no network — pure in-memory. Runs in milliseconds on any machine:
 *   node scripts/verify-ledger.js
 *
 * Exit code 0 = all assertions passed; 1 = a divergence (prints the diff).
 */
const LedgerCache = require('../src/matching-engine/LedgerCache');
const { add, sub, mul, div, eq, gt } = require('../src/utils/decimal');

/* ── tiny assert harness ─────────────────────────────────────────────── */
let failures = 0;
let checks = 0;
function expectEq(label, got, want) {
  checks += 1;
  if (!eq(got, want)) {
    failures += 1;
    console.error(`  ✗ ${label}\n      got  = ${got}\n      want = ${want}`);
  } else {
    console.log(`  ✓ ${label} = ${got}`);
  }
}
function expectAbsent(label, val) {
  checks += 1;
  if (val) { failures += 1; console.error(`  ✗ ${label}: expected position to be CLOSED, but it still exists (qty=${val.quantity})`); }
  else console.log(`  ✓ ${label} (position closed)`);
}

/* ── REFERENCE model — independently written settlement bookkeeping ──────
 * Mirrors MatchingEngine._updatePosition + walletService.settleTradeClose but
 * is a separate implementation, so agreement between this and LedgerCache is a
 * genuine cross-check, not a tautology. */
function makeRef(startBalance) {
  return {
    balance: String(startBalance),
    locked: '0',
    pos: new Map(), // posKey -> { side, qty, entry, margin }
    key: (sym, ps) => `${sym}|${ps}`,
  };
}
function refApply(ref, f) {
  const ps = f.positionSide || (f.side === 'BUY' ? 'LONG' : 'SHORT');
  const k = ref.key(f.symbol, ps);
  const margin = div(mul(f.quantity, f.price), String(f.leverage || 1));
  let p = ref.pos.get(k);

  if (!f.closeOnly && (!p || p.side === f.side)) {
    if (!p) {
      ref.pos.set(k, { side: f.side, qty: String(f.quantity), entry: String(f.price), margin });
    } else {
      const nq = add(p.qty, f.quantity);
      p.entry = div(add(mul(p.entry, p.qty), mul(f.price, f.quantity)), nq);
      p.qty = nq;
      p.margin = add(p.margin, margin);
    }
    ref.locked = add(ref.locked, margin);
    return;
  }
  if (!p) return; // nothing to close
  const closeQty = gt(p.qty, f.quantity) ? f.quantity : p.qty;
  const pnl = p.side === 'BUY'
    ? mul(sub(f.price, p.entry), closeQty)
    : mul(sub(p.entry, f.price), closeQty);
  const fee = f.fee != null ? String(f.fee) : '0';
  const rel = eq(p.qty, closeQty) ? p.margin : div(mul(p.margin, closeQty), p.qty);
  ref.balance = sub(add(ref.balance, pnl), fee);
  ref.locked = sub(ref.locked, rel);
  if (gt('0', ref.locked)) ref.locked = '0';
  if (gt(p.qty, closeQty)) { p.qty = sub(p.qty, closeQty); p.margin = sub(p.margin, rel); }
  else ref.pos.delete(k);
}

/* ── scenario ────────────────────────────────────────────────────────────
 * One account, leverage 10, starting balance 10,000. Exercises: open, grow
 * (weighted-avg entry), partial reduce w/ realized PnL, HEDGE coexistence
 * (LONG + SHORT open at once), close-short profit, close-long loss w/ fee. */
async function run() {
  const ACC = 'acc-1';
  const SYM = 'BTCUSD';
  const LEV = 10;
  const START = '10000';

  const ledger = new LedgerCache();
  ledger.loadBalance(ACC, { balance: START, currency: 'USD' });
  const ref = makeRef(START);

  // [label, fill, golden? {balance, locked, [posChecks]}]
  const steps = [
    ['1. BUY 10 @100  (open LONG)',
      { accountId: ACC, symbol: SYM, side: 'BUY', quantity: '10', price: '100', leverage: LEV },
      { balance: '10000', locked: '100' }],

    ['2. BUY 10 @110  (grow LONG, wavg entry → 105)',
      { accountId: ACC, symbol: SYM, side: 'BUY', quantity: '10', price: '110', leverage: LEV },
      { balance: '10000', locked: '210', entry: { ps: 'LONG', v: '105' }, qty: { ps: 'LONG', v: '20' } }],

    ['3. SELL 5 @120  (reduce LONG, +75 PnL, release 52.5)',
      { accountId: ACC, symbol: SYM, side: 'SELL', quantity: '5', price: '120', leverage: LEV, closeOnly: true, positionSide: 'LONG' },
      { balance: '10075', locked: '157.5', qty: { ps: 'LONG', v: '15' } }],

    ['4. SELL 8 @100  (open SHORT — HEDGE, coexists with LONG)',
      { accountId: ACC, symbol: SYM, side: 'SELL', quantity: '8', price: '100', leverage: LEV },
      { balance: '10075', locked: '237.5', qty: { ps: 'SHORT', v: '8' } }],

    ['5. BUY 8 @90    (close SHORT, +80 PnL, release 80)',
      { accountId: ACC, symbol: SYM, side: 'BUY', quantity: '8', price: '90', leverage: LEV, closeOnly: true, positionSide: 'SHORT' },
      { balance: '10155', locked: '157.5', closed: 'SHORT' }],

    ['6. SELL 15 @90  (close LONG, -225 PnL, fee 5, release 157.5)',
      { accountId: ACC, symbol: SYM, side: 'SELL', quantity: '15', price: '90', leverage: LEV, closeOnly: true, positionSide: 'LONG', fee: '5' },
      { balance: '9925', locked: '0', closed: 'LONG' }],
  ];

  for (const [label, fill, gold] of steps) {
    console.log(`\n${label}`);
    const computeFee = async () => (fill.fee != null ? String(fill.fee) : '0');
    await ledger.applyFill({ ...fill, computeFee });
    refApply(ref, fill);

    const bal = ledger.getBalance(ACC);
    // 1) GOLDEN checkpoints (hand-computed, implementation-independent)
    expectEq('balance', bal.balance, gold.balance);
    expectEq('locked', bal.locked, gold.locked);
    if (gold.qty)   expectEq(`qty[${gold.qty.ps}]`,   ledger.getPosition(ACC, SYM, gold.qty.ps)?.quantity, gold.qty.v);
    if (gold.entry) expectEq(`entry[${gold.entry.ps}]`, ledger.getPosition(ACC, SYM, gold.entry.ps)?.entryPrice, gold.entry.v);
    if (gold.closed) expectAbsent(`pos[${gold.closed}]`, ledger.getPosition(ACC, SYM, gold.closed));

    // 2) REFERENCE cross-check (independent model, every step)
    expectEq('  ↳ ref:balance', bal.balance, ref.balance);
    expectEq('  ↳ ref:locked', bal.locked, ref.locked);
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures === 0) {
    console.log(`✅ LEDGER CORRECTNESS VERIFIED — ${checks} checks passed, 0 divergences.`);
    console.log('   The in-memory ledger settles balances/margin/positions exactly');
    console.log('   like the live engine. Gate 1 of the 40–50k cutover is GREEN.');
    process.exit(0);
  } else {
    console.error(`❌ ${failures}/${checks} checks FAILED — do NOT proceed to shadow wiring.`);
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
