module.exports = {
  ROLES: {
    USER: 'USER',
    AFFILIATE: 'AFFILIATE',
    MANAGER: 'MANAGER',
    ADMIN: 'ADMIN',
    SUPER_ADMIN: 'SUPER_ADMIN',
  },

  KYC_STATUS: {
    NOT_SUBMITTED: 'NOT_SUBMITTED',
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
  },

  // Canonical 6-tier catalogue lives in config/accountTypes.js. These
  // constants are kept here because models/services/log strings still
  // reference the strings as enum values. Legacy types (REAL/VIRTUAL/
  // DEMO) stay in the enum so old TradingAccount docs continue to load —
  // they're mapped to STANDARD at the fee/leverage service layer.
  ACCOUNT_TYPES: {
    STANDARD:    'STANDARD',
    STANDARD_IC: 'STANDARD_IC',
    PRO:         'PRO',
    PRO_IC:      'PRO_IC',
    FREE:        'FREE',
    FREE_IC:     'FREE_IC',
    // Legacy — preserved for backward compatibility only.
    REAL:        'REAL',
    VIRTUAL:     'VIRTUAL',
    DEMO:        'DEMO',
  },

  ORDER_SIDE: {
    BUY: 'BUY',
    SELL: 'SELL',
  },

  ORDER_TYPE: {
    MARKET: 'MARKET',
    LIMIT: 'LIMIT',
    STOP: 'STOP',
  },

  ORDER_STATUS: {
    PENDING: 'PENDING',
    PARTIALLY_FILLED: 'PARTIALLY_FILLED',
    FILLED: 'FILLED',
    CANCELLED: 'CANCELLED',
    REJECTED: 'REJECTED',
  },

  ROUTING: {
    INTERNAL: 'INTERNAL',
    EXTERNAL: 'EXTERNAL',
    B_BOOK: 'B_BOOK',
  },

  TRADING_MODE: {
    INTERNAL: 'INTERNAL',
    EXTERNAL: 'EXTERNAL',
    HYBRID: 'HYBRID',
  },

  // Per-account book type — replaces the instrument-level routing decision.
  // Same instrument can be A-book for one user and B-book for another.
  BOOK_TYPE: {
    A_BOOK: 'A_BOOK',   // forward to LP / external venue
    B_BOOK: 'B_BOOK',   // internal counterparty (broker becomes the venue)
    HYBRID: 'HYBRID',   // risk engine decides per-order
  },

  // External liquidity-provider integration. NONE = no LP wired up
  // (A-book is then invalid for this account).
  LP_PROVIDER: {
    NONE: 'NONE',
    OANDA: 'OANDA',
    BINANCE: 'BINANCE',
    CUSTOM_LP: 'CUSTOM_LP',
  },

  // Stamped on every Order/Trade so reporting can split flow by where it
  // actually executed. HYBRID_* preserves the original HYBRID decision so
  // we can audit how the risk engine routed each order.
  EXECUTION_SOURCE: {
    INTERNAL: 'INTERNAL',
    LP: 'LP',
    HYBRID_INTERNAL: 'HYBRID_INTERNAL',
    HYBRID_LP: 'HYBRID_LP',
  },

  POSITION_STATUS: {
    OPEN: 'OPEN',
    // Intermediate state set when a close has been requested (manual click or
    // SL/TP trigger). Used as an atomic claim so two concurrent close requests
    // can't both settle the same position. Engine still finds the position
    // (via {$in: [OPEN, CLOSING]}) and transitions it to CLOSED on settle.
    CLOSING: 'CLOSING',
    CLOSED: 'CLOSED',
  },

  WALLET_TX_TYPE: {
    DEPOSIT: 'DEPOSIT',
    WITHDRAWAL: 'WITHDRAWAL',
    TRADE_OPEN: 'TRADE_OPEN',
    TRADE_CLOSE: 'TRADE_CLOSE',
    FEE: 'FEE',
    ADJUSTMENT: 'ADJUSTMENT',
    TRANSFER: 'TRANSFER',                          // intra-user (account-to-account)
    INTERNAL_TRANSFER_OUT: 'INTERNAL_TRANSFER_OUT',// peer-to-peer: sender side
    INTERNAL_TRANSFER_IN:  'INTERNAL_TRANSFER_IN', // peer-to-peer: receiver side
  },
};
