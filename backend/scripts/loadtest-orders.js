/**
 * Matching-engine load test — measures real order-placement throughput &
 * latency through the full stack (HTTP → auth → controller → MatchingEngine →
 * MongoDB). Dependency-free (Node 18+ built-in fetch).
 *
 * WHAT IT MEASURES
 *   - successful orders/sec (sustained throughput)
 *   - latency p50 / p95 / p99 / max
 *   - error + rate-limited breakdown
 *
 * IMPORTANT — the /api/trading/orders route is rate-limited to 60 orders/min
 * PER USER (env RATE_LIMIT_ORDERS_PER_MIN). To measure true engine capacity:
 *   • EITHER set a high limit on the server for the test:
 *       RATE_LIMIT_ORDERS_PER_MIN=100000  (restart backend)
 *   • AND/OR supply many users (each user has its own 60/min budget) via USERS.
 * If you see mostly "rateLimited", that's the limiter, not the engine.
 *
 * USAGE (env vars)
 *   BASE_URL   API base            (default http://localhost:5000/api)
 *   EMAIL,PASSWORD                 single test user, OR…
 *   USERS      "e1:p1,e2:p2,..."   multiple users (recommended)
 *   TOKENS     "tok1,tok2,..."     pre-issued access tokens (skip login)
 *   ACCOUNT_ID forced account id   (default: auto-pick DEMO/VIRTUAL, else first)
 *   SYMBOL     instrument          (default BTCUSD)
 *   QTY        order size          (default 0.001)
 *   LEVERAGE                       (default 100  → tiny margin per order)
 *   CONCURRENCY in-flight requests (default 20)
 *   DURATION   seconds             (default 10)
 *
 * EXAMPLE
 *   BASE_URL=http://localhost:5000/api EMAIL=trader@x.com PASSWORD=pass \
 *   SYMBOL=BTCUSD CONCURRENCY=30 DURATION=15 node scripts/loadtest-orders.js
 */
'use strict';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const SYMBOL = process.env.SYMBOL || 'BTCUSD';
const QTY = process.env.QTY || '0.001';
const LEVERAGE = Number(process.env.LEVERAGE) || 100;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 20;
const DURATION_MS = (Number(process.env.DURATION) || 10) * 1000;
const SYMBOLS = (process.env.SYMBOLS || '').split(',').map((s) => s.trim()).filter(Boolean); // multi-symbol aggregate test
let activeList = [];       // [{ symbol, qty }] resolved against live instruments

const log = (...a) => console.log(...a);
// Throw instead of process.exit() — an abrupt exit while fetch sockets are
// still closing triggers a libuv assertion on Windows. Let the event loop drain.
class FatalError extends Error {}
const die = (msg) => { throw new FatalError(msg); };

