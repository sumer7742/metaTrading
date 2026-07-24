# Broker Module — Database Design

Five new collections. **No existing collection is modified.** The forex/crypto
`Order`, `Position`, `Trade` and `Wallet` collections are untouched — broker
orders live in their own system of record because their semantics differ: we
are not the counterparty and not the custodian.

`Instrument` is read **only** — the broker module never writes to the
instrument catalogue.

---

## `BrokerConnection`

One row per (user, broker). The credential vault.

| Field | Type | Notes |
|---|---|---|
| `userId` | ObjectId → User | indexed |
| `broker` | String | `DHAN` \| `UPSTOX` \| … |
| `authMode` | String | `MANUAL` \| `OAUTH` |
| `accessToken` | String | **AES-256-GCM ciphertext**, `select: false` |
| `refreshToken` | String | ciphertext, `select: false`, null when the broker has none |
| `brokerClientId` | String | ciphertext, `select: false` |
| `encryptionKeyId` | String | which key encrypted this row (enables rotation) |
| `tokenFingerprint` | String | `sha256(token)[0..16]` — correlation without the secret |
| `expiresAt` | Date | broker-reported; null = unknown |
| `status` | String | `PENDING · ACTIVE · EXPIRED · INVALID · REVOKED · DISCONNECTED · ERROR` |
| `maskedToken` / `maskedClientId` | String | display only |
| `brokerUserName`, `label`, `scopes` | | display only |
| `isDefault` | Boolean | used when a request doesn't name a broker |
| `lastConnectedAt` / `lastUsedAt` / `lastValidatedAt` | Date | |
| `lastError` | `{code, message, at}` | normalized only — never a raw broker payload |
| `failureCount` | Number | consecutive failures; threshold flips status to `ERROR` |
| `createdIp` / `createdUserAgent` | String | audit breadcrumbs |
| `createdAt` / `updatedAt` | Date | |

**Indexes**

```js
{ userId: 1, broker: 1 }      // UNIQUE — one connection per user per broker
{ userId: 1, isDefault: 1 }
{ status: 1, expiresAt: 1 }   // expiry sweep
{ tokenFingerprint: 1 }
```

Secret fields are `select: false` **and** stripped in `toJSON`/`toObject`.
`accessToken` is nullable so a disconnected row keeps its audit history with
the secret material wiped.

---

## `OrderSync`

