/**
 * WriteBehind — batched, asynchronous persistence for the matching engine
 * (Phase 1). See MATCHING_ENGINE_PHASE1.md.
 *
 * The engine settles in memory + appends to the Journal (durable), then enqueues
 * the DERIVED Mongo writes here. We flush them in batches via `bulkWrite` on a
 * short interval (or when the buffer fills), keeping per-order DB cost OFF the
 * hot path.
 *
 * Ordering: same-document churn is coalesced UPSTREAM by the in-memory ledger
 * (we enqueue the latest position/wallet state, not every intermediate), so
 * `ordered:false` is safe and lets Mongo parallelize across documents.
 *
 * Durability: this layer may lose its in-flight buffer on a hard crash — that's
 * fine, because the Journal still holds every ACKed event and replays the
 * un-applied ones on boot. WriteBehind is "derived/repairable", never the truth.
 *
 * NOT wired into the live path yet — opt-in via the engine's write-behind mode.
 */
class WriteBehind {
  /**
   * @param {object}   opts
   * @param {number}   opts.flushMs   flush interval (ms)
   * @param {number}   opts.maxBatch  force-flush when buffered ops reach this
   * @param {function} opts.onFlushed async (seqs:number[]) => void — checkpoint
   *                                   the journal after derived writes land
   */
  constructor({ flushMs = 25, maxBatch = 1000, onFlushed = null } = {}) {
    this.buf = new Map();      // modelName -> { model, ops:[], seqs:[] }
    this.flushMs = flushMs;
    this.maxBatch = maxBatch;
    this.onFlushed = onFlushed;
    this.size = 0;
    this.timer = null;
    this.flushing = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Queue one Mongo write op for a model.
   * @param {import('mongoose').Model} model
   * @param {object} op   a bulkWrite op, e.g. { insertOne:{document} } or
   *                      { updateOne:{ filter, update, upsert } }
   * @param {number} [seq] the journal seq this write derives from (for checkpoint)
   */
  enqueue(model, op, seq) {
    let b = this.buf.get(model.modelName);
    if (!b) { b = { model, ops: [], seqs: [] }; this.buf.set(model.modelName, b); }
    b.ops.push(op);
    if (seq != null) b.seqs.push(seq);
    this.size += 1;
    if (this.size >= this.maxBatch) this.flush().catch(() => {});
  }

  /** Flush the current buffer via bulkWrite (one call per model, in parallel). */
  async flush() {
    if (this.flushing || this.size === 0) return;
    this.flushing = true;
    const batch = this.buf;
    this.buf = new Map();
    this.size = 0;
    const seqs = [];
    try {
      const tasks = [];
      for (const { model, ops, seqs: s } of batch.values()) {
        if (ops.length) tasks.push(model.bulkWrite(ops, { ordered: false }));
        for (const x of s) seqs.push(x);
      }
      await Promise.all(tasks);
      if (this.onFlushed && seqs.length) await this.onFlushed(seqs);
    } catch (e) {
      // Re-queue everything so nothing is dropped; the Journal is still the
      // source of truth, so a later flush (or boot-time replay) reconciles.
      console.error('[WriteBehind] flush failed — re-queuing:', e.message);
      for (const [name, b] of batch) {
        const cur = this.buf.get(name) || { model: b.model, ops: [], seqs: [] };
        cur.ops = b.ops.concat(cur.ops);
        cur.seqs = b.seqs.concat(cur.seqs);
        this.buf.set(name, cur);
        this.size += b.ops.length;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Flush until empty — call on graceful shutdown. */
  async drain() {
    let guard = 0;
    while (this.size > 0 && guard++ < 10000) {
      // eslint-disable-next-line no-await-in-loop
      await this.flush();
    }
  }
}

module.exports = WriteBehind;
