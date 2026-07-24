const mongoose = require('mongoose');
const { BROKER_CODES, AUTH_MODE, CONNECTION_STATUS } = require('../brokers/constants');

/**
 * BrokerConnection — a user's link to ONE broker account.
 *
 * SECURITY CONTRACT (enforced structurally, not by convention):
 *   - `accessToken` / `refreshToken` / `brokerClientId` hold AES-256-GCM
 *     ciphertext produced by services/broker/tokenEncryption.service.js.
 *     Plaintext never touches this collection.
 *   - The three secret paths carry `select: false`, so an ordinary
 *     `find()` / `findOne()` does NOT load them. Reading them requires an
 *     explicit `.select('+accessToken')`, which only the credential service
 *     does — a new endpoint cannot leak them by accident.
 *   - `toJSON` / `toObject` transforms delete them anyway, so even a document
 *     loaded WITH the secrets cannot be serialized into an HTTP response.
 *
 * One connection per (userId, broker) — enforced by a unique compound index.
 * Multi-account-per-broker is a future extension: add `brokerAccountId` to
 * the unique key, nothing else changes.
 */
const brokerConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Broker code — validated against the constants list, NOT the live
    // registry, so historic rows for a temporarily unregistered broker still
    // load instead of failing validation.
    broker: { type: String, required: true, uppercase: true, enum: BROKER_CODES, index: true },

    // MANUAL — user pasted a token from the broker's dashboard (Dhan today).
    // OAUTH  — issued through the broker's partner flow (plug-in ready).
    authMode: { type: String, enum: Object.values(AUTH_MODE), default: AUTH_MODE.MANUAL },

    // ── Encrypted secrets (never selected by default, never serialized) ──
    // Nullable by design: DISCONNECTED / REVOKED rows keep their audit trail
    // (createdAt, label, isDefault history) with the secret material wiped.
    // Presence is enforced by brokerConnection.service on connect, not here.
    accessToken: { type: String, default: null, select: false },
    refreshToken: { type: String, default: null, select: false },
    // The broker's own client/account id. Not strictly a secret, but it is
    // account-identifying and part of the auth header pair, so it gets the
    // same treatment.
    brokerClientId: { type: String, default: null, select: false },

    // Envelope key id that encrypted this row. Lets us rotate the master key
    // without a bulk re-encrypt: new writes use the current key, old rows
    // decrypt with the key named here.
    encryptionKeyId: { type: String, default: null },

    // SHA-256 prefix of the plaintext token. Enables "is this the same token
    // the user already pasted?" and audit correlation WITHOUT storing or
    // logging the token itself. Not reversible.
    tokenFingerprint: { type: String, default: null, index: true },

    // Broker-reported expiry. Null = the broker doesn't tell us (treat the
    // token as valid until it fails, then mark INVALID).
    expiresAt: { type: Date, default: null, index: true },

    status: {
      type: String,
      enum: Object.values(CONNECTION_STATUS),
      default: CONNECTION_STATUS.PENDING,
      index: true,
    },

    // Display-only fields — safe to return to the frontend.
    label: { type: String, default: null },          // user-given nickname
    maskedToken: { type: String, default: null },    // e.g. '••••••••4f2a'
    maskedClientId: { type: String, default: null },
    brokerUserName: { type: String, default: null }, // profile name from the broker
    scopes: { type: [String], default: [] },

    // When several brokers are connected, this one is used if the request
    // doesn't name a broker. Kept unique-per-user by the connection service.
    isDefault: { type: Boolean, default: false },

    lastConnectedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    lastValidatedAt: { type: Date, default: null },

    // Last normalized failure — code + user-safe message ONLY. Never a raw
    // broker payload (which can echo the token back).
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },

    // Consecutive auth/transport failures. The health sweep flips the
    // connection to ERROR past a threshold so the UI can prompt a reconnect.
    failureCount: { type: Number, default: 0 },

    // Audit breadcrumbs for the connect action itself.
    createdIp: { type: String, default: null },
    createdUserAgent: { type: String, default: null },
  },
  { timestamps: true }
);

brokerConnectionSchema.index({ userId: 1, broker: 1 }, { unique: true });
brokerConnectionSchema.index({ status: 1, expiresAt: 1 });
brokerConnectionSchema.index({ userId: 1, isDefault: 1 });

// Belt-and-braces: even a document loaded with `.select('+accessToken')`
// cannot serialize its secrets into a response.
const _stripSecrets = (doc, ret) => {
  delete ret.accessToken;
  delete ret.refreshToken;
  delete ret.brokerClientId;
  delete ret.encryptionKeyId;
  delete ret.tokenFingerprint;
  return ret;
};
brokerConnectionSchema.set('toJSON', { transform: _stripSecrets });
brokerConnectionSchema.set('toObject', { transform: _stripSecrets });

/** Canonical safe view for API responses. */
brokerConnectionSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    broker: this.broker,
    authMode: this.authMode,
    status: this.status,
    label: this.label,
    maskedToken: this.maskedToken,
    maskedClientId: this.maskedClientId,
    brokerUserName: this.brokerUserName,
    scopes: this.scopes || [],
    isDefault: !!this.isDefault,
    expiresAt: this.expiresAt || null,
    lastConnectedAt: this.lastConnectedAt || null,
    lastUsedAt: this.lastUsedAt || null,
    lastValidatedAt: this.lastValidatedAt || null,
    lastError: this.lastError && this.lastError.code
      ? { code: this.lastError.code, message: this.lastError.message, at: this.lastError.at }
      : null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/** Same shape from a `.lean()` object. */
brokerConnectionSchema.statics.safeView = function safeView(row) {
  if (!row) return null;
  return brokerConnectionSchema.methods.toSafeJSON.call(row);
};

module.exports = mongoose.model('BrokerConnection', brokerConnectionSchema);
