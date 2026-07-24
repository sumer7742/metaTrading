# Broker Module — API Reference

Base URL: `/api`
Auth: `Authorization: Bearer <accessToken>` on every endpoint (platform JWT).

Envelope (matches the rest of the platform):

```jsonc
// success
{ "success": true, "data": { … } }

// failure
{ "success": false, "error": { "message": "…", "code": "MARGIN_ERROR", "broker": "DHAN", "retryable": false } }
```

**The endpoint never changes with the broker.** Pass `broker` to choose one;
omit it to use the user's default connection.

---

## Orders — `/api/orders`

### `POST /api/orders` — place

```jsonc
{
  "symbol": "RELIANCE",        // required
  "exchange": "NSE",           // required: NSE | BSE | NFO | BFO | MCX | CDS | BCD
  "qty": 10,                   // required, positive integer
  "side": "BUY",               // required: BUY | SELL
  "orderType": "LIMIT",        // required: MARKET | LIMIT | SL | SL_M
  "productType": "INTRADAY",   // required: INTRADAY | DELIVERY | MARGIN | MTF | CO | BO
  "broker": "DHAN",            // optional — defaults to the user's default connection
  "price": 2500.50,            // required for LIMIT and SL
  "triggerPrice": 2495,        // required for SL and SL_M
  "validity": "DAY",           // DAY | IOC (default DAY)
  "disclosedQty": 0,
  "amo": false,                // after-market order — bypasses the session check
  "clientOrderId": "PX-20260718-9F3A21C4",  // optional; generated when absent
  "tag": "strategy-a"
}
```

`202 Accepted` — the broker has the order; the exchange has not necessarily
filled it.

```jsonc
{
  "success": true,
  "data": {
    "success": true,
    "broker": "DHAN",
    "orderId": "112233445566",              // broker's order id
    "clientOrderId": "PX-20260718-9F3A21C4", // ours — use for modify/cancel/track
    "status": "BROKER_ACCEPTED",
    "message": "Order submitted to Dhan",
    "timestamp": "2026-07-18T04:12:33.120Z"
  }
}
```

**Idempotency.** Send the same `clientOrderId` (or an `Idempotency-Key`
header) and the stored acknowledgement is replayed — the broker is not called
twice. The response carries `"duplicate": true`.

Unknown body fields are **rejected**, not ignored: a typo'd `quantity` must
never silently become a default-quantity order.

### `PUT /api/orders/:clientOrderId` — modify

```jsonc
{ "qty": 15, "price": 2510, "triggerPrice": 2505, "orderType": "LIMIT", "validity": "DAY" }
```

At least one field required.

### `DELETE /api/orders/:clientOrderId` — cancel

Cancelling an already-cancelled order returns success with `"duplicate": true`
(the user tapped twice, or a fill raced the cancel).

### `GET /api/orders` — order book

| Query | Default | Notes |
|---|---|---|
| `broker` | default connection | |
| `source` | `broker` | `broker` = live from the broker · `local` = our OrderSync records, no broker call |
| `force` | `false` | bypass the 2s read cache |
| `status`, `symbol`, `limit`, `skip` | | `source=local` only |

### `GET /api/orders/history` — executed trades

`from` / `to` (`YYYY-MM-DD`), `page`, `today=true` (intraday trade book — fresher).

### `GET /api/orders/:clientOrderId`

Returns our record plus the broker's live view: `{ order, live }`.
Add `?live=false` to skip the broker call.

### `GET /api/orders/:clientOrderId/audit`

Full lifecycle: `{ transitions, logs, errors }` — request → queue → broker →
exchange → response, with timings.

---

## Connections — `/api/broker`

### `GET /api/broker/brokers` — catalogue

Drives the "Connect a broker" UI. New brokers appear here automatically.

```jsonc
{ "brokers": [{
  "code": "DHAN", "name": "Dhan", "website": "https://dhan.co",
  "authModes": ["MANUAL"],
  "capabilities": { "placeOrder": true, "orderStream": true, "tickStream": false, … },
  "credentialFields": [
    { "key": "clientId",    "label": "Dhan Client ID", "type": "text",     "required": true, "help": "…" },
    { "key": "accessToken", "label": "Access Token",   "type": "password", "required": true, "help": "…" }
  ]
}]}
```

