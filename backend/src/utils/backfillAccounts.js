/**
 * Backfill missing Live (Real) trading accounts for existing users.
 *
 * Use this if you registered/seeded users with an older version of the code
 * that only created a DEMO account, and now you want every user to also have
 * an empty Live account.
 *
 * Run with:
 *   node src/utils/backfillAccounts.js
 *
 * Safe to re-run — only creates accounts that don't exist.
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const User = require('../models/User');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { ACCOUNT_TYPES, TRADING_MODE, ROLES } = require('../config/constants');

const run = async () => {
  await connectDB();

  // Only backfill regular trader users (skip admins)
  const users = await User.find({ role: ROLES.USER });
  console.log(`Backfilling ${users.length} user(s)...`);

  let demoAdded = 0;
  let liveAdded = 0;

  for (const user of users) {
    // Ensure Demo account exists
    const demo = await TradingAccount.findOne({ userId: user._id, accountType: ACCOUNT_TYPES.DEMO });
    if (!demo) {
      const accountNumber = 'TA' + Date.now().toString().slice(-9) + Math.floor(Math.random() * 100);
      const acct = await TradingAccount.create({
        userId: user._id,
        accountNumber,
        accountType: ACCOUNT_TYPES.DEMO,
        baseCurrency: 'USD',
        leverage: 100,
        mode: TRADING_MODE.HYBRID,
        nickname: 'Practice Account',
      });
      await Wallet.create({ userId: user._id, accountId: acct._id, currency: 'USD', balance: '10000' });
      console.log(`  + Demo account for ${user.email}`);
      demoAdded++;
    }

    // Ensure Live account exists
    const live = await TradingAccount.findOne({ userId: user._id, accountType: ACCOUNT_TYPES.REAL });
    if (!live) {
      const accountNumber = 'TA' + (Date.now() + 1).toString().slice(-9) + Math.floor(Math.random() * 100);
      const acct = await TradingAccount.create({
        userId: user._id,
        accountNumber,
        accountType: ACCOUNT_TYPES.REAL,
        baseCurrency: 'USD',
        leverage: 100,
        mode: TRADING_MODE.HYBRID,
        nickname: 'Live Account',
      });
      // Real account starts at $0 - user funds it via deposit
      await Wallet.create({ userId: user._id, accountId: acct._id, currency: 'USD', balance: '0' });
      console.log(`  + Live account for ${user.email}`);
      liveAdded++;
    }
  }

  console.log(`\n✓ Backfill complete: ${demoAdded} demo + ${liveAdded} live account(s) added`);
  process.exit(0);
};

run().catch((e) => {
  console.error('Backfill error:', e);
  process.exit(1);
});
