/**
 * Full chart pipeline test — for every active instrument, verifies the
 * data flow the PriceChart component depends on:
 *
 *   1. Candles endpoint returns enough rows per timeframe
 *   2. Candles are well-formed (monotonic time, valid OHLC)
 *   3. lastPrice is recent (< 60s old) — live feed firing
 *   4. Order-book snapshot returns sensible shape
 *   5. Watchlist row has every field the UI consumes
 *
 * Run: node src/utils/testCharts.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const Instrument = require('../models/Instrument');
const Candle = require('../models/Candle');
const matchingEngine = require('../matching-engine/MatchingEngine');

const TF_OPTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'];
const NEED_MIN_CANDLES = 50; // chart needs at least this for indicators to render
const STALE_THRESHOLD_SECS = 60;

const pad = (s, n) => String(s).padEnd(n);

const ageSecs = (date) => {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / 1000);
};

const fmtAge = (secs) => {
  if (!Number.isFinite(secs) || secs === Infinity) return 'never';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
};

const checkCandles = (rows, symbol, tf) => {
  if (!rows.length) return { ok: false, reason: `no ${tf} candles` };
  if (rows.length < NEED_MIN_CANDLES) {
    return { ok: false, reason: `only ${rows.length}/${NEED_MIN_CANDLES} ${tf} candles` };
  }
  // Monotonic time check
  for (let i = 1; i < rows.length; i++) {
    if (new Date(rows[i].openTime).getTime() <= new Date(rows[i - 1].openTime).getTime()) {
      return { ok: false, reason: `non-monotonic time at row ${i} (${tf})` };
    }
  }
  // Validity check on first + last
  for (const c of [rows[0], rows[rows.length - 1]]) {
    const O = Number(c.open), H = Number(c.high), L = Number(c.low), C = Number(c.close);
    if (![O, H, L, C].every(Number.isFinite)) {
      return { ok: false, reason: `non-numeric OHLC at ${tf}` };
    }
    if (H < L || H < O || H < C || L > O || L > C) {
      return { ok: false, reason: `OHLC invariant violated (${tf}: O=${O},H=${H},L=${L},C=${C})` };
    }
  }
  return { ok: true };
};

(async () => {
  await connectDB();
  const instruments = await Instrument.find({ isActive: true }).sort({ symbol: 1 }).lean();
  console.log(`\nTesting ${instruments.length} active instruments\n`);

  let passSymbols = 0;
  let failSymbols = 0;
  const allFailures = [];

  for (const inst of instruments) {
    const failures = [];
    const symbol = inst.symbol;

    // 1) Live-tick age
    const age = ageSecs(inst.lastPriceUpdatedAt);
    if (age > STALE_THRESHOLD_SECS) {
      failures.push(`live feed stale (lastPrice ${fmtAge(age)} old)`);
    }
    if (!inst.lastPrice || Number(inst.lastPrice) <= 0) {
      failures.push(`lastPrice missing/zero`);
    }

    // 2) Candles per timeframe — chart fetches `1m` by default; we also
    // check higher TFs that the TF segmented control exposes.
    const candleResults = {};
    for (const tf of TF_OPTIONS) {
      const rows = await Candle.find({ symbol, timeframe: tf })
        .sort({ openTime: 1 })
        .limit(500)
        .lean();
      const check = checkCandles(rows, symbol, tf);
      candleResults[tf] = { count: rows.length, ok: check.ok, reason: check.reason };
      if (!check.ok && tf === '1m') {
        // 1m is the chart's default — failure here is critical
        failures.push(`1m candles: ${check.reason}`);
      } else if (!check.ok) {
        // Other TFs aren't critical — chart can still render 1m
        failures.push(`${tf} candles: ${check.reason}`);
      }
    }

    // 3) Order-book snapshot via the matching engine — should at least
    // return a valid shape even if internal book is empty.
    const ob = matchingEngine.getSnapshot(symbol, 25);
    if (!ob || !Array.isArray(ob.bids) || !Array.isArray(ob.asks)) {
      failures.push(`order book snapshot malformed`);
    }

    // 4) Watchlist field shape — the MarketWatch row reads these fields
    // by name; missing ones break the UI silently.
    const watchlistFields = ['symbol', 'pricePrecision', 'lastPrice', 'baseCurrency', 'quoteCurrency'];
    for (const f of watchlistFields) {
      if (inst[f] === undefined || inst[f] === null) {
        failures.push(`missing field "${f}"`);
      }
    }

    // Print row summary
    const cdlSummary = TF_OPTIONS.map((tf) =>
      `${tf}:${candleResults[tf].count}${candleResults[tf].ok ? '' : '✗'}`
    ).join(' ');
    const statusIcon = failures.length === 0 ? '✓' : '✗';
    console.log(
      `${statusIcon} ${pad(symbol, 9)} age=${pad(fmtAge(age), 6)} ${cdlSummary}`
    );
    if (failures.length === 0) passSymbols++;
    else {
      failSymbols++;
      for (const f of failures) {
        allFailures.push(`  ${symbol}: ${f}`);
      }
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`✓ Pass: ${passSymbols}/${instruments.length}`);
  console.log(`✗ Fail: ${failSymbols}/${instruments.length}`);
  if (allFailures.length) {
    console.log('\n=== FAILURES ===');
    for (const f of allFailures) console.log(f);
  }

  process.exit(failSymbols === 0 ? 0 : 1);
})().catch((e) => { console.error('Test runner error:', e); process.exit(2); });
