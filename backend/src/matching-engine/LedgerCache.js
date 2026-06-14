/**
 * LedgerCache — in-memory authority for wallet balances + positions (Phase 1).
 * See MATCHING_ENGINE_PHASE1.md.
 *
 * This is the CORE of the write-behind cutover: once the engine settles against
 * this in-memory ledger (instead of Mongo per order), the only hot-path I/O is
 * the batched Journal append; the derived Position/Wallet/Trade/Order writes are
 * coalesced and flushed asynchronously by WriteBehind. That coalescing — writing
 * the LATEST state once per flush instead of once per order — is what removes
 * the per-order DB write ceiling and unlocks 3–5k orders/sec/symbol.
 *
 * Built but NOT yet wired into the live money path. Enabling it requires the
 * staged cutover (placeOrder margin lock → ledger, shadow reconciliation, load
 * test) described in the design doc. Until then this module is dead code.
 *
 * Math mirrors MatchingEngine._updatePosition + walletService.settleTradeClose:
 *   open / grow  → lock margin (qty·price/leverage), weighted-avg entry
 *   reduce       → release proportional margin, realize partial PnL − fee
 *   close        → release all margin, realize PnL − fee
 * Hedge mode: identity is (accountId, symbol, positionSide); LONG and SHORT
 * coexist. All decimals use the shared utils/decimal helpers for exactness.
 */
const { add, sub, mul, div, gt, eq } = require('../utils/decimal');

const posKey = (accountId, symbol, positionSide) => `${accountId}|${symbol}|${positionSide}`;
const sideToPS = (side) => (side === 'BUY' ? 'LONG' : 'SHORT');

class LedgerCache {
  constructor() {
    this.balances = new Map();  // accountId -> { balance, locked, currency }
    this.positions = new Map(); // posKey   -> { accountId, symbol, positionSide, side, quantity, entryPrice, margin }
  }

  /** Seed an account's wallet from the DB exactly once (idempotent). */
  loadBalance(accountId, { balance, locked = '0', currency = 'USD' }) {
    const k = String(accountId);
    if (!this.balances.has(k)) this.balances.set(k, { balance: String(balance), locked: String(locked), currency });
    return this.balances.get(k);
  }

  /** Seed an existing open position from the DB exactly once. */
  loadPosition(p) {
    const k = posKey(p.accountId, p.symbol, p.positionSide || sideToPS(p.side));
    if (!this.positions.has(k)) {
      this.positions.set(k, {
        accountId: String(p.accountId), symbol: p.symbol,
        positionSide: p.positionSide || sideToPS(p.side), side: p.side,
        quantity: String(p.quantity), entryPrice: String(p.entryPrice), margin: String(p.margin || '0'),
      });
    }
    return this.positions.get(k);
  }

  getBalance(accountId) { return this.balances.get(String(accountId)); }
  getPosition(accountId, symbol, positionSide) { return this.positions.get(posKey(accountId, symbol, positionSide)); }

