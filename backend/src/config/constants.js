module.exports = {
  ROLES: {
    USER: 'USER',
    AFFILIATE: 'AFFILIATE',
    ADMIN: 'ADMIN',
    SUPER_ADMIN: 'SUPER_ADMIN',
  },

  KYC_STATUS: {
    NOT_SUBMITTED: 'NOT_SUBMITTED',
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
  },

  ACCOUNT_TYPES: {
    REAL: 'REAL',
    VIRTUAL: 'VIRTUAL',
    DEMO: 'DEMO',
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
    TRANSFER: 'TRANSFER',
  },
};
