# Runbook: Wallet ledger mismatch

**Severity:** P0 — financial integrity issue, user trust on the line.

## Symptoms
- `reconciliationService` daily report alerts: "X trades in window but 0 TRADE_CLOSE ledger rows".
- User opens support ticket: "my balance is wrong after closing this position".
- Audit query shows wallet.balance != Σ(ledger entries).

## Triage (first 10 minutes)
1. **Identify scope** — single user or platform-wide?
   ```js
   // Compare ledger sum vs wallet.balance for one user:
   const w = await Wallet.findOne({ userId, accountId, currency });
   const sum = (await WalletLedger.aggregate([
     { $match: { walletId: w._id } },
     { $group: { _id: null, total: { $sum: { $toDouble: '$amount' } } } }
   ]))[0]?.total;
   console.log({ walletBalance: w.balance, ledgerSum: sum, diff: Number(w.balance) - sum });
   ```
2. **Identify direction** — wallet ahead of ledger (free money) vs wallet behind ledger (user shorted).

## If single user
- Find the missing ledger entry. Most common causes:
  1. settleTradeClose ran but ledger insert hit a duplicate `dedupeKey` and short-circuited — check ledger rows on `dedupeKey` LIKE `TRADE_SETTLE:%`.
  2. Wallet was credited via direct `findOneAndUpdate` without going through walletService (bug).
  3. Concurrent settles created phantom credit (the dedupeKey index prevents this — verify the index exists).
- **Fix:** create a manual ledger entry of type `ADJUSTMENT` with the correcting amount and a clear `note: "Reconciliation: TKT-1234 — missing TRADE_CLOSE for position abc"`. Update AuditLog.

## If platform-wide
- HALT new orders immediately: `kubectl scale deploy/backend --replicas=0`. (Yes, this is harsh — financial integrity > availability.)
- Triage in maintenance mode. DO NOT let new trades land while ledger is broken.
- Restore from the most recent backup that pre-dates the mismatch. Apply transactions forward from audit logs to recover post-backup activity.

## Prevention
- Daily reconciliation cron is the canary. Ensure the alert is routed to PagerDuty.
- Code review rule: NEVER write to Wallet.balance directly. Always go through `walletService.credit` / `debit` / `settleTradeClose`.
- The `dedupeKey` unique sparse index on WalletLedger is the safety net — check it exists in every environment:
  ```js
  db.walletledgers.getIndexes()
  // must include: { dedupeKey: 1 }, unique: true, sparse: true
  ```
