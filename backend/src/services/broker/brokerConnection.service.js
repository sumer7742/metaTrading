/**
 * brokerConnection.service.js — the ONLY module allowed to touch broker
 * credentials.
 *
 * Everything else (controllers, adapters, router, manager) receives either a
 * safe view (no secrets) or a short-lived in-memory credentials object. There
 * is exactly one function that decrypts — `getCredentials()` — which makes the
 * blast radius auditable in a single file.
 *
 * Responsibilities:
 *   connect / disconnect / verify a broker account
 *   encrypt-at-rest + decrypt-on-use
 *   connection status machine (PENDING → ACTIVE → INVALID/EXPIRED/…)
 *   default-broker selection for requests that don't name one
 */

const BrokerConnection = require('../../models/BrokerConnection');
const encryption = require('./tokenEncryption.service');
const audit = require('./brokerAudit.service');
const registry = require('../../brokers/registry');
const { BrokerError, ERROR_CODE } = require('../../brokers/base/BrokerError');
const {
  AUTH_MODE, CONNECTION_STATUS, USABLE_CONNECTION_STATUSES,
} = require('../../brokers/constants');
const logger = require('../../utils/logger');

const STAGE = audit.STAGE;

const _safe = (doc) => (doc && typeof doc.toSafeJSON === 'function'
  ? doc.toSafeJSON()
  : BrokerConnection.safeView(doc));

/**
 * Connect (or re-connect) a broker account.
 *
 * MODE 1 (MANUAL): `credentials` carries the token the user generated in the
 * broker's dashboard. We validate it against the broker BEFORE storing, so a
 * typo fails at connect time rather than at 09:15 on the first order.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.broker
 * @param {object} p.credentials  raw fields from the connect form
 * @param {'MANUAL'|'OAUTH'} [p.authMode]
 * @param {string} [p.label] [p.ip] [p.userAgent] [p.requestId]
 * @returns {Promise<object>} safe connection view
 */
