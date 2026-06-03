/**
 * Permanent public User ID generator.
 *
 * Produces human-readable, unique, never-reused identifiers like
 * `USR100001`, `USR100002`, … backed by the atomic `Counter` collection.
 * Each call increments the shared 'userUid' sequence with a single atomic
 * `$inc`, so two concurrent registrations can never collide and a value is
 * never handed out twice (the counter only ever moves forward).
 *
 * Additive utility — used by the User pre-save hook and the backfill
 * migration only.
 */
const Counter = require('../models/Counter');

const UID_PREFIX = 'USR';
const UID_BASE = 100000; // first id → USR100001 (seq starts at 1)
const SEQ_KEY = 'userUid';

/** Format a raw sequence number into the public id string. */
const formatUserUid = (seq) => `${UID_PREFIX}${UID_BASE + Number(seq)}`;

/** Atomically reserve and return the next unique user id (e.g. "USR100001"). */
async function nextUserUid() {
  const c = await Counter.findByIdAndUpdate(
    SEQ_KEY,
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return formatUserUid(c.seq);
}

module.exports = { nextUserUid, formatUserUid, UID_PREFIX, UID_BASE, SEQ_KEY };
