import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum, fmtPriceDual } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import { useWatchlists } from '../hooks/useWatchlists';
import CountryFlag from './CountryFlag';
import AssetIcon from './AssetIcon';

// Currency code → flag emoji. Used as the right-side mini-icon for forex
// pairs and for single-asset avatars on commodities/forex.
const CURRENCY_FLAG = {
  USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', CHF: '🇨🇭',
  AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦', INR: '🇮🇳',
};

/**
 * Get the visual avatar config for an instrument:
 *  • Crypto / commodities: single round colored tile with brand glyph
 *  • Forex pairs: two overlapped flag emojis (base + quote)
 */
function avatarFor(row) {
  const sym = (row.symbol || '').toUpperCase();
  const base = (row.baseCurrency || '').toUpperCase();
  const quote = (row.quoteCurrency || '').toUpperCase();
  const cat = (row.category || '').toUpperCase();

  // Single-tile assets (crypto, commodities, indices)
  if (cat === 'CRYPTO') {
    if (base === 'BTC') return { kind: 'tile', glyph: '₿', bg: '#F7931A', fg: '#fff' };
    if (base === 'ETH') return { kind: 'tile', glyph: 'Ξ', bg: '#627EEA', fg: '#fff' };
    if (base === 'SOL') return { kind: 'tile', glyph: '◎', bg: '#9945FF', fg: '#fff' };
    return { kind: 'tile', glyph: base.slice(0, 1), bg: '#475569', fg: '#fff' };
  }
  if (cat === 'COMMODITY') {
    if (base === 'XAU') return { kind: 'tile', glyph: 'Au', bg: '#FCD535', fg: '#0F0F12' };
    if (base === 'XAG') return { kind: 'tile', glyph: 'Ag', bg: '#C0C0C0', fg: '#0F0F12' };
    return { kind: 'tile', glyph: base.slice(0, 2), bg: '#FCD535', fg: '#0F0F12' };
  }

  // Forex pairs — two overlapped CountryFlag images (CDN-served, render
  // identically across all platforms including Windows).
  if (CURRENCY_FLAG[base] && CURRENCY_FLAG[quote]) {
    return { kind: 'pair', baseCurrency: base, quoteCurrency: quote };
  }
  // Fallback — text initials
  return { kind: 'tile', glyph: sym.slice(0, 2), bg: '#475569', fg: '#fff' };
}

/**
 * Synthesize a small sparkline path based on 24h % change direction.
 * Real candle sparklines need a small history series per symbol (separate
 * endpoint); this is a stylized stand-in that reads the right vibe — green
 * uptrend for positive change, red downtrend for negative.
 *
 * Returns an SVG `path d` string and a tone color.
 */
function sparkPath(change24h) {
  const W = 56, H = 22, mid = H / 2;
  const positive = !Number.isFinite(change24h) || change24h >= 0;
  const tone = !Number.isFinite(change24h)
    ? 'rgb(107 114 128)'
    : positive ? '#10b981' : '#ef4444';

  // Shape: 7 points zig-zagging with overall slope matching the sign of change.
  const slope = positive ? -1 : 1; // SVG y goes down → invert
  const amp = 4;
  const start = mid + (positive ? 4 : -4);
  const end = mid + (positive ? -4 : 4);
  const points = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const x = t * W;
    const noise = ((i % 2 === 0) ? 1 : -1) * (amp - i * 0.4);
    const y = start + (end - start) * t + noise * 0.6;
    points.push([x.toFixed(1), y.toFixed(1)]);
  }
  const d = points.map(([x, y], i) => (i === 0 ? `M${x} ${y}` : `L${x} ${y}`)).join(' ');
  return { d, tone, W, H };
}

/**
 * Premium market-watch list. Two tabs (Favourite / All) with full live
 * tickers, INR-primary + USD-secondary pricing, per-row star toggle, mini
 * sparkline showing 24h direction, and golden-glow active styling.
 */