async function jpost(path, body, token) {
  const r = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
}
async function jget(path, token) {
  const r = await fetch(BASE_URL + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
}

async function login(email, password) {
  const { status, json } = await jpost('/auth/login', { email, password });
  const token = json?.data?.accessToken;
  if (status !== 200 || !token) die(`Login failed for ${email}: ${status} ${JSON.stringify(json?.error || json)}`);
  return token;
}

async function resolveAccount(token) {
  if (process.env.ACCOUNT_ID) return process.env.ACCOUNT_ID;
  const { json } = await jget('/user/accounts', token);
  const list = json?.data || [];
  if (!list.length) die('No trading accounts for this user — fund a demo account or pass ACCOUNT_ID.');
  // Prefer a tradable account: trading-enabled + active status.
  const tradable = list.filter((a) => a.isTradingEnabled !== false && (a.status ? a.status === 'ACTIVE' : true) && a.isActive !== false);
  const pool = tradable.length ? tradable : list;
  const demo = pool.find((a) => ['DEMO', 'VIRTUAL'].includes(a.accountType));
  const chosen = demo || pool[0];
  if (!tradable.length) log('   ⚠ no trading-enabled account found — using first (orders may be rejected). Enable trading in admin or pass ACCOUNT_ID.');
  log(`   account: ${chosen.accountNumber || chosen._id} (${chosen.accountType}, trading=${chosen.isTradingEnabled !== false})`);
  return String(chosen._id);
}

async function buildIdentities() {
  // Pre-issued tokens
  if (process.env.TOKENS) {
    const toks = process.env.TOKENS.split(',').map((s) => s.trim()).filter(Boolean);
    return Promise.all(toks.map(async (token) => ({ token, accountId: await resolveAccount(token) })));
  }
  // email:pass list
  if (process.env.USERS) {
    const pairs = process.env.USERS.split(',').map((s) => s.trim()).filter(Boolean);
    return Promise.all(pairs.map(async (p) => {
      const i = p.indexOf(':'); const email = p.slice(0, i); const pass = p.slice(i + 1);
      const token = await login(email, pass);
      return { token, accountId: await resolveAccount(token) };
    }));
  }
  // single user
  if (process.env.EMAIL && process.env.PASSWORD) {
    const token = await login(process.env.EMAIL, process.env.PASSWORD);
    return [{ token, accountId: await resolveAccount(token) }];
  }
  die('Provide EMAIL+PASSWORD, or USERS="e1:p1,e2:p2", or TOKENS="t1,t2".');
}

// Resolve tradable (active) instruments — the order path requires isActive:true.
// SYMBOLS="A,B,C" → multi-symbol aggregate (each symbol matches in parallel).
// Else the single SYMBOL (auto-falls back to first active). Quantity is bumped
// to each instrument's min order size.
async function resolveInstruments(token) {
  const { json } = await jget('/instruments', token);
  const list = json?.data || [];
  if (!list.length) { activeList = [{ symbol: SYMBOL, qty: QTY }]; return; }
  const actives = list.filter((i) => i.isActive !== false);
  const pool = actives.length ? actives : list;
  const qtyFor = (inst) => { const m = Number(inst.minOrderSize || inst.minVolume || inst.lotSize || 0); return (m && Number(QTY) < m) ? String(m) : QTY; };

  if (SYMBOLS.length) {
    const all = SYMBOLS.length === 1 && SYMBOLS[0].toUpperCase() === 'ALL';
    const want = new Set(SYMBOLS.map((s) => s.toUpperCase()));
    const picked = all ? pool : pool.filter((i) => want.has(String(i.symbol).toUpperCase()));
    if (!picked.length) die(`None of SYMBOLS=${SYMBOLS.join(',')} are active.`);
    activeList = picked.map((i) => ({ symbol: i.symbol, qty: qtyFor(i) }));
    return;
  }
  const want = SYMBOL.toUpperCase();
  const inst = pool.find((i) => String(i.symbol).toUpperCase() === want) || pool[0];
  if (String(inst.symbol).toUpperCase() !== want) log(`   ⚠ '${SYMBOL}' not active — using '${inst.symbol}' instead`);
  const q = qtyFor(inst);
  if (q !== QTY) log(`   ⚠ qty ${QTY} < min — using ${q} for ${inst.symbol}`);
  activeList = [{ symbol: inst.symbol, qty: q }];
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

(async () => {
  log(`\n⚡ Matching-engine load test`);
  log(`   ${BASE_URL}  symbol=${SYMBOL} qty=${QTY} lev=${LEVERAGE} concurrency=${CONCURRENCY} duration=${DURATION_MS / 1000}s`);
  const ids = await buildIdentities();
  await resolveInstruments(ids[0].token);
  log(`   identities: ${ids.length} user(s) · symbols: ${activeList.map((s) => s.symbol).join(', ')}\n`);

  const lat = [];
  let sent = 0, ok = 0, rate = 0, err = 0;
  const errSamples = {};
  let rr = 0;
  const deadline = Date.now() + DURATION_MS;

  const worker = async () => {
    while (Date.now() < deadline) {
      const idn = ids[rr % ids.length];
      const inst = activeList[rr % activeList.length]; // round-robin symbols → parallel matching
      rr++;
      const side = (sent % 2 === 0) ? 'BUY' : 'SELL'; // alternate to keep net exposure ~flat
      sent++;
      const t0 = performance.now();
      try {
        const { status, json } = await jpost('/trading/orders', {
          accountId: idn.accountId, symbol: inst.symbol, side, quantity: inst.qty, orderMode: 'MARKET', leverage: LEVERAGE,
        }, idn.token);
        lat.push(performance.now() - t0);
        if (status === 200 || status === 201) ok++;
        else if (status === 429 || json?.error?.code === 'RATE_LIMITED') rate++;
        else {
          err++;
          const c = json?.error?.code || `HTTP_${status}`;
          const msg = json?.error?.message || json?.message || '';
          if (!errSamples[c]) errSamples[c] = { n: 0, msg };
          errSamples[c].n++;
        }
      } catch (e) {
        lat.push(performance.now() - t0); err++;
        const c = e.code || 'NETWORK';
        if (!errSamples[c]) errSamples[c] = { n: 0, msg: e.message || '' };
        errSamples[c].n++;
      }
    }
  };

  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);

  log('──────── RESULTS ────────');
  log(`duration        ${secs.toFixed(2)} s`);
  log(`sent            ${sent}`);
  log(`ok              ${ok}   (${(ok / secs).toFixed(1)} orders/sec)`);
  log(`rate-limited    ${rate}${rate > ok ? '   ⚠ raise RATE_LIMIT_ORDERS_PER_MIN or add more USERS' : ''}`);
  log(`errors          ${err}`);
  for (const [code, { n, msg }] of Object.entries(errSamples)) log(`   • ${code} ×${n}  — ${msg}`);
  if (lat.length) {
    log(`latency p50     ${pct(lat, 50).toFixed(0)} ms`);
    log(`latency p95     ${pct(lat, 95).toFixed(0)} ms`);
    log(`latency p99     ${pct(lat, 99).toFixed(0)} ms`);
    log(`latency max     ${lat[lat.length - 1].toFixed(0)} ms`);
  }
  log('─────────────────────────\n');
  log('Tip: throughput here is end-to-end (incl. rate limit, HTTP, Mongo). For pure');
  log('engine capacity, set RATE_LIMIT_ORDERS_PER_MIN high + run multiple USERS.\n');
})().catch((e) => {
  console.error('\n✖', e instanceof Error ? e.message : e, '\n');
  process.exitCode = 1;
});
