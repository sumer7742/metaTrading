/**
 * Order Router — single entry point for every order.
 *
 * Routing decision is now a GLOBAL platform setting (admin Settings page):
 *
 *   SystemSetting.routingMode === 'B_BOOK'  → internal execution (default)
 *   SystemSetting.routingMode === 'A_BOOK'  → forward to default LP provider
 *
 * Per-account bookType / lpProvider fields on TradingAccount are kept in
 * the schema for backward compatibility but are NOT read here. The whole
 * platform runs in one mode based on the admin toggle.
 *
 *   routeOrder({ order, userId })
 *     1. Load account + instrument (ownership + tradability checks)
 *     2. Read global routingMode + defaultLpProvider
 *     3. If A_BOOK: require defaultLpProvider != NONE, dispatch to LP
 *        If B_BOOK: dispatch to internal matching engine
 *     4. Stamp executionSource on the order
 *     5. Return { settledOrder, executionSource, book, reason }
 *
 * Backwards-compat: per-account fields (bookType / lpProvider) live in the
 * DB but no code branches on them. Per-user controls (riskOverride,
 * blockedInstruments) still apply — they're orthogonal.
 */
const TradingAccount = require('../models/TradingAccount');
const Instrument = require('../models/Instrument');
const User = require('../models/User');
const internalExec = require('./internalExecution.service');
const lpExec = require('./lpExecution.service');
const riskEngine = require('./riskEngine.service');
const systemSettings = require('./systemSettings.service');
const { AppError } = require('../utils/errors');
const {
  BOOK_TYPE,
  LP_PROVIDER,
  EXECUTION_SOURCE,
  ROUTING,
} = require('../config/constants');

/**
 * Resolve the effective routing mode for this order.
 *
 *   1. If the user has an explicit `riskOverride.routingMode`, that wins.
 *      Lets admin force individual users into A/B/HYBRID regardless of
 *      what the platform-wide toggle says.
 *   2. Otherwise the global SystemSetting.routingMode applies.
 *   3. Both default to B_BOOK if missing — safest fallback.
 */
const _resolveRoutingMode = async (user) => {
  const userOverride = user?.riskOverride?.routingMode;
  if (userOverride && Object.values(BOOK_TYPE).includes(userOverride)) {
    return { mode: userOverride, source: 'user' };
  }
  const global = (await systemSettings.getSetting('routingMode')) || BOOK_TYPE.B_BOOK;
  return { mode: global, source: 'global' };
};

/**
 * Pre-flight validations — pure, no side effects.
 *
 * `isTradingEnabled=false` blocks NEW exposure but never blocks a close
 * (closeOnly=true). Otherwise an admin freezing a user's account would
 * trap their open positions through SL/TP and the user couldn't liquidate.
 */
const _validate = (account, instrument, order) => {
  if (!account.isActive) {
    throw new AppError('Account is inactive', 403, 'ACCOUNT_INACTIVE');
  }
  const isClose = !!order?.closeOnly;
  if (!isClose && account.isTradingEnabled === false) {
    throw new AppError('Trading is disabled on this account', 403, 'TRADING_DISABLED');
  }
  if (!instrument.isActive && !isClose) {
    throw new AppError(`Instrument ${instrument.symbol} is inactive`, 400, 'INSTRUMENT_INACTIVE');
  }
};

const routeOrder = async ({ order, userId }) => {
  // 1. Load account & instrument
  const account = await TradingAccount.findById(order.accountId);
  if (!account) throw new AppError('Account not found', 404, 'ACCOUNT_NOT_FOUND');
  if (String(account.userId) !== String(userId)) {
    throw new AppError('Account does not belong to user', 403, 'ACCOUNT_FORBIDDEN');
  }

  const instrument = await Instrument.findById(order.instrumentId);
  if (!instrument) throw new AppError('Instrument not found', 404, 'INSTRUMENT_NOT_FOUND');

  // Load user once — we need both blockedInstruments AND riskOverride.
  const user = await User.findById(userId)
    .select('blockedInstruments riskOverride userGroup')
    .lean();

  // Per-user symbol block list. Closes are allowed even on blocked symbols
  // so flipping the block doesn't trap positions.
  if (!order.closeOnly) {
    if (Array.isArray(user?.blockedInstruments) && user.blockedInstruments.includes(instrument.symbol)) {
      throw new AppError(
        `Instrument ${instrument.symbol} is blocked for this user`,
        403,
        'INSTRUMENT_BLOCKED'
      );
    }
  }

  _validate(account, instrument, order);

  // 2. Resolve effective routing mode — per-user override wins, else global.
  const { mode: routingMode, source: routingSource } = await _resolveRoutingMode(user);

  // 3. For HYBRID, ask the risk engine per-order whether THIS order goes
  //    A-book or B-book. For pure A/B, no decision needed.
  let book = routingMode;
  let reason = `${routingSource}.routingMode=${routingMode}`;
  if (routingMode === BOOK_TYPE.HYBRID) {
    const decision = await riskEngine.decideHybridRoute({
      userId,
      instrument,
      order: { quantity: order.quantity, price: order.price, side: order.side },
    });
    book = decision.book;
    reason = `${routingSource}=HYBRID → ${decision.book} (${decision.reason})`;
  }

  // 4. A-book path needs a configured LP. Clear error if missing so admin
  //    knows exactly which knob to turn.
  let lpProvider = LP_PROVIDER.NONE;
  if (book === BOOK_TYPE.A_BOOK) {
    lpProvider = (await systemSettings.getSetting('defaultLpProvider')) || LP_PROVIDER.NONE;
    if (!lpProvider || lpProvider === LP_PROVIDER.NONE) {
      throw new AppError(
        'LP provider is not configured. Please configure default LP before using A-Book mode.',
        400,
        'LP_PROVIDER_NOT_CONFIGURED'
      );
    }
  }

  // 5. Stamp execution metadata on the order BEFORE submitting.
  const isHybrid = routingMode === BOOK_TYPE.HYBRID;
  const executionSource = book === BOOK_TYPE.A_BOOK
    ? (isHybrid ? EXECUTION_SOURCE.HYBRID_LP : EXECUTION_SOURCE.LP)
    : (isHybrid ? EXECUTION_SOURCE.HYBRID_INTERNAL : EXECUTION_SOURCE.INTERNAL);
  order.executionSource = executionSource;
  // Backward-compat field — old reports / dashboards still read `routing`.
  order.routing = book === BOOK_TYPE.A_BOOK ? ROUTING.EXTERNAL : ROUTING.B_BOOK;
  await order.save();

  // 6. Dispatch.
  let settledOrder;
  if (book === BOOK_TYPE.A_BOOK) {
    settledOrder = await lpExec.execute({
      order,
      account: { ...account.toObject(), lpProvider },
      instrument,
    });
  } else {
    settledOrder = await internalExec.execute(order);
  }

  return { settledOrder, executionSource, book, reason };
};

/**
 * routeCancel — symmetrical helper for cancels. Routes via the same path
 * the original order took (read from order.executionSource).
 */
const routeCancel = async ({ order }) => {
  if (order.executionSource === EXECUTION_SOURCE.LP || order.executionSource === EXECUTION_SOURCE.HYBRID_LP) {
    const account = await TradingAccount.findById(order.accountId);
    const lpProvider = (await systemSettings.getSetting('defaultLpProvider')) || LP_PROVIDER.NONE;
    return lpExec.cancel({ order, account: { ...account.toObject(), lpProvider } });
  }
  return internalExec.cancel(order);
};

module.exports = { routeOrder, routeCancel };
