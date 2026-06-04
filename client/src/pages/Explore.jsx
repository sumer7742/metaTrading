import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EconomicCalendarSection } from '../components/EconomicCalendar';
import AssetIcon from '../components/AssetIcon';
import WatchlistButton from '../components/WatchlistButton';
import { useInstruments } from '../hooks/useInstruments';
import { useRecentlyViewed } from '../hooks/useRecentlyViewed';
import { wsClient } from '../services/ws';
import { api, errorMessage } from '../services/api';
import { fmtNum } from '../utils/format';
import toast from 'react-hot-toast';

/**
 * Explore — Groww-style discovery page. Most sections pull from the live
 * /instruments catalog and subscribe to ticker:* WebSocket channels so prices
 * tick in real time. Every clickable surface routes to /trade?symbol=…,
 * which the Trade page already consumes to drive the chart, order form and
 * order book.
 */

// ─── Inline icons ─────────────────────────────────────────────────────────
const Icon = ({ d, size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);
const I = {
  bookmark: <Icon d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  arrow:    <Icon d={['M5 12h14', 'M13 6l6 6-6 6']} size={14} />,
  arrowUp:  <Icon d={['M7 17l10-10', 'M7 7h10v10']} size={12} />,
  arrowDn:  <Icon d={['M17 7L7 17', 'M17 17H7V7']} size={12} />,
  chevron:  <Icon d="M9 18l6-6-6-6" size={14} />,
  copy:     <Icon d={['M20 7H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z', 'M16 21V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2']} />,
  signal:   <Icon d={['M2 12h4', 'M10 7h4', 'M18 2h4', 'M2 18h4', 'M10 13h4', 'M18 8h4']} />,
  stake:    <Icon d={['M12 2L2 7l10 5 10-5-10-5z', 'M2 17l10 5 10-5', 'M2 12l10 5 10-5']} />,
  bot:      <Icon d={['M9 8h6', 'M12 2v4', 'M5 12h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M9 16h0', 'M15 16h0']} />,
  cal:      <Icon d={['M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M16 2v4', 'M8 2v4', 'M3 10h18']} />,
  reports:  <Icon d={['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M9 13h6', 'M9 17h6']} />,
  close:    <Icon d={['M18 6L6 18', 'M6 6l12 12']} size={12} />,
  fire:     <Icon d={['M12 2s4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 1-3', 'M12 14a4 4 0 1 0 0 8 4 4 0 0 0 0-8z']} size={12} />,
  // Sector glyphs
  chip:     <Icon d={['M9 3v4', 'M15 3v4', 'M9 17v4', 'M15 17v4', 'M3 9h4', 'M3 15h4', 'M17 9h4', 'M17 15h4', 'M7 7h10v10H7z', 'M10 10h4v4h-4z']} />,
  bank:     <Icon d={['M3 21h18', 'M5 21V10', 'M9 21V10', 'M15 21V10', 'M19 21V10', 'M2 10l10-7 10 7']} />,
  bolt:     <Icon d="M13 2L3 14h7l-1 8 10-12h-7z" />,
  ingot:    <Icon d={['M4 8h16l-2 12H6z', 'M6 4h12l2 4H4z']} />,
  layers:   <Icon d={['M12 2l10 6-10 6L2 8z', 'M2 14l10 6 10-6', 'M2 11l10 6 10-6']} />,
  car:      <Icon d={['M5 17h14l-2-7H7z', 'M3 17h2', 'M19 17h2', 'M7 13h10', 'M8 17v2', 'M16 17v2']} />,
  barrel:   <Icon d={['M5 3h14v18H5z', 'M5 8h14', 'M5 16h14', 'M5 3c0 2 2 2 2 2h10s2 0 2-2']} />,
  stars:    <Icon d={['M3 21V3', 'M3 13l4-4 4 3 6-7 4 4', 'M3 21h18']} />,
  rocket:   <Icon d={['M5 13c-2 4 0 7 0 7s3 2 7 0', 'M19 5s-3-3-9 3-3 9-3 9 6 0 9-3 3-9 3-9z', 'M14 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2z']} />,
  doller:   <Icon d={['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']} />,
  diamond:  <Icon d={['M6 3h12l4 6-10 12L2 9z', 'M2 9h20', 'M12 3l4 6-4 12-4-12z']} />,
  user:     <Icon d={['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']} />,
  headset:  <Icon d={['M3 14v-2a9 9 0 0 1 18 0v2', 'M21 14v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z', 'M3 14v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z']} />,
};

// ─── Asset glyph metadata ────────────────────────────────────────────────
const ASSET_META = {
  BTCUSD: { glyph: '₿',  bg: '#F7931A' },
  ETHUSD: { glyph: 'Ξ',  bg: '#627EEA' },
  SOLUSD: { glyph: '◎',  bg: '#9945FF' },
  XRPUSD: { glyph: 'X',  bg: '#23292F' },
  EURUSD: { glyph: '€$', bg: '#1F3A8A' },
  GBPUSD: { glyph: '£$', bg: '#7C3AED' },
  USDJPY: { glyph: '¥$', bg: '#0F172A' },
  AUDUSD: { glyph: 'A$', bg: '#0EA5E9' },
  GOLD:   { glyph: 'Au', bg: '#D4A017' },
  XAUUSD: { glyph: 'Au', bg: '#D4A017' },
  XAGUSD: { glyph: 'Ag', bg: '#94A3B8' },
  NAS100: { glyph: 'NQ', bg: '#0EA5E9' },
  US30:   { glyph: 'DJ', bg: '#475569' },
  SPX500: { glyph: 'SP', bg: '#3B82F6' },
};

function glyphFor(symbol) {
  if (ASSET_META[symbol]) return ASSET_META[symbol];
  return { glyph: (symbol || '?').slice(0, 2).toUpperCase(), bg: '#475569' };
}

// ─── Sectors — grounded in the real backend `category` enum ──────────────
// The Instrument model only carries CRYPTO/FOREX/STOCK/INDEX/COMMODITY (no
// sector metadata), so we surface those five real groupings plus two
// derivable refinements (Forex Majors, Precious Metals). Any sector with
// zero matching instruments is hidden automatically at render time.
const cat = (r) => (r.category || '').toUpperCase();
const isCrypto    = (r) => cat(r) === 'CRYPTO';
const isForex     = (r) => cat(r) === 'FOREX';
const isCommodity = (r) => cat(r) === 'COMMODITY';
const isIndex     = (r) => cat(r) === 'INDEX';
const isStock     = (r) => cat(r) === 'STOCK';
const MAJOR_CCY   = new Set(['EUR','GBP','USD','JPY','CHF','AUD','NZD','CAD']);

const SECTOR_DEFS = [
  { key: 'crypto',  label: 'Crypto',         icon: I.diamond, tint: '#F7931A', match: isCrypto },
  { key: 'forex',   label: 'Forex',          icon: I.doller,  tint: '#10B981', match: isForex },
  { key: 'majors',  label: 'Forex Majors',   icon: I.doller,  tint: '#0EA5E9',
    match: (r) => isForex(r)
      && MAJOR_CCY.has((r.baseCurrency || '').toUpperCase())
      && MAJOR_CCY.has((r.quoteCurrency || '').toUpperCase()) },
  { key: 'comm',    label: 'Commodities',    icon: I.barrel,  tint: '#A16207', match: isCommodity },
  { key: 'gold',    label: 'Precious Metals', icon: I.ingot,  tint: '#D4A017',
    match: (r) => isCommodity(r)
      && ['XAU','XAG'].includes((r.baseCurrency || '').toUpperCase()) },
  { key: 'indices', label: 'Indices',        icon: I.stars,   tint: '#3B82F6', match: isIndex },
  { key: 'stocks',  label: 'Stocks',         icon: I.bank,    tint: '#8B5CF6', match: isStock },
];

// Products link to existing routes so each tile actually goes somewhere.
// Mirrors every entry from the secondary top-nav (Trading Account, Funds,
// IB Room, Plans & Pricing, Helpdesk) plus the original product tiles —
// gives users a discoverable second path to those pages from Explore.
const PRODUCTS = [
  { to: '/accounts', label: 'Trading Account',   caption: 'Manage demo & real accounts', icon: I.user,    tint: '#1D4ED8' },
  { to: '/wallet',   label: 'Funds',             caption: 'Deposit & withdraw',          icon: I.doller,  tint: '#10B981' },
  { to: '/ib-room',  label: 'IB Room',           caption: 'Partner & copy-trading hub',  icon: I.copy,    tint: '#2563EB' },
  { to: '/plans',    label: 'Plans & Pricing',   caption: 'Compare account tiers',       icon: I.diamond, tint: '#8B5CF6' },
  { to: '/helpdesk', label: 'Helpdesk',          caption: 'Talk to our support team',    icon: I.headset, tint: '#EC4899' },
  { to: '/alerts',   label: 'Signals & Alerts',  caption: 'Price-based entry alerts',    icon: I.signal,  tint: '#3B82F6' },
  { to: '/trade',    label: 'Trading Terminal',  caption: 'Open the pro chart',          icon: I.bot,     tint: '#0EA5E9' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Synthesize a stylized sparkline from a 24h % change. Real per-symbol
 *  candle history would require an extra endpoint per pill; this gives the
 *  same visual signal (uptrend / downtrend / flat) without that fan-out. */
function synthSpark(change, seed = 0) {
  const ch = Number(change);
  const dir = !Number.isFinite(ch) ? 0 : ch >= 0 ? 1 : -1;
  const N = 10;
  const start = 50 - dir * 12;
  const end   = 50 + dir * 12;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    // PRNG-ish noise from i+seed so each card has a different micro-pattern
    const wiggle = Math.sin((i + seed) * 1.3) * 3;
    pts.push(start + (end - start) * t + wiggle);
  }
  return pts;
}

function Sparkline({ points, positive, width = 110, height = 36 }) {
  if (!points?.length) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(height - ((p - min) / span) * (height - 4) - 2).toFixed(2)}`)
    .join(' ');
  const stroke = positive ? '#16A34A' : '#DC2626';
  const fill   = positive ? 'rgba(22, 163, 74, 0.10)' : 'rgba(220, 38, 38, 0.10)';
  const area   = `${path} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={area} fill={fill} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Thin wrapper kept for backwards compat with the existing JSX call sites.
// New code should import AssetIcon directly. When the parent passes a
// full `row` we render the real crypto logo / forex flag pair via AssetIcon;
// when only `sym` is known we fall back to the colored tile.
function AssetGlyph({ sym, row, size = 40 }) {
  if (row) return <AssetIcon row={row} size={size} />;
  const meta = glyphFor(sym);
  return (
    <span
      className="rounded-xl flex items-center justify-center font-bold text-white shrink-0"
      style={{ width: size, height: size, background: meta.bg, fontSize: Math.round(size * 0.42) }}
    >
      {meta.glyph}
    </span>
  );
}

function ChangePill({ value }) {
  if (!Number.isFinite(value)) {
    return <span className="text-[11px] text-text-muted">—</span>;
  }
  const positive = value >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs font-semibold rounded-md px-1.5 py-0.5 ${
        positive ? 'text-[#16A34A] bg-[#16A34A]/10' : 'text-[#DC2626] bg-[#DC2626]/10'
      }`}
    >
      {positive ? I.arrowUp : I.arrowDn}
      {positive ? '+' : ''}{value.toFixed(2)}%
    </span>
  );
}

/** Groww-style change display: "+1.68 (9.41%)" with color, no chip background.
 *  `absChange` is signed price units; `pct` is signed percentage. */
function ChangeText({ absChange, pct, precision }) {
  const ok = Number.isFinite(pct);
  const positive = ok ? pct >= 0 : true;
  const color = !ok ? '#9CA3AF' : positive ? '#16A34A' : '#DC2626';
  if (!ok) return <span className="text-xs text-text-muted">—</span>;
  const absStr = Number.isFinite(absChange) ? fmtNum(Math.abs(absChange), Math.min(Number(precision) || 2, 4)) : '—';
  return (
    <span className="text-sm font-semibold" style={{ color }}>
      {positive ? '+' : '-'}{absStr} <span className="font-medium">({positive ? '+' : '-'}{Math.abs(pct).toFixed(2)}%)</span>
    </span>
  );
}

/** Horizontal split bar showing gainers (green) vs losers (red) proportions
 *  with counts above each segment. Used by the new Sectors table. */
function GainersLosersBar({ gainers, losers }) {
  const total = (gainers || 0) + (losers || 0);
  // If nothing trades, show a thin neutral bar so the row still aligns.
  const gPct = total ? (gainers / total) * 100 : 50;
  const lPct = total ? (losers / total) * 100 : 50;
  return (
    <div className="w-full max-w-[220px]">
      <div className="flex items-center justify-between text-sm font-semibold mb-1">
        <span className="text-[#16A34A]">{gainers || 0}</span>
        <span className="text-[#DC2626]">{losers || 0}</span>
      </div>
      <div className="flex h-[3px] rounded-full overflow-hidden bg-bg-hover">
        <div className="bg-[#16A34A]" style={{ width: `${gPct}%` }} />
        <div className="bg-[#DC2626]" style={{ width: `${lPct}%` }} />
      </div>
    </div>
  );
}

function SentimentTag({ value }) {
  const map = {
    Bullish: { color: '#16A34A', bg: 'rgba(22, 163, 74, 0.10)' },
    Bearish: { color: '#DC2626', bg: 'rgba(220, 38, 38, 0.10)' },
    Neutral: { color: '#4B5563', bg: 'rgba(75, 85, 99, 0.10)' },
  };
  const s = map[value] || map.Neutral;
  return (
    <span
      className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md"
      style={{ color: s.color, background: s.bg }}
    >
      {value}
    </span>
  );
}

// Inline SVG illustration — forex/crypto themed empty-state. Five
// candlesticks on a soft grid with an upward trend line cutting
// across, flanked by a Bitcoin coin (₿) and a US-dollar pill —
// signals the platform is for FX + crypto trading at a glance.
function InvestmentsIllustration() {
  return (
    <svg width="200" height="120" viewBox="0 0 200 120" fill="none" className="mx-auto">
      {/* Soft grid lines */}
      <line x1="10" y1="35" x2="190" y2="35" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="10" y1="60" x2="190" y2="60" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="10" y1="85" x2="190" y2="85" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />

      {/* Candle 1 — bullish (green) */}
      <line x1="55" y1="38" x2="55" y2="78" stroke="#00C853" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="50" y="55" width="10" height="20" rx="1.5" fill="#00C853" />

      {/* Candle 2 — bearish (red) */}
      <line x1="75" y1="42" x2="75" y2="86" stroke="#FF3B57" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="70" y="55" width="10" height="22" rx="1.5" fill="#FF3B57" />

      {/* Candle 3 — bullish (green) — strong */}
      <line x1="95" y1="28" x2="95" y2="78" stroke="#00C853" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="90" y="38" width="10" height="32" rx="1.5" fill="#00C853" />

      {/* Candle 4 — bearish (red) — small */}
      <line x1="115" y1="32" x2="115" y2="62" stroke="#FF3B57" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="110" y="40" width="10" height="14" rx="1.5" fill="#FF3B57" />

      {/* Candle 5 — bullish (green) — strong breakout */}
      <line x1="135" y1="18" x2="135" y2="58" stroke="#00C853" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="130" y="22" width="10" height="28" rx="1.5" fill="#00C853" />

      {/* Trend line over the candles */}
      <path
        d="M50 70 L75 65 L95 50 L115 45 L135 28"
        stroke="#1D4ED8"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="135" cy="28" r="3" fill="#1D4ED8" />

      {/* Bitcoin coin — left */}
      <circle cx="20" cy="40" r="14" fill="#F7931A" />
      <text x="20" y="46" textAnchor="middle" fontSize="16" fontWeight="700" fill="#FFFFFF" fontFamily="Inter, sans-serif">₿</text>

      {/* USD pill — right */}
      <rect x="160" y="78" width="32" height="22" rx="11" fill="#1D4ED8" />
      <text x="176" y="93" textAnchor="middle" fontSize="11" fontWeight="700" fill="#FFFFFF" fontFamily="Inter, sans-serif">USD</text>

      {/* Baseline */}
      <line x1="10" y1="108" x2="190" y2="108" stroke="#E5E7EB" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SectionHeader({ title, caption, action }) {
  return (
    <div className="flex items-end justify-between mb-4">
      <div>
        <h2 className="text-lg font-bold text-text-primary">{title}</h2>
        {caption && <p className="text-xs text-text-secondary mt-1">{caption}</p>}
      </div>
      {action}
    </div>
  );
}

// Volume formatting — instruments expose `volume24h` as a string; format to
// a compact B/M/K. Returns "—" when missing so we never render NaN.
function fmtVolume(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtPrice(raw, precision) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(precision) || 2, 6));
}

// ─── Page ────────────────────────────────────────────────────────────────
export default function Explore() {
  const navigate = useNavigate();
  const { rows: instruments, loading } = useInstruments();

  const [moverTab, setMoverTab] = useState('Gainers');
  const [selectedSector, setSelectedSector] = useState(null);
  const [priceMap, setPriceMap] = useState({});

  // Subscribe to live tickers for every instrument. Same model the
  // InstrumentStrip uses — the WS multiplexes to one socket so this is
  // bounded by symbol count, not subscriber count.
  const symbolsKey = useMemo(
    () => instruments.map((r) => r.symbol).sort().join('|'),
    [instruments]
  );
  useEffect(() => {
    if (!symbolsKey) return;
    const symbols = symbolsKey.split('|').filter(Boolean);
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        const last = Number(data.lastPrice);
        if (!Number.isFinite(last) || last <= 0) return;
        setPriceMap((prev) => (prev[sym] === String(last) ? prev : { ...prev, [sym]: String(last) }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [symbolsKey]);

  // Instruments with live price applied (everything downstream reads from this).
  const lived = useMemo(
    () => instruments.map((r) => priceMap[r.symbol] ? { ...r, lastPrice: priceMap[r.symbol] } : r),
    [instruments, priceMap]
  );

  // ── Open positions — live ─────────────────────────────────────────────
  // Pulled from /trading/positions on mount and re-fetched whenever the
  // server emits a position-related WS event (open / close / modify).
  // Mark prices come from the `priceMap` already populated by the
  // ticker subscriptions above, so unrealised PnL ticks in real time
  // without any extra fan-out.
  const [positions, setPositions] = useState([]);
  const [pendingOrders, setPendingOrders] = useState([]);
  // Tab inside the "Your activity" card — flips between live positions
  // and pending limit / stop orders. Defaults to positions so the user
  // sees their actual P/L first.
  const [activityTab, setActivityTab] = useState('positions');
  // Bulk-action busy flag — disables Close All / Cancel All buttons
  // while the corresponding API call is in flight to prevent
  // double-fires from impatient clicks.
  const [bulkBusy, setBulkBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [posRes, ordRes] = await Promise.all([
          api.get('/trading/positions'),
          api.get('/trading/orders/open').catch(() => ({ data: { data: [] } })),
        ]);
        if (cancelled) return;
        setPositions(Array.isArray(posRes?.data?.data) ? posRes.data.data : []);
        setPendingOrders(Array.isArray(ordRes?.data?.data) ? ordRes.data.data : []);
      } catch (_) { /* keep prior; empty state will render */ }
    };
    load();
    const unsubP = wsClient.subscribe('positions', load);
    const unsubO = wsClient.subscribe('orders', load);
    return () => { cancelled = true; unsubP && unsubP(); unsubO && unsubO(); };
  }, []);
  const livePositions = useMemo(() => positions.map((p) => {
    const markPx = Number(priceMap[p.symbol] ?? p.markPrice ?? p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    if (!Number.isFinite(entry) || !Number.isFinite(qty) || !Number.isFinite(markPx)) {
      return { ...p, markPrice: markPx || 0, unrealizedPnl: 0 };
    }
    const livePnl = p.side === 'BUY' ? (markPx - entry) * qty : (entry - markPx) * qty;
    return { ...p, markPrice: markPx, unrealizedPnl: livePnl };
  }), [positions, priceMap]);

  // ── Position / order action handlers ──────────────────────────────
  // Matches the same endpoints used on the Trade page so behaviour is
  // identical (single-source backend, single permission check).
  const closePosition = async (id) => {
    try {
      await api.post(`/trading/positions/${id}/close`);
      toast.success('Position closing');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const closeAllPositions = async () => {
    if (!livePositions.length) return;
    if (!window.confirm(`Close all ${livePositions.length} open position(s)?`)) return;
    setBulkBusy(true);
    try {
      const accountId = livePositions[0]?.accountId;
      const { data } = await api.post('/trading/positions/close-all', accountId ? { accountId } : {});
      const r = data?.data || {};
      if (r.failed?.length) toast.error(`Closed ${r.closed}/${r.total}. ${r.failed.length} failed.`);
      else toast.success(`Closed ${r.closed ?? livePositions.length} position(s)`);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBulkBusy(false); }
  };
  const cancelOrder = async (id) => {
    try {
      await api.delete(`/trading/orders/${id}`);
      toast.success('Order cancelled');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const cancelAllOrders = async () => {
    if (!pendingOrders.length) return;
    if (!window.confirm(`Cancel all ${pendingOrders.length} pending order(s)?`)) return;
    setBulkBusy(true);
    // No bulk endpoint exists — fan out single deletes and tally.
    const results = await Promise.allSettled(
      pendingOrders.map((o) => api.delete(`/trading/orders/${o._id}`))
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (failed) toast.error(`Cancelled ${ok}/${results.length}. ${failed} failed.`);
    else toast.success(`Cancelled ${ok} order(s)`);
    setBulkBusy(false);
  };

  // ── Recently viewed — localStorage-tracked list of symbols the user has
  // visited via /trade. Resolved against the live catalog so we can render
  // each pill with its current price + change. ─────────────────────────
  const recentSymbols = useRecentlyViewed();
  const recentlyViewed = useMemo(
    () => recentSymbols.map((s) => lived.find((r) => r.symbol === s)).filter(Boolean),
    [recentSymbols, lived]
  );

  // ── Most traded — pick by volume24h when available, else by abs(change). ─
  const mostTraded = useMemo(() => {
    const ranked = [...lived].sort((a, b) => {
      const va = Number(a.volume24h) || 0;
      const vb = Number(b.volume24h) || 0;
      if (vb !== va) return vb - va;
      const ca = Math.abs(Number(a.change24h) || 0);
      const cb = Math.abs(Number(b.change24h) || 0);
      return cb - ca;
    });
    return ranked.slice(0, 5);
  }, [lived]);

  // ── Sectors with computed perf + top asset + gainers/losers counts ─────
  const sectors = useMemo(() => {
    return SECTOR_DEFS
      .map((s) => {
        const matches = lived.filter(s.match);
        if (!matches.length) return null;
        const changes = matches.map((r) => Number(r.change24h)).filter(Number.isFinite);
        const perf = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
        const gainers = matches.filter((r) => Number(r.change24h) > 0).length;
        const losers  = matches.filter((r) => Number(r.change24h) < 0).length;
        const top = [...matches].sort(
          (a, b) => (Number(b.change24h) || 0) - (Number(a.change24h) || 0)
        )[0];
        return {
          ...s,
          matches,
          perf,
          gainers,
          losers,
          top,
        };
      })
      .filter(Boolean)
      // Sort sectors by perf descending so the strongest movers are at top
      .sort((a, b) => b.perf - a.perf);
  }, [lived]);

  const toggleSector = (sector) =>
    setSelectedSector((curr) => (curr?.key === sector.key ? null : sector));

  // ── Movers — sort live data per tab, narrow by sector if selected ──────
  const movers = useMemo(() => {
    let pool = lived;
    if (selectedSector) {
      pool = pool.filter(selectedSector.match);
    }
    const sortFns = {
      Gainers:       (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
      Losers:        (a, b) => (Number(a.change24h) ||  Infinity) - (Number(b.change24h) ||  Infinity),
      'Most Active': (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
      Trending:      (a, b) => Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0),
    };
    return [...pool].sort(sortFns[moverTab] || sortFns.Gainers).slice(0, 8);
  }, [lived, moverTab, selectedSector]);

  const openTrade = (sym) => navigate(`/trade?symbol=${encodeURIComponent(sym)}`);

  return (
    <div className="space-y-8">
      {/* Dynamic instrument strip now lives in the global Layout
          header — removed from here to avoid a duplicate rail. */}

      {/* ── Main 2-column layout — feed on the left, sidebar on the right ─ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-8 space-y-8 min-w-0">

      {/* ── Recently viewed — only shown after the user has clicked into
          at least one symbol on /trade. Symbols are tracked in localStorage. */}
      {recentlyViewed.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3">Recently viewed</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {recentlyViewed.map((r) => {
              const ch = Number(r.change24h);
              const positive = Number.isFinite(ch) ? ch >= 0 : true;
              return (
                <button
                  key={r.symbol}
                  type="button"
                  onClick={() => openTrade(r.symbol)}
                  className="group flex flex-col items-center text-center"
                >
                  <AssetGlyph sym={r.symbol} row={r} size={36} />
                  <span className="mt-2 text-sm font-semibold text-text-primary group-hover:text-primary-600 transition-colors">
                    {r.symbol}
                  </span>
                  {Number.isFinite(ch) && (
                    <span
                      className="mt-0.5 text-xs font-semibold"
                      style={{ color: positive ? '#16A34A' : '#DC2626' }}
                    >
                      {positive ? '+' : ''}{ch.toFixed(2)}%
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Section 1 — Most traded ───────────────────────────────────── */}
      <section>
        <SectionHeader
          title="Most traded"
          caption="Top liquidity across all markets today"
          action={
            <Link to="/markets?view=most-traded" className="inline-flex items-center gap-1 text-xs font-semibold text-primary-500 hover:text-primary-600 transition-colors">
              View all {I.chevron}
            </Link>
          }
        />
        {loading && <SkeletonCards count={5} />}
        {!loading && mostTraded.length === 0 && (
          <EmptyState message="No instruments available yet." />
        )}
        {!loading && mostTraded.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-4">
              {mostTraded.slice(0, 4).map((a) => {
                const change = Number(a.change24h);
                const price = Number(a.lastPrice);
                const absChange = Number.isFinite(change) && Number.isFinite(price)
                  ? (price * change) / 100
                  : NaN;
                return (
                  <button
                    key={a.symbol}
                    type="button"
                    onClick={() => openTrade(a.symbol)}
                    className="group relative text-left bg-white border border-border-dark rounded-[20px] p-5 hover:shadow-card hover:border-primary-500/30 hover:-translate-y-0.5 transition-all"
                  >
                    <WatchlistButton symbol={a.symbol} row={a} className="absolute top-3 right-3" />
                    <AssetGlyph sym={a.symbol} row={a} size={44} />
                    <div className="mt-4 text-sm font-medium text-text-primary truncate">
                      {a.name || a.symbol}
                    </div>
                    <div className="mt-5 text-xl font-bold text-text-primary font-mono">
                      {fmtPrice(a.lastPrice, a.pricePrecision)}
                    </div>
                    <div className="mt-1.5">
                      <ChangeText absChange={absChange} pct={change} precision={a.pricePrecision} />
                    </div>
                  </button>
                );
              })}
            </div>
            <Link
              to="/markets?view=most-traded"
              className="inline-flex items-center gap-1 mt-4 text-sm font-semibold text-primary-500 hover:text-primary-600 transition-colors"
            >
              See more {I.chevron}
            </Link>
          </>
        )}
      </section>

      {/* ── Section 2 — Market movers ─────────────────────────────────── */}
      <section id="movers">
        <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-bold text-text-primary">Market movers</h2>
            <p className="text-xs text-text-secondary mt-1">Top names by performance over the last 24h.</p>
            {selectedSector && (
              <div className="mt-2 inline-flex items-center gap-2 text-xs font-medium px-2.5 py-1 rounded-full bg-primary-500/10 text-primary-600">
                Filtered: {selectedSector.label}
                <button
                  type="button"
                  onClick={() => setSelectedSector(null)}
                  aria-label="Clear sector filter"
                  className="text-primary-600 hover:text-primary-700"
                >
                  {I.close}
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {['Gainers', 'Losers', 'Most Active', 'Trending'].map((t) => (
              <button
                key={t}
                onClick={() => setMoverTab(t)}
                className={`text-sm px-5 py-2 rounded-full border transition-all ${
                  moverTab === t
                    ? 'border-text-primary text-text-primary font-semibold bg-white'
                    : 'border-border-dark text-text-secondary hover:text-text-primary hover:border-text-primary/40'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-text-muted bg-bg-card">
                <th className="text-left font-medium px-5 py-3">Asset</th>
                <th className="text-left font-medium px-5 py-3 hidden md:table-cell">Trend</th>
                <th className="text-right font-medium px-5 py-3">Price</th>
                <th className="text-right font-medium px-5 py-3">24h %</th>
                <th className="text-right font-medium px-5 py-3 hidden sm:table-cell">Volume</th>
                <th className="px-3 py-3 w-px"><span className="sr-only">Watchlist</span></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-text-muted">Loading market data…</td>
                </tr>
              )}
              {!loading && movers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-text-muted">
                    No assets match this filter.
                  </td>
                </tr>
              )}
              {!loading && movers.map((m, idx) => {
                const change = Number(m.change24h);
                return (
                  <tr
                    key={m.symbol}
                    onClick={() => openTrade(m.symbol)}
                    className={`group border-t border-border-subtle hover:bg-bg-hover transition-colors cursor-pointer ${idx === 0 ? 'border-t-0' : ''}`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <AssetGlyph sym={m.symbol} row={m} size={34} />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-text-primary leading-none">{m.symbol}</div>
                          <div className="text-[11px] text-text-muted mt-1 leading-none truncate">{m.name || ''}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 hidden md:table-cell">
                      <Sparkline points={synthSpark(change, idx)} positive={Number.isFinite(change) ? change >= 0 : true} width={90} height={28} />
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-sm text-text-primary">
                      {fmtPrice(m.lastPrice, m.pricePrecision)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <ChangePill value={change} />
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-xs text-text-secondary hidden sm:table-cell">
                      {fmtVolume(m.volume24h)}
                    </td>
                    <td className="px-3 py-3.5 text-right align-middle">
                      <WatchlistButton symbol={m.symbol} row={m} variant="ghost" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Section 2b — Sectors trending today (after Movers per request) ─ */}
      <section id="sectors">
        <h2 className="text-xl font-bold text-text-primary mb-4">Sectors trending today</h2>

        {loading && (
          <div className="bg-white border border-border-dark rounded-2xl p-6 animate-pulse">
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 bg-bg-hover rounded" />
              ))}
            </div>
          </div>
        )}

        {!loading && sectors.length === 0 && <EmptyState message="No sector data yet." />}

        {!loading && sectors.length > 0 && (
          <>
            <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
              {/* Column header */}
              <div className="grid grid-cols-12 gap-4 px-6 py-3 text-xs text-text-muted bg-bg-card border-b border-border-subtle">
                <div className="col-span-5 sm:col-span-4">Sector</div>
                <div className="col-span-4 sm:col-span-5 text-left">Gainers/Losers</div>
                <div className="col-span-3 text-right">1D price change</div>
              </div>

              {/* Rows */}
              {sectors.map((s) => {
                const active = selectedSector?.key === s.key;
                const positive = s.perf >= 0;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => {
                      toggleSector(s);
                      setTimeout(() => {
                        document.getElementById('movers')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 60);
                    }}
                    className={`w-full grid grid-cols-12 gap-4 items-center px-6 py-4 text-left border-b border-border-subtle last:border-b-0 transition-colors ${
                      active ? 'bg-primary-500/5' : 'hover:bg-bg-hover'
                    }`}
                  >
                    <div className="col-span-5 sm:col-span-4 flex items-center gap-3 min-w-0">
                      <span
                        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                        style={{ background: `${s.tint}15`, color: s.tint }}
                      >
                        {s.icon}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-text-primary truncate">{s.label}</div>
                        <div className="text-[11px] text-text-muted truncate hidden sm:block">
                          Top: {s.top?.symbol || '—'}
                        </div>
                      </div>
                    </div>

                    <div className="col-span-4 sm:col-span-5">
                      <GainersLosersBar gainers={s.gainers} losers={s.losers} />
                    </div>

                    <div className="col-span-3 text-right">
                      <span
                        className="text-sm font-semibold font-mono"
                        style={{ color: positive ? '#16A34A' : '#DC2626' }}
                      >
                        {positive ? '+' : ''}{s.perf.toFixed(2)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <Link
              to="/markets?view=sectors"
              className="inline-flex items-center gap-1 mt-4 text-sm font-semibold text-primary-500 hover:text-primary-600 transition-colors"
            >
              See all sectors {I.chevron}
            </Link>
          </>
        )}
      </section>

      </div>{/* end left column */}

      {/* ── Right sidebar — Your investments + Products & Tools ───────── */}
      <aside className="lg:col-span-4 space-y-4">
        {/* Your activity — tabbed card with Positions + Pending Orders.
            Tabs swap content inline with a soft cross-fade; empty
            states stay visually centred so the card never looks lopsided. */}
        <div>
          <div className="bg-white border border-border-dark rounded-[20px] shadow-sm overflow-hidden">
            {/* ── Tab bar ─────────────────────────────────────────── */}
            <div className="flex items-center gap-1 px-3 pt-3 pb-2 border-b border-border-subtle">
              {[
                { id: 'positions', label: 'Positions',      count: livePositions.length },
                { id: 'orders',    label: 'Pending Orders', count: pendingOrders.length },
              ].map((t) => {
                const active = activityTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActivityTab(t.id)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${
                      active
                        ? 'bg-primary-500/10 text-primary-600 shadow-sm'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                    }`}
                    aria-pressed={active}
                  >
                    <span>{t.label}</span>
                    {t.count > 0 && (
                      <span
                        className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold inline-flex items-center justify-center transition-colors ${
                          active ? 'bg-primary-500 text-white' : 'bg-bg-hover text-text-muted'
                        }`}
                      >
                        {t.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* ── Tab body with soft cross-fade ───────────────────── */}
            <div className="relative">
              {/* POSITIONS */}
              <div
                key="positions-pane"
                className={`transition-all duration-300 ease-out ${
                  activityTab === 'positions' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none absolute inset-0'
                }`}
              >
                {livePositions.length === 0 ? (
                  <div className="p-6 flex flex-col items-center text-center">
                    <InvestmentsIllustration />
                    <p className="mt-4 text-sm text-text-secondary">No open trades yet</p>
                    <p className="mt-1 text-xs text-text-muted">Fund your account and place your first FX or crypto trade.</p>
                    <div className="mt-4 flex items-center gap-2">
                      <Link
                        to="/wallet"
                        className="inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                      >
                        Add funds {I.arrow}
                      </Link>
                      <Link
                        to="/trade"
                        className="inline-flex items-center gap-2 border border-border-dark hover:border-primary-500/50 hover:bg-primary-500/5 text-text-primary text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                      >
                        Start trading
                      </Link>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="divide-y divide-border-subtle">
                      {livePositions.slice(0, 5).map((p) => {
                        const inst = instruments.find((i) => i.symbol === p.symbol);
                        const prec = Math.min(inst?.pricePrecision || 2, 5);
                        const pnl = Number(p.unrealizedPnl || 0);
                        const pnlPositive = pnl >= 0;
                        const sideBull = p.side === 'BUY';
                        return (
                          <div
                            key={p._id || `${p.symbol}-${p.entryPrice}`}
                            className="group flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors"
                          >
                            <Link
                              to={`/trade?symbol=${encodeURIComponent(p.symbol)}`}
                              className="flex items-center gap-3 min-w-0 flex-1"
                            >
                              <AssetIcon row={inst || { symbol: p.symbol, category: p.category }} size={28} round />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold text-text-primary truncate">{p.symbol}</span>
                                  <span
                                    className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                                    style={{
                                      background: sideBull ? 'rgba(0,200,83,0.12)' : 'rgba(255,59,87,0.12)',
                                      color: sideBull ? '#16A34A' : '#DC2626',
                                    }}
                                  >
                                    {sideBull ? 'Long' : 'Short'}
                                  </span>
                                </div>
                                <div className="text-[11px] text-text-muted font-mono mt-0.5 tabular-nums">
                                  {Number(p.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 })} @ {fmtNum(p.entryPrice, prec)}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div
                                  className="text-sm font-bold font-mono tabular-nums"
                                  style={{ color: pnlPositive ? '#16A34A' : '#DC2626' }}
                                >
                                  {pnlPositive ? '+' : ''}{pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </div>
                                <div className="text-[10px] text-text-muted font-mono mt-0.5 tabular-nums">
                                  {fmtNum(p.markPrice || p.entryPrice, prec)}
                                </div>
                              </div>
                            </Link>
                            <button
                              type="button"
                              onClick={() => closePosition(p._id)}
                              title="Close position"
                              className="opacity-0 group-hover:opacity-100 sm:opacity-100 text-[11px] font-bold px-2.5 py-1.5 rounded-md bg-bear/10 text-bear border border-bear/25 hover:bg-bear/20 hover:scale-[1.03] active:scale-95 transition-all shrink-0"
                            >
                              Close
                            </button>
                          </div>
                        );
                      })}
                      {livePositions.length > 5 && (
                        <Link
                          to="/trade"
                          className="block px-4 py-2.5 text-center text-[12px] font-semibold text-primary-600 hover:bg-bg-hover transition-colors"
                        >
                          View all {livePositions.length} positions →
                        </Link>
                      )}
                    </div>
                    <div className="px-4 py-3 border-t border-border-subtle bg-bg-hover/30 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={closeAllPositions}
                        disabled={bulkBusy}
                        className="inline-flex items-center gap-1.5 text-[12px] font-bold px-3 py-1.5 rounded-lg bg-bear/10 text-bear border border-bear/30 hover:bg-bear/20 hover:shadow-sm hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {bulkBusy ? 'Closing…' : `Close All (${livePositions.length})`}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* PENDING ORDERS */}
              <div
                key="orders-pane"
                className={`transition-all duration-300 ease-out ${
                  activityTab === 'orders' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none absolute inset-0'
                }`}
              >
                {pendingOrders.length === 0 ? (
                  <div className="p-6 flex flex-col items-center text-center">
                    <InvestmentsIllustration />
                    <p className="mt-4 text-sm text-text-secondary">No pending orders yet</p>
                    <p className="mt-1 text-xs text-text-muted">Limit and stop orders waiting to be filled will appear here.</p>
                    <div className="mt-4 flex items-center gap-2">
                      <Link
                        to="/trade"
                        className="inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                      >
                        Place an order {I.arrow}
                      </Link>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="divide-y divide-border-subtle">
                      {pendingOrders.slice(0, 5).map((o) => {
                        const inst = instruments.find((i) => i.symbol === o.symbol);
                        const prec = Math.min(inst?.pricePrecision || 2, 5);
                        const sideBull = o.side === 'BUY';
                        const trigger = Number(o.limitPrice ?? o.stopPrice ?? o.price ?? 0);
                        return (
                          <div
                            key={o._id || `${o.symbol}-${o.createdAt}`}
                            className="group flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors"
                          >
                            <Link
                              to={`/trade?symbol=${encodeURIComponent(o.symbol)}`}
                              className="flex items-center gap-3 min-w-0 flex-1"
                            >
                              <AssetIcon row={inst || { symbol: o.symbol, category: o.category }} size={28} round />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold text-text-primary truncate">{o.symbol}</span>
                                  <span
                                    className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                                    style={{
                                      background: sideBull ? 'rgba(0,200,83,0.12)' : 'rgba(255,59,87,0.12)',
                                      color: sideBull ? '#16A34A' : '#DC2626',
                                    }}
                                  >
                                    {sideBull ? 'Buy' : 'Sell'}
                                  </span>
                                  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                                    {o.orderType || 'LIMIT'}
                                  </span>
                                </div>
                                <div className="text-[11px] text-text-muted font-mono mt-0.5 tabular-nums">
                                  {Number(o.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 })} @ {fmtNum(trigger, prec)}
                                </div>
                              </div>
                              <div className="text-right shrink-0">
                                <div className="text-sm font-bold font-mono tabular-nums text-text-primary">
                                  {fmtNum(priceMap[o.symbol] ?? inst?.lastPrice ?? trigger, prec)}
                                </div>
                                <div className="text-[10px] text-text-muted font-mono mt-0.5">Mark</div>
                              </div>
                            </Link>
                            <button
                              type="button"
                              onClick={() => cancelOrder(o._id)}
                              title="Cancel order"
                              className="opacity-0 group-hover:opacity-100 sm:opacity-100 text-[11px] font-bold px-2.5 py-1.5 rounded-md bg-bear/10 text-bear border border-bear/25 hover:bg-bear/20 hover:scale-[1.03] active:scale-95 transition-all shrink-0"
                            >
                              Cancel
                            </button>
                          </div>
                        );
                      })}
                      {pendingOrders.length > 5 && (
                        <Link
                          to="/trade"
                          className="block px-4 py-2.5 text-center text-[12px] font-semibold text-primary-600 hover:bg-bg-hover transition-colors"
                        >
                          View all {pendingOrders.length} orders →
                        </Link>
                      )}
                    </div>
                    <div className="px-4 py-3 border-t border-border-subtle bg-bg-hover/30 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={cancelAllOrders}
                        disabled={bulkBusy}
                        className="inline-flex items-center gap-1.5 text-[12px] font-bold px-3 py-1.5 rounded-lg bg-bear/10 text-bear border border-bear/30 hover:bg-bear/20 hover:shadow-sm hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {bulkBusy ? 'Cancelling…' : `Cancel All (${pendingOrders.length})`}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Products & Tools — compact list */}
        <div>
          <h3 className="text-base font-bold text-text-primary mb-3">Products &amp; Tools</h3>
          <div className="bg-white border border-border-dark rounded-[20px] p-3">
            <ul className="divide-y divide-border-subtle">
              {PRODUCTS.map((p) => (
                <li key={p.to + p.label}>
                  <Link
                    to={p.to}
                    className="group flex items-center gap-3 px-2 py-3 rounded-lg hover:bg-bg-hover transition-colors"
                  >
                    <span
                      className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: `${p.tint}15`, color: p.tint }}
                    >
                      {p.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-text-primary truncate">
                        {p.label}
                      </span>
                      <span className="block text-[11px] text-text-muted truncate">
                        {p.caption}
                      </span>
                    </span>
                    <span className="text-text-muted group-hover:text-text-primary transition-colors shrink-0">
                      {I.chevron}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
      </div>{/* end 2-column grid */}

      {/* ── Section 5 — Economic Calendar (real release schedule) ────── */}
      <EconomicCalendarSection max={8} />

      <div className="h-4" />
    </div>
  );
}

// ─── Loading + empty placeholders ─────────────────────────────────────────
function SkeletonCards({ count = 5, mini = false }) {
  return (
    <div className={`grid gap-4 ${mini ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-white border border-border-dark rounded-[20px] p-5 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-bg-hover" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-20 bg-bg-hover rounded" />
              <div className="h-2 w-28 bg-bg-hover rounded" />
            </div>
          </div>
          <div className="mt-4 h-9 bg-bg-hover rounded" />
          <div className="mt-3 h-3 w-3/4 bg-bg-hover rounded" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ message }) {
  return (
    <div className="bg-white border border-border-dark rounded-[20px] p-10 text-center text-sm text-text-muted">
      {message}
    </div>
  );
}
