/**
 * Unit tests for the shared inclusive date-range helper.
 * No framework — run with:  node backend/tests/dateRange.test.js
 * Exits 0 on pass, throws (non-zero) on first failure.
 *
 * Covers the reported bug: From == To must return the WHOLE day (00:00 → 23:59:59.999),
 * not nothing. Boundaries are server-LOCAL calendar days.
 */
const assert = require('assert');
const { localDayStart, nextDayStart, endOfDay, dateRangeFilter, applyDateRange, presetRange } = require('../src/utils/dateRange');

let n = 0;
const test = (name, fn) => { fn(); n += 1; console.log(`  ok  ${name}`); };
// A record falls in [$gte, $lt) — the exact predicate Mongo applies.
const inRange = (recDate, op) => (!op.$gte || recDate >= op.$gte) && (!op.$lt || recDate < op.$lt);

// 1. THE BUG: From == To returns the whole selected day.
test('From==To (22 Jul → 22 Jul) covers the entire day', () => {
  const op = dateRangeFilter('2026-07-22', '2026-07-22');
  assert.ok(op.$gte && op.$lt, 'both bounds present');
  assert.strictEqual(op.$lt.getTime() - op.$gte.getTime(), 24 * 60 * 60 * 1000, 'exactly one day wide');
  // start-of-day and last millisecond both inside; next day excluded
  assert.ok(inRange(localDayStart('2026-07-22'), op), '00:00:00.000 included');
  assert.ok(inRange(endOfDay('2026-07-22'), op), '23:59:59.999 included');
  assert.ok(!inRange(localDayStart('2026-07-23'), op), 'next-day 00:00 excluded');
  assert.ok(!inRange(new Date(localDayStart('2026-07-22').getTime() - 1), op), 'prev-day 23:59:59.999 excluded');
});

// 2. From < To spans both days inclusively.
test('22 Jul → 23 Jul covers both days', () => {
  const op = dateRangeFilter('2026-07-22', '2026-07-23');
  assert.ok(inRange(endOfDay('2026-07-22'), op), 'end of 22nd included');
  assert.ok(inRange(endOfDay('2026-07-23'), op), 'end of 23rd included');
  assert.ok(!inRange(localDayStart('2026-07-24'), op), '24th excluded');
});

// 3. Open-ended bounds.
test('only-from / only-to / neither', () => {
  assert.ok(dateRangeFilter('2026-07-22', null).$gte && !dateRangeFilter('2026-07-22', null).$lt, 'only from → $gte only');
  assert.ok(!dateRangeFilter(null, '2026-07-22').$gte && dateRangeFilter(null, '2026-07-22').$lt, 'only to → $lt only');
  assert.strictEqual(dateRangeFilter(null, null), null, 'neither → null (All Time)');
  assert.strictEqual(dateRangeFilter('', ''), null, 'empty strings → null');
});

// 4. applyDateRange assigns onto the named field, and is a no-op when absent.
test('applyDateRange assigns field / no-op when absent', () => {
  const f = {}; applyDateRange(f, 'closedAt', '2026-07-22', '2026-07-22');
  assert.ok(f.closedAt && f.closedAt.$gte && f.closedAt.$lt, 'closedAt range assigned');
  const g = { userId: 'x' }; applyDateRange(g, 'createdAt', undefined, undefined);
  assert.deepStrictEqual(g, { userId: 'x' }, 'no bounds → field untouched, other keys intact');
});

// 5. Records anywhere in the day (early + late, IST) are inside From==To.
test('records at 00:15 and 23:30 local both inside From==To', () => {
  const op = dateRangeFilter('2026-07-22', '2026-07-22');
  const early = new Date(localDayStart('2026-07-22').getTime() + 15 * 60000);        // 00:15
  const late = new Date(localDayStart('2026-07-22').getTime() + (23 * 60 + 30) * 60000); // 23:30
  assert.ok(inRange(early, op) && inRange(late, op), 'both inside');
});

// 6. Date-only string is parsed as LOCAL midnight (not UTC), and ISO inputs snap to their day.
test('local-day parse + ISO snap', () => {
  const s = localDayStart('2026-07-22');
  assert.strictEqual(s.getHours(), 0, 'local midnight');
  assert.strictEqual(s.getDate(), 22, 'same calendar day');
  assert.strictEqual(nextDayStart('2026-07-22').getDate(), 23, 'next day');
  assert.strictEqual(localDayStart(new Date(2026, 6, 22, 14, 30)).getHours(), 0, 'Date input snaps to day start');
});

// 7. Presets resolve to sane day-aligned ranges.
test('presets: today/yesterday/7d/month/year/all', () => {
  const now = new Date(2026, 6, 22, 15, 0, 0);
  const today = presetRange('today', now);
  assert.strictEqual(today.from.getDate(), 22);
  assert.strictEqual(presetRange('yesterday', now).from.getDate(), 21);
  assert.strictEqual(presetRange('7d', now).from.getDate(), 16, '7d = last 7 calendar days incl today');
  assert.strictEqual(presetRange('month', now).from.getDate(), 1, 'month → 1st');
  assert.strictEqual(presetRange('year', now).from.getMonth(), 0, 'year → January');
  assert.deepStrictEqual(presetRange('all', now), { from: null, to: null }, 'all → no bounds');
});

console.log(`\n${n} date-range tests passed.`);
