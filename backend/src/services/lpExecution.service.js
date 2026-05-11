/**
 * LP execution path — A-book.
 *
 * Sends the order to the configured liquidity provider via the adapter
 * layer, then synthesises the trade/position/wallet plumbing locally
 * using the LP-reported fill price.
 *
 * Design choice: we DON'T rebuild the position/wallet machinery from
 * scratch — instead we stamp the LP's fill price onto the order and
 * route it through MatchingEngine. The engine's "no-counterparty market
 * fill" path (which is how B-book fills work today) settles the order
 * at the price stamped on it. End result: the same wallet/position
 * audit trail regardless of book, with `executionSource: 'LP'` on the
 * Order/Trade docs so reporting can split A-book volume from B-book.
 *
 * Failure mode: if the LP adapter throws (network down, creds invalid,
 * provider reject) we mark the order REJECTED and let the controller's
 * top-level catch release the margin lock.
 */
const matchingEngine = require('../matching-engine/MatchingEngine');
const { getAdapter } = require('../adapters/lp');
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../config/constants');

/**
 * Execute an order against the LP. Mutates `order` with provider
 * metadata before submitting to the engine; returns the settled order.
 */
const execute = async ({ order, account, instrument }) => {
  const adapter = getAdapter(account.lpProvider);

  let lpResp;
  try {
    lpResp = await adapter.placeOrder({
      accountRef: account.accountNumber,
      symbol: instrument.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price,
      stopPrice: order.stopPrice,
    });
  } catch (err) {
    order.status = ORDER_STATUS.REJECTED;
    order.rejectionReason = `LP error: ${err.message}`;
    await order.save();
    throw err;
  }

  if (!lpResp || lpResp.status === 'REJECTED' || !lpResp.avgFillPrice) {
    order.status = ORDER_STATUS.REJECTED;
    order.rejectionReason = `LP rejected order${lpResp?.raw?.reason ? `: ${lpResp.raw.reason}` : ''}`;
    await order.save();
    throw new Error(order.rejectionReason);
  }

  // Stamp provider metadata onto the order so audit/reporting can trace
  // back to the LP order id and the price we got from the venue.
  order.price = String(lpResp.avgFillPrice);
  order.lpProviderOrderId = lpResp.providerOrderId;
  order.lpProvider = lpResp.provider;
  await order.save();

  // Settle via the existing engine — it'll see executionSource: LP on the
  // order and fill at the LP-stamped price (treated as a no-resistance
  // market fill, same code path as B-book counterparty fill).
  return matchingEngine.submit(order);
};

const cancel = async ({ order, account }) => {
  if (order.lpProviderOrderId) {
    try {
      const adapter = getAdapter(account.lpProvider);
      await adapter.cancelOrder({
        accountRef: account.accountNumber,
        providerOrderId: order.lpProviderOrderId,
        symbol: order.symbol,
      });
    } catch (err) {
      // Cancel-side failures on the LP shouldn't strand the local order
      // — log + continue to engine cancel so the user isn't stuck.
      console.warn(`[lpExecution] LP cancel failed for ${order._id}: ${err.message}`);
    }
  }
  return matchingEngine.cancel(order);
};

module.exports = { execute, cancel };
