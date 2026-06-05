const mongoose = require('mongoose');
const { EXECUTION_MODE, ROUTING_RESULT } = require('../config/constants');

/**
 * RoutingDecision — immutable audit record of how ONE order was routed.
 *
 * Written by orderRouter for every order (any mode), so ops/compliance can
 * answer "why did this order go A-book / B-book / internal-matching, and who
 * decided?". Also powers the admin execution-stats dashboard (routing
 * distribution %, hybrid-routed count).
 *
 *   executionMode    — the mode in force (INTERNAL_MATCHING|B_BOOK|A_BOOK|HYBRID)
 *   routingResult    — concrete venue chosen (null if REJECTED)
 *   reason           — human-readable explanation
 *   riskEngineReason — populated only for HYBRID (the risk engine's verdict)
 *   modeSource       — 'user' (per-user override) | 'global' (platform setting)
 */
const routingDecisionSchema = new mongoose.Schema(
  {
    orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradingAccount' },
    symbol:    { type: String, index: true },
    side:      String,

    executionMode: { type: String, enum: Object.values(EXECUTION_MODE), required: true, index: true },
    routingResult: { type: String, enum: [...Object.values(ROUTING_RESULT), 'REJECTED', null], default: null, index: true },

    notional:         { type: Number, default: 0 }, // USD-ish notional at decision time
    reason:           { type: String, default: '' },
    riskEngineReason: { type: String, default: null }, // HYBRID only
    modeSource:       { type: String, enum: ['user', 'global'], default: 'global' },

    createdAt: { type: Date, default: Date.now, immutable: true, index: true },
  },
  { timestamps: false }
);

routingDecisionSchema.index({ executionMode: 1, createdAt: -1 });
routingDecisionSchema.index({ routingResult: 1, createdAt: -1 });

module.exports = mongoose.model('RoutingDecision', routingDecisionSchema);
