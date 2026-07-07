import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInstruments } from '../hooks/useInstruments';
import { useRecommendedMarkets } from '../hooks/useRecommendedMarkets';
import { api } from '../services/api';
import AssetIcon from './AssetIcon';
import WatchlistButton from './WatchlistButton';

/**
 * SearchModal — Groww-style search sheet. Opens from the header search bar
 * and houses BOTH the search input AND the category filter (which used to
 * live inline on the InstrumentStrip). Clicking a result navigates to
 * /trade?symbol=… exactly like the strip's pills do, so the symbol resolves
 * through the existing Trade page.
 */

// Indian instruments carry an exchange; global CFDs don't. Used to split the
// Stocks / Indices tabs into Indian vs Global.
const INDIAN_EXCHANGES = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'NCDEX']);
const isIndian = (r) => INDIAN_EXCHANGES.has(String(r.exchange || '').toUpperCase());

// An instrument's effective filter key — STOCK / INDEX get a region suffix so
// Indian and global markets live under separate tabs.
const catKeyOf = (r) => {
  const c = (r.category || '').toUpperCase();
  if (c === 'STOCK') return isIndian(r) ? 'STOCK_IN' : 'STOCK_GL';
  if (c === 'INDEX') return isIndian(r) ? 'INDEX_IN' : 'INDEX_GL';
  return c;
};

const CATEGORIES = [
  { key: 'ALL',       label: 'All' },
  { key: 'FOREX',     label: 'Forex' },
  { key: 'CRYPTO',    label: 'Crypto' },
  { key: 'COMMODITY', label: 'Commodities' },
  { key: 'INDEX_IN',  label: 'Indian Indices' },
  { key: 'INDEX_GL',  label: 'Global Indices' },
  { key: 'STOCK_IN',  label: 'Indian Stocks' },
  { key: 'STOCK_GL',  label: 'Global Stocks' },
];

const SearchIcon = (props) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M21 21l-4.35-4.35" />
    <circle cx="11" cy="11" r="8" />
  </svg>
);

