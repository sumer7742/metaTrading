/**
 * Internal execution path — B-book.
 *
 * For an internalised order, the broker becomes the counterparty: there
 * is no real LP / exchange interaction. We hand the order to the existing
 * MatchingEngine which has been the workhorse all along; this service is
 * a thin facade so the rest of the system can talk to "execution" via
 * one interface regardless of book.
 *
 * The MatchingEngine handles:
 *   - book matching for LIMIT orders against other internal flow
 *   - market-maker fill at lastPrice for B-book counterparty fills
 *   - trade / position / wallet settlement
 *   - WS broadcasts
 *
 * Returns the engine's settled order document.
 */
const matchingEngine = require('../matching-engine/MatchingEngine');

const execute = async (order) => {
  // Engine reads order.executionSource / order.routing already populated
  // by the router before this call; we don't second-guess routing here.
  return matchingEngine.submit(order);
};

const cancel = async (order) => {
  return matchingEngine.cancel(order);
};

module.exports = { execute, cancel };
