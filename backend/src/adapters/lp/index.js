/**
 * LP adapter selector. The router/execution service asks for an adapter
 * by provider name and gets back a uniform interface (placeOrder /
 * cancelOrder / getQuote). Throws for `NONE` so an A-book account
 * without a configured provider fails loudly instead of silently
 * falling back to internal execution.
 */
const { LP_PROVIDER } = require('../../config/constants');

const oanda = require('./oanda.adapter');
const binance = require('./binance.adapter');
const customLp = require('./customLp.adapter');

const REGISTRY = {
  [LP_PROVIDER.OANDA]: oanda,
  [LP_PROVIDER.BINANCE]: binance,
  [LP_PROVIDER.CUSTOM_LP]: customLp,
};

// Order of preference when auto-picking. OANDA first because it covers
// forex (the largest instrument set on this platform), then Binance for
// crypto, then any custom in-house bridge.
const PROVIDER_PRIORITY = [LP_PROVIDER.OANDA, LP_PROVIDER.BINANCE, LP_PROVIDER.CUSTOM_LP];

// Which env vars must be set for a provider to be considered "credentialed".
// When NONE of these are present, the adapter falls back to its stub fill —
// which is fine for dev but means a real production deploy should set at
// least one of these.
const _hasCreds = {
  [LP_PROVIDER.OANDA]:    () => !!(process.env.OANDA_API_KEY && process.env.OANDA_ACCOUNT_ID),
  [LP_PROVIDER.BINANCE]:  () => !!(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET),
  [LP_PROVIDER.CUSTOM_LP]: () => !!(process.env.CUSTOM_LP_BASE_URL && process.env.CUSTOM_LP_API_KEY),
};

const getAdapter = (provider) => {
  if (!provider || provider === LP_PROVIDER.NONE) {
    throw new Error('LP provider is required for A-book execution.');
  }
  const adapter = REGISTRY[provider];
  if (!adapter) {
    throw new Error(`Unknown LP provider: ${provider}`);
  }
  return adapter;
};

/**
 * Auto-pick a working LP provider. Used when admin flips an account to
 * A_BOOK without specifying which LP — we should NOT make ops manually
 * select one if a credentialed provider is sitting right there.
 *
 * Selection order:
 *   1. First provider in PROVIDER_PRIORITY whose env credentials are set.
 *   2. If none have creds, fall back to OANDA (which will run in
 *      stub-fill mode — fine for dev / staging, never silent in prod
 *      because the adapter logs a warning on every stub call).
 *
 * Returns one of LP_PROVIDER.* (never NONE).
 */
const pickAvailableProvider = () => {
  for (const p of PROVIDER_PRIORITY) {
    if (_hasCreds[p] && _hasCreds[p]()) return p;
  }
  return LP_PROVIDER.OANDA;
};

/**
 * Quick capability report — useful for an admin "Connections" dashboard.
 *   [{ provider: 'OANDA', credentialed: true },
 *    { provider: 'BINANCE', credentialed: false }, ...]
 */
const listProviderStatus = () =>
  PROVIDER_PRIORITY.map((p) => ({
    provider: p,
    credentialed: !!(_hasCreds[p] && _hasCreds[p]()),
  }));

module.exports = { getAdapter, pickAvailableProvider, listProviderStatus };
