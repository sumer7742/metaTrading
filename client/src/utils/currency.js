/**
 * Indian Rupee currency formatter.
 *
 * Backend stores all monetary values as strings (decimal-precise).
 * Frontend uses this helper to display them as ₹X,XX,XXX format
 * with Indian comma placement (lakh/crore style).
 *
 * Usage:
 *   formatINR(50000)         → "₹50,000"
 *   formatINR("123456.78")   → "₹1,23,456.78"
 *   formatINR(10000000)      → "₹1,00,00,000"
 */

const USD_TO_INR_RATE = 83; // Approximate, used only for display conversion of legacy USD data

/**
 * Format a number as INR with proper Indian comma placement.
 * Uses Intl.NumberFormat with Indian locale.
 */
export const formatINR = (amount, opts = {}) => {
  const { showSymbol = true, decimals = 2, compact = false } = opts;

  const num = Number(amount || 0);
  if (isNaN(num)) return showSymbol ? '₹0' : '0';

  if (compact && Math.abs(num) >= 10000000) {
    // Crore
    return (showSymbol ? '₹' : '') + (num / 10000000).toFixed(2) + ' Cr';
  }
  if (compact && Math.abs(num) >= 100000) {
    // Lakh
    return (showSymbol ? '₹' : '') + (num / 100000).toFixed(2) + ' L';
  }

  const formatter = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const formatted = formatter.format(num);
  return showSymbol ? `₹${formatted}` : formatted;
};

/**
 * Format with no decimals (for whole rupee amounts).
 */
export const formatINRWhole = (amount, opts = {}) => formatINR(amount, { ...opts, decimals: 0 });

/**
 * Compact format (e.g., ₹1.23 L, ₹2.45 Cr).
 */
export const formatINRCompact = (amount) => formatINR(amount, { compact: true, decimals: 2 });

/**
 * Convert legacy USD value to display INR (for backwards compatibility
 * during migration). Use only when you know the source is USD-stored.
 */
export const usdToINR = (usdAmount) => {
  return Number(usdAmount || 0) * USD_TO_INR_RATE;
};

/**
 * Currency symbol per code.
 */
export const currencySymbol = (code) => {
  const map = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  return map[code] || code + ' ';
};

/**
 * Format with given currency code (defaults to INR).
 */
export const formatMoney = (amount, currency = 'INR', opts = {}) => {
  if (currency === 'INR') return formatINR(amount, opts);
  const num = Number(amount || 0);
  return currencySymbol(currency) + num.toFixed(opts.decimals ?? 2);
};

/**
 * Pip value calculation in INR (for Indian context).
 * Useful for showing "1 pip movement = ₹X profit/loss".
 */
export const pipValueINR = (lotSize, instrument) => {
  const pip = Number(instrument?.pipValue || 0.0001);
  const value = Number(lotSize || 0) * pip * USD_TO_INR_RATE;
  return formatINR(value);
};
