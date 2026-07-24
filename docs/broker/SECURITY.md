# Broker Module — Security Design

The module holds credentials that can place real orders on a user's real
brokerage account. That is the highest-value secret in the platform, and the
design treats it accordingly.

---

## 1. Threat model

| Threat | Control |
|---|---|
| Database read (leaked backup, compromised replica, `mongodump`) | Tokens are AES-256-GCM ciphertext. The key is not in the database. |
| Database **write** (attacker grafts one user's token onto their own row) | AAD binds every ciphertext to `userId:broker`. A moved ciphertext fails to decrypt. |
| Token leaking through an API response | Secret fields are `select: false`, deleted in `toJSON`/`toObject`, and responses are built from an explicit safe view. Three independent layers. |
| Token leaking through logs | Every audit payload passes `redact()`: credential-shaped keys **and** JWT/opaque-shaped values, at any depth. |
| Token leaking through a stringified object | Credentials are non-enumerable; adapters implement `toJSON()` returning only a health snapshot. |
| Stolen token used after revocation | Auth failure flips the connection to `INVALID` and evicts the cached adapter immediately. |
| Cross-user data access | Every query is scoped by `userId`; cache keys are namespaced by `userId`; WebSocket channels are server-scoped per user. |
| Order replay / duplicate submission | `clientOrderId` with a unique index; a repeat replays the stored response. |
| Credential brute force | Connect is rate limited to 20 attempts / 15 min per user. |
| Broker API abuse (our own bug) | Every outbound call passes a queue + rate limiter. No path bypasses it. |
| DoS via order flooding | Per-user HTTP limits, bounded queue (`QUEUE_OVERFLOW` at capacity), bounded adapter pool. |

---

## 2. Credential encryption

**Algorithm:** AES-256-GCM (authenticated encryption — tampering fails the auth
tag rather than decrypting to garbage we then send to a broker).

**Stored format** — one opaque string:

```
v1.<keyId>.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>
```

| Element | Choice | Why |
|---|---|---|
| IV | 12 random bytes per encryption | NIST-recommended GCM length; never reused |
| Auth tag | 16 bytes | full-strength integrity |
| AAD | `${userId}:${broker}` | ciphertext is bound to its row — copying it elsewhere fails |
| `keyId` | in the payload | rotate the master key without a bulk re-encrypt |

**Key sources** (`services/broker/tokenEncryption.service.js`):

```bash
BROKER_ENCRYPTION_KEY=<openssl rand -hex 32>        # single key → id "k1"
BROKER_ENCRYPTION_KEYS=k1:<hex>,k2:<hex>            # rotation set
BROKER_ENCRYPTION_KEY_ID=k2                         # which key NEW writes use
BROKER_KMS_KEY_ID=arn:aws:kms:...                   # AWS KMS instead (plug point)
```

**Rotation** — no downtime, no migration window:

1. Add the new key: `BROKER_ENCRYPTION_KEYS=k1:<old>,k2:<new>`
2. Point new writes at it: `BROKER_ENCRYPTION_KEY_ID=k2`
3. Old rows keep decrypting with `k1` (their payload names it).
4. Optionally re-encrypt in the background (`needsRotation()` / `rotate()`).
5. Remove `k1` once no row references it.

**Production fail-closed.** Without a configured key, `assertConfigured()`
throws in production — a misconfigured box refuses to store credentials rather
than storing them weakly. In development it derives an insecure key and warns
loudly on every boot.

---

## 3. Credential handling rules

1. **One decryption path.** `brokerConnection.service.getCredentials()` is the
   only function in the codebase that decrypts. Everything else receives either
   a safe view or a short-lived in-memory credentials object.
2. **Validate before storing.** The token is proven against the broker at
   connect time — a bad paste fails immediately, not at 09:15 on the first order.
3. **Plaintext never persists.** No Redis, no cache, no log, no file. It exists
   in memory for the life of one adapter (idle TTL 10 minutes) and is dropped
   on eviction.
4. **Masked-only externally.** `mask()` → `••••••••4f2a91` is the only
   representation allowed out of the backend.
5. **Fingerprints, not tokens, in audit.** `sha256(token)[0..16]` correlates
   audit rows without storing anything reversible.
6. **Non-enumerable in memory.** Credentials sit on non-enumerable properties,
   so a stray `JSON.stringify(adapter)` or `{...client}` cannot leak them.

---

## 4. Defence in depth on responses

Three independent layers must all fail before a token can reach a client:

1. **Schema** — `accessToken`, `refreshToken`, `brokerClientId` carry
   `select: false`: an ordinary `find()` does not load them. A new endpoint
   cannot accidentally return what it never fetched.
2. **Serialization** — `toJSON`/`toObject` transforms delete them, so even a
   document loaded *with* secrets cannot be serialized into a response.
3. **Explicit safe view** — controllers return `toSafeJSON()`, an allow-list.

The same allow-list principle applies to broker payloads: normalized objects
carry the raw broker response under a `Symbol` key, which `JSON.stringify` and
object spread both ignore. The audit layer can persist it; the HTTP layer
structurally cannot leak it.

---

## 5. Redaction

`brokerAudit.service.redact()` runs on **every** payload before it reaches a
log line or the database:

- **By key name** (any depth): `token`, `secret`, `password`, `apiKey`,
  `authorization`, `auth`, `credential`, `privateKey`, `clientSecret`, `totp`,
  `pin`, `otp`, `signature`.
- **By value shape**: JWT-like values (2- or 3-segment, anywhere in the string —
  brokers embed tokens in error text like `invalid token: eyJ...`) and long
  opaque bearer blobs.
- Depth, array-length and string-length caps prevent log-flooding.

Redaction lives inside the audit service, not at the call sites, so it cannot
be forgotten.

---

## 6. Transport & platform security

- **HTTPS only** to broker APIs; tokens travel in headers, never in query
  strings. `DhanHttpClient` additionally strips auth-shaped query params before
  logging a URL.
- **Hard timeouts** on every call (`AbortController`) — orders get the
  shortest budget, because a hung order is worse than a failed one.
- **Helmet, CORS allow-list, JWT auth, request ids** — inherited from the
  existing platform middleware; the broker routes add nothing weaker.
- **Input validation** with zod on every endpoint. Order payloads are
  `.strict()`: an unknown field is a rejection, not a silently-ignored key.
- **Feature kill switch**: `BROKER_MODULE_ENABLED=false` makes every broker
  route return 404 without touching forex/crypto.

---

## 7. Audit trail

| Collection | Contents | Retention |
|---|---|---|
| `BrokerLog` | stage narrative: request → queue → broker → exchange → response | 30 days (TTL) |
| `OrderAudit` | immutable order state transitions | forever (compliance) |
| `BrokerError` | normalized failures with broker diagnostic codes | 90 days (TTL) |

`OrderAudit` blocks `updateOne`/`updateMany`/`findOneAndUpdate` at the schema
level — history cannot be rewritten through the ODM.

Every entry carries `requestId` and `clientOrderId`, so a user report maps to
the exact chain of events, with timings, in one query
(`GET /api/orders/:clientOrderId/audit`).

---

## 8. Deployment checklist

- [ ] `BROKER_ENCRYPTION_KEY` set from a secrets manager (never committed)
- [ ] Key generated with `openssl rand -hex 32` and unique per environment
- [ ] `NODE_ENV=production` (enables fail-closed encryption + HSTS/CSP posture)
- [ ] `REDIS_URL` set if running more than one API instance
- [ ] MongoDB encryption at rest + restricted network access
- [ ] Log shipping configured; spot-check that no `[REDACTED]` value is ever a
      real token
- [ ] `BROKER_ERROR_STACKS=false` in production
- [ ] Alerting on `BrokerError` rate by `code` (spike in `INVALID_TOKEN` or
      `BROKER_OFFLINE` = broker-side incident)
- [ ] Key rotation runbook exercised at least once in staging
