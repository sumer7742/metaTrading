const mongoose = require('mongoose');

/**
 * Generic atomic sequence counter. One document per named sequence
 * (`_id` = the sequence name, e.g. 'userUid'). Incremented via an atomic
 * `$inc` so concurrent callers never receive the same value — the basis
 * for permanent, never-reused public identifiers.
 *
 * Additive: this collection is brand new and read/written only by the
 * userUid generator + its backfill migration. It touches nothing else.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String },          // sequence name
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);
