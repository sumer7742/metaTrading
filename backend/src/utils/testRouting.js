/**
 * Logic-level tests for the GLOBAL routing layer.
 *
 * No DB — external dependencies (TradingAccount, Instrument, User,
 * matchingEngine, LP adapter, systemSettings) are stubbed via
 * require.cache injection BEFORE the router is loaded.
 *
 * The routing decision now reads a global SystemSetting, NOT per-account
 * bookType. Each test seeds the global routingMode via the stub before
 * calling routeOrder.
 *
 * Run: node src/utils/testRouting.js
 * Exits 0 if all pass, 1 otherwise.
 */
const path = require('path');

// Mutable test state — each scenario re-seeds these before calling routeOrder.
const stub = {
  account: null,
  instrument: null,
  user: null,
  routingMode: 'B_BOOK',
  defaultLpProvider: 'NONE',
  lastSubmittedOrder: null,
  lastLpRequest: null,
  matchingResult: { status: 'FILLED' },
  lpResult: {
    provider: 'OANDA',
    providerOrderId: 'TEST-1',
    status: 'FILLED',
    avgFillPrice: '100',
    filledQuantity: '1',
  },
};

const fakeModule = (filename, exports) => ({
  id: filename,
  filename,
  loaded: true,
  exports,
  children: [],
  paths: [],
});

const stubAt = (absPath, exports) => {
  require.cache[absPath] = fakeModule(absPath, exports);
};

const modelsDir = path.join(__dirname, '..', 'models');
const servicesDir = path.join(__dirname, '..', 'services');
const engineDir = path.join(__dirname, '..', 'matching-engine');

stubAt(path.join(modelsDir, 'TradingAccount.js'), {
  findById: async () => stub.account,
});
stubAt(path.join(modelsDir, 'Instrument.js'), {
  findById: async () => stub.instrument,
});
stubAt(path.join(modelsDir, 'User.js'), {
  findById: () => ({ select: () => ({ lean: async () => stub.user }) }),
});
stubAt(path.join(modelsDir, 'Position.js'), {
  find: () => ({ select: () => ({ lean: async () => [] }) }),
});

// Global routing setting is now sourced from systemSettings.service.
// We replace the whole module so getSetting() returns the test's
// preconfigured routingMode / defaultLpProvider without DB.
stubAt(path.join(servicesDir, 'systemSettings.service.js'), {
  getSetting: async (key) => {
    if (key === 'routingMode') return stub.routingMode;
    if (key === 'defaultLpProvider') return stub.defaultLpProvider;
    return null;
  },
  getSettingSync: (key) => {
    if (key === 'routingMode') return stub.routingMode;
    if (key === 'defaultLpProvider') return stub.defaultLpProvider;
    return null;
  },
  setSetting: async () => {},
  getAllSettings: async () => ({ routingMode: stub.routingMode, defaultLpProvider: stub.defaultLpProvider }),
  warmCache: async () => {},
  DEFAULTS: { routingMode: 'B_BOOK', defaultLpProvider: 'NONE' },
});

stubAt(path.join(engineDir, 'MatchingEngine.js'), {
  submit: async (o) => {
    stub.lastSubmittedOrder = o;
    return { ...o, ...stub.matchingResult };
  },
  cancel: async () => ({ status: 'CANCELLED' }),
});
stubAt(path.join(servicesDir, 'internalExecution.service.js'), {
  execute: async (order) => {
    stub.lastSubmittedOrder = order;
    return { ...order, ...stub.matchingResult };
  },
  cancel: async () => ({ status: 'CANCELLED' }),
});
stubAt(path.join(servicesDir, 'lpExecution.service.js'), {
  execute: async ({ order, account }) => {
    stub.lastLpRequest = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
      accountRef: account.accountNumber,
      lpProvider: account.lpProvider,
    };
    return { ...order, ...stub.lpResult };
  },
  cancel: async () => ({ status: 'CANCELLED' }),
});

// Stub riskEngine for HYBRID path. We pre-seed the decision so the test
// asserts the router consumes it correctly rather than re-testing the
// engine itself (that lives in its own test).
stub.hybridDecision = { book: 'B_BOOK', reason: 'test-default' };
stubAt(path.join(servicesDir, 'riskEngine.service.js'), {
  decideHybridRoute: async () => stub.hybridDecision,
});

// Now load the router AFTER stubs are wired.
const orderRouter = require('../services/orderRouter.service');