export default function MarketWatch({ activeSymbol, onSelect, search = '' }) {
  const [rows, setRows] = useState([]);
  const [spreadRules, setSpreadRules] = useState({});
  const [tab, setTab] = useState('favourite');
  // Server-backed Favorites — the ★ always adds/removes from the
  // Favorites (default) watchlist, shared across the whole platform.
  const { has: isFavSym, toggleFavorite, favCount: totalFavs } = useWatchlists();
  const fxRate = useFxRate();

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, all] = await Promise.all([
          api.get('/instruments/watchlist'),
          api.get('/instruments'),
        ]);
        if (cancelled) return;
        // Merge category + base/quote into watchlist rows so the avatar
        // resolver doesn't need a separate lookup.
        const meta = {};
        for (const i of all.data.data) {
          meta[i.symbol] = {
            category: i.category,
            baseCurrency: i.baseCurrency,
            quoteCurrency: i.quoteCurrency,
          };
        }
        const enriched = (w.data.data || []).map((r) => ({ ...r, ...(meta[r.symbol] || {}) }));
        setRows(enriched);
        const rules = {};
        for (const i of all.data.data) {
          rules[i.symbol] = { value: i.spreadValue || '0', type: i.spreadType || 'FIXED' };
        }
        setSpreadRules(rules);
      } catch (e) { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live tickers
  useEffect(() => {
    if (!rows.length) return;
    const unsubs = rows.map((r) =>
      wsClient.subscribe(`ticker:${r.symbol}`, (data) => {
        const last = Number(data.lastPrice);
        if (!Number.isFinite(last) || last <= 0) return;
        const rule = spreadRules[r.symbol] || { value: '0', type: 'FIXED' };
        const half = Number(rule.value || 0) / 2;
        const bid = rule.type === 'PERCENTAGE' ? last * (1 - half) : last - half;
        const ask = rule.type === 'PERCENTAGE' ? last * (1 + half) : last + half;
        setRows((prev) =>
          prev.map((row) =>
            row.symbol === r.symbol
              ? { ...row, lastPrice: String(last), bid: String(bid), ask: String(ask), spread: String(ask - bid) }
              : row
          )
        );
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [rows.length, spreadRules]);

  const toggleFav = (symbol, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    toggleFavorite(symbol);
  };

  const visibleRows = useMemo(() => {
    const q = (search || '').trim().toUpperCase();
    let r = rows;
    if (tab === 'favourite') r = r.filter((row) => isFavSym(row.symbol));
    if (q) r = r.filter((row) => row.symbol.includes(q) || (row.name || '').toUpperCase().includes(q));
    return r;
  }, [rows, search, tab, isFavSym]);

  const allCount = useMemo(() => {
    const q = (search || '').trim().toUpperCase();
    if (!q) return rows.length;
    return rows.filter((row) => row.symbol.includes(q) || (row.name || '').toUpperCase().includes(q)).length;
  }, [rows, search]);

  const favCount = useMemo(() => {
    const q = (search || '').trim().toUpperCase();
    const fav = rows.filter((row) => isFavSym(row.symbol));
    if (!q) return fav.length;
    return fav.filter((row) => row.symbol.includes(q) || (row.name || '').toUpperCase().includes(q)).length;
  }, [rows, isFavSym, search]);

  if (!rows.length) {
    return <div className="p-4 text-sm text-text-muted">Loading watchlist…</div>;
  }

  return (
    <div className="flex flex-col">
      {/* Tabs */}
      <div className="flex items-center border-b border-border-dark px-2 sticky top-0 bg-bg-card z-20">
        {[
          { k: 'favourite', label: 'Favourite', count: favCount },
          { k: 'all', label: 'All', count: allCount },
        ].map((t) => (
          <button
            key={t.k}
            type="button"
            onClick={() => setTab(t.k)}
            className={`relative px-3 py-2.5 text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              tab === t.k ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t.k === 'favourite' && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            )}
            {t.label}
            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                tab === t.k ? 'bg-primary-500/20 text-primary-500' : 'bg-bg-hover text-text-muted'
              }`}
            >
              {t.count}
            </span>
            {tab === t.k && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary-500 rounded-t-full" />
            )}
          </button>
        ))}
      </div>

      {/* Rows — divided list (no table) for finer control over the row */}
      <div className="overflow-y-auto max-h-[55vh] divide-y divide-border-subtle">
        {visibleRows.map((r) => (
          <Row
            key={r.symbol}
            row={r}
            isActive={r.symbol === activeSymbol}
            isFav={isFavSym(r.symbol)}
            fxRate={fxRate}
            onSelect={() => onSelect?.(r.symbol)}
            onToggleFav={(e) => toggleFav(r.symbol, e)}
          />
        ))}
        {!visibleRows.length && (
          <div className="px-3 py-10 text-center">
            {tab === 'favourite' && !totalFavs ? (
              <div className="text-text-secondary text-sm">
                <div className="mb-1">No favourites yet</div>
                <div className="text-[11px] text-text-muted">
                  Click the ★ next to any symbol to add it here.
                </div>
              </div>
            ) : (
              <div className="text-text-muted text-sm">No symbols match "{search}"</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ row, isActive, isFav, fxRate, onSelect, onToggleFav }) {
  const change = Number(row.change24h);
  const changeColor =
    !Number.isFinite(change) ? 'text-text-muted' : change >= 0 ? 'text-bull' : 'text-bear';
  const quote = row.quoteCurrency || 'USD';
  const bidPx = fmtPriceDual(row.bid, quote, fxRate, row.pricePrecision || 2);
  const askPx = fmtPriceDual(row.ask, quote, fxRate, row.pricePrecision || 2);
  const av = avatarFor(row);
  const spark = sparkPath(change);

  return (
    <div
      onClick={onSelect}
      className={`relative flex items-center gap-3 px-3 py-3 cursor-pointer transition-colors ${
        isActive
          ? 'bg-primary-500/5 ring-1 ring-inset ring-primary-500/40'
          : 'hover:bg-bg-hover'
      }`}
    >
      {/* Avatar — delegates to <AssetIcon /> so crypto rows get the real
          coin logo, forex pairs get stacked flag PNGs, commodities and
          indices keep their coloured tile glyph. */}
      <div className="shrink-0">
        <AssetIcon row={row} size={40} round />
      </div>

      {/* Symbol + name + spread */}
      <div className="min-w-0 w-[140px]">
        <div className="text-sm font-bold text-text-primary truncate">{row.symbol}</div>
        <div className="text-[11px] text-text-muted truncate">{row.name || ''}</div>
        <div className="text-[11px] text-text-muted font-mono mt-0.5">
          {fmtNum(row.spread, Math.min(row.pricePrecision || 2, 5))}
        </div>
      </div>

      {/* Bid */}
      <div className="text-right shrink-0 w-[110px]">
        <div className="font-mono text-blue-400 text-sm">{bidPx.primary}</div>
        {bidPx.secondary && (
          <div className="text-[10px] text-text-muted font-mono">{bidPx.secondary}</div>
        )}
        {row.dayLow && (
          <div className="text-[10px] text-text-muted font-mono mt-0.5">
            L {fmtNum(row.dayLow, row.pricePrecision)}
          </div>
        )}
      </div>

      {/* Ask */}
      <div className="text-right shrink-0 w-[110px]">
        <div className="font-mono text-red-400 text-sm">{askPx.primary}</div>
        {askPx.secondary && (
          <div className="text-[10px] text-text-muted font-mono">{askPx.secondary}</div>
        )}
        {row.dayHigh && (
          <div className="text-[10px] text-text-muted font-mono mt-0.5">
            H {fmtNum(row.dayHigh, row.pricePrecision)}
          </div>
        )}
      </div>

      {/* Change% + sparkline */}
      <div className="text-right shrink-0 w-[80px] flex flex-col items-end gap-1">
        <div className={`text-[11px] font-mono font-semibold ${changeColor}`}>
          {Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '—'}
        </div>
        <svg
          width={spark.W}
          height={spark.H}
          viewBox={`0 0 ${spark.W} ${spark.H}`}
          className="opacity-90"
        >
          {/* Subtle filled area below the line */}
          <path
            d={`${spark.d} L${spark.W} ${spark.H} L0 ${spark.H} Z`}
            fill={spark.tone}
            opacity="0.12"
          />
          <path d={spark.d} stroke={spark.tone} strokeWidth="1.5" fill="none" />
        </svg>
      </div>

      {/* Star — far right */}
      <button
        type="button"
        onClick={onToggleFav}
        title={isFav ? 'Remove from favourites' : 'Add to favourites'}
        className={`shrink-0 p-1.5 rounded transition-colors ${
          isFav ? 'text-primary-500' : 'text-text-muted hover:text-primary-500'
        }`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={isFav ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </button>
    </div>
  );
}
