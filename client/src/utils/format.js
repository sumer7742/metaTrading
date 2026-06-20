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

export const fmtMoney = (v, currency = 'USD') => `${currencySymbol(currency)}${fmtNum(v, 2)}`;

export const fmtPnl = (v, currency = 'USD') => {
  const n = Number(v);
  const sign = n > 0 ? '+' : '';
  return `${sign}${currencySymbol(currency)}${fmtNum(Math.abs(n), 2) * (n < 0 ? -1 : 1) === 0 ? '0.00' : fmtNum(n, 2)}`;
};

// Simpler PnL formatting that handles negative correctly
export const fmtPnlSimple = (v, currency = 'USD') => {
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
 * Compact money formatter — INR-primary across the app. Returns:
 *   { primary: '₹1,00,000.00', secondary: '', primaryRaw, secondaryRaw }
 *
 * The fxRate converts USD-sourced numbers into INR. Signature stays
 * identical to the previous dual helper so call sites don't change.
 *
 * Sign-aware: negatives keep their sign; `withSign=true` adds a leading
 * '+' on positives (useful for PnL display).
 */
export const fmtMoneyDual = (value, sourceCurrency = 'USD', fxRate = 83, withSign = false) => {
  const n = Number(value);
  if (!isFinite(n)) {
    return { primary: '₹0.00', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  }
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n);
  const rate = Number(fxRate || 0) > 0 ? Number(fxRate) : 83;

  let inrAbs;
  if (sourceCurrency === 'INR') {
    inrAbs = abs;
  } else if (sourceCurrency === 'USD') {
    inrAbs = abs * rate;
  } else {
    // Unknown source currency — display native (no FX conversion).
    return {
      primary: `${sign}${currencySymbol(sourceCurrency)}${fmtNum(abs, 2)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: 0,
    };
  }

  const signedInr = inrAbs * (n < 0 ? -1 : 1);
  return {
    primary: `${sign}₹${fmtNum(inrAbs, 2)}`,
    secondary: '',
    primaryRaw: signedInr,
    secondaryRaw: signedInr,
  };
};

/**
 * Both-currency money formatter — used on the headline "final total"
 * summary cards (Wallet equity, Funds real-balance / demo-balance hero
 * cards, Dashboard top-line balance, Account cards, PnL summaries).
 *
 * India-first display policy:
 *   { primary: '₹1,00,000.00', secondary: '≈ $1,204.82 USD' }
 *
 * Primary is INR (large), secondary is USD (small, prefixed with ≈
 * and suffixed " USD"). Conversion uses the live `fxRate` passed from
 * the `useFxRate` hook.
 *
 * Everywhere ELSE (PnL columns, chart info-strip, per-account rows) we
 * stick with the USD-only `fmtMoneyDual`. This helper is intentionally
 * narrow — reserved for the visually dominant total amounts.
 */
export const fmtMoneyBoth = (value, sourceCurrency = 'USD', fxRate = 83, withSign = false) => {
  const n = Number(value);
  if (!isFinite(n)) {
    return { primary: '₹0.00', secondary: '≈ $0.00 USD', primaryRaw: 0, secondaryRaw: 0 };
  }
  const sign = withSign && n > 0 ? '+' : (n < 0 ? '-' : '');
  const abs = Math.abs(n);
  const rate = Number(fxRate || 0) > 0 ? Number(fxRate) : 83;

  let usdAbs;
  let inrAbs;
  if (sourceCurrency === 'USD') {
    usdAbs = abs;
    inrAbs = abs * rate;
  } else if (sourceCurrency === 'INR') {
    inrAbs = abs;
    usdAbs = abs / rate;
  } else {
    // Unknown source currency — display native as primary, no INR convert.
    return {
      primary: `${sign}${currencySymbol(sourceCurrency)}${fmtNum(abs, 2)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: 0,
    };
  }

  const signedUsd = usdAbs * (n < 0 ? -1 : 1);
  const signedInr = inrAbs * (n < 0 ? -1 : 1);
  return {
    // INR is the dominant figure (India-first). USD reads as an
    // approximate conversion below.
    primary: `${sign}₹${fmtNum(inrAbs, 2)}`,
    secondary: `≈ ${sign}$${fmtNum(usdAbs, 2)} USD`,
    primaryRaw: signedInr,
    secondaryRaw: signedUsd,
  };
};

/**
 * Price formatter — USD-primary for every instrument. Returns:
 *   { primary: '$60,000.00', secondary: '', primaryRaw, secondaryRaw }
 *
 * - USD-quoted instruments: primary = the native USD price (decimals
 *   honored, e.g. 5 for forex).
 * - INR-quoted instruments: converted to USD via fxRate.
 * - Other quotes (EUR/GBP/JPY/etc): kept in native currency since we
 *   don't have cross-rates yet — same fallback behaviour as before.
 */
export const fmtPriceDual = (price, quoteCurrency = 'USD', fxRate = 83, decimals = 2) => {
  const n = Number(price);
  if (!isFinite(n)) return { primary: '-', secondary: '', primaryRaw: 0, secondaryRaw: 0 };
  if (quoteCurrency === 'USD') {
    return {
      primary: `$${fmtNum(n, decimals)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: n,
    };
  }
  if (quoteCurrency === 'INR') {
    // Native INR-quoted instruments (NSE/BSE cash) — show ₹ directly. These are
    // already in rupees; converting to USD would be wrong (₹1500 ≠ $18).
    return {
      primary: `₹${fmtNum(n, decimals)}`,
      secondary: '',
      primaryRaw: n,
      secondaryRaw: n,
    };
  }
  // Other quote currencies (JPY/EUR/GBP/CHF/etc.). The numeric value IS
  // the FX rate for the pair (e.g. EUR/JPY = 184.837 means 1 EUR =
  // 184.837 JPY) — that's what the trader acts on. We don't have cross
  // rates to convert to USD, so we keep the raw number but display with
  // a `$` sign to stay visually consistent with the rest of the UI.
  return {
    primary: `$${fmtNum(n, decimals)}`,
    secondary: '',
    primaryRaw: n,
    secondaryRaw: n,
  };
};
