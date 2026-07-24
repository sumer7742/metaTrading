# Broker Module — Indian Stock Market

Broker-agnostic trading terminal. Users trade through **their own** broker
accounts; we route, normalize, protect and audit. We are not a broker.

**Live:** Dhan · **Ready for:** Upstox, FYERS, Angel One, Zerodha, Shoonya, and
anything after them.

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Layers, request flow, folder map, **how to add a broker**, design decisions |
| [API.md](./API.md) | Every endpoint, request/response shapes, error codes, WebSocket channels |
| [SECURITY.md](./SECURITY.md) | Threat model, AES-256-GCM design, key rotation, redaction, deployment checklist |
| [DATABASE.md](./DATABASE.md) | Five collections, indexes, lifecycle, retention, sizing |

---

## Quick start

**1. Configure encryption** (required — credentials are never stored weakly):

```bash
# backend/.env
BROKER_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

**2. Start the server.** The module registers itself at boot:

```
[broker] module initialized { brokers: ['DHAN'], encryption: true, marketDataProvider: 'AUTO' }
```

**3. A user connects their broker** (Dhan web → Profile → DhanHQ Trading APIs →
Generate Access Token):

```http
POST /api/broker/connections
{ "broker": "DHAN", "credentials": { "clientId": "1100112233", "accessToken": "<token>" } }
```

**4. Trade** — the same endpoint for every broker:

```http
POST /api/orders
{ "symbol": "RELIANCE", "exchange": "NSE", "qty": 10, "side": "BUY",
  "orderType": "LIMIT", "productType": "INTRADAY", "price": 2500.50 }
```

**5. Live updates** on the existing platform WebSocket:

```js
ws.send(JSON.stringify({ action: 'subscribe', channel: 'user:broker:order' }));
```

---

## What this does not touch

The forex engine, crypto engine, matching engine, wallet, admin panel, user
management, existing APIs and the TradingView charts are **unchanged**. The
only edits to pre-existing files are four additive lines in `server.js` (two
route mounts, one init, one shutdown hook) plus a new section in
`.env.example`.

`BROKER_MODULE_ENABLED=false` makes every broker route return 404 without
affecting anything else.

---

## Adding a broker

1. Create `backend/src/brokers/<code>/` with an adapter extending
   `BrokerAdapter` and an `index.js` descriptor (copy `brokers/dhan/`).
2. Add one line to `brokers/index.js`:
   `registry.register(require('./<code>'));`

Routes, controllers, services, models, the queue, the rate limiter, the audit
trail and the frontend need no changes. See
[ARCHITECTURE.md § 4](./ARCHITECTURE.md#4-adding-a-broker).

---

## Operations

| Task | How |
|---|---|
| Health (queues, sockets, limits, cache, encryption) | `GET /api/broker/health` *(admin)* |
| Trace one order end-to-end | `GET /api/orders/:clientOrderId/audit` |
| Force a broker reconciliation | `POST /api/broker/portfolio/sync` |
| Throttle a broker during an incident | `BROKER_RATELIMIT_DHAN_ORDERS_PERSECOND=5` |
| Disable the module entirely | `BROKER_MODULE_ENABLED=false` |
| Rotate the encryption key | [SECURITY.md § 2](./SECURITY.md#2-credential-encryption) |
