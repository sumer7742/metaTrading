# Broker Module — Architecture

Broker-agnostic trading terminal for the Indian stock market.

**We are not a broker.** Users trade through their own broker accounts; we route
their orders to whichever broker they connected. Execution, funds and custody
stay with the broker. This module is the routing, normalization, safety and
audit layer in between.

Initially one broker is wired up (**Dhan**). The architecture supports unlimited
brokers — Upstox, FYERS, Angel One, Zerodha, Shoonya and anything after them.

---

## 1. The rules this design enforces

| Rule | How it is enforced (not just documented) |
|---|---|
| The frontend never talks to a broker | The only broker-reachable code is server-side, behind `authenticate`. The browser never sees a broker URL or token. |
| The frontend always talks to us | One endpoint per action (`POST /api/orders`), identical for every broker. |
| The backend decides the adapter | `BrokerRouter` resolves broker → connection → adapter at runtime. |
| No broker-specific logic outside adapters | Broker names, enums, URLs and error strings appear **only** under `brokers/<code>/`. Services speak `brokers/constants.js`. |
| Adding a broker = create + register | Two steps, one line of wiring. Nothing else changes. |
| Forex / crypto / wallet / admin untouched | Separate routes, separate models, separate services. The only edits to existing files are 4 additive lines in `server.js`. |

---

## 2. Request flow

```
Frontend
   │  POST /api/orders { symbol, exchange, qty, side, orderType, productType, broker? }
   ▼
Route            routes/brokerOrders.js      auth · per-user limit · zod validation · idempotency key
   ▼
Controller       controllers/brokerOrderController.js
   ▼
Command service  services/broker/brokerOrder.service.js
   │               1. resolve broker      (explicit, or the user's default)
   │               2. claim clientOrderId (unique index — idempotency)
   │               3. validate            (session, lot size, circuits, price)
   │               4. CREATED → VALIDATED → QUEUED
   ▼
BrokerRouter     brokers/BrokerRouter.js     picks the adapter, applies dispatch policy
   ▼
OrderQueue       brokers/queue/OrderQueue.js FIFO within priority · retry · back-pressure
   ▼
RateLimiter      brokers/queue/RateLimiter.js sliding windows per broker per category
   ▼
BrokerManager    brokers/BrokerManager.js    adapter pool (decrypt once, reuse)
   ▼
Adapter          brokers/dhan/DhanAdapter.js normalized in → normalized out
   ▼
Broker API       api.dhan.co
```

Every step writes to the audit trail: `BrokerLog` (stage narrative),
`OrderAudit` (immutable transitions), `BrokerError` (normalized failures).

Nothing bypasses the queue. `queue.submit()` is the single choke point, which is
what makes "never exceed a broker's API limit" a structural guarantee rather
than a code-review rule.

---

## 3. Folder structure

```
backend/src/
├── brokers/
│   ├── index.js                    module entry: register brokers, init, shutdown, health
│   ├── constants.js                platform vocabulary (statuses, sides, products, exchanges)
│   ├── registry.js                 THE extension point — register/get/list brokers
│   ├── BrokerFactory.js            builds adapter instances (only place that does)
│   ├── BrokerRouter.js             which broker · dispatch policy · post-call policy
│   ├── BrokerManager.js            adapter pool + broker socket supervision + WS fan-out
│   │
│   ├── base/
│   │   ├── BrokerAdapter.js        the interface every broker implements
│   │   ├── AuthProvider.js         replaceable auth strategy (MANUAL / OAUTH)
│   │   ├── MarketDataProvider.js   price sources, decoupled from execution
│   │   ├── BrokerError.js          normalized error codes + classification
│   │   └── normalize.js            normalized response contracts
│   │
│   ├── queue/
│   │   ├── OrderQueue.js           FIFO · priority · retry · concurrency · drain
│   │   ├── RateLimiter.js          per-broker, per-category sliding windows
│   │   └── index.js                submit() — the only sanctioned path to a broker
│   │
│   ├── marketdata/
│   │   └── MarketDataRegistry.js   Dhan today; TrueData / Polygon / … later
│   │
│   ├── validation/schemas.js       zod schemas for every broker endpoint
│   │
│   └── dhan/                       ◄── one folder per broker
│       ├── index.js                descriptor (what registry.register receives)
│       ├── DhanAdapter.js          composition root
│       ├── DhanHttpClient.js       auth headers · timeouts · error mapping
│       ├── config.js               URLs, enums, rate limits, timeouts
│       ├── errors.js               Dhan error → normalized code
│       ├── mappers.js              Dhan ⇄ platform translation
│       ├── SymbolResolver.js       symbol → Dhan securityId
│       ├── auth/                   manual-token provider · OAuth plug point
│       ├── orders/ positions/ holdings/ funds/ history/
│       ├── marketdata/             quotes, candles, session status
│       └── websocket/              order-update socket (reconnect + heartbeat)
│
├── services/broker/
│   ├── tokenEncryption.service.js  AES-256-GCM envelope encryption (+ KMS hook)
│   ├── brokerConnection.service.js the only module that touches credentials
│   ├── brokerOrder.service.js      CQRS commands: place / modify / cancel
│   ├── brokerPortfolio.service.js  CQRS queries: positions / funds / holdings / …
│   ├── brokerSync.service.js       reconciliation + polling fallback
│   ├── idempotency.service.js      clientOrderId generation + dedupe
│   ├── instrumentCatalog.service.js broker-neutral instrument metadata (read-only)
│   ├── brokerAudit.service.js      audit trail + redaction
│   └── cache.js                    Redis-or-memory read cache
│
├── models/                         BrokerConnection · OrderSync · BrokerLog
│                                   BrokerError · OrderAudit
├── controllers/                    brokerController.js · brokerOrderController.js
├── routes/                         broker.js (/api/broker) · brokerOrders.js (/api/orders)
└── middleware/                     validate.js · brokerContext.js
```

