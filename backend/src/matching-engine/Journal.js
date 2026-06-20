/**
 * Journal — the matching engine's Write-Ahead Log (Phase 1).
 * See MATCHING_ENGINE_PHASE1.md.
 *
 * Every settled event is appended here BEFORE it's acknowledged. The append is
 * group-committed (many orders share one `insertMany`/fsync) so it's cheap per
 * order yet durable. The derived collections (Trade/Position/Wallet/Ledger/
 * Order) are written asynchronously by WriteBehind; once they land, the matching
 * journal entries are marked `applied` (checkpoint) and later purged.
 *
 * Crash recovery: on boot, rebuild the in-memory ledger from Mongo, then
 * `replayUnapplied()` re-applies any entries whose derived writes never flushed.
 * Idempotent via the existing WalletLedger `dedupeKey` unique index.
 *
 * NOT wired into the live path yet.
 */
const mongoose = require('mongoose');

const journalSchema = new mongoose.Schema(
  {
    seq:     { type: Number, index: true },   // monotonic within a process run
    symbol:  { type: String, index: true },
    type:    { type: String },                 // e.g. 'BBOOK_FILL'
    payload: mongoose.Schema.Types.Mixed,      // everything needed to re-derive writes
    applied: { type: Boolean, default: false, index: true },
    ts:      { type: Date, default: Date.now },
  },
  { versionKey: false }
);
// Replay scans unapplied entries oldest-first.
journalSchema.index({ applied: 1, seq: 1 });

const JournalEntry = mongoose.models.EngineJournal
  || mongoose.model('EngineJournal', journalSchema);

class Journal {
  constructor({ commitMs = 5, maxBatch = 1000 } = {}) {
    this.pending = [];          // [{ doc, resolve, reject }]
    this.commitMs = commitMs;
    this.maxBatch = maxBatch;
    this.timer = null;
    this.committing = false;
    // Monotonic seq seed. Multiplying the epoch keeps seqs increasing across
    // restarts without a counter collection (good enough for ordering + replay).
    this._seq = Date.now() * 1000;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this._commit().catch(() => {}); }, this.commitMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  nextSeq() { return ++this._seq; }

  /**
   * Durably append one event. Resolves with its `seq` once the group-commit
   * lands in Mongo — the caller (engine) ACKs the order only after this.
   * @param {{seq?:number, symbol:string, type:string, payload:object}} entry
   */
  append(entry) {
    const doc = {
      seq: entry.seq != null ? entry.seq : this.nextSeq(),
      symbol: entry.symbol,
      type: entry.type,
      payload: entry.payload,
      applied: false,
      ts: new Date(),
    };
    return new Promise((resolve, reject) => {
      this.pending.push({ doc, resolve, reject });
      if (this.pending.length >= this.maxBatch) this._commit().catch(() => {});
    });
  }

  async _commit() {
    if (this.committing || this.pending.length === 0) return;
    this.committing = true;
    const batch = this.pending;
    this.pending = [];
    try {
      // Write through the NATIVE driver collection, not Mongoose insertMany.
      // Mongoose insertMany validates + casts every document, which on the WAL's
      // hot path cost ~80x vs the raw driver (bench: 2.4k/s mongoose vs ~190k/s
      // raw bulkWrite). The WAL docs are already fully-formed, so skip all that.
      await JournalEntry.collection.insertMany(batch.map((b) => b.doc), { ordered: false });
      for (const b of batch) b.resolve(b.doc.seq);
    } catch (e) {
      for (const b of batch) b.reject(e);
    } finally {
      this.committing = false;
    }
  }

  /** Mark entries whose derived writes have been persisted (checkpoint). */
  async markApplied(seqs) {
    if (!seqs || !seqs.length) return;
    await JournalEntry.updateMany({ seq: { $in: seqs } }, { $set: { applied: true } });
  }

  /**
   * Re-apply every un-applied entry (oldest first) — call once on boot AFTER
   * the in-memory ledger is rebuilt from Mongo. `handler(entry)` must be
   * idempotent.
   * @returns {Promise<number>} count replayed
   */
  async replayUnapplied(handler) {
    const cursor = JournalEntry.find({ applied: false }).sort({ seq: 1 }).cursor();
    let n = 0;
    for (let e = await cursor.next(); e; e = await cursor.next()) {
      await handler(e);
      n += 1;
    }
    return n;
  }

  /** Commit anything pending — call on graceful shutdown. */
  async drain() {
    let guard = 0;
    while (this.pending.length && guard++ < 10000) {
      // eslint-disable-next-line no-await-in-loop
      await this._commit();
    }
  }

  /** Housekeeping — drop old applied entries to keep the WAL bounded. */
  async purgeApplied(olderThanMs = 3600000) {
    await JournalEntry.deleteMany({ applied: true, ts: { $lt: new Date(Date.now() - olderThanMs) } });
  }
}

module.exports = { Journal, JournalEntry };
