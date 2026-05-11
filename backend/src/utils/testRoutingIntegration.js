/**
 * Live integration test for the global routing layer.
 *
 * Talks to the REAL MongoDB and runs the REAL systemSettings service
 * (no stubs). Verifies:
 *   - SystemSetting writes persist
 *   - Service cache invalidates on write
 *   - getSetting / setSetting / getAllSettings shapes match expectations
 *   - User.riskOverride.routingMode accepts the new field
 *
 * Restores the original routingMode + defaultLpProvider at exit so the
 * platform is left in whatever state it started.
 *
 * Run: node src/utils/testRoutingIntegration.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const mongoose = require('mongoose');

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
    const m = (e.code && e.code === codeOrMsg) || (e.message && e.message.includes(codeOrMsg));
    if (!m) throw new Error(`wrong error: got "${e.code || e.message}", want "${codeOrMsg}"`);
  }
};

// ─── Tests ────────────────────────────────────────────────────────────

test('SystemSetting model exists + has unique key index', async () => {
  const SystemSetting = require('../models/SystemSetting');
  const indexes = await SystemSetting.collection.indexes();
  const keyIdx = indexes.find((i) => i.key && i.key.key === 1 && i.unique);
  if (!keyIdx) throw new Error('SystemSetting missing unique index on `key`');
});

test('setSetting then getSetting round-trips through DB', async () => {
  const svc = require('../services/systemSettings.service');
  await svc.setSetting('routingMode', 'B_BOOK');
  const v = await svc.getSetting('routingMode');
  assertEq(v, 'B_BOOK', 'roundtrip');
});

test('setSetting busts cache so next getSetting sees new value', async () => {
  const svc = require('../services/systemSettings.service');
  await svc.setSetting('routingMode', 'B_BOOK');
  await svc.getSetting('routingMode'); // warm cache
  await svc.setSetting('routingMode', 'A_BOOK');
  const v = await svc.getSetting('routingMode');
  assertEq(v, 'A_BOOK', 'cache invalidated');
});

test('getAllSettings returns both routingMode and defaultLpProvider', async () => {
  const svc = require('../services/systemSettings.service');
  await svc.setSetting('routingMode', 'HYBRID');
  await svc.setSetting('defaultLpProvider', 'OANDA');
  const all = await svc.getAllSettings();
  assertEq(all.routingMode, 'HYBRID', 'routingMode in bulk');
  assertEq(all.defaultLpProvider, 'OANDA', 'defaultLpProvider in bulk');
});

test('User.riskOverride.routingMode accepts A_BOOK / B_BOOK / HYBRID / null', async () => {
  const User = require('../models/User');
  const fake = new User({
    email: `routing-test-${Date.now()}@test.local`,
    passwordHash: 'x',
    riskOverride: { routingMode: 'HYBRID' },
  });
  // Test only the validation — don't persist.
  await fake.validate();

  fake.riskOverride.routingMode = 'A_BOOK'; await fake.validate();
  fake.riskOverride.routingMode = 'B_BOOK'; await fake.validate();
  fake.riskOverride.routingMode = null; await fake.validate();
});

test('User.riskOverride.routingMode rejects garbage', async () => {
  const User = require('../models/User');
  const fake = new User({
    email: `routing-test-bad-${Date.now()}@test.local`,
    passwordHash: 'x',
    riskOverride: { routingMode: 'NONSENSE' },
  });
  await assertThrows(() => fake.validate(), 'is not a valid enum value');
});

test('Admin updateSystemSettings rejects A_BOOK + NONE LP', async () => {
  const { updateSystemSettings } = require('../controllers/adminController');
  const svc = require('../services/systemSettings.service');
  // Seed clean state.
  await svc.setSetting('routingMode', 'B_BOOK');
  await svc.setSetting('defaultLpProvider', 'NONE');

  const req = {
    body: { routingMode: 'A_BOOK' }, // leaves defaultLpProvider=NONE
    userId: new mongoose.Types.ObjectId(),
    user: { role: 'ADMIN' },
    headers: {},
    ip: '127.0.0.1',
  };
  let captured = null;
  const next = (e) => { captured = e; };
  const res = { json() {}, status() { return this; } };
  await updateSystemSettings(req, res, next);
  if (!captured) throw new Error('expected rejection');
  if (captured.code !== 'LP_PROVIDER_NOT_CONFIGURED') {
    throw new Error(`expected LP_PROVIDER_NOT_CONFIGURED, got ${captured.code || captured.message}`);
  }
});

test('Admin updateSystemSettings accepts HYBRID + OANDA', async () => {
  const { updateSystemSettings } = require('../controllers/adminController');
  const svc = require('../services/systemSettings.service');

  const req = {
    body: { routingMode: 'HYBRID', defaultLpProvider: 'OANDA' },
    userId: new mongoose.Types.ObjectId(),
    user: { role: 'ADMIN' },
    headers: {},
    ip: '127.0.0.1',
  };
  let captured = null;
  const next = (e) => { captured = e; };
  let body = null;
  const res = { json(b) { body = b; }, status() { return this; } };
  await updateSystemSettings(req, res, next);
  if (captured) throw new Error(`unexpected error: ${captured.message}`);
  if (!body || body.success !== true) throw new Error('expected success response');

  // Read back via the service to confirm persistence.
  assertEq(await svc.getSetting('routingMode'), 'HYBRID', 'persisted routingMode');
  assertEq(await svc.getSetting('defaultLpProvider'), 'OANDA', 'persisted lp');
});

test('Admin updateSystemSettings rejects invalid mode', async () => {
  const { updateSystemSettings } = require('../controllers/adminController');
  const req = {
    body: { routingMode: 'X_BOOK' },
    userId: new mongoose.Types.ObjectId(),
    user: { role: 'ADMIN' },
    headers: {},
    ip: '127.0.0.1',
  };
  let captured = null;
  const next = (e) => { captured = e; };
  const res = { json() {}, status() { return this; } };
  await updateSystemSettings(req, res, next);
  if (!captured) throw new Error('expected rejection');
  if (!captured.message.includes('routingMode must be one of')) {
    throw new Error(`expected enum error, got ${captured.message}`);
  }
});

// ─── Runner ───────────────────────────────────────────────────────────

(async () => {
  await connectDB();

  // Save original state so we can restore at exit.
  const svc = require('../services/systemSettings.service');
  const SystemSetting = require('../models/SystemSetting');
  const original = {
    routingMode: await svc.getSetting('routingMode'),
    defaultLpProvider: await svc.getSetting('defaultLpProvider'),
  };
  console.log('Saved original settings:', original);
  console.log(`\nRunning ${cases.length} integration tests…\n`);

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

  // Restore.
  await svc.setSetting('routingMode', original.routingMode);
  await svc.setSetting('defaultLpProvider', original.defaultLpProvider);
  console.log(`\nRestored settings: ${JSON.stringify(original)}`);
  console.log(`\n${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ''}`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
