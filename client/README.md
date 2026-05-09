# Trading Platform - Trader Client

React + Vite + Tailwind trader UI.

## Features

- Login / Register with optional 2FA
- Dashboard overview (balances, P&L, positions, markets)
- Real-time trade page:
  - TradingView Lightweight Charts (OHLCV) with timeframe switching
  - Live order book (WebSocket-driven)
  - Order entry (Market / Limit / Stop) with leverage slider, SL / TP
  - Open positions and orders tabs (close / cancel actions)
- Wallet page (balances, deposits, withdrawals, ledger)
- Profile (KYC submission, 2FA setup, referral code)
- Order history

## Stack

- React 18, Vite 5
- React Router 6
- Tailwind CSS
- Zustand (state)
- Axios (with token refresh interceptor)
- TradingView Lightweight Charts
- react-hot-toast

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The client runs on http://localhost:5173 and expects the backend at http://localhost:5000.

## Demo Credentials

Trader: `trader@tradingplatform.local` / `Trader@12345`