async function connect({ userId, broker, credentials, authMode = AUTH_MODE.MANUAL, label, ip, userAgent, requestId }) {
  const descriptor = registry.get(broker);
  const code = descriptor.code;
  encryption.assertConfigured();

  const provider = registry.createAuthProvider(code, authMode);

  // 1. Validate with the broker first — never store an unverified credential.
  let auth;
  try {
    auth = await provider.authenticate(credentials || {});
  } catch (err) {
    audit.recordError(err, { userId, broker: code, operation: 'connect', requestId });
    throw BrokerError.from(err, code);
  }
  if (!auth || !auth.accessToken) {
    throw new BrokerError(ERROR_CODE.INVALID_TOKEN, 'The broker did not return a usable access token.', { broker: code });
  }

  // 2. Encrypt, bound to this (userId, broker) pair via AAD.
  const ctx = { userId: String(userId), broker: code };
  const [tokenEnc, refreshEnc, clientIdEnc] = await Promise.all([
    encryption.encrypt(auth.accessToken, ctx),
    auth.refreshToken ? encryption.encrypt(auth.refreshToken, ctx) : Promise.resolve(null),
    auth.brokerClientId ? encryption.encrypt(String(auth.brokerClientId), ctx) : Promise.resolve(null),
  ]);

  const now = new Date();
  const update = {
    userId,
    broker: code,
    authMode,
    accessToken: tokenEnc.payload,
    refreshToken: refreshEnc ? refreshEnc.payload : null,
    brokerClientId: clientIdEnc ? clientIdEnc.payload : null,
    encryptionKeyId: tokenEnc.keyId,
    tokenFingerprint: tokenEnc.fingerprint,
    maskedToken: tokenEnc.masked,
    maskedClientId: auth.brokerClientId ? encryption.mask(String(auth.brokerClientId)) : null,
    expiresAt: auth.expiresAt || null,
    status: CONNECTION_STATUS.ACTIVE,
    label: label || null,
    brokerUserName: (auth.profile && (auth.profile.name || auth.profile.userName)) || null,
    scopes: auth.scopes || [],
    lastConnectedAt: now,
    lastValidatedAt: now,
    failureCount: 0,
    lastError: { code: null, message: null, at: null },
    createdIp: ip || null,
    createdUserAgent: userAgent ? String(userAgent).slice(0, 300) : null,
  };

  const doc = await BrokerConnection.findOneAndUpdate(
    { userId, broker: code },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // First connection for this user becomes the default automatically.
  const count = await BrokerConnection.countDocuments({ userId, status: { $in: USABLE_CONNECTION_STATUSES } });
  if (count === 1 && !doc.isDefault) {
    doc.isDefault = true;
    await doc.save();
  }

  audit.log({
    userId, broker: code, stage: STAGE.AUTH, action: 'connect', requestId,
    message: `Connected ${descriptor.name}`, success: true,
    // fingerprint only — the token itself is never logged
    payload: { authMode, fingerprint: tokenEnc.fingerprint, expiresAt: auth.expiresAt || null },
  });

  // Drop any cached adapter built on the previous token.
  _evictFromManager(userId, code);

  return _safe(doc);
}

/** Disconnect: best-effort revoke at the broker, then wipe the stored secrets. */
async function disconnect({ userId, broker, requestId }) {
  const code = String(broker).toUpperCase();
  const doc = await BrokerConnection.findOne({ userId, broker: code }).select('+accessToken +refreshToken +brokerClientId');
  if (!doc) throw new BrokerError(ERROR_CODE.NOT_CONNECTED, `No ${code} connection to disconnect.`, { broker: code });

  try {
    const provider = registry.createAuthProvider(code, doc.authMode);
    const creds = await _decryptRow(doc);
    await provider.revoke(creds);
  } catch (e) {
    // A broker that can't revoke (or is down) must not block the user from
    // removing their credentials from OUR system.
    logger.warn('Broker revoke failed — clearing local credentials anyway', { broker: code, err: e });
  }

  await BrokerConnection.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: CONNECTION_STATUS.DISCONNECTED,
        accessToken: null,                   // secret material wiped; row kept for audit
        refreshToken: null,
        brokerClientId: null,
        tokenFingerprint: null,
        maskedToken: null,
        maskedClientId: null,
        isDefault: false,
        expiresAt: null,
      },
    }
  );

  _evictFromManager(userId, code);
  audit.log({ userId, broker: code, stage: STAGE.AUTH, action: 'disconnect', requestId, success: true, message: 'Broker disconnected' });

  // Promote another connection to default so the user isn't left without one.
  const next = await BrokerConnection.findOne({ userId, status: CONNECTION_STATUS.ACTIVE }).sort({ lastUsedAt: -1 });
  if (next && !next.isDefault) { next.isDefault = true; await next.save(); }

  return { broker: code, status: CONNECTION_STATUS.DISCONNECTED };
}

/** List a user's connections (safe views only). */
async function list(userId) {
  const rows = await BrokerConnection.find({ userId }).sort({ isDefault: -1, updatedAt: -1 }).lean();
  return rows.map(_safe);
}

/** One safe view, or null. */
async function get(userId, broker) {
  const row = await BrokerConnection.findOne({ userId, broker: String(broker).toUpperCase() }).lean();
  return _safe(row);
}

/**
 * The connection a request should use.
 *   - explicit broker → that connection (must be usable)
 *   - no broker + exactly one usable connection → that one
 *   - no broker + a default → the default
 *   - otherwise → BROKER_REQUIRED, listing the choices
 */
