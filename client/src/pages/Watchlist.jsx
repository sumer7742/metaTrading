import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import AssetIcon from '../components/AssetIcon';
import { useInstruments } from '../hooks/useInstruments';
import { useFavorites } from '../hooks/useFavorites';
import { useRecentlyViewed } from '../hooks/useRecentlyViewed';
import { wsClient } from '../services/ws';
import { fmtNum } from '../utils/format';
import { api } from '../services/api';

// ─── Helpers ─────────────────────────────────────────────────────────

// Tiny inline SVG sparkline driven by 24h direction. Same visual style
// as the rest of the platform so the watchlist page feels native.
function sparkPath(change24h) {
  const W = 84, H = 30, mid = H / 2;
  const positive = !Number.isFinite(change24h) || change24h >= 0;
  const tone = !Number.isFinite(change24h) ? '#9CA3AF' : positive ? '#16A34A' : '#DC2626';
  const start = mid + (positive ? 6 : -6);
  const end = mid + (positive ? -6 : 6);
  const points = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = t * W;
    const noise = ((i % 2 === 0) ? 1 : -1) * (5 - i * 0.35);
    const y = start + (end - start) * t + noise * 0.6;
    points.push([x.toFixed(1), y.toFixed(1)]);
  }
  const d = points.map(([x, y], i) => (i === 0 ? `M${x} ${y}` : `L${x} ${y}`)).join(' ');
  return { d, tone, W, H };
}

const fmtPrice = (raw, prec) => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(prec) || 2, 6));
};

const CATEGORIES = [
  { id: 'all',       label: 'All' },
  { id: 'CRYPTO',    label: 'Crypto' },
  { id: 'FOREX',     label: 'Forex' },
  { id: 'STOCK',     label: 'Stocks' },
  { id: 'COMMODITY', label: 'Commodities' },
];

const SORT_OPTIONS = [
  { id: 'symbol',     label: 'Symbol (A→Z)' },
  { id: 'gain',       label: 'Top gainers' },
  { id: 'loss',       label: 'Top losers' },
  { id: 'price-desc', label: 'Price (high → low)' },
  { id: 'price-asc',  label: 'Price (low → high)' },
];

// ─── Illustration ────────────────────────────────────────────────────
function WatchlistIllustration() {
  return (
    <svg width="220" height="140" viewBox="0 0 220 140" fill="none" className="mx-auto">
      {/* Soft grid */}
      <line x1="10" y1="40" x2="210" y2="40" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="10" y1="70" x2="210" y2="70" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="10" y1="100" x2="210" y2="100" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />

      {/* Sparkline rising — blue */}
      <path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22" stroke="#3B82F6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22 L200 120 L20 120 Z" fill="url(#wishGrad)" opacity="0.18" />
      <defs>
        <linearGradient id="wishGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Star at the peak */}
      <circle cx="200" cy="22" r="13" fill="#FFFFFF" stroke="#3B82F6" strokeWidth="2" />
      <polygon points="200,14 202.2,19.7 208.5,20.1 203.5,24.1 205.2,30 200,26.6 194.8,30 196.5,24.1 191.5,20.1 197.8,19.7" fill="#3B82F6" />

      {/* Bottom baseline */}
      <line x1="10" y1="120" x2="210" y2="120" stroke="#E5E7EB" strokeWidth="2" strokeLinecap="round" />

      {/* Crypto + forex chips */}
      <circle cx="40" cy="118" r="11" fill="#F7931A" />
      <text x="40" y="123" textAnchor="middle" fontSize="13" fontWeight="700" fill="#FFFFFF" fontFamily="Inter, sans-serif">₿</text>
      <rect x="65" y="108" width="34" height="22" rx="11" fill="#3B82F6" />
      <text x="82" y="123" textAnchor="middle" fontSize="11" fontWeight="700" fill="#FFFFFF" fontFamily="Inter, sans-serif">EUR</text>
      <rect x="110" y="108" width="34" height="22" rx="11" fill="#10B981" />
      <text x="127" y="123" textAnchor="middle" fontSize="11" fontWeight="700" fill="#FFFFFF" fontFamily="Inter, sans-serif">USD</text>
    </svg>
  );
}

