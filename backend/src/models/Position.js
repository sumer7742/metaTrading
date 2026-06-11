const mongoose = require('mongoose');
const { ORDER_SIDE, POSITION_STATUS } = require('../config/constants');

const positionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
    instrumentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Instrument', required: true },
    symbol: { type: String, required: true, index: true },

    side: { type: String, enum: Object.values(ORDER_SIDE), required: true },
    // Hedge-mode identity. LONG = built from BUY fills, SHORT = built from
    // SELL fills. Position lookup is (accountId, symbol, positionSide) so a
    // BUY and a SELL on the same instrument coexist as two open positions
    // instead of netting into one. Legacy docs without this field fall back
    // to side-derived values at the application layer (BUY→LONG, SELL→SHORT)
    // and get backfilled the next time the position is updated.
    positionSide: {
      type: String,
      enum: ['LONG', 'SHORT'],
      default: function () { return this.side === 'BUY' ? 'LONG' : 'SHORT'; },
      index: true,
    },
    quantity: { type: String, required: true }, // REMAINING open size (0 when fully closed)
    // Cumulative volume closed over the position's life. `quantity` is zeroed on
    // full close, so this preserves the traded size for history/reporting.
    closedQuantity: { type: String, default: '0' },
    entryPrice: { type: String, required: true },
    leverage: { type: Number, default: 1 },
    margin: { type: String, default: '0' }, // locked margin

    // Which book holds this position's risk — stamped at open from the opening
    // order's routingResult. A_BOOK = forwarded to LP; B_BOOK = broker is the
    // counterparty (covers B_BOOK + internal matching). Powers the admin
    // live-exposure A/B breakdown. Legacy docs default to B_BOOK.
    book: { type: String, enum: ['A_BOOK', 'B_BOOK'], default: 'B_BOOK', index: true },

    stopLoss: String,
    takeProfit: String,

    // Trailing stop loss (doc Phase 8 - now implemented).
    // When set, worker re-computes effective SL = bestPrice ± trailingDistance
    // bestPrice is the highest price seen since open (for BUY) or lowest (for SELL).
    trailingDistance: String, // distance from market in price units (null = no trail)
    trailingHighWatermark: String, // best favorable price seen since position opened

    realizedPnl: { type: String, default: '0' },
    unrealizedPnl: { type: String, default: '0' }, // updated by risk engine
    closePrice: String,

    // Idempotency stamps — set by walletService.settleTradeClose only once.
    // settled:true means PnL was credited and the audit ledger row exists.
    // Even if a duplicate close request slips through, the ledger's unique
    // dedupeKey blocks a second credit and we re-affirm settled here.
    settled: { type: Boolean, default: false },
    settledAt: Date,
    // Net amount returned to the user's free balance at settle time:
    //   settlementAmount = marginReleased + pnl - fee
    // Useful in audit/reports as the single "what did the user receive" figure.
    settlementAmount: String,

    // Cumulative commission charged across all close legs of this position.
    // Persisted here (rather than only via Wallet ledger) so the trade
    // history view can show commission per row without joining ledger entries.
    commission: { type: String, default: '0' },
    // Overnight financing / swap charges accumulated against this position.
    // Currently always 0 — there's no swap engine yet — but the field exists
    // so the history schema is forward-compatible when one is added.
    swap: { type: String, default: '0' },

    // Why this position closed. Set by the background worker just before
    // submitting the closing order, so the history view can show "PROFIT
    // TAKEN" / "STOP LOSS HIT" etc instead of a generic "N/A". For manual
    // user-initiated closes this stays null and renders as "N/A".
    closeReason: {
      type: String,
      enum: ['TAKE_PROFIT', 'STOP_LOSS', 'TRAILING_STOP', 'MARGIN_STOPOUT', 'NEGATIVE_BALANCE', 'MANUAL'],
      default: null,
    },

    status: { type: String, enum: Object.values(POSITION_STATUS), default: POSITION_STATUS.OPEN, index: true },

    // Mutual-exclusion flag for partial closes. The controller flips it true
    // before submitting the partial-close order and clears it in `finally`.
    // While true, a second concurrent partial-close request is rejected with
    // 409 — preventing two requests from over-closing or accidentally flipping.
    partialClosing: { type: Boolean, default: false },
    partialClosingAt: Date,

    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
  },
  { timestamps: true }
);

positionSchema.index({ accountId: 1, status: 1 });
// Hedge-mode lookup — the matching engine finds the side-specific position
// for a given (account, symbol) by querying on this triple. Status is
// included because we filter to OPEN / CLOSING when grouping.
positionSchema.index({ accountId: 1, symbol: 1, positionSide: 1, status: 1 });

// Optimization indexes — speed up common query patterns
positionSchema.index({ userId: 1, status: 1 });           // user's open positions
positionSchema.index({ symbol: 1, status: 1 });           // worker scanning by symbol
positionSchema.index({ status: 1, openedAt: -1 });        // worker scan + sort
positionSchema.index({ stopLoss: 1, status: 1 });         // SL trigger checks
positionSchema.index({ takeProfit: 1, status: 1 });       // TP trigger checks

module.exports = mongoose.model('Position', positionSchema);
