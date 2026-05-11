/**
 * Migration: backfill execution-routing fields on existing TradingAccount docs.
 *
 *   Sets, for every account that lacks the field:
 *     bookType         → 'B_BOOK'  (safe default — internalised)
 *     lpProvider       → 'NONE'    (A-book needs explicit LP wiring)
 *     isTradingEnabled → true      (existing accounts were tradable)
 *
 * Run:  node src/scripts/migrateAccountBookType.js
 *
 * Idempotent: re-running has no effect on already-migrated docs.
 * Read-only by default — pass `--apply` to write.
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const TradingAccount = require('../models/TradingAccount');

const apply = process.argv.includes('--apply');

(async () => {
  await connectDB();

  const missing = await TradingAccount.countDocuments({
    $or: [{ bookType: { $exists: false } }, { bookType: null }],
  });

  console.log(`Found ${missing} account(s) missing bookType.`);

  if (!apply) {
    console.log('\nDry-run mode. Re-run with --apply to write changes.');
    process.exit(0);
  }

  const result = await TradingAccount.updateMany(
    {
      $or: [{ bookType: { $exists: false } }, { bookType: null }],
    },
    {
      $set: {
        bookType: 'B_BOOK',
        lpProvider: 'NONE',
        isTradingEnabled: true,
      },
    }
  );

  console.log(`\n✓ Updated ${result.modifiedCount} account(s).`);
  console.log('  bookType:         B_BOOK');
  console.log('  lpProvider:       NONE');
  console.log('  isTradingEnabled: true');
  process.exit(0);
})().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
