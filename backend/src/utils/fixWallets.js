/**
 * Migrate existing accounts to USD-denominated trading.
 *
 * Why: the seed used to create accounts/wallets in INR, but instruments are
 * USD-quoted. PnL settles into account.baseCurrency, so an INR wallet would
 * never receive USD profits cleanly. This script normalizes to USD without
 * destroying the old INR wallet's history.
 *
 * Run: node src/utils/fixWallets.js
 */
require('dotenv').config();
const { connectDB } = require('../config/db');
const TradingAccount = require('../models/TradingAccount');
const { Wallet } = require('../models/Wallet');
const { ACCOUNT_TYPES } = require('../config/constants');

const DEFAULT_BALANCES = {
  [ACCOUNT_TYPES.DEMO]: '50000',
  [ACCOUNT_TYPES.REAL]: '2500',
};

(async () => {
  await connectDB();
  console.log('--- Migrating accounts and wallets to USD ---\n');

  const accounts = await TradingAccount.find({});
  let accountsUpdated = 0;
  let walletsCreated = 0;

  for (const acc of accounts) {
    if (acc.baseCurrency !== 'USD') {
      console.log(`Account ${acc.accountNumber} (${acc.accountType}): baseCurrency ${acc.baseCurrency} → USD`);
      acc.baseCurrency = 'USD';
      await acc.save();
      accountsUpdated++;
    }

    const usdWallet = await Wallet.findOne({ userId: acc.userId, accountId: acc._id, currency: 'USD' });
    if (!usdWallet) {
      const startBalance = DEFAULT_BALANCES[acc.accountType] || '0';
      await Wallet.create({
        userId: acc.userId,
        accountId: acc._id,
        currency: 'USD',
        balance: startBalance,
      });
      console.log(`  → created USD wallet with $${startBalance}`);
      walletsCreated++;
    } else {
      console.log(`  • USD wallet already exists ($${usdWallet.balance}, locked $${usdWallet.locked})`);
    }
  }

  console.log(`\nDone. Accounts updated: ${accountsUpdated}, USD wallets created: ${walletsCreated}`);
  console.log('Note: any old INR wallets are left in place — admin can ignore or clear them.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
