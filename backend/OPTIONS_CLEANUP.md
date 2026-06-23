# Indian Options — instrument-explosion fix

Collapses the option universe from ~6,000 contracts to a small **near-expiry
chain per underlying**, removes options from the bulk instrument APIs, and keeps
everything else (equities, futures, orders, positions, history) untouched.

## What changed (behaviour)

| Area | Before | After |
|---|---|---|
| Option contracts in DB | ~5,974 (all strikes, all expiries) | ~few hundred (2 nearest expiries, ±12% strikes) |
| `/api/instruments` & `/watchlist` | returned all ~6k (slow/fail) | exclude options → ~200–300 rows, fast |
| Explore / strip / watchlists | options mixed in (category STOCK/INDEX) | equities + futures only |
| Search | client-filtered catalog | new `/api/instruments/search` — equities/futures first, options only on option-like queries |
| Option chain | unchanged | unchanged (`/api/instruments/option-chain`) |
| Live feed / WS | polled+streamed ~6k | polls the small kept set only |

## Tunable env (safe defaults)

```
DHAN_SYNC_FNO=NIFTY,BANKNIFTY,FINNIFTY   # underlyings to keep options for (+MIDCPNIFTY / stocks as needed)
DHAN_OPT_EXPIRIES=2                       # nearest non-expired expiries per underlying
DHAN_OPT_STRIKE_PCT=12                    # keep strikes within ±N% of ATM (0 = all strikes)
```

## Migration steps (EC2)

```bash
git pull && docker compose up -d --build backend

# 1. Preview what would change (no writes):
docker compose exec -e DRY_RUN=true backend node scripts/cleanup-options.js

# 2. Apply (deactivates far/expired options; equities/futures untouched):
docker compose exec backend node scripts/cleanup-options.js

# 3. Confirm APIs are fast + options gone from the bulk list:
docker compose exec backend node scripts/verify-indian-live.js
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" "https://<host>/api/instruments"
```

The daily `dhanInstrumentSync` now self-maintains this (imports only the
near-expiry chain and deactivates the rest each run), so the bloat won't return.

## Rollback strategy

Everything is an `isActive` flip — **no deletes, fully reversible**:

```bash
# Re-activate ALL options (undo the cleanup):
docker compose exec -e RESTORE=true backend node scripts/cleanup-options.js

# Revert the code (sync/list behaviour) if needed:
git revert <commit>   # then rebuild backend
```

The list/search exclusion also has a runtime escape hatch — `?includeOptions=true`
or `?segment=OPT` on `/api/instruments` returns options without any redeploy.

## Performance impact (estimate)

- **Instruments in bulk APIs:** ~6,000 → ~200–300 (~20× smaller payload).
- **API response (`/instruments`, `/watchlist`):** seconds/timeout → ~sub-second.
- **DB option docs active:** ~6,000 → ~few hundred.
- **Live-feed work / WebSocket fan-out:** polls + streams only the kept set (large drop in DB writes, candle work, and socket messages).
- **Chart load / search:** faster (smaller catalog; search is an indexed, limited query).

## Safety

- No schema changes. No deletes. Orders, positions, trades, wallets, balances untouched.
- Only options (`segment:'OPT'`) are deactivated; equities & futures are left alone.
- `DRY_RUN` preview + `RESTORE` rollback.

## Files modified

- `backend/src/services/optionUniverse.js` — **new**: keep-rules (underlyings, near expiries, strike window).
- `backend/src/services/dhanInstrumentSync.js` — import only the near-expiry chain; deactivate non-kept options.
- `backend/scripts/cleanup-options.js` — **new**: safe DB migration (DRY_RUN / RESTORE).
- `backend/src/controllers/instrumentController.js` — `list`/`watchlist` exclude options; new `search` endpoint.
- `backend/src/routes/instrument.js` — register `/search`.
- (Frontend auto-benefits: Explore / instrument strip / market-watch consume `/instruments` + `/watchlist`. Optional follow-up: wire the global search box to `/api/instruments/search` so option-like queries surface options.)