// ─── Asset card ──────────────────────────────────────────────────────
function WatchlistCard({ row, isFav, onToggleFav, alertsOn, onToggleAlerts }) {
  const change = Number(row.change24h);
  const positive = !Number.isFinite(change) ? null : change >= 0;
  const tone = positive == null ? '#9CA3AF' : positive ? '#16A34A' : '#DC2626';
  const toneBg = positive == null ? 'rgba(156,163,175,0.10)' : positive ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)';
  const isOpen = row.marketStatus !== 'CLOSED' && row.marketStatus !== 'HOLIDAY';
  const spark = sparkPath(change);
  return (
    <div className="group relative bg-white border border-border-dark rounded-2xl p-4 shadow-sm hover:shadow-card hover:-translate-y-0.5 hover:border-primary-500/40 transition-all duration-200">
      {/* Top row — icon + symbol + market status */}
      <div className="flex items-start gap-3">
        <AssetIcon row={row} size={40} round />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-text-primary truncate">{row.symbol}</span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${isOpen ? 'text-bull' : 'text-text-muted'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isOpen ? 'bg-bull animate-pulse' : 'bg-text-muted'}`} />
              {isOpen ? 'Open' : 'Closed'}
            </span>
          </div>
          <div className="text-[11px] text-text-muted truncate mt-0.5">{row.name || `${row.baseCurrency}/${row.quoteCurrency}`}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Price alert toggle */}
          <button
            type="button"
            onClick={onToggleAlerts}
            title={alertsOn ? 'Price alerts on' : 'Enable price alerts'}
            className={`p-1.5 rounded-lg transition-all ${alertsOn ? 'text-primary-500 bg-primary-500/10' : 'text-text-muted hover:text-primary-500 hover:bg-primary-500/5'}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill={alertsOn ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </button>
          {/* Favorite star */}
          <button
            type="button"
            onClick={onToggleFav}
            title={isFav ? 'Remove from watchlist' : 'Add to watchlist'}
            className={`p-1.5 rounded-lg transition-all ${isFav ? 'text-yellow-500 bg-yellow-500/10' : 'text-text-muted hover:text-yellow-500 hover:bg-yellow-500/5'}`}
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24"
              fill={isFav ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`transition-transform duration-200 ${isFav ? 'scale-110' : 'scale-100'}`}
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Price + change + sparkline */}
      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xl font-bold font-mono tabular-nums text-text-primary leading-tight">
            {fmtPrice(row.lastPrice, row.pricePrecision)}
          </div>
          <div
            className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded-md transition-colors"
            style={{ color: tone, background: toneBg }}
          >
            {positive == null ? '—' : (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  {positive ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
                </svg>
                {positive ? '+' : ''}{Number.isFinite(change) ? change.toFixed(2) : '0.00'}%
              </>
            )}
          </div>
        </div>
        <svg width={spark.W} height={spark.H} viewBox={`0 0 ${spark.W} ${spark.H}`} className="shrink-0">
          <path d={`${spark.d} L${spark.W} ${spark.H} L0 ${spark.H} Z`} fill={spark.tone} opacity="0.12" />
          <path d={spark.d} stroke={spark.tone} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {/* CTA row */}
      <div className="mt-4 flex items-center gap-2">
        <Link
          to={`/trade?symbol=${encodeURIComponent(row.symbol)}`}
          className="flex-1 inline-flex items-center justify-center gap-1.5 bg-primary-500 hover:bg-primary-600 hover:shadow-card active:scale-[0.98] text-white text-xs font-bold px-3 py-2 rounded-lg transition-all"
        >
          Quick Trade
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
          </svg>
        </Link>
        <Link
          to={`/trade?symbol=${encodeURIComponent(row.symbol)}`}
          className="inline-flex items-center justify-center px-3 py-2 rounded-lg border border-border-dark text-text-primary text-xs font-semibold hover:border-primary-500/50 hover:bg-primary-500/5 transition-colors"
          title="View details"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z" /></svg>
        </Link>
      </div>
    </div>
  );
}

// ─── Mini-row used in the right sidebar (top movers / recently viewed) ─
function MiniRow({ row }) {
  const change = Number(row.change24h);
  const positive = !Number.isFinite(change) ? null : change >= 0;
  const tone = positive == null ? '#9CA3AF' : positive ? '#16A34A' : '#DC2626';
  return (
    <Link
      to={`/trade?symbol=${encodeURIComponent(row.symbol)}`}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-hover transition-colors"
    >
      <AssetIcon row={row} size={26} round />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-text-primary truncate">{row.symbol}</div>
        <div className="text-[10px] text-text-muted font-mono tabular-nums">{fmtPrice(row.lastPrice, row.pricePrecision)}</div>
      </div>
      <div className="text-[11px] font-bold font-mono tabular-nums" style={{ color: tone }}>
        {positive == null ? '—' : `${positive ? '+' : ''}${change.toFixed(2)}%`}
      </div>
    </Link>
  );
}

// ─── Page ────────────────────────────────────────────────────────────
export default function Watchlist() {
  const { rows: instruments } = useInstruments();
  const { favs, toggle, count } = useFavorites();

  // Live price stream — subscribes to every instrument and updates the
  // priceMap so the per-card prices tick in real time without re-fetching.
  const [priceMap, setPriceMap] = useState({});
  useEffect(() => {
    if (!instruments.length) return;
    const unsubs = instruments.map((r) =>
      wsClient.subscribe(`ticker:${r.symbol}`, (msg) => {
        const px = Number(msg?.price ?? msg?.last);
        if (Number.isFinite(px)) setPriceMap((m) => (m[r.symbol] === px ? m : { ...m, [r.symbol]: px }));
      })
    );
    return () => { unsubs.forEach((u) => u && u()); };
  }, [instruments]);

  const lived = useMemo(
    () => instruments.map((r) => (priceMap[r.symbol] ? { ...r, lastPrice: priceMap[r.symbol] } : r)),
    [instruments, priceMap]
  );

  // ── UI state ───────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('all');
  const [sort, setSort] = useState('symbol');
  const [filterOpen, setFilterOpen] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);
  const [gainersOnly, setGainersOnly] = useState(false);
  const [alertsSet, setAlertsSet] = useState(() => new Set());

  // ── Price alerts — persisted server-side via /reports/alerts so they
  //    survive across sessions. Best-effort: if the endpoint is missing
  //    we silently fall back to a local-only toggle.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/reports/alerts').catch(() => ({ data: { data: [] } }));
        const symbols = new Set();
        for (const a of (data?.data || [])) {
          if (a?.symbol && (a.status === 'ACTIVE' || a.enabled !== false)) symbols.add(a.symbol);
        }
        setAlertsSet(symbols);
      } catch (_) { /* fall back to local-only */ }
    })();
  }, []);

  const toggleAlertFor = (symbol) => {
    setAlertsSet((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
    // Best-effort persistence — server-side schema may vary.
    if (alertsSet.has(symbol)) {
      api.delete(`/reports/alerts/by-symbol/${encodeURIComponent(symbol)}`).catch(() => {});
    } else {
      api.post('/reports/alerts', { symbol, type: 'PRICE_CROSS', enabled: true }).catch(() => {});
    }
  };

  // ── Derived rows ───────────────────────────────────────────────────
  const wishRows = useMemo(() => lived.filter((r) => favs.has(r.symbol)), [lived, favs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = wishRows;
    if (tab !== 'all') rows = rows.filter((r) => (r.category || '').toUpperCase() === tab);
    if (openOnly) rows = rows.filter((r) => r.marketStatus !== 'CLOSED' && r.marketStatus !== 'HOLIDAY');
    if (gainersOnly) rows = rows.filter((r) => Number(r.change24h) > 0);
    if (q) {
      rows = rows.filter((r) =>
        (r.symbol || '').toLowerCase().includes(q) ||
        (r.name || '').toLowerCase().includes(q)
      );
    }
    const ranked = [...rows];
    if (sort === 'symbol') ranked.sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
    else if (sort === 'gain') ranked.sort((a, b) => Number(b.change24h || 0) - Number(a.change24h || 0));
    else if (sort === 'loss') ranked.sort((a, b) => Number(a.change24h || 0) - Number(b.change24h || 0));
    else if (sort === 'price-desc') ranked.sort((a, b) => Number(b.lastPrice || 0) - Number(a.lastPrice || 0));
    else if (sort === 'price-asc') ranked.sort((a, b) => Number(a.lastPrice || 0) - Number(b.lastPrice || 0));
    return ranked;
  }, [wishRows, tab, openOnly, gainersOnly, search, sort]);

  // ── Counts per category (for tab chip badge) ──────────────────────
  const tabCounts = useMemo(() => {
    const c = { all: wishRows.length, CRYPTO: 0, FOREX: 0, STOCK: 0, COMMODITY: 0 };
    for (const r of wishRows) {
      const k = (r.category || '').toUpperCase();
      if (c[k] != null) c[k]++;
    }
    return c;
  }, [wishRows]);

  // ── Sidebar feeds ─────────────────────────────────────────────────
  const topMovers = useMemo(() => {
    return [...lived]
      .filter((r) => Number.isFinite(Number(r.change24h)))
      .sort((a, b) => Math.abs(Number(b.change24h)) - Math.abs(Number(a.change24h)))
      .slice(0, 6);
  }, [lived]);

  const recentSymbols = useRecentlyViewed();
  const recentRows = useMemo(
    () => recentSymbols.map((s) => lived.find((r) => r.symbol === s)).filter(Boolean).slice(0, 6),
    [recentSymbols, lived]
  );

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-6">

      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Watchlist</h1>
              {count > 0 && (
                <span className="inline-flex items-center justify-center min-w-[28px] h-[24px] px-2 rounded-full text-xs font-bold bg-primary-500/10 text-primary-600">
                  {count}
                </span>
              )}
            </div>
            <p className="text-sm text-text-secondary mt-1">Track your favorite assets and market opportunities</p>
          </div>
          {/* Live market pulse */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-border-dark text-[11px] font-semibold text-text-secondary shrink-0">
            <span className="relative flex w-2 h-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-bull opacity-60 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-bull" />
            </span>
            Live market pulse
          </div>
        </div>

        {/* Search + filter + sort */}
        <div className="flex items-stretch gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assets, symbols, names…"
              className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none transition-colors"
            />
          </div>
          <button
            type="button"
            onClick={() => setFilterOpen((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border text-sm font-semibold transition-all ${filterOpen ? 'border-primary-500 bg-primary-500/5 text-primary-600' : 'border-border-dark text-text-primary hover:border-primary-500/50 hover:bg-primary-500/5'}`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
            Filter
            {(gainersOnly || openOnly) && <span className="w-1.5 h-1.5 rounded-full bg-primary-500" />}
          </button>
          <div className="relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="appearance-none pl-3.5 pr-9 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary hover:border-primary-500/50 focus:border-primary-500 focus:outline-none cursor-pointer transition-colors"
            >
              {SORT_OPTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </div>

        {/* Filter chips drawer — opens under the controls */}
        <div className={`overflow-hidden transition-all duration-300 ease-out ${filterOpen ? 'max-h-32 opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="flex items-center gap-2 flex-wrap p-3 rounded-xl bg-bg-hover border border-border-dark">
            <span className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Quick filters</span>
            <button
              type="button"
              onClick={() => setOpenOnly((v) => !v)}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-all ${openOnly ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark bg-white text-text-primary hover:border-primary-500/40'}`}
            >
              Markets open
            </button>
            <button
              type="button"
              onClick={() => setGainersOnly((v) => !v)}
              className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-all ${gainersOnly ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark bg-white text-text-primary hover:border-primary-500/40'}`}
            >
              Gainers only
            </button>
            <button
              type="button"
              onClick={() => { setOpenOnly(false); setGainersOnly(false); setSearch(''); }}
              className="ml-auto text-[11px] font-semibold text-text-secondary hover:text-primary-600 transition-colors"
            >
              Clear all
            </button>
          </div>
        </div>

        {/* ── Tabs ────────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 p-1 bg-white border border-border-dark rounded-xl overflow-x-auto">
          {CATEGORIES.map((c) => {
            const active = tab === c.id;
            const cnt = tabCounts[c.id] ?? 0;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setTab(c.id)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all duration-200 ${active ? 'bg-primary-500 text-white shadow-sm' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
                aria-pressed={active}
              >
                <span>{c.label}</span>
                {cnt > 0 && (
                  <span className={`min-w-[20px] h-[18px] px-1.5 rounded-full text-[10px] font-bold inline-flex items-center justify-center transition-colors ${active ? 'bg-white/25 text-white keep-white' : 'bg-bg-hover text-text-muted'}`}>
                    {cnt}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      {/* ── Grid: cards (left) + sidebar (right) ─────────────────── */}
      <div className="grid grid-cols-12 gap-5">

        {/* ── Left: card grid / empty state ─────────────────────── */}
        <main className="col-span-12 lg:col-span-8">
          {wishRows.length === 0 ? (
            /* Premium empty state */
            <div className="bg-white border border-border-dark rounded-2xl p-10 flex flex-col items-center text-center shadow-sm">
              <WatchlistIllustration />
              <h3 className="mt-4 text-lg font-bold text-text-primary">No assets in your watchlist yet</h3>
              <p className="mt-1 text-sm text-text-secondary max-w-md">Add your favorite trading pairs to track market movements, set alerts, and trade with one click.</p>
              <div className="mt-5 flex items-center gap-2 flex-wrap justify-center">
                <Link to="/explore" className="inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 hover:shadow-card active:scale-[0.98] text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-all">
                  Explore Markets
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
                </Link>
                <Link to="/trade" className="inline-flex items-center gap-2 border border-border-dark hover:border-primary-500/50 hover:bg-primary-500/5 text-text-primary text-sm font-bold px-4 py-2.5 rounded-xl transition-colors">
                  Start Trading
                </Link>
              </div>
            </div>
          ) : filtered.length === 0 ? (
            /* Filtered-empty (watchlist has items but tab/filter/search excludes everything) */
            <div className="bg-white border border-border-dark rounded-2xl p-10 flex flex-col items-center text-center shadow-sm">
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <h3 className="mt-3 text-base font-bold text-text-primary">No matching assets</h3>
              <p className="mt-1 text-xs text-text-muted">Try a different tab, clear filters, or change your search.</p>
              <button onClick={() => { setTab('all'); setSearch(''); setOpenOnly(false); setGainersOnly(false); }} className="mt-4 text-xs font-semibold text-primary-600 hover:underline">Clear all filters</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-2 gap-4">
              {filtered.map((row) => (
                <WatchlistCard
                  key={row.symbol}
                  row={row}
                  isFav={favs.has(row.symbol)}
                  onToggleFav={() => toggle(row.symbol)}
                  alertsOn={alertsSet.has(row.symbol)}
                  onToggleAlerts={() => toggleAlertFor(row.symbol)}
                />
              ))}
            </div>
          )}
        </main>

        {/* ── Right sidebar: pinned + top movers + recently viewed ── */}
        <aside className="col-span-12 lg:col-span-4 space-y-4">
          {/* Pinned (favs limited to 3) */}
          {wishRows.length > 0 && (
            <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <span className="text-sm font-bold text-text-primary inline-flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#3B82F6" stroke="#3B82F6" strokeWidth="1.5"><path d="M12 17v5" /><path d="M9 10.76V5h6v5.76l3 2.24v3H6v-3z" /></svg>
                  Pinned
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{wishRows.length}</span>
              </div>
              <div className="p-2">
                {wishRows.slice(0, 3).map((row) => <MiniRow key={row.symbol} row={row} />)}
              </div>
            </div>
          )}

          {/* Top movers */}
          <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <span className="text-sm font-bold text-text-primary inline-flex items-center gap-1.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
                Top Movers
              </span>
              <Link to="/markets" className="text-[11px] font-semibold text-primary-600 hover:underline">View all</Link>
            </div>
            <div className="p-2">
              {topMovers.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-text-muted">Loading market data…</div>
              ) : topMovers.map((row) => <MiniRow key={row.symbol} row={row} />)}
            </div>
          </div>

          {/* Recently viewed */}
          {recentRows.length > 0 && (
            <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <span className="text-sm font-bold text-text-primary inline-flex items-center gap-1.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                  Recently Viewed
                </span>
              </div>
              <div className="p-2">
                {recentRows.map((row) => <MiniRow key={row.symbol} row={row} />)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
