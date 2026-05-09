# Trading Platform - Backend

Hybrid Exchange + Broker backend (Node.js + Express + MongoDB + WebSockets).

## Features

- JWT auth with refresh tokens + 2FA (TOTP)
- KYC submission and review
- Multi-currency wallets with append-only ledger
- Trading accounts (Real / Virtual / Demo / Custom)
- Instruments with per-instrument config (leverage, spread, mode, B-book)
- Order placement (MARKET, LIMIT, STOP)
- In-memory matching engine with price-time priority
- Position aggregation
- OHLCV candle generation across multiple timeframes
- Real-time WebSocket streaming (order book, trades, candles, user events)
- Admin panel APIs (users, KYC review, withdrawals with 4-eyes, audit log)
- Risk engine (margin, equity, free margin, margin level)

## Important Notes

The official spec recommends **PostgreSQL** for ACID guarantees on financial data.
This MERN implementation uses **MongoDB** as requested. For production trading you should:
- Add multi-document transactions (Mongo replica set required)
- Or migrate the wallet ledger and trades to PostgreSQL with NUMERIC types

All money values in this codebase are stored as **strings** and computed with `decimal.js`
to avoid floating-point errors. Never cast them to JS `Number` for arithmetic.

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# edit .env -> set MONGODB_URI, JWT_*_SECRET, etc.

# 3. Start MongoDB locally (or use Atlas / Docker)
# docker run -d -p 27017:27017 --name trading-mongo mongo:7

# 4. Seed sample data
npm run seed

# 5. Start server
npm run dev
```

Default seeded credentials (change in production!):
- Admin: `admin@tradingplatform.local` / `Admin@12345`
- Trader: `trader@tradingplatform.local` / `Trader@12345`

## API Endpoints

### Auth
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login (with optional `twoFactorCode`)
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout (auth)
- `GET  /api/auth/me` - Current user (auth)
- `POST /api/auth/2fa/setup` - Get TOTP secret + QR (auth)
- `POST /api/auth/2fa/enable` - Enable 2FA (auth, code required)
- `POST /api/auth/2fa/disable` - Disable 2FA (auth, code required)

### User
- `PUT  /api/user/profile` - Update profile
- `POST /api/user/kyc` - Submit KYC documents
- `GET  /api/user/kyc/status` - KYC status
- `GET  /api/user/accounts` - List trading accounts
- `POST /api/user/accounts` - Create trading account

### Wallet
- `GET  /api/wallet/balances?accountId=` - Balances
- `GET  /api/wallet/ledger?accountId=` - Ledger entries
- `POST /api/wallet/deposits` - Request deposit
- `GET  /api/wallet/deposits` - List deposits
- `POST /api/wallet/withdrawals` - Request withdrawal
- `GET  /api/wallet/withdrawals` - List withdrawals

### Instruments
- `GET  /api/instruments` - List active instruments
- `GET  /api/instruments/:symbol` - Instrument details
- `GET  /api/instruments/:symbol/candles?timeframe=1m&limit=500` - OHLCV
- `GET  /api/instruments/:symbol/orderbook?depth=25` - Order book snapshot
- `POST /api/instruments` (admin) - Create instrument
- `PUT  /api/instruments/:symbol` (admin) - Update instrument
- `DELETE /api/instruments/:symbol` (admin) - Soft delete

### Trading
- `POST /api/trading/orders` - Place order
- `GET  /api/trading/orders/open` - Open orders
- `GET  /api/trading/orders/history` - Order history
- `DELETE /api/trading/orders/:id` - Cancel order
- `GET  /api/trading/positions` - Open positions
- `POST /api/trading/positions/:id/close` - Close position

### Admin (requires ADMIN or SUPER_ADMIN role)
- `GET  /api/admin/dashboard` - Stats
- `GET  /api/admin/users` - Users list (search, filter)
- `GET  /api/admin/users/:id` - User detail
- `PUT  /api/admin/users/:id/status` - Block / unblock
- `POST /api/admin/users/:id/kyc-review` - Approve/reject KYC
- `POST /api/admin/users/:id/balance-adjustment` - Manual adjustment (audited)
- `GET  /api/admin/withdrawals` - List withdrawals
- `POST /api/admin/withdrawals/:id/approve` - Approve (4-eyes for >$10k)
- `POST /api/admin/withdrawals/:id/reject` - Reject
- `GET  /api/admin/deposits` - List deposits
- `POST /api/admin/deposits/:id/confirm` - Confirm deposit
- `GET  /api/admin/audit-log` - Audit log
- `GET  /api/admin/reports/trades` - Trade report
- `GET  /api/admin/accounts/:accountId/metrics` - Account metrics

## WebSocket

Connect to `ws://localhost:5000/ws` (or `ws://localhost:5000/ws?token=<accessToken>` for private channels).

Subscribe:
```json
{ "action": "subscribe", "channel": "orderbook:BTCUSD" }
```

Channels:
- Public: `ticker:<symbol>`, `orderbook:<symbol>`, `trades:<symbol>`, `candles:<symbol>:<tf>`
- Private (token required): `user:orders`, `user:positions`, `user:wallet`, `user:notifications`
- Admin: `admin:exposure`

## Project Structure

```
src/
  config/        DB connection, constants
  controllers/   Route handlers
  middleware/    Auth, error handler
  models/        Mongoose schemas
  routes/        Express routers
  services/      Wallet, candle, risk
  matching-engine/  OrderBook + MatchingEngine
  websocket/     WS server
  utils/         Decimal, JWT, errors, seed
  server.js      Entry point
```

## Production TODO

- Move order book state to Redis (currently in-process)
- Implement STOP order trigger monitor
- Wire up real email sender (SMTP / SendGrid)
- External feed adapters (Binance WS / TradingView / NSE)
- B-book engine + hedging logic
- Prometheus metrics + Sentry error tracking
- MongoDB replica set with multi-doc transactions
- Idempotency on all financial endpoints (currently only orders)
