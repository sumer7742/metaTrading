/**
 * Broker module test suite — no network, no database.
 *
 * Run:  node tests/broker.test.js
 *
 * Covers the invariants that must not regress:
 *   encryption + AAD binding · idempotency · normalization contracts ·
 *   Dhan enum/error mapping · rate limiting · queue priority + retry ·
 *   redaction · validation · adapter contract · credential non-leakage
 */

process.env.NODE_ENV = 'test';
process.env.BROKER_ENCRYPTION_KEY = process.env.BROKER_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.BROKER_SYNC_ENABLED = 'false';
process.env.BROKER_LOG_PERSIST = 'false';

const assert = require('assert');

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
  }
}

function section(name) { results.push(`\n${name}`); }

(async () => {
  const brokerModule = require('../src/brokers');
  const registry = require('../src/brokers/registry');
  const constants = require('../src/brokers/constants');
  const normalize = require('../src/brokers/base/normalize');
  const { BrokerError, ERROR_CODE } = require('../src/brokers/base/BrokerError');
  const encryption = require('../src/services/broker/tokenEncryption.service');
  const idempotency = require('../src/services/broker/idempotency.service');
  const audit = require('../src/services/broker/brokerAudit.service');
  const schemas = require('../src/brokers/validation/schemas');
  const mappers = require('../src/brokers/dhan/mappers');
  const dhanErrors = require('../src/brokers/dhan/errors');
  const { RateLimiter } = require('../src/brokers/queue/RateLimiter');
  const { OrderQueue } = require('../src/brokers/queue/OrderQueue');
  const DhanAdapter = require('../src/brokers/dhan/DhanAdapter');

  brokerModule.init({ broadcaster: null, startSync: false });

  // ─── Registry ──────────────────────────────────────────────────────
  section('registry');

  await test('DHAN is registered', () => {
    assert.ok(registry.has('DHAN'));
    assert.ok(registry.codes().includes('DHAN'));
  });

  await test('catalogue exposes credential fields for the connect UI', () => {
    const dhan = registry.list().find((b) => b.code === 'DHAN');
    assert.deepStrictEqual(dhan.credentialFields.map((f) => f.key), ['clientId', 'accessToken']);
    assert.strictEqual(dhan.credentialFields[1].type, 'password');
  });

  await test('unknown broker throws UNKNOWN_BROKER, not a crash', () => {
    assert.throws(() => registry.get('NOPE'), (e) => e.code === ERROR_CODE.UNKNOWN_BROKER);
  });

  await test('unregistered auth mode is refused, never silently downgraded', () => {
    assert.throws(
      () => registry.createAuthProvider('DHAN', 'OAUTH'),
      (e) => e.code === ERROR_CODE.UNSUPPORTED_OPERATION
    );
  });

  // ─── Encryption ────────────────────────────────────────────────────
  section('credential encryption (AES-256-GCM)');
  const ctx = { userId: 'user-1', broker: 'DHAN' };
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.dhan-access-token-payload.signature';

  await test('round-trips and never stores plaintext', async () => {
    const e = await encryption.encrypt(TOKEN, ctx);
    assert.ok(e.payload.startsWith('v1.'));
    assert.ok(!e.payload.includes(TOKEN));
    assert.strictEqual(await encryption.decrypt(e.payload, ctx), TOKEN);
  });

  await test('IV is unique per encryption (no ciphertext reuse)', async () => {
    const a = await encryption.encrypt(TOKEN, ctx);
    const b = await encryption.encrypt(TOKEN, ctx);
    assert.notStrictEqual(a.payload, b.payload);
  });

  await test('AAD blocks grafting a ciphertext onto another user', async () => {
    const e = await encryption.encrypt(TOKEN, ctx);
    await assert.rejects(
      () => encryption.decrypt(e.payload, { userId: 'user-2', broker: 'DHAN' }),
      (err) => err.code === ERROR_CODE.ENCRYPTION_ERROR
    );
  });

  await test('AAD blocks reusing a ciphertext for another broker', async () => {
    const e = await encryption.encrypt(TOKEN, ctx);
    await assert.rejects(
      () => encryption.decrypt(e.payload, { userId: 'user-1', broker: 'UPSTOX' }),
      (err) => err.code === ERROR_CODE.ENCRYPTION_ERROR
    );
  });

  await test('tampered ciphertext fails the auth tag', async () => {
    const e = await encryption.encrypt(TOKEN, ctx);
    const parts = e.payload.split('.');
    parts[4] = parts[4].slice(0, -4) + 'AAAA';
    await assert.rejects(() => encryption.decrypt(parts.join('.'), ctx));
  });

  await test('mask() is the only externally safe representation', () => {
    const masked = encryption.mask(TOKEN);
    assert.ok(masked.startsWith('••••'));
    assert.ok(!masked.includes('dhan-access-token'));
    assert.strictEqual(masked.length, 14);
  });

  await test('fingerprint is stable and non-reversible', () => {
    const f = encryption.fingerprint(TOKEN);
    assert.strictEqual(f, encryption.fingerprint(TOKEN));
    assert.strictEqual(f.length, 16);
    assert.ok(!TOKEN.includes(f));
  });

  await test('describe() exposes no key material', () => {
    assert.ok(!JSON.stringify(encryption.describe()).includes(process.env.BROKER_ENCRYPTION_KEY));
  });

  // ─── Idempotency ───────────────────────────────────────────────────
  section('idempotency');

  await test('clientOrderId matches PX-YYYYMMDD-XXXXXXXX', () => {
    assert.ok(/^PX-\d{8}-[0-9A-F]{8}$/.test(idempotency.generateClientOrderId()));
  });

  await test('ids are unique across a burst', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => idempotency.generateClientOrderId()));
    assert.strictEqual(ids.size, 2000);
  });

  await test('a malformed client-supplied id is rejected', () => {
    assert.throws(() => idempotency.resolveClientOrderId('../../etc/passwd'), (e) => e.code === ERROR_CODE.VALIDATION_ERROR);
    assert.throws(() => idempotency.resolveClientOrderId('PX-2026-ZZ'), (e) => e.code === ERROR_CODE.VALIDATION_ERROR);
  });

  await test('a valid client-supplied id is preserved (retry safety)', () => {
    const id = 'PX-20260718-9F3A21C4';
    assert.strictEqual(idempotency.resolveClientOrderId(id), id);
    assert.strictEqual(idempotency.resolveClientOrderId(id.toLowerCase()), id);
  });

  await test('a completed order replays instead of resending', () => {
    const d = idempotency.replayDecision({
      status: constants.ORDER_STATUS.FILLED, broker: 'DHAN', clientOrderId: 'PX-20260718-9F3A21C4',
      brokerOrderId: '112233', response: { success: true, message: 'ok' },
    });
    assert.ok(d.replay);
    assert.ok(d.ack.duplicate);
    assert.strictEqual(d.ack.orderId, '112233');
  });

  await test('an order that never reached the broker may be retried', () => {
    const d = idempotency.replayDecision({ status: constants.ORDER_STATUS.FAILED });
    assert.strictEqual(d.replay, false);
    assert.ok(d.retryable);
  });

  // ─── Normalized contracts ──────────────────────────────────────────
  section('normalized responses');

  await test('order ack exposes exactly the agreed contract', () => {
    const ack = normalize.orderAck({ broker: 'DHAN', orderId: '1', clientOrderId: 'PX-20260718-9F3A21C4', status: 'BROKER_ACCEPTED' });
    for (const k of ['success', 'broker', 'orderId', 'status', 'message']) assert.ok(k in ack, `missing ${k}`);
  });

  await test('broker payloads cannot serialize into a response', () => {
    const p = normalize.position({ symbol: 'X', raw: { dhanInternal: 'SENSITIVE' } });
    assert.ok(!JSON.stringify(p).includes('SENSITIVE'));
    assert.ok(!Object.keys(p).includes('raw'));
    assert.deepStrictEqual(normalize.getRaw(p), { dhanInternal: 'SENSITIVE' }); // still available to audit
  });

  await test('string numbers and casing are normalized', () => {
    const p = normalize.position({ symbol: 'reliance', exchange: 'nse', qty: '10', averagePrice: '2,500.50', pnl: 'NA' });
    assert.strictEqual(p.symbol, 'RELIANCE');
    assert.strictEqual(p.exchange, 'NSE');
    assert.strictEqual(p.averagePrice, 2500.5);
    assert.strictEqual(p.pnl, 0);
  });

  await test('holding derives invested/current/pnl consistently', () => {
    const h = normalize.holding({ symbol: 'TCS', quantity: 10, averagePrice: 100, currentPrice: 110 });
    assert.strictEqual(h.investedValue, 1000);
    assert.strictEqual(h.currentValue, 1100);
    assert.strictEqual(h.pnl, 100);
    assert.strictEqual(h.pnlPercent, 10);
  });

  await test('funds always reports the three required fields', () => {
    const f = normalize.funds({});
    assert.strictEqual(f.availableCash, 0);
    assert.strictEqual(f.utilizedMargin, 0);
    assert.strictEqual(f.totalBalance, 0);
    assert.strictEqual(f.currency, 'INR');
  });

  // ─── Dhan mapping ──────────────────────────────────────────────────
  section('dhan translation');

  await test('exchange segments map both ways', () => {
    assert.strictEqual(mappers.toExchangeSegment('NSE'), 'NSE_EQ');
    assert.strictEqual(mappers.toExchangeSegment('NFO'), 'NSE_FNO');
    assert.strictEqual(mappers.toExchangeSegment('MCX'), 'MCX_COMM');
    assert.strictEqual(mappers.toExchangeSegment('NSE', 'INDEX'), 'IDX_I');
    assert.strictEqual(mappers.fromExchangeSegment('NSE_FNO'), 'NFO');
  });

  await test('DELIVERY ⇄ CNC (the mapping most likely to be got wrong)', () => {
    assert.strictEqual(mappers.toProductType('DELIVERY'), 'CNC');
    assert.strictEqual(mappers.fromProductType('CNC'), 'DELIVERY');
  });

  await test('order types map both ways', () => {
    assert.strictEqual(mappers.toOrderType('SL'), 'STOP_LOSS');
    assert.strictEqual(mappers.toOrderType('SL_M'), 'STOP_LOSS_MARKET');
    assert.strictEqual(mappers.fromOrderType('STOP_LOSS_MARKET'), 'SL_M');
  });

  await test('dhan statuses map onto the platform lifecycle', () => {
    const S = constants.ORDER_STATUS;
    assert.strictEqual(mappers.fromOrderStatus('TRANSIT'), S.BROKER_ACCEPTED);
    assert.strictEqual(mappers.fromOrderStatus('PENDING'), S.EXCHANGE_ACCEPTED);
    assert.strictEqual(mappers.fromOrderStatus('PART_TRADED'), S.PARTIALLY_FILLED);
    assert.strictEqual(mappers.fromOrderStatus('TRADED'), S.FILLED);
    assert.strictEqual(mappers.fromOrderStatus('REJECTED'), S.REJECTED);
  });

  await test('unsupported enums fail fast with VALIDATION_ERROR', () => {
    assert.throws(() => mappers.toExchangeSegment('NASDAQ'), (e) => e.code === ERROR_CODE.VALIDATION_ERROR);
    assert.throws(() => mappers.toProductType('SWING'), (e) => e.code === ERROR_CODE.VALIDATION_ERROR);
  });

  await test('clientOrderId travels to Dhan as correlationId', () => {
    const id = 'PX-20260718-9F3A21C4';
    const body = mappers.toPlaceOrderBody({
      clientOrderId: id, symbol: 'RELIANCE', exchange: 'NSE', securityId: '2885',
      side: 'BUY', qty: 10, orderType: 'LIMIT', productType: 'DELIVERY', price: 2500,
    }, '1100112233');
    assert.strictEqual(body.correlationId, id);
    assert.strictEqual(body.productType, 'CNC');
    assert.strictEqual(body.quantity, 10);
  });

  await test('placing without a resolved security id is refused', () => {
    assert.throws(
      () => mappers.toPlaceOrderBody({ symbol: 'X', exchange: 'NSE', side: 'BUY', qty: 1, orderType: 'MARKET', productType: 'INTRADAY' }, '1'),
      (e) => e.code === ERROR_CODE.SYMBOL_NOT_FOUND
    );
  });

  // ─── Error normalization ───────────────────────────────────────────
  section('error normalization');

  await test('dhan error codes map to platform codes', () => {
    assert.strictEqual(dhanErrors.fromResponse(401, { errorCode: 'DH-901' }).code, ERROR_CODE.INVALID_TOKEN);
    assert.strictEqual(dhanErrors.fromResponse(403, { errorCode: 'DH-902' }).code, ERROR_CODE.BROKER_UNAUTHORIZED);
    assert.strictEqual(dhanErrors.fromResponse(429, { errorCode: 'DH-904' }).code, ERROR_CODE.RATE_LIMIT);
    assert.strictEqual(dhanErrors.fromResponse(500, {}).code, ERROR_CODE.BROKER_OFFLINE);
  });

  await test('free-text rejections are classified by meaning', () => {
    assert.strictEqual(dhanErrors.fromRejection({ omsErrorDescription: 'Insufficient margin' }).code, ERROR_CODE.MARGIN_ERROR);
    assert.strictEqual(dhanErrors.fromRejection({ omsErrorDescription: 'Quantity exceeds freeze limit' }).code, ERROR_CODE.QUANTITY_ERROR);
    assert.strictEqual(dhanErrors.fromRejection({ omsErrorDescription: 'Price is outside the circuit band' }).code, ERROR_CODE.PRICE_ERROR);
    assert.strictEqual(dhanErrors.fromRejection({ omsErrorDescription: 'Market is closed' }).code, ERROR_CODE.MARKET_CLOSED);
  });

  await test('transport failures are classified, not swallowed as 500', () => {
    assert.strictEqual(BrokerError.from({ name: 'AbortError' }).code, ERROR_CODE.TIMEOUT);
    assert.strictEqual(BrokerError.from({ code: 'ECONNREFUSED' }).code, ERROR_CODE.NETWORK_FAILURE);
    assert.strictEqual(BrokerError.from(new Error('fetch failed')).code, ERROR_CODE.NETWORK_FAILURE);
    assert.strictEqual(BrokerError.from({ code: 11000 }).code, ERROR_CODE.DUPLICATE_ORDER);
  });

  await test('only transient failures are retryable', () => {
    assert.ok(new BrokerError(ERROR_CODE.RATE_LIMIT).retryable);
    assert.ok(new BrokerError(ERROR_CODE.TIMEOUT).retryable);
    assert.ok(!new BrokerError(ERROR_CODE.MARGIN_ERROR).retryable);
    assert.ok(!new BrokerError(ERROR_CODE.INVALID_TOKEN).retryable);
  });

  await test('the error response carries no broker payload', () => {
    const r = dhanErrors.fromResponse(500, { errorCode: 'DH-908', internal: 'stack trace' }).toResponse();
    assert.deepStrictEqual(Object.keys(r).sort(), ['broker', 'code', 'details', 'message', 'retryable', 'success'].sort());
    assert.ok(!JSON.stringify(r).includes('stack trace'));
  });

  // ─── Rate limiting ─────────────────────────────────────────────────
  section('rate limiter');

  await test('admits up to the limit, then throttles', () => {
    const rl = new RateLimiter({ broker: 'T', limits: { orders: { perSecond: 3 } } });
    assert.ok(rl.tryAcquire('orders').ok);
    assert.ok(rl.tryAcquire('orders').ok);
    assert.ok(rl.tryAcquire('orders').ok);
    const r = rl.tryAcquire('orders');
    assert.strictEqual(r.ok, false);
    assert.ok(r.retryAfterMs > 0 && r.retryAfterMs <= 1000);
  });

  await test('every configured window must admit', () => {
    const rl = new RateLimiter({ broker: 'T', limits: { orders: { perSecond: 100, perMinute: 2 } } });
    assert.ok(rl.tryAcquire('orders').ok);
    assert.ok(rl.tryAcquire('orders').ok);
    assert.strictEqual(rl.tryAcquire('orders').ok, false, 'per-minute cap must bind');
  });

  await test('acquire() waits for a slot instead of failing', async () => {
    const rl = new RateLimiter({ broker: 'T', limits: { orders: { perSecond: 2 } } });
    rl.tryAcquire('orders'); rl.tryAcquire('orders');
    const t = Date.now();
    await rl.acquire('orders', { timeoutMs: 3000 });
    assert.ok(Date.now() - t > 500, 'should have waited for the window');
  });

  await test('acquire() gives up with RATE_LIMIT past its budget', async () => {
    const rl = new RateLimiter({ broker: 'T', limits: { orders: { perSecond: 1 } } });
    rl.tryAcquire('orders');
    await assert.rejects(() => rl.acquire('orders', { timeoutMs: 50 }), (e) => e.code === ERROR_CODE.RATE_LIMIT);
  });

  await test('brokers are limited independently', () => {
    const { RateLimiterRegistry } = require('../src/brokers/queue/RateLimiter');
    const reg = new RateLimiterRegistry();
    const a = reg.for('DHAN', { orders: { perSecond: 1 } });
    const b = reg.for('UPSTOX', { orders: { perSecond: 1 } });
    assert.ok(a.tryAcquire('orders').ok);
    assert.strictEqual(a.tryAcquire('orders').ok, false);
    assert.ok(b.tryAcquire('orders').ok, 'a DHAN burst must not throttle UPSTOX');
  });

  // ─── Queue ─────────────────────────────────────────────────────────
  section('order queue');

  await test('higher priority runs first, FIFO within a level', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1 });
    const seen = [];
    await Promise.all([
      q.enqueue(async () => seen.push('n1'), { priority: constants.PRIORITY.NORMAL }),
      q.enqueue(async () => seen.push('n2'), { priority: constants.PRIORITY.NORMAL }),
      q.enqueue(async () => seen.push('cancel'), { priority: constants.PRIORITY.HIGH }),
    ]);
    assert.deepStrictEqual(seen, ['cancel', 'n1', 'n2']);
  });

  await test('retries transient failures then succeeds', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1, baseBackoffMs: 5 });
    let n = 0;
    const out = await q.enqueue(async () => {
      if (++n < 3) throw new BrokerError(ERROR_CODE.NETWORK_FAILURE);
      return 'ok';
    }, { maxRetries: 3 });
    assert.strictEqual(out, 'ok');
    assert.strictEqual(n, 3);
  });

  await test('never retries a deterministic rejection', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1, baseBackoffMs: 5 });
    let n = 0;
    await assert.rejects(() => q.enqueue(async () => { n++; throw new BrokerError(ERROR_CODE.MARGIN_ERROR); }, { maxRetries: 5 }));
    assert.strictEqual(n, 1, 'a margin rejection must not be retried');
  });

  await test('rejects with QUEUE_OVERFLOW instead of unbounded growth', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1, maxQueueSize: 2 });
    const hold = new Promise((r) => setTimeout(r, 60));
    q.enqueue(() => hold); q.enqueue(() => hold);
    await assert.rejects(() => q.enqueue(async () => 1), (e) => e.code === ERROR_CODE.QUEUE_OVERFLOW);
    await hold;
  });

  await test('concurrency cap is honoured', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 2 });
    let inFlight = 0; let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => q.enqueue(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
    })));
    assert.strictEqual(peak, 2);
  });

  await test('drain lets already-queued work finish', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1 });
    const done = [];
    const a = q.enqueue(async () => { await new Promise((r) => setTimeout(r, 10)); done.push('a'); });
    const b = q.enqueue(async () => { done.push('b'); });
    await q.drain(1000);
    await Promise.all([a, b]);
    assert.deepStrictEqual(done, ['a', 'b']);
  });

  await test('drain refuses NEW work once shutdown starts', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1 });
    const inFlight = q.enqueue(async () => new Promise((r) => setTimeout(r, 30)));
    const drained = q.drain(500);
    await assert.rejects(
      () => q.enqueue(async () => 'too late'),
      (e) => e.code === ERROR_CODE.BROKER_OFFLINE
    );
    await inFlight; await drained;
  });

  await test('drain fails work still queued at the deadline (never hangs)', async () => {
    const q = new OrderQueue({ broker: 'T', concurrency: 1 });
    const slow = q.enqueue(async () => new Promise((r) => setTimeout(r, 400)));
    const stuck = q.enqueue(async () => 'never runs');
    await q.drain(60); // deadline passes while `slow` is still running
    await assert.rejects(() => stuck, (e) => e.code === ERROR_CODE.BROKER_OFFLINE);
    await slow;
  });

  // ─── Redaction ─────────────────────────────────────────────────────
  section('audit redaction');

  await test('credential-shaped keys are redacted at any depth', () => {
    const out = audit.redact({ a: { b: { accessToken: 'X', clientSecret: 'Y', keep: 'Z' } } });
    assert.strictEqual(out.a.b.accessToken, '[REDACTED]');
    assert.strictEqual(out.a.b.clientSecret, '[REDACTED]');
    assert.strictEqual(out.a.b.keep, 'Z');
  });

  await test('token-shaped VALUES are redacted under innocent key names', () => {
    const out = audit.redact({
      value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpM',
      note: 'invalid token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghij',
      opaque: 'A'.repeat(80),
    });
    assert.strictEqual(out.value, '[REDACTED]');
    assert.strictEqual(out.note, '[REDACTED]', 'a token embedded in a message must be redacted');
    assert.strictEqual(out.opaque, '[REDACTED]');
  });

  await test('ordinary trade data survives redaction', () => {
    const out = audit.redact({ symbol: 'RELIANCE', qty: 10, price: 2500.5, side: 'BUY' });
    assert.deepStrictEqual(out, { symbol: 'RELIANCE', qty: 10, price: 2500.5, side: 'BUY' });
  });

  await test('redaction does not mutate the caller’s object', () => {
    const input = { accessToken: 'secret' };
    audit.redact(input);
    assert.strictEqual(input.accessToken, 'secret');
  });

  // ─── Validation ────────────────────────────────────────────────────
  section('request validation');

  await test('coerces and normalizes a valid order', () => {
    const r = schemas.placeOrder.parse({ symbol: 'reliance', exchange: 'nse', side: 'buy', qty: '10', orderType: 'market', productType: 'intraday' });
    assert.strictEqual(r.symbol, 'RELIANCE');
    assert.strictEqual(r.qty, 10);
    assert.strictEqual(r.validity, 'DAY');
    assert.strictEqual(r.amo, false);
  });

  await test('rejects unknown fields (a typo must not become a default)', () => {
    const r = schemas.placeOrder.safeParse({ symbol: 'X', exchange: 'NSE', side: 'BUY', qty: 1, orderType: 'MARKET', productType: 'INTRADAY', quantity: 999 });
    assert.strictEqual(r.success, false);
  });

  await test('rejects fractional, zero and negative quantities', () => {
    for (const bad of [0, -5, 1.5]) {
      const r = schemas.placeOrder.safeParse({ symbol: 'X', exchange: 'NSE', side: 'BUY', qty: bad, orderType: 'MARKET', productType: 'INTRADAY' });
      assert.strictEqual(r.success, false, `qty ${bad} should be rejected`);
    }
  });

  await test('"false" in a query string stays false', () => {
    // z.coerce.boolean() would make this true and silently bypass the cache.
    assert.strictEqual(schemas.portfolioQuery.parse({ force: 'false' }).force, false);
    assert.strictEqual(schemas.portfolioQuery.parse({ force: '0' }).force, false);
    assert.strictEqual(schemas.portfolioQuery.parse({ force: 'true' }).force, true);
    assert.strictEqual(schemas.portfolioQuery.parse({ force: '1' }).force, true);
    assert.strictEqual(schemas.portfolioQuery.parse({}).force, false);
  });

  await test('modify requires at least one field', () => {
    assert.strictEqual(schemas.modifyOrder.safeParse({}).success, false);
    assert.strictEqual(schemas.modifyOrder.safeParse({ price: 100 }).success, true);
  });

  await test('symbol list parsing handles per-symbol exchanges', () => {
    assert.deepStrictEqual(
      schemas.parseSymbolList('reliance:nse, tcs ,infy:bse', 'NSE'),
      [{ symbol: 'RELIANCE', exchange: 'NSE' }, { symbol: 'TCS', exchange: 'NSE' }, { symbol: 'INFY', exchange: 'BSE' }]
    );
  });

  // ─── Adapter contract ──────────────────────────────────────────────
  section('adapter contract');
  const adapter = new DhanAdapter({
    broker: 'DHAN', userId: 'u1',
    credentials: { accessToken: 'x'.repeat(60), brokerClientId: '1100112233' },
  });

  await test('implements every interface method', () => {
    for (const m of ['connect', 'disconnect', 'placeOrder', 'modifyOrder', 'cancelOrder',
      'positions', 'holdings', 'funds', 'orders', 'history', 'quotes', 'marketStatus', 'subscribeOrderUpdates']) {
      assert.strictEqual(typeof adapter[m], 'function', `missing ${m}`);
    }
  });

  await test('declares capabilities honestly', () => {
    assert.ok(adapter.supports('placeOrder'));
    assert.ok(adapter.supports('orderStream'));
    assert.strictEqual(adapter.supports('tickStream'), false);
    assert.throws(() => adapter.assertSupports('tickStream'), (e) => e.code === ERROR_CODE.UNSUPPORTED_OPERATION);
  });

  await test('credentials never serialize out of an adapter', () => {
    const s = JSON.stringify(adapter);
    assert.ok(!s.includes('1100112233'), 'broker client id leaked');
    assert.ok(!s.includes('xxxx'), 'access token leaked');
    assert.ok(!Object.keys(adapter).includes('credentials'));
  });

  await test('market status comes from the platform exchange calendar', async () => {
    const [nse] = await adapter.marketStatus('NSE');
    assert.strictEqual(nse.exchange, 'NSE');
    assert.ok(['OPEN', 'PRE_OPEN', 'CLOSED', 'HOLIDAY', 'WEEKEND'].includes(nse.state));
    assert.strictEqual(nse.timezone, 'Asia/Kolkata');
  });

  await test('an unimplemented base method fails with UNSUPPORTED_OPERATION', async () => {
    const BrokerAdapter = require('../src/brokers/base/BrokerAdapter');
    class Bare extends BrokerAdapter {}
    const bare = new Bare({ broker: 'TEST' });
    await assert.rejects(() => bare.placeOrder({}), (e) => e.code === ERROR_CODE.UNSUPPORTED_OPERATION);
  });

  // ─── Lifecycle rules ───────────────────────────────────────────────
  section('order lifecycle');

  await test('terminal states are recognised', () => {
    assert.ok(constants.isTerminal(constants.ORDER_STATUS.FILLED));
    assert.ok(constants.isTerminal(constants.ORDER_STATUS.REJECTED));
    assert.ok(!constants.isTerminal(constants.ORDER_STATUS.QUEUED));
  });

  await test('status ranks prevent moving backwards', () => {
    const S = constants.ORDER_STATUS;
    const R = constants.STATUS_RANK;
    assert.ok(R[S.QUEUED] > R[S.CREATED]);
    assert.ok(R[S.FILLED] > R[S.EXCHANGE_ACCEPTED]);
    assert.ok(R[S.EXCHANGE_ACCEPTED] < R[S.FILLED], 'a late EXCHANGE_ACCEPTED must not overwrite FILLED');
  });

  await test('every status has a timeline field', () => {
    for (const s of constants.ORDER_STATUSES) {
      assert.ok(constants.STATUS_TIMELINE_FIELD[s], `no timeline field for ${s}`);
    }
  });

  // ─── Health ────────────────────────────────────────────────────────
  section('module health');

  await test('health reports state without leaking secrets', () => {
    const h = brokerModule.health();
    assert.ok(h.initialized);
    assert.strictEqual(h.encryption.algorithm, 'aes-256-gcm');
    assert.ok(!JSON.stringify(h).includes(process.env.BROKER_ENCRYPTION_KEY));
  });

  await brokerModule.shutdown();

  // ─── Report ────────────────────────────────────────────────────────
  console.log(results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(results.join('\n'));
  console.error('\nSUITE CRASHED:', e.stack || e.message);
  process.exit(1);
});