export default function SearchModal({ open, onClose }) {
  const navigate = useNavigate();
  const { rows, loading } = useInstruments();
  const { symbols: recommended } = useRecommendedMarkets();
  const [category, setCategory] = useState('ALL');
  // Recommended defaults to the admin order; this toggle alphabetises it client-
  // side (other tabs are always alphabetical).
  const [recSortAlpha, setRecSortAlpha] = useState(false);
  const [query, setQuery] = useState('');
  // Options are excluded from the cached catalog, so surface them on demand via
  // the server search — but only for option-like queries (a strike number or
  // CE/PE), so a normal search isn't flooded with contracts.
  const [optionResults, setOptionResults] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    const q = query.trim();
    const optionLike = /\d{3,}/.test(q) || /(^|[^a-z])(ce|pe)([^a-z]|$)/i.test(q);
    if (!q || !optionLike) { setOptionResults([]); return undefined; }
    const id = setTimeout(() => {
      api.get(`/instruments/search?q=${encodeURIComponent(q)}`)
        .then((res) => setOptionResults((res.data?.data || []).filter((r) => r.segment === 'OPT')))
        .catch(() => setOptionResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  // Reset state every time the modal opens, and focus the input. Default to the
  // "Recommended" tab when the admin has configured one, else "All".
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCategory(recommended.length ? 'RECOMMENDED' : 'ALL');
    // Slight delay so the input is mounted + paint-stable before focus.
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc to close, and Cmd/Ctrl+K passthrough at the global level is handled
  // by the parent; here we only react to Escape inside the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    // Lock background scroll while the sheet is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    // "Recommended" = admin-curated set, kept in the admin's configured order
    // (never re-sorted). Every other tab is sorted alphabetically by name.
    const byName = (a, b) => (a.name || a.symbol).localeCompare(b.name || b.symbol, undefined, { sensitivity: 'base' });
    let base;
    if (category === 'RECOMMENDED') {
      const bySym = new Map(rows.map((r) => [r.symbol, r]));
      base = recommended.map((s) => bySym.get(s)).filter(Boolean);
      if (recSortAlpha) base = [...base].sort(byName); // opt-in alphabetise
    } else {
      base = rows
        .filter((r) => category === 'ALL' || catKeyOf(r) === category)
        .sort(byName);
    }
    if (!q) return base;
    return base.filter((r) => r.symbol?.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q));
  }, [rows, category, query, recommended, recSortAlpha]);

  // When the query is empty we show the FULL filtered set (not a slice), so the
  // list matches the category count badge (e.g. "All 16" really shows 16).
  const trending = useMemo(() => visible, [visible]);

  // Per-category counts (for the pill badges, only when > 0).
  const counts = useMemo(() => {
    const out = { ALL: rows.length };
    for (const r of rows) {
      const k = catKeyOf(r) || 'OTHER';
      out[k] = (out[k] || 0) + 1;
    }
    const rowSet = new Set(rows.map((r) => r.symbol));
    out.RECOMMENDED = recommended.filter((s) => rowSet.has(s)).length;
    return out;
  }, [rows, recommended]);

  // "Recommended" sits right after "All" — only when the admin has configured
  // markets that resolve to live instruments (else it's hidden entirely).
  const categories = useMemo(() => (
    counts.RECOMMENDED > 0
      ? [CATEGORIES[0], { key: 'RECOMMENDED', label: 'Recommended' }, ...CATEGORIES.slice(1)]
      : CATEGORIES
  ), [counts.RECOMMENDED]);

  const handlePick = (sym) => {
    onClose?.();
    navigate(`/trade?symbol=${encodeURIComponent(sym)}`);
  };

  if (!open) return null;

  const showTrending = !query.trim();
  // Merge in server-found options (deduped) when searching.
  const list = showTrending
    ? trending
    : [...visible, ...optionResults.filter((o) => !visible.some((v) => v.symbol === o.symbol))];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:pt-20"
      role="dialog"
      aria-modal="true"
      aria-label="Search markets"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-text-primary/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Sheet */}
      <div className="relative w-full max-w-2xl bg-white rounded-2xl border border-border-dark shadow-elevated overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-subtle">
          <span className="text-text-muted">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search markets…"
            className="flex-1 bg-transparent outline-none text-base text-text-primary placeholder-text-muted"
          />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Close (Esc)"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Category pills */}
        <div className="px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            {categories.map((c) => {
              const active = category === c.key;
              const count = counts[c.key];
              if (c.key !== 'ALL' && !count) return null;
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setCategory(c.key)}
                  className={`shrink-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm transition-all border ${
                    active
                      ? 'border-text-primary bg-bg-card text-text-primary font-semibold'
                      : 'border-border-dark bg-white text-text-secondary hover:text-text-primary hover:border-text-primary/40'
                  }`}
                >
                  {c.label}
                  {count != null && (
                    <span className={`text-[10px] font-semibold ${active ? 'text-text-primary' : 'text-text-muted'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Results / trending list */}
        <div className="max-h-[60vh] overflow-y-auto">
          <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-text-secondary">
              {showTrending
                ? `${category === 'RECOMMENDED' ? 'Recommended' : 'All markets'} (${visible.length})`
                : `Results (${list.length})`}
            </span>
            {category === 'RECOMMENDED' && showTrending && (
              <button
                type="button"
                onClick={() => setRecSortAlpha((v) => !v)}
                aria-pressed={recSortAlpha}
                title={recSortAlpha ? 'Showing A–Z — click for the recommended order' : 'Sort A–Z'}
                className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-md border transition-colors ${
                  recSortAlpha
                    ? 'border-primary-500 text-primary-600 bg-primary-500/10'
                    : 'border-border-dark text-text-muted hover:text-text-primary hover:border-primary-500/40'
                }`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h11M3 12h8M3 18h5" /><path d="M17 8l3-3 3 3M20 5v14" />
                </svg>
                A–Z
              </button>
            )}
          </div>

          {loading && (
            <div className="px-5 py-6 text-sm text-text-muted">Loading instruments…</div>
          )}

          {!loading && list.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-text-muted">
              No matches for "{query}".
            </div>
          )}

          <ul className="pb-3">
            {list.map((r) => (
              <li key={r.symbol}>
                {/* `group` enables the bookmark's desktop hover-reveal; on
                    mobile (and when saved) it stays visible. The bookmark is a
                    focusable <span role="button"> so nesting it inside this row
                    <button> stays valid, and it stops click propagation so
                    tapping it opens the watchlist modal instead of navigating. */}
                <div className="group flex items-center gap-3 px-5 py-3 hover:bg-bg-hover transition-colors">
                  <button
                    type="button"
                    onClick={() => handlePick(r.symbol)}
                    className="flex items-center gap-3 min-w-0 flex-1 text-left"
                  >
                    <AssetIcon row={r} size={28} round />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-text-primary truncate">
                        {r.name || r.symbol}
                      </span>
                      <span className="block text-[11px] text-text-muted truncate">
                        {r.symbol}
                        {r.category ? ` · ${formatCategory(r)}` : ''}
                      </span>
                    </span>
                  </button>
                  <WatchlistButton symbol={r.symbol} row={r} variant="ghost" size={18} className="shrink-0" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function formatCategory(r) {
  const c = (r.category || '').toUpperCase();
  const base = { FOREX: 'Forex', CRYPTO: 'Crypto', COMMODITY: 'Commodity', INDEX: 'Index', STOCK: 'Stock' }[c] || c;
  // Region-tag stocks + indices so a result reads e.g. "Indian Stock" / "Global Index".
  return (c === 'STOCK' || c === 'INDEX') ? `${isIndian(r) ? 'Indian' : 'Global'} ${base}` : base;
}