async function resolveForRequest(userId, requestedBroker) {
  if (requestedBroker) {
    const code = String(requestedBroker).toUpperCase();
    registry.get(code); // throws UNKNOWN_BROKER for unregistered codes
    const row = await BrokerConnection.findOne({ userId, broker: code }).lean();
    if (!row) throw new BrokerError(ERROR_CODE.NOT_CONNECTED, `Connect your ${code} account first.`, { broker: code });
    _assertUsable(row);
    return _safe(row);
  }

  const rows = await BrokerConnection.find({ userId, status: { $in: USABLE_CONNECTION_STATUSES } }).lean();
  if (!rows.length) throw new BrokerError(ERROR_CODE.NOT_CONNECTED, 'Connect a broker account to place orders.');
  if (rows.length === 1) return _safe(rows[0]);

  const preferred = rows.find((r) => r.isDefault);
  if (preferred) return _safe(preferred);

  throw new BrokerError(
    ERROR_CODE.BROKER_REQUIRED,
    'You have several brokers connected — specify which one to use.',
    { details: { connected: rows.map((r) => r.broker) } }
  );
}

function _assertUsable(row) {
  if (!USABLE_CONNECTION_STATUSES.includes(row.status)) {
    const map = {
      [CONNECTION_STATUS.EXPIRED]: ERROR_CODE.TOKEN_EXPIRED,
      [CONNECTION_STATUS.INVALID]: ERROR_CODE.INVALID_TOKEN,
      [CONNECTION_STATUS.REVOKED]: ERROR_CODE.INVALID_TOKEN,
    };
    throw new BrokerError(
      map[row.status] || ERROR_CODE.NOT_CONNECTED,
      `Your ${row.broker} connection is ${String(row.status).toLowerCase()}. Reconnect to continue.`,
      { broker: row.broker }
    );
  }
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
    throw new BrokerError(ERROR_CODE.TOKEN_EXPIRED, `Your ${row.broker} token expired. Generate a new one and reconnect.`, { broker: row.broker });
  }
}

/**
 * Decrypt credentials for use by an adapter.
 *
 * ⚠️ The ONLY decryption path in the codebase. Returns a plain object that
 * lives in memory for the duration of one adapter's life — it is never
 * persisted, cached in Redis, or logged.
 */
async function getCredentials(userId, broker) {
  const code = String(broker).toUpperCase();
  const doc = await BrokerConnection.findOne({ userId, broker: code })
    .select('+accessToken +refreshToken +brokerClientId');
  if (!doc) throw new BrokerError(ERROR_CODE.NOT_CONNECTED, `Connect your ${code} account first.`, { broker: code });
  _assertUsable(doc);
  return _decryptRow(doc);
}

async function _decryptRow(doc) {
  const ctx = { userId: String(doc.userId), broker: doc.broker };
  const [accessToken, refreshToken, brokerClientId] = await Promise.all([
    encryption.decrypt(doc.accessToken, ctx),
    doc.refreshToken ? encryption.decrypt(doc.refreshToken, ctx) : Promise.resolve(null),
    doc.brokerClientId ? encryption.decrypt(doc.brokerClientId, ctx) : Promise.resolve(null),
  ]);
  return { accessToken, refreshToken, brokerClientId, authMode: doc.authMode, connectionId: String(doc._id) };
}

/** Re-validate a stored token against the broker, on demand or on a schedule. */
async function verify({ userId, broker, requestId }) {
  const code = String(broker).toUpperCase();
  const doc = await BrokerConnection.findOne({ userId, broker: code }).select('+accessToken +refreshToken +brokerClientId');
  if (!doc) throw new BrokerError(ERROR_CODE.NOT_CONNECTED, `No ${code} connection found.`, { broker: code });

  const provider = registry.createAuthProvider(code, doc.authMode);
  try {
    const creds = await _decryptRow(doc);
    const result = await provider.validate(creds);
    if (result && result.valid) {
      await BrokerConnection.updateOne({ _id: doc._id }, {
        $set: {
          status: CONNECTION_STATUS.ACTIVE,
          lastValidatedAt: new Date(),
          failureCount: 0,
          lastError: { code: null, message: null, at: null },
          ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
          ...(result.profile && result.profile.name ? { brokerUserName: result.profile.name } : {}),
        },
      });
      audit.log({ userId, broker: code, stage: STAGE.AUTH, action: 'verify', requestId, success: true, message: 'Token valid' });
      return { broker: code, valid: true, status: CONNECTION_STATUS.ACTIVE, expiresAt: result.expiresAt || doc.expiresAt || null };
    }
    await markInvalid({ userId, broker: code, code: ERROR_CODE.INVALID_TOKEN, message: (result && result.reason) || 'Broker rejected the token.' });
    return { broker: code, valid: false, status: CONNECTION_STATUS.INVALID, reason: (result && result.reason) || null };
  } catch (err) {
    const e = BrokerError.from(err, code);
    if ([ERROR_CODE.INVALID_TOKEN, ERROR_CODE.TOKEN_EXPIRED].includes(e.code)) {
      await markInvalid({ userId, broker: code, code: e.code, message: e.message });
      return { broker: code, valid: false, status: CONNECTION_STATUS.INVALID, reason: e.message };
    }
    audit.recordError(e, { userId, broker: code, operation: 'verify', requestId });
    throw e;
  }
}