### `POST /api/broker/connections` — connect (MODE 1: manual token)

```jsonc
{
  "broker": "DHAN",
  "label": "My Dhan account",
  "credentials": { "clientId": "1100112233", "accessToken": "<token from the Dhan dashboard>" }
}
```

The token is **validated with the broker before storage**, then encrypted
(AES-256-GCM). `201` returns a safe view — no token, ever:

```jsonc
{ "connection": {
  "id": "…", "broker": "DHAN", "authMode": "MANUAL", "status": "ACTIVE",
  "maskedToken": "••••••••4f2a91", "brokerUserName": "…",
  "isDefault": true, "expiresAt": "2026-08-17T18:29:00.000Z", "lastConnectedAt": "…"
}}
```

Rate limited to 20 attempts / 15 min per user.

| Endpoint | Purpose |
|---|---|
| `GET /connections` | list (safe views) |
| `DELETE /connections/:broker` | revoke at the broker (best effort) + wipe local secrets |
| `POST /connections/:broker/verify` | re-check the stored token now |
| `PATCH /connections/:broker/default` | choose the broker used when a request omits one |
| `POST /connections/:broker/stream` | start the live order stream |
| `DELETE /connections/:broker/stream` | stop it |

Connection `status`: `PENDING · ACTIVE · EXPIRED · INVALID · REVOKED · DISCONNECTED · ERROR`

### OAuth (MODE 2 — plug point)

`GET /api/broker/oauth/:broker/authorize` · `GET /api/broker/oauth/:broker/callback`

Returns `501 UNSUPPORTED_OPERATION` until a broker registers an OAuth provider.
**The frontend can call these today** — the day a partner integration lands they
start returning a URL and the same UI works, with no frontend release.

---

## Portfolio — `/api/broker/portfolio`

All accept `broker` and `force` (bypass cache).

| Endpoint | Returns | Cache |
|---|---|---|
| `GET /portfolio/summary` | funds + positions + holdings + totals | per-part |
| `GET /portfolio/positions` | `position[]` (`?includeClosed=true` for squared-off) | 3s |
| `GET /portfolio/holdings` | `holding[]` | 30s |
| `GET /portfolio/funds` | `funds` | 5s |
| `POST /portfolio/sync` | force reconciliation against the broker order book | — |

`summary` degrades partially: if holdings fail, funds and positions still
return, with the failure listed under `errors`.

---

## Market data — `/api/broker/market`

### `GET /api/broker/market/quotes?symbols=RELIANCE:NSE,TCS:NSE&mode=FULL`

`symbols` is `SYMBOL[:EXCHANGE]` comma-separated (max 500).
`mode`: `LTP` | `OHLC` | `FULL` (default).

### `GET /api/broker/market/status?exchange=NSE`

```jsonc
{ "markets": [{
  "exchange": "NSE", "state": "OPEN", "isOpen": true,
  "opensAt": "09:15", "closesAt": "15:30", "reason": "continuous session",
  "timezone": "Asia/Kolkata"
}]}
```

`state`: `OPEN · PRE_OPEN · CLOSED · HOLIDAY · WEEKEND`

### `GET /api/broker/health` *(admin)*

Queue depth, rate-limiter usage, adapter pool, live sockets, cache backend,
encryption posture, registered brokers. No user data, no credentials.

---

## Normalized models

Identical for every broker — the frontend has no broker-specific branches.

