/**
 * k6 load test — places market orders concurrently against a running
 * backend, measures p95 latency and error rate.
 *
 * Setup:
 *   1. Backend up + seeded with at least 1 active instrument (BTCUSD by default).
 *   2. A test user with KYC=APPROVED and a wallet balance > 100,000.
 *   3. Set TOKEN env var to a valid JWT access token for that user.
 *   4. Set ACCOUNT_ID to the user's trading account id.
 *
 *   k6 run -e TOKEN=eyJh... -e ACCOUNT_ID=66a... tests/load/k6-orders.js
 *
 * Tunable via env:
 *   BASE_URL     default http://localhost:5000
 *   SYMBOL       default BTCUSD
 *   QTY          default 0.001
 *
 * Scenario: ramp 1→200 virtual users over 30s, hold 200 for 1 min,
 * ramp down. Expect ~10 orders/sec at peak. Each VU places 1 order
 * every 5 seconds — well under the 60/min rate-limit per user.
 *
 * Thresholds (test FAILS if breached):
 *   - p(95) order placement <500ms
 *   - error rate <1%
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const orderLatency = new Trend('order_latency_ms');

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up
    { duration: '1m',  target: 200 },  // peak
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:place_order}': ['p(95)<500'],
    errors: ['rate<0.01'],
  },
};

const BASE = __ENV.BASE_URL || 'http://localhost:5000';
const TOKEN = __ENV.TOKEN;
const ACCOUNT_ID = __ENV.ACCOUNT_ID;
const SYMBOL = __ENV.SYMBOL || 'BTCUSD';
const QTY = __ENV.QTY || '0.001';

if (!TOKEN || !ACCOUNT_ID) {
  throw new Error('Set TOKEN and ACCOUNT_ID env vars before running');
}

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${TOKEN}`,
};

export default function () {
  const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
  const payload = JSON.stringify({
    accountId: ACCOUNT_ID,
    symbol: SYMBOL,
    side,
    orderMode: 'MARKET',
    quantity: QTY,
    idempotencyKey: `k6-${__VU}-${__ITER}-${Date.now()}`,
  });

  const res = http.post(`${BASE}/api/trading/orders`, payload, {
    headers,
    tags: { name: 'place_order' },
  });

  const ok = check(res, {
    'status is 201': (r) => r.status === 201,
    'response has order id': (r) => {
      try { return !!JSON.parse(r.body).data?._id; } catch { return false; }
    },
  });

  errorRate.add(!ok);
  orderLatency.add(res.timings.duration);

  sleep(5); // 1 order per VU per 5s
}
