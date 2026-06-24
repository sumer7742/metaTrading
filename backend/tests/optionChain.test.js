/**
 * Unit tests for the option-chain validation layer (data integrity).
 * No framework — run with:  node backend/tests/optionChain.test.js
 * Exits 0 on pass, non-zero (throws) on first failure.
 */
const assert = require('assert');
const { validateLeg, buildChain, checkIntegrity } = require('../src/services/optionChain');

const REF = 24000;                 // forward / future price
const EXP = '2026-06-30T00:00:00.000Z';
const EXP_MS = Date.parse(EXP) + 14 * 86400000; // ~2w out so Greeks are computable
const fresh = () => new Date();
let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`  ok  ${name}`); };

// 1. Missing/zero price → null LTP, never 0.00.
test('NO_PRICE: zero/blank premium → ltp null, valid false', () => {
  const leg = validateLeg({ symbol: 'NIFTY...24000CE', strike: '24000', lastPrice: '0', lastPriceUpdatedAt: fresh() }, { type: 'CE', ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(leg.ltp, null);
  assert.strictEqual(leg.valid, false);
  assert.strictEqual(leg.reason, 'NO_PRICE');
  assert.notStrictEqual(leg.ltp, '0');
  assert.notStrictEqual(leg.ltp, 0);
});

// 2. The reported bug: 21000 CE @ 2838 with spot 24000 (intrinsic 3000) is BELOW
//    intrinsic → must be rejected (stale/mis-mapped), not shown.
test('BELOW_INTRINSIC: 21000CE @2838 (intrinsic 3000) → rejected', () => {
  const leg = validateLeg({ symbol: 'NIFTY...21000CE', strike: '21000', lastPrice: '2838', lastPriceUpdatedAt: fresh() }, { type: 'CE', ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(leg.valid, false);
  assert.strictEqual(leg.reason, 'BELOW_INTRINSIC');
  assert.strictEqual(leg.ltp, null);
  assert.strictEqual(leg.intrinsic, 3000);
});

// 3. Valid ITM CE (premium ≥ intrinsic) → intrinsic + time value + Greeks.
test('VALID CE: premium ≥ intrinsic → timeValue + greeks', () => {
  const leg = validateLeg({ symbol: 'NIFTY...23000CE', strike: '23000', lastPrice: '1080', lastPriceUpdatedAt: fresh() }, { type: 'CE', ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(leg.valid, true);
  assert.strictEqual(leg.ltp, '1080');
  assert.strictEqual(leg.intrinsic, 1000);          // 24000−23000
  assert.strictEqual(leg.timeValue, 80);            // 1080−1000
  assert.ok(leg.iv > 0, 'IV computed');
  assert.ok(leg.delta > 0.5, 'ITM call delta > 0.5');
});

// 4. Stale tick → flagged stale (price still shown, but marked).
test('STALE: old tick → stale true', () => {
  const old = new Date(Date.now() - 60 * 1000);
  const leg = validateLeg({ symbol: 'X', strike: '24000', lastPrice: '150', lastPriceUpdatedAt: old }, { type: 'CE', ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(leg.stale, true);
  assert.ok(leg.ageSec >= 55);
});

// 5. Invalid IV (premium ≤ intrinsic-ish / no time value) → iv null ("N/A").
test('IV N/A: premium == intrinsic → iv null', () => {
  const leg = validateLeg({ symbol: 'X', strike: '23000', lastPrice: '1000', lastPriceUpdatedAt: fresh() }, { type: 'CE', ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(leg.valid, true);    // exactly intrinsic is allowed
  assert.strictEqual(leg.iv, null);       // no time value ⇒ IV unsolvable ⇒ N/A
});

// 6. PE intrinsic side.
test('VALID PE: OTM put (strike < ref) intrinsic 0', () => {
  const leg = validateLeg({ symbol: 'X', strike: '23000', lastPrice: '40', lastPriceUpdatedAt: fresh() }, { type: 'PE', ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(leg.intrinsic, 0);
  assert.strictEqual(leg.timeValue, 40);
  assert.ok(leg.delta < 0, 'put delta negative');
});

// 7. buildChain: ATM detection + monotonicity violation flagged (not fixed).
test('buildChain: ATM + CE monotonicity violation flagged', () => {
  const mk = (k, type, px) => ({ symbol: `N${k}${type}`, strike: String(k), optionType: type, expiryDate: EXP, lastPrice: String(px), lastPriceUpdatedAt: fresh() });
  const options = [
    mk(23900, 'CE', 220), mk(23950, 'CE', 250), // 250 > 220 as strike rises = CE violation
    mk(24000, 'CE', 180),
    mk(23900, 'PE', 150), mk(24000, 'PE', 200),
  ];
  const { rows, atm, integrity } = buildChain({ options, expiryIso: EXP, ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(atm, '24000');
  assert.strictEqual(rows.length, 3);
  assert.ok(integrity.ceMonotonicityViolations >= 1, 'CE violation detected');
});

// 8. Never emit 0 for a missing leg inside a built chain.
test('buildChain never emits 0 LTP for missing price', () => {
  const options = [{ symbol: 'Z', strike: '24000', optionType: 'CE', expiryDate: EXP, lastPrice: '0', lastPriceUpdatedAt: fresh() }];
  const { rows } = buildChain({ options, expiryIso: EXP, ref: REF, refExpiryMs: EXP_MS });
  assert.strictEqual(rows[0].ce.ltp, null);
});

console.log(`\n✓ option-chain validation: ${n} tests passed`);
