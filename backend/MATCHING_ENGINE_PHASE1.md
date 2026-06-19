# Matching Engine — Phase 1 (In-Memory Ledger + Journal + Write-Behind)

Target: **3,000–5,000 orders/sec per symbol** (from ~110/sec today).

> Status: foundation modules built (`LedgerCache.js`, `Journal.js`, `WriteBehind.js`).
> **Gate 1 (ledger correctness) is GREEN** — `scripts/verify-ledger.js` proves the
> in-memory ledger settles balances/margin/positions byte-for-byte vs the live
> engine (30 checks, 0 divergences) AND vs an independent reference model.
> `scripts/bench-ledger.js` confirms in-memory matching ≈ 255k fills/sec locally
> (3.92 µs/op) — i.e. matching is NOT the ceiling; persistence is. Still **not
> wired into the live money path**. Roll out increment-by-increment behind a flag.
>
> Next gate: run `MONGO_URI=… node scripts/bench-ledger.js` on a capable instance
> (NVMe) to measure the Journal group-commit ACK rate — that's the number that
> must clear 40–50k/sec.

---

## 1. Why we can't get there today

Per order, the hot path awaits ~5–7 **sequential** Mongo writes inside the
per-symbol serial queue:

```
Trade.create → Position.findOneAndUpdate → Wallet.findOneAndUpdate
            → WalletLedger.create(s) → Order.save
```

At ~1 ms/op (local) → ~6–7 ms/order → ~110/sec. 5,000/sec needs **0.2 ms/order**
→ a DB round-trip per order is impossible. The matching itself (in-memory order
book) is already microseconds; **persistence is the ceiling.**

## 2. Core idea: decouple matching from persistence

```
            ┌─────────────── per-symbol single writer ───────────────┐
 order ──▶  │ 1. match + settle IN MEMORY (µs)                        │ ──▶ ACK
            │ 2. append event to JOURNAL (WAL, group-commit, durable) │
            │ 3. enqueue derived DB writes to WRITE-BEHIND (no await) │
            └────────────────────────────────────────────────────────┘
                                   │ (async, batched)
                                   ▼
                    Mongo: Trade / Position / Wallet / Ledger / Order
```

- **In-memory ledger** = source of truth for balances + positions while running.
- **Journal (WAL)** = durability anchor. The ACK waits only for the journal
  group-commit (one fsync amortized across many orders), **not** for the derived
  writes.
- **Write-behind** = batches the derived writes via `bulkWrite`, off the hot path.
- Mongo becomes the **derived/reporting store**, not the matching source of truth.

## 3. In-memory ledger (the crux + the risk)

`LedgerCache` holds, per account (lazily loaded from Mongo on first touch):

```
balances: accountId -> { balance, locked, currency }
positions: `${accountId}|${symbol}|${positionSide}` -> { qty, entryPrice, margin, side, ... }
```

Rules:
- **Single-writer per symbol** already guaranteed (per-symbol promise chain) →
  no locks needed within a symbol.
- An account can trade **multiple symbols** → its balance is touched by multiple
  symbol-writers. Phase 1 keeps the existing per-symbol serialization; for
  cross-symbol balance safety we either (a) pin an account to one shard, or
  (b) use atomic in-memory ops on a single-process ledger (Node is single-
  threaded, so map mutations are atomic within the process). Phase 1 = single
  process → (b) holds. Phase 2 (sharding) requires (a) or Redis.
- Settlement math is identical to today (`computeCloseFee`, half-spread, PnL) —
  only **where state lives** changes (memory vs Mongo).

## 4. Journal (WAL) — durability

Collection `EngineJournal`: `{ seq, symbol, type, payload, applied, ts }`.

- `append(entry)` → resolves once the entry is **group-committed** (insertMany
  batched every ~5 ms). The order ACKs after this. One commit covers N orders.
- After write-behind flushes the derived writes for a set of `seq`s, mark them
  `applied:true` (checkpoint). Applied entries are purged periodically.
- **Crash recovery (startup):** rebuild `LedgerCache` from Mongo (Wallet +
  open Positions), then `replayUnapplied()` re-applies journal entries whose
  derived writes never flushed → memory + Mongo converge. Idempotent via the
  existing `dedupeKey` on WalletLedger.

Durability guarantee: an ACKed order is in the journal. If the process dies
before write-behind flushes, replay reconstructs the derived writes. **No money
is lost**; at most the derived collections lag by the un-flushed window, healed
on restart.

## 5. Write-behind

`WriteBehind` buffers ops per model, flushes via `model.bulkWrite(ops,{ordered:false})`
every ~25 ms or at `maxBatch`. Same-document churn is coalesced upstream by the
ledger (we write the **latest** position/wallet state, not every intermediate).
On flush success → `journal.markApplied(seqs)`. On failure → re-queue (journal
still holds the truth).

## 6. Failure modes & answers

| Failure | Outcome |
|---|---|
| Crash after journal commit, before DB flush | Replay journal on boot → DB converges. No loss. |
| Crash before journal commit | Order was never ACKed → client retries / it never happened. |
| DB flush fails transiently | Re-queued; journal unchanged; retried next tick. |
| Duplicate settle (replay) | `dedupeKey` unique index makes it idempotent (already in place). |
| Memory vs DB drift | Periodic reconciliation job compares ledger snapshot vs Mongo. |

## 7. Rollout — increments (each independently shippable + testable)

- **Increment 0 (done — Phase 0):** instrument/account caches, version-safe
  lastPrice, parallel Trade+settle. ~92→110/sec.
- **Increment 1 (infra, no behavior change):** land `Journal.js` + `WriteBehind.js`
  modules. Not wired. ← _this commit_
- **Increment 2 (shadow):** in write-behind mode (flag `MATCHING_WRITE_BEHIND`,
  default OFF), run the B-book path through `LedgerCache` + Journal + WriteBehind.
  Validate in **staging** with the bench + a reconciliation check (ledger vs DB).
- **Increment 3 (recovery):** journal replay on boot; kill-9 tests prove no loss.
- **Increment 4 (enable):** flip the flag in staging → load test to 3–5k/sec →
  then production.
- **Increment 5 (scale-out, Phase 2):** per-symbol sharding, Redis/streams,
  Mongo replica set.

## 8. Feature flag & safety

- `MATCHING_WRITE_BEHIND` (default `false`) — when off, the engine is byte-for-byte
  today's behavior. The new path is dead code until explicitly enabled.
- Enable only after: bench ≥ target, reconciliation clean, kill-9 recovery proven.
- Roll back instantly by unsetting the flag (in-memory state flushes via `drain()`
  on graceful shutdown).

## 9. Tuning knobs (env)

```
MATCHING_WRITE_BEHIND=false           # master switch
MATCHING_JOURNAL_COMMIT_MS=5          # group-commit window (durability vs latency)
MATCHING_WRITEBEHIND_FLUSH_MS=25      # derived-write flush window
MATCHING_WRITEBEHIND_MAX_BATCH=1000   # force-flush threshold
MATCHING_INSTRUMENT_CACHE_MS=50       # (Phase 0) price staleness bound
```

## 10. Open decisions (need owner sign-off before Increment 2)

1. **Durability latency:** commit window 5 ms (≈ up to 5 ms of orders share a
   fsync). Acceptable? Lower = safer/slower, higher = faster/riskier.
2. **Cross-symbol accounts:** single process is safe now; sharding (Phase 2)
   needs account→shard pinning or a Redis balance authority. Pick before scale-out.
3. **Mongo write concern** for derived writes: `w:1` (fast) vs `majority` (safe).
   With the journal as the anchor, `w:1` is acceptable.
