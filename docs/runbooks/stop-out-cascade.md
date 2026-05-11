# Runbook: Stop-out cascade

**Severity:** P1 — multiple accounts auto-liquidating in a short window.

## Symptoms
- Sentry alerts: "stop-out close failed" or "negative balance close failed".
- `open_positions` gauge in Prometheus drops by >5% within a 1-min window.
- Customer reports of "all my positions closed without warning".

## Likely causes
1. Sudden price gap (e.g. weekend close, market open) crossed many users' stop-out level simultaneously.
2. Bad tick from the price feed (e.g. Finnhub flash zero).
3. Margin call worker calling `_submit` and routing fails repeatedly for one symbol → cascade.

## Triage (first 5 minutes)
1. Check `/api/admin/exposure/<symbol>` for affected symbols — is broker exposure normal?
2. Tail backend logs: `kubectl logs -l app=backend --tail=200 | grep -E "STOP_OUT|NEGATIVE_BALANCE"`.
3. Check feed health: `curl /api/admin/data-feeds` — any provider showing stale ticks?

## If bad tick
- Identify the symbol + the offending tick timestamp from the worker log.
- Halt feed: `POST /api/admin/data-feeds/halt` body `{symbol, durationMs: 60000}` (or set instrument `isActive=false` in admin).
- Reverse the affected closes manually: each closed Position has `closeReason: STOP_OUT` — find them by timestamp, restore via DB or `walletService.credit` to restore the wallet delta. Document on AuditLog.
- Re-enable feed once verified.

## If genuine market move
- Confirm price feed agrees with external sources (TradingView, Bloomberg).
- The closes are legitimate. Communicate to affected users.
- Audit each affected position for slippage vs the user's actual stop level — if our fill was materially worse than the trigger, consider goodwill credits.

## Prevention
- Monitor `bbook_net_exposure` per symbol; alert when any symbol exceeds the configured cap.
- Stagger SL/TP triggers via worker batching (currently sequential — already mitigates).
- Validate every price tick against a sanity range (e.g. <5% move from previous tick) before persisting.
