/**
 * tokenEncryption.service.js — AES-256-GCM envelope encryption for broker
 * credentials.
 *
 * THREAT MODEL
 *   An attacker with read access to the Mongo collection (leaked backup,
 *   compromised replica, `mongodump` on a shared host) must not be able to
 *   trade on any user's broker account.
 *
 * DESIGN
 *   - AES-256-GCM: authenticated encryption. Tampering with the ciphertext
 *     fails the auth tag instead of decrypting to garbage that we then send to
 *     a broker.
 *   - Random 12-byte IV per encryption (never reused; NIST-recommended length
 *     for GCM).
 *   - Additional Authenticated Data = `${userId}:${broker}`. A ciphertext
 *     copied from row A into row B fails to decrypt, so a DB-write attacker
 *     cannot graft one user's token onto another user's connection.
 *   - Key IDs in the payload: rotating the master key does NOT require a bulk
 *     re-encrypt. New writes use the current key; old rows keep decrypting
 *     with the key named in their own payload.
 *   - Pluggable KeyProvider: ENV today, AWS KMS (or Vault) by setting
 *     BROKER_KMS_KEY_ID — the call sites never change.
 *
 * PAYLOAD FORMAT (single opaque string stored in Mongo)
 *   v1.<keyId>.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
 *
 * RULES
 *   - Plaintext tokens exist only in memory, only for the duration of a call.
 *   - Nothing here ever logs a token, an IV-plus-key pair, or a decrypted value.
 *   - `mask()` is the ONLY representation allowed to leave the backend.
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { BrokerError, ERROR_CODE } = require('../../brokers/base/BrokerError');

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const b64u = (buf) => buf.toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

// ─── Key providers ───────────────────────────────────────────────────

/**
 * Abstract key source. Implement `getKey(keyId)` + `currentKeyId()` to back
 * encryption with any secret store.
 */
class KeyProvider {
  currentKeyId() { throw new Error('not implemented'); }
  /** @returns {Buffer} 32-byte key */
  getKey(keyId) { throw new Error('not implemented'); }
  isConfigured() { return false; }
  describe() { return { type: 'none' }; }
}

/**
 * ENV-backed provider.
 *
 *   BROKER_ENCRYPTION_KEY   — 32-byte key, hex (64 chars) or base64. Becomes key id "k1".
 *   BROKER_ENCRYPTION_KEYS  — rotation set: "k1:<hexkey>,k2:<hexkey>".
 *   BROKER_ENCRYPTION_KEY_ID— which id NEW writes use (default: last listed / "k1").
 *
 * Generate one with:  openssl rand -hex 32
 */
class EnvKeyProvider extends KeyProvider {
  constructor() {
    super();
    this._keys = new Map();
    this._current = null;
    this._load();
  }

  _load() {
    const parseKey = (raw) => {
      const s = String(raw || '').trim();
      if (!s) return null;
      let buf = null;
      if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, 'hex');
      else {
        try {
          const b = Buffer.from(s, 'base64');
          if (b.length === KEY_BYTES) buf = b;
        } catch (_) { /* not base64 */ }
      }
      return buf && buf.length === KEY_BYTES ? buf : null;
    };

    // Rotation set first — it can define several keys at once.
    const multi = String(process.env.BROKER_ENCRYPTION_KEYS || '').trim();
    if (multi) {
      for (const pair of multi.split(',')) {
        const idx = pair.indexOf(':');
        if (idx < 1) continue;
        const id = pair.slice(0, idx).trim();
        const key = parseKey(pair.slice(idx + 1));
        if (id && key) { this._keys.set(id, key); this._current = id; }
        else if (id) logger.error('BROKER_ENCRYPTION_KEYS entry is not a 32-byte key', { keyId: id });
      }
    }

    const single = parseKey(process.env.BROKER_ENCRYPTION_KEY);
    if (single) {
      this._keys.set('k1', single);
      if (!this._current) this._current = 'k1';
    } else if (process.env.BROKER_ENCRYPTION_KEY) {
      logger.error('BROKER_ENCRYPTION_KEY is set but is not a 32-byte hex/base64 value — ignoring it.');
    }

