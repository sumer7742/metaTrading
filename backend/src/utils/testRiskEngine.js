/**
 * Test the riskEngine classification + HYBRID routing decision in
 * isolation. Stubs User + Position lookups so we can simulate any
 * trader history without polluting the DB.
 *
 * What we're proving:
 *   - A trader with winRate >= 60% AND profitFactor >= 2 over 10+ closed
 *     positions is classified PROFITABLE.
 *   - When HYBRID mode hits a PROFITABLE trader → A_BOOK.
 *   - Same applies to SUSPICIOUS (winRate >= 80% over 30+) and to users
 *     forced via riskOverride.forceABook / userGroup VIP / NO_BBOOK.
 *   - LOSING / NEW / AVERAGE traders stay on B_BOOK.
 *   - Large notional orders ALSO get routed to A regardless of profile.
 *
 * Run: node src/utils/testRiskEngine.js
 */
const path = require('path');

const stub = {
  user: null,
  closedPositions: [],
  openPositions: [],
};

const stubAt = (absPath, exports) => {
  require.cache[absPath] = {
    id: absPath, filename: absPath, loaded: true, exports, children: [], paths: [],
  };
};

const modelsDir = path.join(__dirname, '..', 'models');

stubAt(path.join(modelsDir, 'User.js'), {
  findById: () => ({ select: () => ({ lean: async () => stub.user }) }),
});
stubAt(path.join(modelsDir, 'Position.js'), {
  find: (filter) => ({
    select: () => ({
      lean: async () => filter?.status === 'CLOSED' ? stub.closedPositions : stub.openPositions,
    }),
  }),
});

const riskEngine = require('../services/riskEngine.service');

let pass = 0;
let fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const assertEq = (got, want, msg) => {
  if (got !== want) throw new Error(`${msg || 'mismatch'}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// Helpers to fabricate trader histories.
//   - winRate is fraction (0–1)
//   - avg wins/losses can be tuned to hit profitFactor thresholds
const makeHistory = ({ count, winRate, avgWin = 100, avgLoss = 50 }) => {
  const winners = Math.round(count * winRate);
  const losers = count - winners;
  const positions = [];
  for (let i = 0; i < winners; i++) positions.push({ realizedPnl: String(avgWin) });
  for (let i = 0; i < losers; i++) positions.push({ realizedPnl: String(-avgLoss) });
  return positions;
};

const seed = (over = {}) => {
  stub.user = { userGroup: 'DEFAULT', riskOverride: {}, ...over.user };
  stub.closedPositions = over.closedPositions || [];
  stub.openPositions = over.openPositions || [];
};

const instrument = { symbol: 'BTCUSD', lastPrice: '100' };
const smallOrder = { quantity: '1', price: '100', side: 'BUY' }; // notional 100, well below 50k threshold

// ─── Tests ────────────────────────────────────────────────────────────

test('NEW trader (<10 closed) → B_BOOK', async () => {
  seed({ closedPositions: makeHistory({ count: 5, winRate: 0.8 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'B_BOOK', 'new trader stays B');
});

test('PROFITABLE trader (winRate 70%, PF=2.8) → A_BOOK', async () => {
  // 14 wins × 100, 6 losses × 50 → totalWin=1400, totalLoss=300, PF=4.67
  seed({ closedPositions: makeHistory({ count: 20, winRate: 0.7, avgWin: 100, avgLoss: 50 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'A_BOOK', 'profitable trader → A');
  if (!r.reason.includes('PROFITABLE')) throw new Error(`unexpected reason: ${r.reason}`);
});

test('AVERAGE trader (winRate 50%, PF=1) → B_BOOK', async () => {
  // 10 wins × 100, 10 losses × 100 → PF=1
  seed({ closedPositions: makeHistory({ count: 20, winRate: 0.5, avgWin: 100, avgLoss: 100 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'B_BOOK', 'average trader stays B');
});

test('LOSING trader (winRate 20%, PF=0.25) → B_BOOK (broker keeps the loss)', async () => {
  // 4 wins × 100, 16 losses × 100 → PF=0.25
  seed({ closedPositions: makeHistory({ count: 20, winRate: 0.2, avgWin: 100, avgLoss: 100 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'B_BOOK', 'losing trader stays B');
});

test('SUSPICIOUS trader (winRate 90% over 40 trades) → A_BOOK', async () => {
  seed({ closedPositions: makeHistory({ count: 40, winRate: 0.9 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'A_BOOK', 'suspicious trader → A');
  if (!r.reason.includes('SUSPICIOUS')) throw new Error(`unexpected reason: ${r.reason}`);
});

test('VIP user group → A_BOOK (NO_BBOOK shortcut, no history needed)', async () => {
  seed({ user: { userGroup: 'VIP' }, closedPositions: makeHistory({ count: 5, winRate: 0.3 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'A_BOOK', 'VIP → A');
});

test('forceABook override → A_BOOK (even for a losing trader)', async () => {
  seed({
    user: { riskOverride: { forceABook: true } },
    closedPositions: makeHistory({ count: 50, winRate: 0.1 }),
  });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'A_BOOK', 'forced A wins');
});

test('Large notional (>50k) → A_BOOK regardless of trader profile', async () => {
  // Losing trader but the order itself is large.
  seed({ closedPositions: makeHistory({ count: 20, winRate: 0.2 }) });
  const bigOrder = { quantity: '1000', price: '100', side: 'BUY' }; // notional 100k
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: bigOrder });
  assertEq(r.book, 'A_BOOK', 'large notional → A');
  if (!r.reason.includes('notional')) throw new Error(`expected notional reason: ${r.reason}`);
});

test('Edge: PROFITABLE threshold exactly met (winRate=60%, PF=2)', async () => {
  // 6 wins × 200, 4 losses × 150 → totalWin=1200, totalLoss=600, PF=2.0, winRate=60%
  seed({ closedPositions: makeHistory({ count: 10, winRate: 0.6, avgWin: 200, avgLoss: 150 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'A_BOOK', 'edge profitable → A');
});

test('Edge: just below threshold (winRate=55%) → AVERAGE → B_BOOK', async () => {
  seed({ closedPositions: makeHistory({ count: 20, winRate: 0.55, avgWin: 200, avgLoss: 100 }) });
  const r = await riskEngine.decideHybridRoute({ userId: 'u', instrument, order: smallOrder });
  assertEq(r.book, 'B_BOOK', 'just-below-threshold stays B');
});

// ─── Runner ───────────────────────────────────────────────────────────

(async () => {
  console.log(`Running ${cases.length} riskEngine tests…\n`);
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
      pass++;
    } catch (e) {
      console.error(`  ✗ ${c.name}`);
      console.error(`      ${e.message}`);
      fail++;
    }
  }
  console.log(`\n${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ''}`);
  process.exit(fail ? 1 : 0);
})();
