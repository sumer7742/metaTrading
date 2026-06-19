/**
 * indicatorCatalog — metadata that drives the redesigned Indicators panel
 * (categorized rows + per-indicator settings). Kept separate from PriceChart so
 * the panel and the chart can share one source of truth.
 *
 * The chart's indicator MODEL stays backward-compatible:
 *   indicators[key] === true                       → on, default params
 *   indicators[key] === { color, lineWidth,        → on, custom params
 *                         lineStyle, length }
 *   indicators[key] falsy / absent                 → off
 *
 * For moving averages the period is part of the KEY (e.g. `ema21`), so the panel
 * shows ONE row per MA type and the settings modal picks the period → enabling
 * the matching `${code}${period}` key.
 */

export const CATEGORIES = ['Trend', 'Momentum', 'Volatility', 'Volume', 'Oscillators'];

// Moving-average types. `periods` mirror PriceChart.MA_DEFS so the chosen period
// maps to a renderable `${code}${period}` key. `def` = default period.
export const MA_TYPES = [
  { code: 'ema',  name: 'EMA',  color: '#1D4ED8', def: 21, periods: [5, 8, 9, 10, 12, 13, 15, 20, 21, 26, 30, 34, 50, 55, 89, 100, 150, 200] },
  { code: 'sma',  name: 'SMA',  color: '#F59E0B', def: 20, periods: [5, 8, 10, 13, 15, 20, 21, 25, 30, 34, 50, 55, 89, 100, 150, 200] },
  { code: 'wma',  name: 'WMA',  color: '#22C55E', def: 20, periods: [9, 14, 20, 21, 30, 34, 50, 55, 89, 100, 200] },
  { code: 'hma',  name: 'HMA',  color: '#EC4899', def: 21, periods: [9, 14, 16, 21, 34, 55, 89, 100] },
  { code: 'dema', name: 'DEMA', color: '#14B8A6', def: 21, periods: [9, 14, 20, 21, 34, 50, 100, 200] },
  { code: 'tema', name: 'TEMA', color: '#8B5CF6', def: 21, periods: [9, 14, 20, 21, 34, 50, 100, 200] },
  { code: 'smma', name: 'SMMA', color: '#0EA5E9', def: 21, periods: [7, 10, 14, 21, 34, 50, 100, 200] },
  { code: 'vwma', name: 'VWMA', color: '#F97316', def: 20, periods: [14, 20, 30, 50, 89, 100, 200] },
  { code: 'alma', name: 'ALMA', color: '#A855F7', def: 21, periods: [9, 14, 21, 34, 50, 100, 200] },
];

const MA_BY_CODE = Object.fromEntries(MA_TYPES.map((m) => [m.code, m]));

// Non-MA indicators. `overlay:true` = drawn on the price pane (length is honored
// live); sub-panel oscillators are `overlay:false`. `defLength` drives the
// settings "Length" field; omit when the indicator has no single length.
export const INDICATORS = [
  // ── Trend (overlays)
  { key: 'vwap',       name: 'VWAP',                cat: 'Volume',      overlay: true,  color: '#7C3AED' },
  { key: 'linreg',     name: 'Linear Regression',   cat: 'Trend',       overlay: true,  color: '#0D9488', defLength: 14 },
  { key: 'psar',       name: 'Parabolic SAR',       cat: 'Trend',       overlay: true,  color: '#DC2626' },
  { key: 'supertrend', name: 'SuperTrend',          cat: 'Trend',       overlay: true,  color: '#0891B2', defLength: 10 },
  // ── Volatility (overlay channels)
  { key: 'bb',         name: 'Bollinger Bands',     cat: 'Volatility',  overlay: true,  color: '#0EA5E9', defLength: 20 },
  { key: 'donchian',   name: 'Donchian Channels',   cat: 'Volatility',  overlay: true,  color: '#10B981', defLength: 20 },
  { key: 'keltner',    name: 'Keltner Channels',    cat: 'Volatility',  overlay: true,  color: '#F97316', defLength: 20 },
  { key: 'envelopes',  name: 'Envelopes',           cat: 'Volatility',  overlay: true,  color: '#64748B', defLength: 20 },
  // ── Sub-panel oscillators / momentum
  { key: 'rsi',        name: 'RSI',                 cat: 'Oscillators', overlay: false, color: '#8B5CF6', defLength: 14 },
  { key: 'stoch',      name: 'Stochastic',          cat: 'Oscillators', overlay: false, color: '#3B82F6', defLength: 14 },
  { key: 'wr',         name: 'Williams %R',         cat: 'Oscillators', overlay: false, color: '#DB2777', defLength: 14 },
  { key: 'cci',        name: 'CCI',                 cat: 'Oscillators', overlay: false, color: '#7C3AED', defLength: 20 },
  { key: 'macd',       name: 'MACD',                cat: 'Momentum',    overlay: false, color: '#2DD4BF' },
  { key: 'atr',        name: 'ATR',                 cat: 'Volatility',  overlay: false, color: '#0EA5E9', defLength: 14 },
  // ── Volume
  { key: 'volume',     name: 'Volume',              cat: 'Volume',      overlay: false, color: '#26A69A' },
];

export const LINE_STYLES = [
  { value: 0, label: 'Solid' },
  { value: 1, label: 'Dashed' },
  { value: 2, label: 'Dotted' },
];

/** Parse a moving-average key (e.g. "ema21") → { code, period, def } or null. */
export function parseMaKey(key) {
  const m = /^([a-z]+?)(\d+)$/.exec(key || '');
  if (!m) return null;
  const def = MA_BY_CODE[m[1]];
  if (!def) return null;
  return { code: m[1], period: Number(m[2]), def };
}

/** Human label for an active indicator key, e.g. "EMA (21)", "RSI (14)". */
export function labelForActive(key, cfg) {
  const ma = parseMaKey(key);
  if (ma) return `${ma.def.name} (${ma.period})`;
  const ind = INDICATORS.find((i) => i.key === key);
  if (!ind) return key;
  const len = (cfg && cfg.length) || ind.defLength;
  return len ? `${ind.name} (${len})` : ind.name;
}

/** Category for an active indicator key (MAs are Trend). */
export function categoryForKey(key) {
  if (parseMaKey(key)) return 'Trend';
  return INDICATORS.find((i) => i.key === key)?.cat || 'Trend';
}