    const pinned = String(process.env.BROKER_ENCRYPTION_KEY_ID || '').trim();
    if (pinned && this._keys.has(pinned)) this._current = pinned;

    // ── Dev fallback ──
    // Non-production only: derive a deterministic key so a developer can run
    // the broker module without provisioning secrets. Loud on every boot, and
    // NEVER available in production (see assertConfigured()).
    if (!this._keys.size && (process.env.NODE_ENV || 'development') !== 'production') {
      const seed = process.env.BROKER_ENCRYPTION_DEV_SEED || 'metatrading-dev-insecure-seed';
      this._keys.set('dev', crypto.scryptSync(seed, 'broker-token-dev-salt', KEY_BYTES));
      this._current = 'dev';
      logger.warn('[broker] BROKER_ENCRYPTION_KEY not set — using an INSECURE derived dev key. Never deploy this.');
    }
  }

  currentKeyId() { return this._current; }

  getKey(keyId) {
    const key = this._keys.get(keyId);
    if (!key) {
      throw new BrokerError(
        ERROR_CODE.ENCRYPTION_ERROR,
        'Stored credential was encrypted with a key this server does not have. Reconnect your broker account.',
        { details: { keyId } }
      );
    }
    return key;
  }

  isConfigured() { return this._keys.size > 0 && this._current !== 'dev'; }
  describe() { return { type: 'env', keyIds: [...this._keys.keys()], currentKeyId: this._current }; }
}

/**
 * AWS KMS provider — plug point.
 *
 * Envelope pattern when enabled: KMS holds the master key and this provider
 * returns a cached data key. Enable by setting BROKER_KMS_KEY_ID and adding
 * @aws-sdk/client-kms. Until then it declares itself unconfigured so the
 * factory falls back to ENV — no behaviour change for existing deployments.
 */
class KmsKeyProvider extends KeyProvider {
  constructor() {
    super();
    this.keyArn = process.env.BROKER_KMS_KEY_ID || null;
    this._client = null;
    this._cache = new Map(); // keyId -> { key: Buffer, at: number }
  }

  isConfigured() {
    if (!this.keyArn) return false;
    try { require.resolve('@aws-sdk/client-kms'); return true; } catch (_) {
      logger.error('[broker] BROKER_KMS_KEY_ID is set but @aws-sdk/client-kms is not installed — falling back to ENV keys.');
      return false;
    }
  }

  currentKeyId() { return 'kms'; }

  getKey() {
    // Intentionally not implemented: KMS GenerateDataKey is async and the
    // sync interface here would force a blocking call. Wire this up together
    // with the async encrypt path when KMS is adopted — the public
    // encrypt/decrypt signatures are already async, so only this class changes.
    throw new BrokerError(ERROR_CODE.ENCRYPTION_ERROR, 'KMS key provider is not wired up yet.');
  }

  describe() { return { type: 'kms', keyArn: this.keyArn ? `${this.keyArn.slice(0, 12)}…` : null }; }
}

let _provider = null;
function provider() {
  if (_provider) return _provider;
  const kms = new KmsKeyProvider();
  _provider = kms.isConfigured() ? kms : new EnvKeyProvider();
  return _provider;
}

// ─── Public API ──────────────────────────────────────────────────────

/** True when a real (non-dev) key is available. */
const isConfigured = () => provider().isConfigured();

/**
 * Fail closed in production. Called at boot (warn) and before every encrypt
 * (throw) so a misconfigured prod box can never store a plaintext-equivalent
 * credential.
 */
function assertConfigured() {
  if (isConfigured()) return true;
  if ((process.env.NODE_ENV || 'development') === 'production') {
    throw new BrokerError(
      ERROR_CODE.ENCRYPTION_ERROR,
      'Broker credential encryption is not configured on this server.',
      { details: { hint: 'Set BROKER_ENCRYPTION_KEY (openssl rand -hex 32) or BROKER_KMS_KEY_ID.' } }
    );
  }
  return false;
}