```jsonc
// Order acknowledgement
{ "success": true, "broker": "DHAN", "orderId": "…", "status": "…", "message": "…" }

// Position
{ "symbol": "RELIANCE", "exchange": "NSE", "side": "BUY", "qty": 10,
  "averagePrice": 2500.5, "pnl": 120.5, "product": "INTRADAY",
  "lastPrice": 2512.55, "realizedPnl": 0, "unrealizedPnl": 120.5, "buyQty": 10, "sellQty": 0 }

// Holding
{ "symbol": "TCS", "quantity": 25, "averagePrice": 3800, "currentPrice": 3925.4, "pnl": 3135,
  "isin": "…", "availableQty": 25, "t1Qty": 0, "investedValue": 95000, "currentValue": 98135, "pnlPercent": 3.3 }

// Funds
{ "availableCash": 152340.25, "utilizedMargin": 47800, "totalBalance": 200140.25,
  "collateral": 0, "withdrawableBalance": 152340.25, "realizedPnl": 0, "unrealizedPnl": 0, "currency": "INR" }
```

Broker-native payloads never appear in a response. They are attached to
normalized objects under a `Symbol` key, which `JSON.stringify` ignores — so
the audit layer can persist them while the HTTP layer structurally cannot leak
them.

---

## Order lifecycle

```
CREATED → VALIDATED → QUEUED → BROKER_ACCEPTED → EXCHANGE_ACCEPTED
                                    ↓
                            PARTIALLY_FILLED → FILLED
                                    ↓
                        CANCELLED | REJECTED | EXPIRED | FAILED
```

`FAILED` = never reached the broker (validation, queue, or network). Every
transition is timestamped on `OrderSync.timeline` and recorded in `OrderAudit`.
Out-of-order updates are dropped: a late `EXCHANGE_ACCEPTED` can't overwrite a
`FILLED`.

---

## Live updates (WebSocket)

Existing platform socket — `wss://<host>/ws?token=<jwt>`:

```js
ws.send(JSON.stringify({ action: 'subscribe', channel: 'user:broker:order' }));   // order updates
ws.send(JSON.stringify({ action: 'subscribe', channel: 'user:broker:stream' }));  // stream health
```

Channels are user-scoped by the server, so cross-user leakage is impossible.
Payloads are normalized order objects.

---

## Error codes

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `INVALID_TOKEN` | 401 | no | Reconnect the broker account |
| `TOKEN_EXPIRED` | 401 | no | Generate a new token, reconnect |
| `NOT_CONNECTED` | 428 | no | Connect a broker first |
| `BROKER_REQUIRED` | 400 | no | Several brokers connected — name one |
| `BROKER_UNAUTHORIZED` | 403 | no | Segment/KYC not enabled at the broker |
| `BROKER_OFFLINE` | 502 | yes | Broker unavailable |
| `EXCHANGE_CLOSED` | 409 | no | Holiday/weekend |
| `MARKET_CLOSED` | 409 | no | Outside session — use `amo: true` |
| `MARGIN_ERROR` | 402 | no | Insufficient margin |
| `QUANTITY_ERROR` | 400 | no | Lot size / freeze limit |
| `PRICE_ERROR` | 400 | no | Tick size / circuit band |
| `ORDER_NOT_FOUND` | 404 | no | Unknown order |
| `DUPLICATE_ORDER` | 409 | no | Idempotency collision |
| `BROKER_REJECTED` | 422 | no | Broker/OMS rejection |
| `RATE_LIMIT` | 429 | yes | Includes `Retry-After` |
| `TIMEOUT` | 504 | yes | Reconciled before being reported |
| `NETWORK_FAILURE` | 502 | yes | Could not reach the broker |
| `SYMBOL_NOT_FOUND` | 404 | no | Not tradable through this broker |
| `UNSUPPORTED_OPERATION` | 501 | no | Broker lacks the capability |
| `VALIDATION_ERROR` | 400 | no | Bad request (per-field `details.fields`) |
| `QUEUE_OVERFLOW` | 503 | yes | Queue saturated |

---

## Rate limits

Two independent layers:

1. **Ours** (per user, HTTP): 100 order writes/min, 300 reads/min,
   20 connects/15 min.
2. **The broker's** (per broker, per category): enforced by `RateLimiter` in
   front of every outbound call. Requests **queue** rather than fail. Dhan:
   ~20 order/s, ~4 data/s, ~18 non-trading/s, with minute/hour/day ceilings.

Cancel and modify outrank new orders in the queue — a user getting out of a
position never waits behind a burst of entries.
