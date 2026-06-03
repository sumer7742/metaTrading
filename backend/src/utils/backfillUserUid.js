/**
 * One-time migration: assign a permanent userUid to every existing account
 * that doesn't have one yet. Oldest account (by createdAt) gets the lowest
 * id (USR100001), so ids broadly follow signup order. Idempotent — re-running
 * skips users that already have a userUid and assigns nothing.
 *
 *   node src/utils/backfillUserUid.js
 *
 * Uses updateOne($set) (not .save()) so it does NOT re-trigger the model's
 * generate-on-create hook (which would advance the counter twice). The shared
 * counter ends at the count of assigned users, so live registrations continue
 * seamlessly from the next number.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const User = require('../models/User');
  const { nextUserUid } = require('./userUid');

  const filter = { $or: [{ userUid: { $exists: false } }, { userUid: null }, { userUid: '' }] };
  const todo = await User.countDocuments(filter);
  console.log(`Users needing a userUid: ${todo}`);

  const cursor = User.find(filter).sort({ createdAt: 1 }).select('_id userUid email').cursor();
  let n = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    if (doc.userUid) continue;
    const uid = await nextUserUid();
    await User.updateOne({ _id: doc._id }, { $set: { userUid: uid } });
    n++;
    if (n <= 5 || n % 100 === 0) console.log(`  ${uid}  ${doc.email}`);
  }
  console.log(`\nBackfill complete: ${n} users assigned a userUid.`);

  const total = await User.countDocuments({});
  const withUid = await User.countDocuments({ userUid: { $exists: true, $ne: null, $nin: [''] } });
  console.log(`Coverage: ${withUid}/${total} users now have a userUid.`);

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
