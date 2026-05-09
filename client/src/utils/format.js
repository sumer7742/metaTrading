export const fmtNum = (v, decimals = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

export const fmtPrice = (v, precision = 2) => fmtNum(v, precision);

export const currencySymbol = (currency = 'INR') => {
  const map = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  return map[currency] || (currency + ' ');
};

export const fmtMoney = (v, currency = 'INR') => `${currencySymbol(currency)}${fmtNum(v, 2)}`;

export const fmtPnl = (v, currency = 'INR') => {
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${currencySymbol(currency)}${fmtNum(Math.abs(n), 2) * (n < 0 ? -1 : 1) === 0 ? '0.00' : fmtNum(n, 2)}`;
};

// Simpler PnL formatting that handles negative correctly
export const fmtPnlSimple = (v, currency = 'INR') => {
  const n = Number(v);
  if (!isFinite(n)) return `${currencySymbol(currency)}0.00`;
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${currencySymbol(currency)}${abs}`;
};

export const fmtDate = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleString('en-IN');
};

export const fmtTime = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleTimeString('en-IN');
};

/**
 * Convert a price quoted in `quoteCurrency` into INR using the supplied FX
 * rate (USD→INR). Returns the same value if the quote currency is already
 * INR, or a sensible string when fxRate isn't available yet.
 *
 * Use this for display only — never for trading math (orders/PnL must keep
 * running in the instrument's native quote currency).
 */
export const toInr = (price, quoteCurrency = 'USD', fxRate = 83) => {
  const n = Number(price);
  if (!isFinite(n) || n <= 0) return 0;
  if (quoteCurrency === 'INR') return n;
  if (quoteCurrency === 'USD') return n * Number(fxRate || 0);
  // Other currencies (EUR, GBP, etc): not converted — return raw and let the
  // caller decide. A future FX layer can add cross rates.
  return n;
};

/**
 * Dual-currency money formatter for balances / PnL / equity. Returns:
 *   { primary: '₹1,00,000.00', secondary: '$1,204.82' }
 *
 * Input is whatever currency the *underlying* number is in. We always show
 * INR as the primary line; secondary is the original (or converted) USD.
 *
 * Sign-aware: negative values keep their sign on both lines, and an
 * optional `withSign=true` adds a leading '+' on positive numbers (handy
 * for PnL where the user wants to see direction at a glance).
 */
export const fmtMoneyDual = (value, sourceCurrency = 'INR', fxRate = 83, withSign = false) => {
  const n = Number(value);
  if (!isFinite(n)) {
    return { primary: '₹0.00', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  }
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n);
  const rate = Number(fxRate || 0);

  let inrAbs;
  let usdAbs;
  if (sourceCurrency === 'INR') {
    inrAbs = abs;
    usdAbs = rate > 0 ? abs / rate : 0;
  } else if (sourceCurrency === 'USD') {
    inrAbs = abs * rate;
    usdAbs = abs;
  } else {
    // Unknown currency — show source side only, no INR conversion.
    return {
      primary: `${sign}${currencySymbol(sourceCurrency)}${fmtNum(abs, 2)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: 0,
    };
  }

  return {
    primary: `${sign}₹${fmtNum(inrAbs, 2)}`,
    secondary: usdAbs > 0 ? `${sign}$${fmtNum(usdAbs, 2)}` : '',
    primaryRaw: sourceCurrency === 'INR' ? n : inrAbs * (n < 0 ? -1 : 1),
    secondaryRaw: sourceCurrency === 'USD' ? n : usdAbs * (n < 0 ? -1 : 1),
  };
};

/**
 * Dual-currency price formatter. Returns:
 *   { primary: '₹50,00,000.00', secondary: '$60,000.00', primaryRaw, secondaryRaw }
 *
 * - For INR-quoted instruments: primary=INR, secondary stays empty so the
 *   UI doesn't show a redundant "$X" line.
 * - For USD-quoted instruments: primary=INR converted, secondary=original USD.
 * - For other quotes (EUR/GBP etc): primary stays in the native currency
 *   until a cross-rate is available.
 */
export const fmtPriceDual = (price, quoteCurrency = 'USD', fxRate = 83, decimals = 2) => {
  const n = Number(price);
  if (!isFinite(n)) return { primary: '-', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  if (quoteCurrency === 'INR') {
    return {
      primary: `₹${fmtNum(n, decimals)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: 0,
    };
  }
  if (quoteCurrency === 'USD') {
    const inr = n * Number(fxRate || 0);
    // INR display rounds to 2 decimals at most — fractions of a paisa add
    // visual noise without informational value.
    const inrDecimals = Math.min(decimals, 2);
    return {
      primary: `₹${fmtNum(inr, inrDecimals)}`,
      secondary: `$${fmtNum(n, decimals)}`,
      primaryRaw: inr,
      secondaryRaw: n,
    };
  }
  return {
    primary: `${currencySymbol(quoteCurrency)}${fmtNum(n, decimals)}`,
    secondary: '',
    primaryRaw: n,
    secondaryRaw: 0,
  };
};
