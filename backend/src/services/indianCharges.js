/**
 * indianCharges.js — statutory + exchange charges for Indian cash equity.
 *
 * Computes the per-leg charge breakdown a SEBI-regulated broker passes through:
 * STT, stamp duty, exchange transaction charge, SEBI turnover fee, and GST.
 * Brokerage is whatever the platform's own fee logic produced (passed in).
 *
 * ⚠️ Rates below are FY2024-25 cash-equity figures — VERIFY against the current
 * SEBI / NSE / BSE circulars before going live; statutory rates change.
 *
 *   STT        — DELIVERY: 0.1% buy+sell · INTRADAY: 0.025% sell-only
 *   Stamp duty — DELIVERY: 0.015% buy · INTRADAY: 0.003% buy (buy-side only)
 *   Exchange   — NSE ~0.00297% · BSE ~0.00375% of turnover (group-dependent)
 *   SEBI       — ₹10 per crore = 0.0001% of turnover
 *   GST        — 18% on (brokerage + exchange + SEBI)
 */
const { mul, add } = require('../utils/decimal');

const RATES = {
  STT:   { DELIVERY: { buy: '0.001',   sell: '0.001' }, INTRADAY: { buy: '0', sell: '0.00025' } },
  STAMP: { DELIVERY: { buy: '0.00015', sell: '0' },     INTRADAY: { buy: '0.00003', sell: '0' } },
  EXCHANGE: { NSE: '0.0000297', BSE: '0.0000375' },
  SEBI: '0.000001',
  GST: '0.18',
};

const _r2 = (x) => Number(x || 0).toFixed(2);

/**
 * @param {object} p
 * @param {'BUY'|'SELL'} p.side
 * @param {string|number} p.turnover   qty × price for this leg
 * @param {'NSE'|'BSE'} [p.exchange]
 * @param {'DELIVERY'|'INTRADAY'} [p.product]  leveraged/margin trades = INTRADAY
 * @param {string|number} [p.brokerage]        platform's own commission for this leg
 * @returns {{brokerage,stt,stampDuty,exchangeTxn,sebi,gst,total}} all 2-dp strings
 */
function computeEquityCharges({ side, turnover, exchange = 'NSE', product = 'INTRADAY', brokerage = '0' }) {
  const leg = String(side).toUpperCase() === 'BUY' ? 'buy' : 'sell';
  const prod = product === 'DELIVERY' ? 'DELIVERY' : 'INTRADAY';
  const t = String(turnover || '0');

  const stt   = mul(t, RATES.STT[prod][leg]);
  const stamp = mul(t, RATES.STAMP[prod][leg]);
  const exch  = mul(t, RATES.EXCHANGE[exchange] || RATES.EXCHANGE.NSE);
  const sebi  = mul(t, RATES.SEBI);
  const gst   = mul(add(add(String(brokerage), exch), sebi), RATES.GST);
  const total = [String(brokerage), stt, stamp, exch, sebi, gst].reduce((a, b) => add(a, b), '0');

  return {
    brokerage: _r2(brokerage), stt: _r2(stt), stampDuty: _r2(stamp),
    exchangeTxn: _r2(exch), sebi: _r2(sebi), gst: _r2(gst), total: _r2(total),
  };
}

module.exports = { computeEquityCharges, RATES };

// Self-check: `node src/services/indianCharges.js`
if (require.main === module) {
  console.log('SELL 10 @ 1500 (NSE intraday), brokerage ₹20:');
  console.log(computeEquityCharges({ side: 'SELL', turnover: 15000, exchange: 'NSE', product: 'INTRADAY', brokerage: '20' }));
}