/**
 * Flip a connection to INVALID/EXPIRED. Called by the router the moment a
 * broker returns an auth failure, so the user gets a "reconnect" prompt
 * instead of a stream of failing orders.
 */
async function markInvalid({ userId, broker, code, message }) {
  const status = code === ERROR_CODE.TOKEN_EXPIRED ? CONNECTION_STATUS.EXPIRED : CONNECTION_STATUS.INVALID;
  await BrokerConnection.updateOne(
    { userId, broker: String(broker).toUpperCase() },
    { $set: { status, lastError: { code, message, at: new Date() } }, $inc: { failureCount: 1 } }
  );
  _evictFromManager(userId, broker);
  return { status };
}

/** Record a non-auth failure; too many in a row flips the connection to ERROR. */
async function recordFailure({ userId, broker, code, message }) {
  const doc = await BrokerConnection.findOneAndUpdate(
    { userId, broker: String(broker).toUpperCase() },
    { $set: { lastError: { code, message, at: new Date() } }, $inc: { failureCount: 1 } },
    { new: true }
  );
  const threshold = Number(process.env.BROKER_FAILURE_THRESHOLD) || 10;
  if (doc && doc.failureCount >= threshold && doc.status === CONNECTION_STATUS.ACTIVE) {
    await BrokerConnection.updateOne({ _id: doc._id }, { $set: { status: CONNECTION_STATUS.ERROR } });
  }
}

/** Mark a successful call — clears the failure streak, stamps lastUsedAt. */
async function touch(userId, broker) {
  await BrokerConnection.updateOne(
    { userId, broker: String(broker).toUpperCase() },
    { $set: { lastUsedAt: new Date(), failureCount: 0 } }
  ).catch(() => { /* telemetry only — never fail a trade over this */ });
}

/** Choose which broker is used when a request doesn't name one. */
async function setDefault({ userId, broker }) {
  const code = String(broker).toUpperCase();
  const doc = await BrokerConnection.findOne({ userId, broker: code });
  if (!doc) throw new BrokerError(ERROR_CODE.NOT_CONNECTED, `No ${code} connection found.`, { broker: code });
  await BrokerConnection.updateMany({ userId }, { $set: { isDefault: false } });
  doc.isDefault = true;
  await doc.save();
  return _safe(doc);
}

/** Connections eligible for background sync (used by brokerSync.service). */
async function activeConnections(limit = 500) {
  return BrokerConnection.find({ status: CONNECTION_STATUS.ACTIVE })
    .select('userId broker updatedAt lastUsedAt')
    .sort({ lastUsedAt: -1 })
    .limit(limit)
    .lean();
}

// Lazy require breaks the cycle: manager → factory → connection service.
function _evictFromManager(userId, broker) {
  try { require('../../brokers/BrokerManager').evict(userId, broker); } catch (_) { /* manager not loaded yet */ }
}

module.exports = {
  connect,
  disconnect,
  list,
  get,
  resolveForRequest,
  getCredentials,
  verify,
  markInvalid,
  recordFailure,
  touch,
  setDefault,
  activeConnections,
};
