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
const RoutingDecision = require('../models/RoutingDecision');
const { mul } = require('../utils/decimal');
const {
  BOOK_TYPE,
  EXECUTION_MODE,
  ROUTING_RESULT,
  LP_PROVIDER,
  EXECUTION_SOURCE,
  ROUTING,
  ORDER_STATUS,
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
  if (userOverride && Object.values(EXECUTION_MODE).includes(userOverride)) {
    return { mode: userOverride, source: 'user' };
  }
  // Legacy values (A_BOOK/B_BOOK/HYBRID) are already valid EXECUTION_MODE
  // values, so old settings keep working after the 4-mode upgrade.
  const global = await systemSettings.getSetting('routingMode');
  const mode = Object.values(EXECUTION_MODE).includes(global) ? global : EXECUTION_MODE.B_BOOK;
  return { mode, source: 'global' };
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
  // Per-account admin block/suspend — affects ONLY this account, never the
  // user's other accounts. Closes stay allowed so positions can be liquidated.
  if (!isClose && account.status && account.status !== 'ACTIVE') {
    throw new AppError(
      `This account is ${account.status.toLowerCase()}. New orders are disabled — you can still close open positions.`,
      403,
      'ACCOUNT_BLOCKED'
    );
  }
  // Plan-driven suspension (over plan cap after a downgrade or payment
  // failure). Closes are still allowed so the user can liquidate to
  // withdraw funds — that's an explicit promise in the plan spec.
  if (!isClose && account.planSuspendedAt) {
    throw new AppError(
      'This account is suspended because it exceeds your current plan limit. Upgrade your plan to resume trading. You can still withdraw funds.',
      403,
      'ACCOUNT_PLAN_SUSPENDED'
    );
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

  // 1b. Optional per-instrument DAILY volume cap. No-op when the instrument
  //     is unlimited (default) or for closing orders. Rejects an opening
  //     order that would push the symbol's daily used volume past the limit.
  await require('./volumeLimitService').assertWithinDailyLimit(instrument, order);

  // 2. Resolve the execution MODE — per-user override wins, else global.
  const { mode: executionMode, source: modeSource } = await _resolveRoutingMode(user);

  // 3. Resolve the concrete VENUE (routingResult). HYBRID delegates to the
  //    risk engine, which picks INTERNAL_MATCHING | B_BOOK | A_BOOK | REJECT.
  let routingResult = executionMode;
  let reason = `${modeSource}.executionMode=${executionMode}`;
  let riskEngineReason = null;
  if (executionMode === EXECUTION_MODE.HYBRID) {
    const decision = await riskEngine.decideHybridRoute({
      userId, instrument, account,
      order: { quantity: order.quantity, price: order.price, side: order.side, closeOnly: order.closeOnly },
    });
    routingResult = decision.route;
    riskEngineReason = decision.reason;
    reason = `HYBRID → ${routingResult} (${decision.reason})`;
  }

  const notional = Number(mul(order.quantity || '0', order.price || instrument.lastPrice || '0')) || 0;
  const audit = async (result) => {
    try {
      await RoutingDecision.create({
        orderId: order._id, userId, accountId: order.accountId,
        symbol: instrument.symbol, side: order.side,
        executionMode, routingResult: result, notional, reason, riskEngineReason, modeSource,
      });
    } catch (_) { /* audit must never block execution */ }
  };

  // 3a. Risk engine can reject outright (e.g. exposure cap breached).
  if (routingResult === 'REJECT' || routingResult === 'REJECTED') {
    order.status = ORDER_STATUS.REJECTED;
    order.executionMode = executionMode;
    order.rejectionReason = `Routing rejected: ${riskEngineReason || reason}`;
    await order.save();
    await audit('REJECTED');
    throw new AppError(order.rejectionReason, 400, 'ROUTING_REJECTED');
  }

  // 4. A-book needs a configured LP. Clear error if missing.
  let lpProvider = LP_PROVIDER.NONE;
  if (routingResult === ROUTING_RESULT.A_BOOK) {
    lpProvider = (await systemSettings.getSetting('defaultLpProvider')) || LP_PROVIDER.NONE;
    if (!lpProvider || lpProvider === LP_PROVIDER.NONE) {
      throw new AppError(
        'LP provider is not configured. Please configure default LP before using A-Book mode.',
        400,
        'LP_PROVIDER_NOT_CONFIGURED'
      );
    }
  }

  // 5. Stamp execution metadata BEFORE submitting.
  const isHybrid = executionMode === EXECUTION_MODE.HYBRID;
  order.executionMode = executionMode;
  order.routingResult = routingResult;
  if (routingResult === ROUTING_RESULT.A_BOOK) {
    order.routing = ROUTING.EXTERNAL;
    order.executionSource = isHybrid ? EXECUTION_SOURCE.HYBRID_LP : EXECUTION_SOURCE.LP;
  } else if (routingResult === ROUTING_RESULT.INTERNAL_MATCHING) {
    order.routing = ROUTING.INTERNAL_MATCHING;
    order.executionSource = isHybrid ? EXECUTION_SOURCE.HYBRID_INTERNAL_MATCHING : EXECUTION_SOURCE.INTERNAL_MATCHING;
  } else { // B_BOOK
    order.routing = ROUTING.B_BOOK;
    order.executionSource = isHybrid ? EXECUTION_SOURCE.HYBRID_INTERNAL : EXECUTION_SOURCE.INTERNAL;
  }
  await order.save();
  await audit(routingResult);

  // 6. Dispatch.
  //    A_BOOK → LP adapter. INTERNAL_MATCHING + B_BOOK both go through the
  //    matching engine, which branches on order.routing:
  //      INTERNAL_MATCHING → user↔user order-book match (broker not counterparty)
  //      B_BOOK            → broker-counterparty fill at internal price
  let settledOrder;
  if (routingResult === ROUTING_RESULT.A_BOOK) {
    settledOrder = await lpExec.execute({
      order,
      account: { ...account.toObject(), lpProvider },
      instrument,
    });
  } else {
    settledOrder = await internalExec.execute(order);
  }

  return { settledOrder, executionMode, routingResult, executionSource: order.executionSource, reason };
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