Our system of record for every broker order — the request and its lifecycle.
(The broker's books remain authoritative for fills.)

| Field | Type | Notes |
|---|---|---|
| `userId`, `broker`, `connectionId` | | |
| `clientOrderId` | String | **UNIQUE** — `PX-YYYYMMDD-XXXXXXXX`, the idempotency key |
| `brokerOrderId` | String | indexed |
| `exchangeOrderId` | String | |
| `request` | Subdoc | `{symbol, exchange, securityId, side, qty, orderType, productType, price, triggerPrice, validity, disclosedQty, amo, tag}` |
| `status` | String | lifecycle status (see below) |
| `previousStatus`, `statusMessage` | | |
| `filledQty`, `pendingQty`, `averagePrice` | Number | |
| `timeline` | Subdoc | one timestamp per lifecycle stage |
| `response` | Subdoc | the ack we returned — **replayed verbatim** on a duplicate |
| `error` | `{code, message, at}` | normalized only |
| `attempts`, `queueWaitMs`, `brokerLatencyMs` | Number | operational metrics |
| `requestId`, `lastUpdateSource`, `lastSyncedAt` | | `API` \| `WEBSOCKET` \| `POLL` \| `SYSTEM` |
| `revisions[]` | Array | modify/cancel trail |

**Indexes**

```js
{ clientOrderId: 1 }                        // UNIQUE — the idempotency guarantee
{ brokerOrderId: 1 }
{ userId: 1, createdAt: -1 }                // user's order book
{ broker: 1, status: 1, updatedAt: -1 }     // reconciliation sweep
{ userId: 1, 'request.symbol': 1, createdAt: -1 }
{ requestId: 1 }
```

**Lifecycle**

```
CREATED → VALIDATED → QUEUED → BROKER_ACCEPTED → EXCHANGE_ACCEPTED
                                  ↓
                          PARTIALLY_FILLED → FILLED
                                  ↓
                      CANCELLED | REJECTED | EXPIRED | FAILED
```

Each status stamps `timeline.<stage>`. Statuses are ranked, so a late-arriving
update can never move an order backwards (out-of-order websocket delivery is
normal). Terminal states are final — except an explicit, audited reset when a
`FAILED` order (one that never reached the broker) is retried on the same
`clientOrderId`.

---

## `BrokerLog`

Stage-by-stage narrative: request → queue → broker → exchange → response.

| Field | Notes |
|---|---|
| `userId`, `broker`, `stage`, `action`, `level` | `stage`: `REQUEST · VALIDATE · QUEUE · BROKER · EXCHANGE · RESPONSE · WEBSOCKET · AUTH · SYNC` |
| `clientOrderId`, `brokerOrderId`, `requestId` | correlation keys |
| `message`, `payload` | `payload` is **redacted** before write |
| `httpStatus`, `durationMs`, `attempt`, `success` | |
| `createdAt` | immutable |

**Indexes**

```js
{ createdAt: 1 }  // TTL — BROKER_LOG_TTL_DAYS (default 30)
{ broker: 1, stage: 1, createdAt: -1 }
{ userId: 1, createdAt: -1 }
{ clientOrderId: 1 }
```

High volume by design → aggressive TTL. Order-critical history lives in
`OrderSync`/`OrderAudit`, which have no TTL.

---

## `BrokerError`

Normalized failures, for triage and alerting.

| Field | Notes |
|---|---|
| `code` | our normalized code — what alerting keys off |
| `message`, `retryable`, `httpStatus` | user-safe |
| `brokerCode`, `brokerMessage` | broker's own identifiers (e.g. `DH-906`) — admin-only diagnostics |
| `operation`, `clientOrderId`, `brokerOrderId`, `requestId`, `attempt` | |
| `context` | redacted |
| `stack` | only when `BROKER_ERROR_STACKS=true` |

**Indexes**

```js
{ createdAt: 1 }  // TTL — BROKER_ERROR_TTL_DAYS (default 90)
{ broker: 1, code: 1, createdAt: -1 }   // "did DHAN start failing at 09:15?"
{ userId: 1, createdAt: -1 }
{ clientOrderId: 1 }
```

Kept separate from `BrokerLog` so an incident query never scans millions of
info rows.

---

## `OrderAudit`

Append-only compliance record: one row per state transition.

| Field | Notes |
|---|---|
| `clientOrderId`, `orderSyncId`, `userId`, `broker`, `brokerOrderId` | |
| `fromStatus` → `toStatus` | the transition |
| `source` | `API` \| `WEBSOCKET` \| `POLL` \| `SYSTEM` |
| `actor` | `USER` \| `SYSTEM` \| `BROKER` \| `ADMIN:<id>` |
| `message`, `snapshot` | `snapshot` redacted |
| `requestId`, `latencyMs` | |
| `createdAt` | immutable |

**Indexes**

```js
{ clientOrderId: 1, createdAt: 1 }   // the trail, in order
{ userId: 1, createdAt: -1 }
{ toStatus: 1 }
```

`updateOne`, `updateMany` and `findOneAndUpdate` are blocked at the schema
level. No TTL — this is the artefact that answers "prove the cancel was
received at 14:59:58".

---

## Sizing and growth

| Collection | Rows per order | Retention |
|---|---|---|
| `OrderSync` | 1 | permanent |
| `OrderAudit` | 4–8 | permanent |
| `BrokerLog` | 5–12 | 30 days |
| `BrokerError` | 0–1 | 90 days |
| `BrokerConnection` | — | 1 per user per broker |

At 10,000 orders/day: ~10k `OrderSync` + ~60k `OrderAudit` + ~100k `BrokerLog`
rows daily. `BrokerLog` self-trims via TTL; the permanent collections grow at a
few hundred MB per year, well inside a single replica set. Set
`BROKER_LOG_PERSIST=false` to keep stage logs in stdout only if volume ever
becomes a concern.

---

## Related read-only usage

`Instrument` — the broker module reads lot size, freeze quantity, circuit
limits, tick size and the provider instrument token, all populated by the
existing instrument-sync jobs. It never writes. Lookups are cached in-process
for `BROKER_CACHE_TTL_INSTRUMENT_MS` (default 10 min), since the scrip master
changes once a day and this lookup sits in the hot order path.
