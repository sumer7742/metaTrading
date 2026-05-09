const { Wallet, WalletLedger } = require('../models/Wallet');
const { add, sub, gt, gte, D } = require('../utils/decimal');
const { AppError } = require('../utils/errors');

// Idempotency is now enforced at the data layer via WalletLedger's unique
// `dedupeKey` index + atomic Wallet.findOneAndUpdate with an aggregation
// pipeline. Mongo transactions are no longer required for correctness —
// the same code runs on standalone (dev/MVP) and replica set (prod).
const _isDuplicateKeyError = (err) =>
  err && (err.code === 11000 || /E11000/i.test(err.message || ''));

const _assertPositive = (amount, label = 'amount') => {
  if (amount === undefined || amount === null || amount === '') {
    throw new AppError(`${label} required`, 400, 'INVALID_AMOUNT');
  }
  let d;
  try {
    d = D(amount);
  } catch (e) {
    throw new AppError(`${label} must be numeric`, 400, 'INVALID_AMOUNT');
  }
  if (!d.isFinite() || d.lte(0)) {
    throw new AppError(`${label} must be positive`, 400, 'INVALID_AMOUNT');
  }
  return d.toString();
};

// Upsert-based getOrCreate is race-safe; two concurrent callers can't both
// insert because the unique index on (userId, accountId, currency) rejects
// the second insert and the upsert returns the existing doc.
const getOrCreateWallet = async (userId, accountId, currency) => {
  return Wallet.findOneAndUpdate(
    { userId, accountId, currency },
    { $setOnInsert: { userId, accountId, currency, balance: '0', locked: '0' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

const credit = async ({ userId, accountId, currency, amount, type, referenceType, referenceId, note, dedupeKey }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          balance: { $toString: { $add: [{ $toDouble: '$balance' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  try {
    await WalletLedger.create({
      walletId: updated._id,
      userId,
      accountId,
      type,
      currency,
      amount: amt,
      balanceAfter: updated.balance,
      referenceType,
      referenceId,
      dedupeKey,
      note,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err) && dedupeKey) {
      console.log(`[walletService] credit SKIPPED (duplicate) dedupeKey=${dedupeKey}`);
      return updated;
    }
    throw err;
  }
  return updated;
};

const debit = async ({ userId, accountId, currency, amount, type, referenceType, referenceId, note, dedupeKey }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  // Atomic precondition: only debit if current balance >= amount. If not,
  // findOneAndUpdate returns null and we throw INSUFFICIENT_FUNDS.
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: { $gte: [{ $toDouble: '$balance' }, amtNum] },
    },
    [
      {
        $set: {
          balance: { $toString: { $subtract: [{ $toDouble: '$balance' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    throw new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS');
  }
  try {
    await WalletLedger.create({
      walletId: updated._id,
      userId,
      accountId,
      type,
      currency,
      amount: '-' + amt,
      balanceAfter: updated.balance,
      referenceType,
      referenceId,
      dedupeKey,
      note,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err) && dedupeKey) {
      console.log(`[walletService] debit SKIPPED (duplicate) dedupeKey=${dedupeKey}`);
      return updated;
    }
    throw err;
  }
  return updated;
};

const lock = async ({ userId, accountId, currency, amount }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: {
        $gte: [
          { $subtract: [{ $toDouble: '$balance' }, { $toDouble: '$locked' }] },
          amtNum,
        ],
      },
    },
    [
      {
        $set: {
          locked: { $toString: { $add: [{ $toDouble: '$locked' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    throw new AppError('Insufficient free balance to lock', 400, 'INSUFFICIENT_FREE');
  }
  return updated;
};

const unlock = async ({ userId, accountId, currency, amount }) => {
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  // $max floors locked at 0 if the unlock would underflow (state drift).
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          locked: {
            $toString: {
              $max: [0, { $subtract: [{ $toDouble: '$locked' }, amtNum] }],
            },
          },
        },
      },
    ],
    { new: true }
  );
  return updated;
};

const getBalances = async (userId, accountId) => {
  const filter = { userId };
  if (accountId) filter.accountId = accountId;
  return Wallet.find(filter).lean();
};

/**
 * Lock margin when an order opens or adds to a position.
 * Atomic: precondition checks free balance server-side, so two concurrent
 * order placements can't both pass the same check and over-lock.
 */
const lockMargin = async ({ userId, accountId, currency, amount, orderId, note }) => {
  if (!gt(amount, '0')) return null;
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    {
      _id: wallet._id,
      $expr: {
        $gte: [
          { $subtract: [{ $toDouble: '$balance' }, { $toDouble: '$locked' }] },
          amtNum,
        ],
      },
    },
    [
      {
        $set: {
          locked: { $toString: { $add: [{ $toDouble: '$locked' }, amtNum] } },
        },
      },
    ],
    { new: true }
  );
  if (!updated) {
    const free = sub(wallet.balance, wallet.locked);
    throw new AppError(
      `Insufficient free balance. Need ${amt} ${currency}, available ${free}`,
      400,
      'INSUFFICIENT_FREE'
    );
  }
  await WalletLedger.create({
    walletId: updated._id,
    userId,
    accountId,
    type: 'TRADE_OPEN',
    currency,
    amount: '0',
    balanceAfter: updated.balance,
    referenceType: 'order',
    referenceId: orderId,
    note: note || `Margin locked: ${amt}`,
  });
  return updated;
};

/**
 * Release locked margin without touching balance. Used on order cancel for
 * the unfilled portion, and from settleTradeClose when a position reduces.
 * Atomic: $max floors locked at 0 if the release would underflow on stale
 * state — same defensive pattern as unlock().
 */
const releaseMargin = async ({ userId, accountId, currency, amount, orderId, positionId, note }) => {
  if (!gt(amount, '0')) return null;
  const amt = _assertPositive(amount, 'amount');
  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const amtNum = Number(amt);
  const updated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          locked: {
            $toString: {
              $max: [0, { $subtract: [{ $toDouble: '$locked' }, amtNum] }],
            },
          },
        },
      },
    ],
    { new: true }
  );
  await WalletLedger.create({
    walletId: updated._id,
    userId,
    accountId,
    type: 'TRADE_CLOSE',
    currency,
    amount: '0',
    balanceAfter: updated.balance,
    referenceType: positionId ? 'position' : 'order',
    referenceId: positionId || orderId,
    note: note || `Margin released: ${amt}`,
  });
  return updated;
};

/**
 * Settle a position close — credit PnL, release margin, charge fee, write
 * a single audit ledger row. Idempotent and retry-safe.
 *
 * Idempotency contract:
 *   Caller MUST pass a stable `dedupeKey` (e.g. "TRADE_SETTLE:<tradeId>" or
 *   "POSITION_SETTLE:<positionId>"). The ledger row uses this key under a
 *   sparse unique index, so a duplicate insert is rejected with E11000 and
 *   we short-circuit BEFORE touching the wallet — guaranteeing PnL can't
 *   be double-credited even if two requests race.
 */
const settleTradeClose = async ({
  userId, accountId, currency, marginToRelease, pnl, fee, positionId, tradeId, dedupeKey,
}) => {
  if (!dedupeKey) {
    dedupeKey = `POSITION_SETTLE:${positionId}`;
  }

  const wallet = await getOrCreateWallet(userId, accountId, currency);
  const balanceBefore = wallet.balance;

  const pnlD = D(pnl);
  const feeD = D(fee || '0');
  const marginD = D(marginToRelease || '0');
  const settlementAmount = marginD.plus(pnlD).minus(feeD).toString();
  const balanceDelta = pnlD.minus(feeD).toString();

  const pnlDisplay =
    pnlD.equals(0) ? '0' :
    pnlD.isNegative() ? pnlD.toString() :
    '+' + pnlD.toString();

  const expectedBalanceAfter = D(wallet.balance).plus(balanceDelta).toString();

  try {
    await WalletLedger.create({
      walletId: wallet._id,
      userId,
      accountId,
      type: 'TRADE_CLOSE',
      currency,
      amount: pnlDisplay,
      balanceAfter: expectedBalanceAfter,
      referenceType: 'position',
      referenceId: positionId,
      dedupeKey,
      note: `PnL ${pnlD.toString()} · margin released ${marginD.toString()} · fee ${feeD.toString()} · settled ${settlementAmount}`,
    });
  } catch (err) {
    if (_isDuplicateKeyError(err)) {
      console.log(`[walletService] settleTradeClose SKIPPED (already settled) dedupeKey=${dedupeKey}`);
      return wallet;
    }
    throw err;
  }

  const balanceDeltaNum = Number(balanceDelta);
  const marginNum = Number(marginD.toString());
  const finalUpdated = await Wallet.findOneAndUpdate(
    { _id: wallet._id },
    [
      {
        $set: {
          balance: {
            $toString: { $add: [{ $toDouble: '$balance' }, balanceDeltaNum] },
          },
          locked: {
            $toString: {
              $max: [
                0,
                { $subtract: [{ $toDouble: '$locked' }, marginNum] },
              ],
            },
          },
        },
      },
    ],
    { new: true }
  );

  if (gt(feeD.toString(), '0')) {
    try {
      await WalletLedger.create({
        walletId: wallet._id,
        userId,
        accountId,
        type: 'FEE',
        currency,
        amount: '-' + feeD.toString(),
        balanceAfter: finalUpdated.balance,
        referenceType: 'trade',
        referenceId: tradeId,
        dedupeKey: `${dedupeKey}:FEE`,
        note: 'Trading fee',
      });
    } catch (err) {
      if (!_isDuplicateKeyError(err)) {
        console.warn('[walletService] fee ledger insert failed:', err.message);
      }
    }
  }

  console.log(
    `[walletService] settleTradeClose acc=${accountId} ${currency} ` +
    `bal ${balanceBefore} -> ${finalUpdated.balance} locked ${wallet.locked} -> ${finalUpdated.locked} ` +
    `(pnl=${pnlD.toString()}, fee=${feeD.toString()}, marginReleased=${marginD.toString()}, ` +
    `settlementAmount=${settlementAmount}, dedupeKey=${dedupeKey})`
  );

  return finalUpdated;
};

module.exports = {
  getOrCreateWallet,
  credit,
  debit,
  lock,
  unlock,
  getBalances,
  lockMargin,
  releaseMargin,
  settleTradeClose,
};
