import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInstruments } from '../hooks/useInstruments';
import AssetIcon from './AssetIcon';
import WatchlistButton from './WatchlistButton';

/**
 * SearchModal — Groww-style search sheet. Opens from the header search bar
 * and houses BOTH the search input AND the category filter (which used to
 * live inline on the InstrumentStrip). Clicking a result navigates to
 * /trade?symbol=… exactly like the strip's pills do, so the symbol resolves
 * through the existing Trade page.
 */

const CATEGORIES = [
  { key: 'ALL',       label: 'All' },
  { key: 'FOREX',     label: 'Forex' },
  { key: 'CRYPTO',    label: 'Crypto' },
  { key: 'COMMODITY', label: 'Commodities' },
  { key: 'INDEX',     label: 'Indices' },
  { key: 'STOCK',     label: 'Stocks' },
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
  const [category, setCategory] = useState('ALL');
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  // Reset state every time the modal opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCategory('ALL');
    // Slight delay so the input is mounted + paint-stable before focus.
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [open]);

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
    return rows.filter((r) => {
      if (category !== 'ALL' && (r.category || '').toUpperCase() !== category) return false;
      if (!q) return true;
      return r.symbol?.toUpperCase().includes(q) || (r.name || '').toUpperCase().includes(q);
    });
  }, [rows, category, query]);

  // "Trending" is shown when the query is empty — first slice of the
  // filtered set so the list always reflects the active category.
  const trending = useMemo(() => visible.slice(0, 10), [visible]);

  // Per-category counts (for the pill badges, only when > 0).
  const counts = useMemo(() => {
    const out = { ALL: rows.length };
    for (const r of rows) {
      const k = (r.category || 'OTHER').toUpperCase();
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }, [rows]);

  const handlePick = (sym) => {
    onClose?.();
    navigate(`/trade?symbol=${encodeURIComponent(sym)}`);
  };

  if (!open) return null;

  const showTrending = !query.trim();
  const list = showTrending ? trending : visible;

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
            className="hidden sm:inline-flex items-center text-[10px] font-semibold text-text-muted border border-border-dark rounded-md px-1.5 py-0.5"
            aria-label="Close (Esc)"
          >
            ESC
          </button>
        </div>

        {/* Category pills */}
        <div className="px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            {CATEGORIES.map((c) => {
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
          <div className="px-5 pt-4 pb-2 text-sm font-semibold text-text-secondary">
            {showTrending ? 'Trending Searches' : `Results (${visible.length})`}
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
                        {r.category ? ` · ${formatCategory(r.category)}` : ''}
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

function formatCategory(c) {
  const map = { FOREX: 'Forex', CRYPTO: 'Crypto', COMMODITY: 'Commodity', INDEX: 'Index', STOCK: 'Stock' };
  return map[(c || '').toUpperCase()] || c;
}