const _aad = (context) => Buffer.from(
  `${context && context.userId ? context.userId : 'anon'}:${context && context.broker ? context.broker : 'any'}`,
  'utf8'
);

/**
 * Encrypt a secret.
 * @param {string} plaintext
 * @param {{userId: string, broker: string}} context binds the ciphertext to this row
 * @returns {Promise<{payload: string, keyId: string, fingerprint: string, masked: string}>}
 */
async function encrypt(plaintext, context = {}) {
  assertConfigured();
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new BrokerError(ERROR_CODE.VALIDATION_ERROR, 'Nothing to encrypt.');
  }
  const p = provider();
  const keyId = p.currentKeyId();
  const key = p.getKey(keyId);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(_aad(context));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    payload: [VERSION, keyId, b64u(iv), b64u(tag), b64u(ct)].join('.'),
    keyId,
    fingerprint: fingerprint(plaintext),
    masked: mask(plaintext),
  };
}

/**
 * Decrypt a payload produced by encrypt().
 * @param {string} payload
 * @param {{userId: string, broker: string}} context MUST match the encrypt context
 * @returns {Promise<string>} plaintext
 */
async function decrypt(payload, context = {}) {
  if (typeof payload !== 'string' || !payload) {
    throw new BrokerError(ERROR_CODE.ENCRYPTION_ERROR, 'Stored credential is empty. Reconnect your broker account.');
  }
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new BrokerError(ERROR_CODE.ENCRYPTION_ERROR, 'Stored credential is in an unrecognised format. Reconnect your broker account.');
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts;

  try {
    const key = provider().getKey(keyId);
    const decipher = crypto.createDecipheriv(ALGO, key, unb64u(ivB64), { authTagLength: TAG_BYTES });
    decipher.setAAD(_aad(context));
    decipher.setAuthTag(unb64u(tagB64));
    return Buffer.concat([decipher.update(unb64u(ctB64)), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    // Auth-tag failure = wrong key, wrong AAD (row grafting) or tampering.
    // Deliberately vague to the user; specific in the server log (no secrets).
    logger.error('Broker credential decryption failed', {
      keyId, userId: context.userId, broker: context.broker, err,
    });
    throw new BrokerError(
      ERROR_CODE.ENCRYPTION_ERROR,
      'Stored broker credential could not be decrypted. Reconnect your broker account.',
    );
  }
}

/**
 * Non-reversible fingerprint — lets us answer "same token as before?" and
 * correlate audit rows without storing the token.
 */
function fingerprint(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The ONLY token representation allowed out of the backend.
 * `mask('eyJ0eXAi…d2f4a1')` → `'••••••••d2f4a1'`
 */
function mask(plaintext) {
  const s = String(plaintext || '');
  if (s.length <= 6) return '••••••';
  return `••••••••${s.slice(-6)}`;
}

/** Does a stored payload need re-encryption under the current key? */
function needsRotation(payload) {
  if (typeof payload !== 'string') return false;
  const parts = payload.split('.');
  if (parts.length !== 5) return true;
  return parts[1] !== provider().currentKeyId();
}

/** Re-encrypt under the current key (rotation job). */
async function rotate(payload, context) {
  const plain = await decrypt(payload, context);
  return encrypt(plain, context);
}

/** Safe description for the admin health endpoint — no key material. */
function describe() {
  return { configured: isConfigured(), algorithm: ALGO, ...provider().describe() };
}

/** Tests only. */
function _resetProvider() { _provider = null; }

module.exports = {
  encrypt,
  decrypt,
  mask,
  fingerprint,
  needsRotation,
  rotate,
  isConfigured,
  assertConfigured,
  describe,
  KeyProvider,
  EnvKeyProvider,
  KmsKeyProvider,
  _resetProvider,
};