  /**
   * Apply a B-book fill in memory. Returns a description of the state change so
   * the engine can enqueue the equivalent derived DB writes (Position/Wallet)
   * to WriteBehind.
   *
   * @param {object} fill
   * @param {string} fill.accountId
   * @param {string} fill.symbol
   * @param {('BUY'|'SELL')} fill.side
   * @param {string} fill.quantity
   * @param {string} fill.price       executed (post-spread) fill price
   * @param {number} fill.leverage
   * @param {boolean} [fill.closeOnly]
   * @param {string} [fill.positionSide]  target side for a close
   * @param {function} fill.computeFee  async ({closeQty, closePrice, closePnl}) => fee string
   * @returns {Promise<{action, position, balance, realizedPnl, fee, marginReleased}>}
   */
  async applyFill(fill) {
    const { accountId, symbol, side, quantity, price, leverage, closeOnly, computeFee } = fill;
    const margin = div(mul(quantity, price), String(leverage || 1));
    const targetPS = fill.positionSide || sideToPS(side);
    const key = posKey(accountId, symbol, targetPS);
    let pos = this.positions.get(key);

    // OPEN or GROW (same-side, not a close).
    if (!closeOnly && (!pos || pos.side === side)) {
      if (!pos) {
        pos = { accountId: String(accountId), symbol, positionSide: targetPS, side, quantity: String(quantity), entryPrice: String(price), margin };
        this.positions.set(key, pos);
      } else {
        const newQty = add(pos.quantity, quantity);
        pos.entryPrice = div(add(mul(pos.entryPrice, pos.quantity), mul(price, quantity)), newQty);
        pos.quantity = newQty;
        pos.margin = add(pos.margin, margin);
      }
      this._lock(accountId, margin); // mirror placeOrder's margin lock
      return { action: pos.quantity === quantity ? 'OPEN' : 'GROW', position: { ...pos }, balance: this.getBalance(accountId), realizedPnl: '0', fee: '0', marginReleased: '0' };
    }

    // REDUCE / CLOSE — settle realized PnL − fee, release proportional margin.
    if (!pos) {
      // Nothing to close (shouldn't happen for a well-formed close); no-op.
      return { action: 'NOOP', position: null, balance: this.getBalance(accountId), realizedPnl: '0', fee: '0', marginReleased: '0' };
    }
    const closeQty = gt(pos.quantity, quantity) ? quantity : pos.quantity;
    const closePnl = pos.side === 'BUY'
      ? mul(sub(price, pos.entryPrice), closeQty)
      : mul(sub(pos.entryPrice, price), closeQty);
    const fee = computeFee ? await computeFee({ closeQty, closePrice: price, closePnl }) : '0';

    const marginRelease = eq(pos.quantity, closeQty)
      ? pos.margin
      : div(mul(pos.margin, closeQty), pos.quantity);

    // balance += pnl − fee ; locked −= released margin
    this._settle(accountId, closePnl, fee, marginRelease);

    let action;
    if (gt(pos.quantity, closeQty)) {
      pos.quantity = sub(pos.quantity, closeQty);
      pos.margin = sub(pos.margin, marginRelease);
      action = 'REDUCE';
    } else {
      this.positions.delete(key);
      action = 'CLOSE';
    }
    return {
      action,
      position: action === 'CLOSE' ? null : { ...pos },
      balance: this.getBalance(accountId),
      realizedPnl: String(closePnl), fee: String(fee), marginReleased: String(marginRelease),
    };
  }

  _lock(accountId, amount) {
    const b = this.balances.get(String(accountId));
    if (b) b.locked = add(b.locked, amount);
  }

  _settle(accountId, pnl, fee, marginRelease) {
    const b = this.balances.get(String(accountId));
    if (!b) return;
    b.balance = sub(add(b.balance, pnl), fee);
    b.locked = sub(b.locked, marginRelease);
    if (gt('0', b.locked)) b.locked = '0'; // floor at 0 (mirrors settleTradeClose)
  }

  /** Compare this ledger against authoritative DB snapshots — reconciliation. */
  diffAgainst({ balances = [], positions = [] }) {
    const out = [];
    for (const db of balances) {
      const mem = this.balances.get(String(db.accountId));
      if (!mem) { out.push({ kind: 'balance', accountId: String(db.accountId), reason: 'missing-in-memory' }); continue; }
      if (!eq(mem.balance, String(db.balance))) out.push({ kind: 'balance', accountId: String(db.accountId), mem: mem.balance, db: String(db.balance) });
    }
    for (const db of positions) {
      const k = posKey(db.accountId, db.symbol, db.positionSide || sideToPS(db.side));
      const mem = this.positions.get(k);
      if (!mem) { out.push({ kind: 'position', key: k, reason: 'missing-in-memory' }); continue; }
      if (!eq(mem.quantity, String(db.quantity))) out.push({ kind: 'position', key: k, field: 'quantity', mem: mem.quantity, db: String(db.quantity) });
    }
    return out;
  }
}

module.exports = LedgerCache;
