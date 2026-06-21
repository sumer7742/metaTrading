module.exports = {
  ROLES: {
    USER: 'USER',
    AFFILIATE: 'AFFILIATE',
    MANAGER: 'MANAGER',
    ADMIN: 'ADMIN',
    SUPER_ADMIN: 'SUPER_ADMIN',
    // ── Financial Department (simplified; request-based, no user ownership) ──
    // Managers process requests DIRECTLY (no separate officers). The Audit
    // Manager is an independent, read-only oversight role: regular checking,
    // fraud detection and random inspection audits across all transactions.
    FINANCIAL_ADMIN:    'FINANCIAL_ADMIN',     // runs the whole finance dept
    DEPOSIT_MANAGER:    'DEPOSIT_MANAGER',     // processes deposit requests directly
    WITHDRAWAL_MANAGER: 'WITHDRAWAL_MANAGER',  // processes withdrawal requests directly
    AUDIT_MANAGER:      'AUDIT_MANAGER',       // read-only oversight: checking, fraud detection, random inspection
  },

  // Convenience grouping for finance RBAC + auto-distribution.
  FINANCE_ROLES: {
    ALL: ['FINANCIAL_ADMIN', 'DEPOSIT_MANAGER', 'WITHDRAWAL_MANAGER', 'AUDIT_MANAGER'],
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
    INTERNAL: 'INTERNAL',           // legacy internal fill (kept for old data)
    INTERNAL_MATCHING: 'INTERNAL_MATCHING', // user↔user order-book match
    EXTERNAL: 'EXTERNAL',           // A-book (forwarded to LP)
    B_BOOK: 'B_BOOK',               // user↔broker (broker is counterparty)
  },

  // The four selectable execution modes (admin/global or per-user override).
  // INTERNAL_MATCHING — user↔user matching (broker earns fees only)
  // B_BOOK           — user↔broker (broker is the counterparty)
  // A_BOOK           — user↔LP (exposure transferred externally)
  // HYBRID           — risk engine routes each order to one of the above
  EXECUTION_MODE: {
    INTERNAL_MATCHING: 'INTERNAL_MATCHING',
    B_BOOK: 'B_BOOK',
    A_BOOK: 'A_BOOK',
    HYBRID: 'HYBRID',
  },

  // The concrete venue an order actually executed on (HYBRID resolves to one
  // of these). Never 'HYBRID' — that's a mode, not a result.
  ROUTING_RESULT: {
    INTERNAL_MATCHING: 'INTERNAL_MATCHING',
    B_BOOK: 'B_BOOK',
    A_BOOK: 'A_BOOK',
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
    INTERNAL: 'INTERNAL',                 // B-book (broker counterparty)
    INTERNAL_MATCHING: 'INTERNAL_MATCHING', // user↔user book match
    LP: 'LP',                             // A-book
    HYBRID_INTERNAL: 'HYBRID_INTERNAL',
    HYBRID_INTERNAL_MATCHING: 'HYBRID_INTERNAL_MATCHING',
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
    DIVIDEND: 'DIVIDEND',                          // corporate-action cash (long credit / short debit)
    TRANSFER: 'TRANSFER',                          // intra-user (account-to-account)
    INTERNAL_TRANSFER_OUT: 'INTERNAL_TRANSFER_OUT',// peer-to-peer: sender side
    INTERNAL_TRANSFER_IN:  'INTERNAL_TRANSFER_IN', // peer-to-peer: receiver side
  },
};
