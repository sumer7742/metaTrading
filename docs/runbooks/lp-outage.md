# Runbook: LP outage

**Severity:** P1 — A-book orders are being rejected.

## Symptoms
- Sentry: `Worker route failed` errors for orders with `executionSource: LP` or `HYBRID_LP`.
- Affected users see toast: "Order rejected — LP error".
- `/api/admin/exposure/<symbol>` may show LP exposure flat (no new hedges going through).

## Triage (first 5 minutes)
1. Confirm the LP is actually down — `curl https://api-fxtrade.oanda.com/v3/accounts/<id>/summary` with the production token.
2. Check our adapter's last successful call timestamp from backend logs.
3. Check status page of the LP (OANDA status, Binance announcements).

## If LP confirmed down
1. **Flip affected accounts to HYBRID** so the risk engine can route at least small orders internally:
   ```
   PATCH /api/admin/accounts/<id>/execution-config
   { "bookType": "HYBRID" }
   ```
   Do this in a batch for every account on the affected LP. Document the change in AuditLog.
2. **Warn users** via in-app notification and email — "Your trades may temporarily fill internally during LP maintenance".
3. Monitor `bbook_net_exposure` — internal flow will grow. If exposure exceeds the comfort threshold, halt new orders on the affected symbols (set instrument `isActive=false`) until LP recovers.

## When LP recovers
1. Smoke-test with a small order from a test account: place a 0.01-lot BUY, verify `executionSource: LP` and `lpProviderOrderId` populated.
2. Revert affected accounts to A_BOOK in batch.
3. Reconcile B-book positions opened during the outage — depending on policy either close them at then-current LP price (hedge after the fact) or let them run.

## Prevention
- Multi-LP fallback: set up CUSTOM_LP as a second route for the same symbols; the orderRouter can pick by latency or status.
- Alert at p95 LP latency >2s for sustained 5 mins (early warning before full outage).
- Quarterly drill: deliberately set `OANDA_API_KEY=invalid` for 5 min, verify HYBRID accounts continue trading and A-book accounts get clean error toasts.
