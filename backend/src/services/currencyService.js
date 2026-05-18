/**
 * Currency / FX conversion service.
 *
 * Single source of truth for the live USD↔INR rate the rest of the
 * backend uses to normalise deposits / withdrawals into the canonical
 * USD wallet. The route layer (`/api/fx/usdinr`) used to own its own
 * cache + upstream fetch — that's now lifted in here so controllers
 * (deposit / withdrawal / convert) can also reach the same cached rate.
 *
 * Supported pairs (today): USD↔INR. Anything else returns the
 * unchanged amount (no FX risk taken).
 */

const FALLBACK = Number(process.env.USDINR_FALLBACK) || 83;
const TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 7000;
// Sanity bounds — refuse a rate that looks tampered (off by >2x).
const MIN_RATE = FALLBACK * 0.5;
const MAX_RATE = FALLBACK * 2;

let cachedRate = FALLBACK;
let cachedAt = 0;
let inflight = null;

const fetchUpstream = async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=INR', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream status ${res.status}`);
    const json = await res.json();
    const rate = Number(json && json.rates && json.rates.INR);
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      throw new Error('upstream payload invalid or out of range');
    }
    return rate;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Returns the live USD→INR rate. Cached for 5 minutes. Falls back to
 * the env-configured rate if the upstream is unreachable.
 */
async function getUsdInrRate() {
  const now = Date.now();
  if (now - cachedAt < TTL_MS && cachedAt > 0) return cachedRate;
  if (!inflight) {
    inflight = fetchUpstream()
      .then((r) => { cachedRate = r; cachedAt = Date.now(); return r; })
      .catch(() => { cachedAt = Date.now(); return cachedRate; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Convert any supported currency to the BASE currency (USD).
 * Returns: { baseCurrency, baseAmount, rate, originalCurrency, originalAmount }
 */
async function toBase(currency, amount) {
  const cur = String(currency || 'USD').toUpperCase();
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) {
    return { baseCurrency: 'USD', baseAmount: 0, rate: 1, originalCurrency: cur, originalAmount: 0 };
  }
  if (cur === 'USD') {
    return { baseCurrency: 'USD', baseAmount: amt, rate: 1, originalCurrency: cur, originalAmount: amt };
  }
  if (cur === 'INR') {
    const rate = await getUsdInrRate();
    return {
      baseCurrency: 'USD',
      baseAmount: Number((amt / rate).toFixed(2)),
      rate,
      originalCurrency: 'INR',
      originalAmount: amt,
    };
  }
  // USDT / BTC / etc. → treat 1:1 with USD until a real pair quote exists.
  return { baseCurrency: 'USD', baseAmount: amt, rate: 1, originalCurrency: cur, originalAmount: amt };
}

/**
 * Convert from the BASE currency (USD) to any supported display currency.
 */
async function fromBase(currency, usdAmount) {
  const cur = String(currency || 'USD').toUpperCase();
  const amt = Number(usdAmount);
  if (!Number.isFinite(amt)) return 0;
  if (cur === 'USD') return amt;
  if (cur === 'INR') return amt * (await getUsdInrRate());
  return amt;
}

module.exports = { getUsdInrRate, toBase, fromBase };
