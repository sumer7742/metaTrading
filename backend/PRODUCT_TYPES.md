# Indian cash-equity Product Types — Delivery vs Intraday

Makes NSE/BSE cash stocks behave like a real broker: a **Delivery (CNC)** vs
**Intraday (MIS)** choice that drives leverage, STT, and auto square-off. Only
applies to `segment:'EQ'` on NSE/BSE — forex, crypto and F&O are unaffected
(`productType:'NORMAL'`).

| | Delivery (CNC) | Intraday (MIS) |
|---|---|---|
| Leverage | **1x** (full cash) | **5x** (`INTRADAY_EQUITY_LEVERAGE`, capped by instrument/account) |
| STT | 0.1% on **both** legs (buy+sell) | 0.025% **sell-only** |
| Stamp duty | 0.015% buy | 0.003% buy |
| Square-off | held until user closes | **auto at 15:15 IST** (`INTRADAY_SQUAREOFF_IST`) |

Example (qty 10, entry ₹1300, exit ₹1320, ₹20 brokerage): Delivery ≈ ₹52.70,
Intraday ≈ ₹27.38.

## How it flows
1. **Order** — client sends `productType` for Indian equity. `orderController`
   sets leverage (1x delivery / 5x intraday) and stamps it on the Order.
2. **Position** — matching engine carries `productType` from order → Position at
   open (threaded through `_updatePosition`).
3. **Charges** — `accountFeeService.computeCloseFee` reads `pos.productType` +
   `pos.entryPrice`: delivery charges **both** legs' STT/stamp, intraday the sell
   leg only. Default (no productType) = INTRADAY → prior behaviour unchanged.
4. **Square-off** — `backgroundWorker.checkIntradaySquareOff()` (tick) closes any
   OPEN `INTRADAY` position at/after 15:15 IST on a trading day, reason
   `INTRADAY_SQUAREOFF`, via the normal closeOnly settlement route.

## Env knobs
```
INTRADAY_EQUITY_LEVERAGE=5      # intraday leverage cap for NSE/BSE EQ
INTRADAY_SQUAREOFF_IST=915      # minutes-from-midnight IST (915 = 15:15)
```

## Safety / backward compatibility
- New optional field `productType` (default `NORMAL`); no schema break.
- `_updatePosition` got a trailing optional param — existing call sites unaffected.
- `computeCloseFee` defaults to INTRADAY when productType is absent → no change for
  pre-existing positions / non-equity.
- No changes to orders, balances, or other asset classes.

## Files modified
- `backend/src/models/Order.js`, `backend/src/models/Position.js` — `productType` field; `INTRADAY_SQUAREOFF` close reason.
- `backend/src/controllers/orderController.js` — product-type leverage + stamp on order.
- `backend/src/matching-engine/MatchingEngine.js` — thread productType to Position; pass productType+entryPrice to close-fee.
- `backend/src/services/accountFeeService.js` — STT by product type (delivery both legs).
- `backend/src/services/backgroundWorker.js` — `checkIntradaySquareOff()` in the tick.
- `client/src/components/OrderForm.jsx` — Delivery/Intraday toggle + payload + charges preview.
- (`backend/src/services/indianCharges.js` already supported DELIVERY/INTRADAY — unchanged.)