let pass = 0;
let fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const assertEq = (got, want, msg) => {
  if (got !== want) throw new Error(`${msg || 'mismatch'}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const assertThrows = async (fn, codeOrMsg) => {
  try {
    await fn();
    throw new Error('expected throw');
  } catch (e) {
    const match = (e.code && e.code === codeOrMsg) || (e.message && e.message.includes(codeOrMsg));
    if (!match) throw new Error(`wrong error: got ${e.code || e.message}, want ${codeOrMsg}`);
  }
};

const makeOrder = (over = {}) => ({
  _id: 'order-1',
  accountId: 'acc-1',
  instrumentId: 'inst-1',
  userId: 'user-1',
  symbol: 'BTCUSD',
  side: 'BUY',
  type: 'MARKET',
  quantity: '1',
  price: '100',
  closeOnly: false,
  save: async function () { return this; },
  toObject: function () { const { save, toObject, ...rest } = this; return rest; },
  ...over,
});

const seed = (over = {}) => {
  stub.account = {
    _id: 'acc-1', userId: 'user-1', isActive: true, isTradingEnabled: true,
    accountNumber: 'ACC1', baseCurrency: 'USD',
    // toObject for compatibility with orderRouter's `...account.toObject()` spread
    toObject() { return { ...this }; },
    ...over.account,
  };
  stub.instrument = {
    _id: 'inst-1', symbol: 'BTCUSD', isActive: true, lastPrice: '100',
    ...over.instrument,
  };
  stub.user = { blockedInstruments: [], userGroup: 'DEFAULT', riskOverride: {}, ...over.user };
  stub.routingMode = over.routingMode || 'B_BOOK';
  stub.defaultLpProvider = over.defaultLpProvider || 'NONE';
  stub.lastSubmittedOrder = null;
  stub.lastLpRequest = null;
};

// ─── Tests ────────────────────────────────────────────────────────────

test('Global B_BOOK → INTERNAL execution, LP never called', async () => {
  seed({ routingMode: 'B_BOOK' });
  const { executionSource, book } = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(book, 'B_BOOK', 'book');
  assertEq(executionSource, 'INTERNAL', 'executionSource');
  if (!stub.lastSubmittedOrder) throw new Error('internal exec was not called');
  if (stub.lastLpRequest) throw new Error('LP adapter should NOT have been called');
});

test('Global A_BOOK + valid default LP → LP execution', async () => {
  seed({ routingMode: 'A_BOOK', defaultLpProvider: 'OANDA' });
  const { executionSource, book } = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(book, 'A_BOOK', 'book');
  assertEq(executionSource, 'LP', 'executionSource');
  if (!stub.lastLpRequest) throw new Error('LP adapter should have been called');
  assertEq(stub.lastLpRequest.lpProvider, 'OANDA', 'lp provider passed to lpExec');
});

test('Global A_BOOK + defaultLpProvider NONE → LP_PROVIDER_NOT_CONFIGURED', async () => {
  seed({ routingMode: 'A_BOOK', defaultLpProvider: 'NONE' });
  await assertThrows(
    () => orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' }),
    'LP_PROVIDER_NOT_CONFIGURED'
  );
});

test('Per-account bookType is IGNORED (global overrides)', async () => {
  // Account says A_BOOK + OANDA but system mode is B_BOOK → should
  // still route internally. The per-account fields are vestigial now.
  seed({
    routingMode: 'B_BOOK',
    account: { bookType: 'A_BOOK', lpProvider: 'OANDA' },
  });
  const { book, executionSource } = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(book, 'B_BOOK', 'book follows global, not account');
  assertEq(executionSource, 'INTERNAL', 'execution source follows global');
});

test('Inactive account blocks everything (incl. close)', async () => {
  seed({ account: { isActive: false } });
  await assertThrows(
    () => orderRouter.routeOrder({ order: makeOrder({ closeOnly: true }), userId: 'user-1' }),
    'ACCOUNT_INACTIVE'
  );
});

test('isTradingEnabled=false blocks new order', async () => {
  seed({ account: { isTradingEnabled: false } });
  await assertThrows(
    () => orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' }),
    'TRADING_DISABLED'
  );
});

test('isTradingEnabled=false ALLOWS closeOnly', async () => {
  seed({ account: { isTradingEnabled: false } });
  const { executionSource } = await orderRouter.routeOrder({
    order: makeOrder({ closeOnly: true }),
    userId: 'user-1',
  });
  assertEq(executionSource, 'INTERNAL', 'closeOnly should route normally');
});

test('blockedInstruments rejects new orders on listed symbol', async () => {
  seed({ user: { blockedInstruments: ['BTCUSD'] } });
  await assertThrows(
    () => orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' }),
    'INSTRUMENT_BLOCKED'
  );
});

test('blockedInstruments ALLOWS close (no trapped positions)', async () => {
  seed({ user: { blockedInstruments: ['BTCUSD'] } });
  const r = await orderRouter.routeOrder({
    order: makeOrder({ closeOnly: true }),
    userId: 'user-1',
  });
  assertEq(r.executionSource, 'INTERNAL', 'close on blocked symbol');
});

test('Account ownership mismatch → ACCOUNT_FORBIDDEN', async () => {
  seed({ account: { userId: 'someone-else' } });
  await assertThrows(
    () => orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' }),
    'ACCOUNT_FORBIDDEN'
  );
});

test('LP request preserves order side/qty/symbol', async () => {
  seed({ routingMode: 'A_BOOK', defaultLpProvider: 'BINANCE' });
  await orderRouter.routeOrder({
    order: makeOrder({ side: 'SELL', quantity: '2' }),
    userId: 'user-1',
  });
  if (!stub.lastLpRequest) throw new Error('LP not called');
  assertEq(stub.lastLpRequest.symbol, 'BTCUSD', 'lp symbol');
  assertEq(stub.lastLpRequest.side, 'SELL', 'lp side');
  assertEq(stub.lastLpRequest.quantity, '2', 'lp qty');
  assertEq(stub.lastLpRequest.lpProvider, 'BINANCE', 'lp provider');
});

test('Missing global routingMode defaults to B_BOOK (safe)', async () => {
  // Don't set routingMode in stub — getSetting returns undefined.
  seed();
  stub.routingMode = undefined;
  const r = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(r.book, 'B_BOOK', 'defaults to B_BOOK');
  assertEq(r.executionSource, 'INTERNAL', 'defaults to internal');
});

test('Global HYBRID → riskEngine picks B_BOOK → HYBRID_INTERNAL', async () => {
  seed({ routingMode: 'HYBRID', defaultLpProvider: 'OANDA' });
  stub.hybridDecision = { book: 'B_BOOK', reason: 'small notional' };
  const r = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(r.book, 'B_BOOK', 'risk engine chose B');
  assertEq(r.executionSource, 'HYBRID_INTERNAL', 'tags as HYBRID_INTERNAL');
  if (stub.lastLpRequest) throw new Error('LP should not have been called');
});

test('Global HYBRID → riskEngine picks A_BOOK → HYBRID_LP via configured LP', async () => {
  seed({ routingMode: 'HYBRID', defaultLpProvider: 'BINANCE' });
  stub.hybridDecision = { book: 'A_BOOK', reason: 'large notional' };
  const r = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(r.book, 'A_BOOK', 'risk engine chose A');
  assertEq(r.executionSource, 'HYBRID_LP', 'tags as HYBRID_LP');
  if (!stub.lastLpRequest) throw new Error('LP should have been called');
  assertEq(stub.lastLpRequest.lpProvider, 'BINANCE', 'lp provider');
});

test('Per-user routingMode=A_BOOK overrides global B_BOOK', async () => {
  seed({
    routingMode: 'B_BOOK',
    defaultLpProvider: 'OANDA',
    user: { riskOverride: { routingMode: 'A_BOOK' } },
  });
  const r = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(r.book, 'A_BOOK', 'user override wins');
  assertEq(r.executionSource, 'LP', 'user override → LP');
  if (!stub.lastLpRequest) throw new Error('LP should have been called');
});

test('Per-user routingMode=B_BOOK overrides global A_BOOK', async () => {
  seed({
    routingMode: 'A_BOOK',
    defaultLpProvider: 'OANDA',
    user: { riskOverride: { routingMode: 'B_BOOK' } },
  });
  const r = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(r.book, 'B_BOOK', 'user override wins');
  assertEq(r.executionSource, 'INTERNAL', 'user override → internal');
  if (stub.lastLpRequest) throw new Error('LP should not have been called');
});

test('Per-user routingMode=null falls back to global', async () => {
  seed({
    routingMode: 'A_BOOK',
    defaultLpProvider: 'OANDA',
    user: { riskOverride: { routingMode: null } },
  });
  const r = await orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' });
  assertEq(r.book, 'A_BOOK', 'inherits global');
});

test('Per-user HYBRID with no global LP still requires LP', async () => {
  seed({
    routingMode: 'B_BOOK',
    defaultLpProvider: 'NONE',
    user: { riskOverride: { routingMode: 'HYBRID' } },
  });
  stub.hybridDecision = { book: 'A_BOOK', reason: 'force A' };
  await assertThrows(
    () => orderRouter.routeOrder({ order: makeOrder(), userId: 'user-1' }),
    'LP_PROVIDER_NOT_CONFIGURED'
  );
});

// ─── Runner ───────────────────────────────────────────────────────────

(async () => {
  console.log(`Running ${cases.length} routing tests…\n`);
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
