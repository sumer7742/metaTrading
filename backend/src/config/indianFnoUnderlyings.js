/**
 * indianFnoUnderlyings.js — the F&O underlyings the platform keeps futures +
 * (near-expiry, strike-windowed) options for. Shared by services/optionUniverse
 * and services/dhanInstrumentSync so the import filter and the cleanup agree.
 *
 * Default = 4 NSE indices + the most liquid NSE stock-F&O names. Kept curated
 * (not the full ~180-name F&O universe) so the option count stays sane on a
 * small box — every underlying adds a near-expiry chain (×strikes ×CE/PE).
 * Override / extend with env  DHAN_SYNC_FNO=NIFTY,BANKNIFTY,RELIANCE,...
 *
 * NOTE: SENSEX / BANKEX are BSE (BFO) — the importer is NSE-only today, so they
 * need BSE support before they can be added here.
 */
const FNO_DEFAULT = [
  // ── NSE indices ──
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
  // ── Top liquid NSE stock F&O ──
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'INFY', 'TCS', 'AXISBANK', 'KOTAKBANK',
  'BHARTIARTL', 'ITC', 'LT', 'BAJFINANCE', 'HINDUNILVR', 'MARUTI', 'TATAMOTORS', 'TATASTEEL',
  'SUNPHARMA', 'ADANIENT', 'HCLTECH', 'WIPRO', 'TITAN', 'ASIANPAINT', 'NTPC', 'ONGC', 'M&M',
];

const FNO_UNDERLYINGS = (process.env.DHAN_SYNC_FNO ? process.env.DHAN_SYNC_FNO.split(',') : FNO_DEFAULT)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ── MCX commodity futures (FUTCOM). Few contracts, light on the box. ──
// Override via DHAN_SYNC_MCX. Empty = MCX import off.
const MCX_DEFAULT = ['GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'ALUMINIUM'];
const MCX_UNDERLYINGS = (process.env.DHAN_SYNC_MCX != null ? process.env.DHAN_SYNC_MCX.split(',') : MCX_DEFAULT)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

module.exports = { FNO_UNDERLYINGS, FNO_DEFAULT, MCX_UNDERLYINGS, MCX_DEFAULT };