---

## 4. Adding a broker

Two steps. Genuinely.

**1. Create the adapter package** — `brokers/upstox/`:

```js
// brokers/upstox/UpstoxAdapter.js
class UpstoxAdapter extends BrokerAdapter {
  capabilities() { return { placeOrder: true, /* … */ }; }
  async connect()          { /* probe the token */ }
  async placeOrder(req)    { /* normalized in → normalize.orderAck out */ }
  async modifyOrder(req)   { /* … */ }
  async cancelOrder(req)   { /* … */ }
  async positions()        { /* → normalize.position[] */ }
  async holdings()         { /* → normalize.holding[]  */ }
  async funds()            { /* → normalize.funds      */ }
  async orders(filter)     { /* → normalize.order[]    */ }
  async history(range)     { /* → normalize.trade[]    */ }
  async quotes(list)       { /* → normalize.quote[]    */ }
  async marketStatus(ex)   { /* → normalize.marketStatus[] */ }
}
```

```js
// brokers/upstox/index.js
module.exports = {
  code: 'UPSTOX',
  name: 'Upstox',
  createAdapter: (ctx) => new UpstoxAdapter(ctx),
  authProviders: { MANUAL: (ctx) => new UpstoxAuthProvider(ctx) },
  capabilities: { placeOrder: true, /* … */ },
  rateLimits: { orders: { perSecond: 10 }, data: { perSecond: 5 } },
};
```

**2. Register it** — one line in `brokers/index.js`:

```js
registry.register(require('./upstox'));
```

Done. The broker now appears in `GET /api/broker/brokers` with its credential
fields, gets its own queue and rate limiter, accepts orders on the same
`POST /api/orders`, and is covered by the same audit trail, idempotency,
reconciliation and error handling.

**Not changed:** routes, controllers, services, models, the queue, the
frontend.

### Adapter contract

1. Accept only normalized input (`brokers/constants.js` vocabulary).
2. Return only values built by `base/normalize.js`.
3. Throw only `BrokerError` (`BrokerError.from(err, this.broker)`).
4. Never log, return, or embed credentials.
5. Never retry or rate-limit internally — the queue owns that, so behaviour is
   identical across brokers.

---

## 5. Design decisions worth knowing

**Authentication is not assumed to be OAuth.** Indian brokers differ wildly:
Dhan issues a long-lived dashboard token, Zerodha needs a daily request-token
exchange, Angel One uses TOTP. `AuthProvider` is a strategy with
`supportsRefresh()` as a *question*, never an assumption. `refresh()` throws
`UNSUPPORTED_OPERATION` by default rather than silently pretending.

**Market data is decoupled from execution.** A user can execute through Dhan
while the platform prices from TrueData. `MarketDataRegistry` selects the
source; `MARKET_DATA_PROVIDER` sets the default.

**Charts are untouched.** TradingView Lightweight Charts keep running on the
existing feed pipeline (`services/dhanFeed.js` → `candleService` → the
`ticker:` / `candles:` websocket channels). The broker module never writes to
it. Broker data can become a chart source later by registering a provider — a
backend decision, no frontend change.

**One exchange calendar.** Pre-trade session checks reuse
`services/marketHours.js`, the same calendar the forex/crypto engine uses. The
chart and the order pad can never disagree about whether NSE is open.

**Websocket is primary, polling is the safety net.** Sockets drop, reconnect
after the fill, or don't exist for some brokers. The broker's order book is the
source of truth: `brokerSync.service` reconciles after every socket reconnect
and sweeps users with open orders while markets are open.

**Broker sockets are isolated.** One user, one broker socket, owned by the
adapter and supervised by `BrokerManager`, which re-publishes on the platform's
existing WebSocket (`user:broker:order`). A broker socket can die and reconnect
without any user-facing socket noticing.

---

## 6. CQRS split

| | Command side | Query side |
|---|---|---|
| Service | `brokerOrder.service.js` | `brokerPortfolio.service.js` |
| Operations | place, modify, cancel | positions, funds, orders, holdings, history |
| Guarantees | exactly-once, durable, fully audited | cheap, cacheable, safe to repeat |
| Caching | never | Redis/memory, 2–30s TTL, `?force=true` bypasses |
| Invalidation | every write clears the user's read models | — |
| Failure mode | fail loudly, record everything | degrade partially (`summary` returns what it can) |

---

## 7. Failure handling

| Situation | Behaviour |
|---|---|
| Order times out | Reconcile by `clientOrderId` before declaring failure. Dhan indexes it as `correlationId`, so we ask "did you get it?" instead of guessing. No duplicate order. |
| Token invalid/expired | Connection flipped to `INVALID`/`EXPIRED` immediately, adapter evicted, UI prompts reconnect. One clear message beats a stream of rejections. |
| Broker 5xx / network | Retried with exponential backoff + jitter inside the queue; deterministic rejections (margin, quantity) never retried. |
| Rate limit hit | Requests queue instead of failing; only a wait beyond the timeout budget surfaces `RATE_LIMIT` with `Retry-After`. |
| Broker socket drops | Exponential reconnect with jitter (prevents thundering-herd), then a REST re-sync to recover missed updates. |
| Socket open but silent | Idle watchdog forces a reconnect — a half-open TCP connection is the failure mode that silently breaks order updates. |
| Broker module fails at boot | Logged; the platform still starts. Forex, crypto, wallet and admin do not depend on it. |
| Server shutting down | Queues drain, sockets close, in-flight orders finish writing their lifecycle rows before the DB closes. |
