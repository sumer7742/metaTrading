import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { wsClient } from '../services/ws';
import { fmtNum } from '../utils/format';
import { useInstruments } from '../hooks/useInstruments';
import CountryFlag from './CountryFlag';
import AssetIcon from './AssetIcon';

/**
 * InstrumentStrip — Groww-style horizontal pill rail of every tradable
 * instrument on the platform. Real data: pulls `/instruments` once on mount
 * and subscribes to a `ticker:<symbol>` channel per visible row so each pill
 * ticks live. Clicking a pill routes to /trade?symbol=SYM which the Trade
 * page already consumes to drive the chart, order form and order book.
 *
 * Inputs intentionally minimal — the active symbol is read off the URL
 * (`?symbol=`) when present so this component stays a drop-in element.
 */

// Currency code → flag emoji (forex pairs use overlapped flags). Mirrors the
// table in MarketWatch so the visual language is consistent across the app.
const FLAG = {
  USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CHF: 'CH',
  AUD: 'AU', NZD: 'NZ', CAD: 'CA', INR: 'IN',
};

// Crypto glyph + tint catalog. Falls back to first letter of base.
const CRYPTO_META = {
  BTC: { glyph: '₿', bg: '#F7931A' },
  ETH: { glyph: 'Ξ', bg: '#627EEA' },
  SOL: { glyph: '◎', bg: '#9945FF' },
  XRP: { glyph: 'X', bg: '#23292F' },
  DOGE:{ glyph: 'D', bg: '#C2A633' },
  ADA: { glyph: 'A', bg: '#0033AD' },
  BNB: { glyph: 'B', bg: '#F0B90B' },
  AVAX:{ glyph: 'A', bg: '#E84142' },
  MATIC:{glyph: 'M', bg: '#8247E5' },
  LINK:{ glyph: 'L', bg: '#2A5ADA' },
};

function avatarFor(row) {
  const cat = (row.category || '').toUpperCase();
  const base = (row.baseCurrency || row.symbol || '').toUpperCase();
  const quote = (row.quoteCurrency || '').toUpperCase();

  if (cat === 'CRYPTO') {
    const meta = CRYPTO_META[base] || { glyph: base.slice(0, 1), bg: '#475569' };
    return { kind: 'tile', ...meta, fg: '#FFFFFF' };
  }
  if (cat === 'COMMODITY') {
    if (base === 'XAU') return { kind: 'tile', glyph: 'Au', bg: '#D4A017', fg: '#FFFFFF' };
    if (base === 'XAG') return { kind: 'tile', glyph: 'Ag', bg: '#94A3B8', fg: '#FFFFFF' };
    if (base.includes('OIL')) return { kind: 'tile', glyph: 'Oil', bg: '#0F172A', fg: '#FFFFFF' };
    return { kind: 'tile', glyph: base.slice(0, 2), bg: '#A16207', fg: '#FFFFFF' };
  }
  if (cat === 'INDEX') {
    return { kind: 'tile', glyph: row.symbol.slice(0, 2), bg: '#3B82F6', fg: '#FFFFFF' };
  }
  if (cat === 'FOREX') {
    return { kind: 'pair', base, quote };
  }
  return { kind: 'tile', glyph: (row.symbol || '?').slice(0, 2), bg: '#475569', fg: '#FFFFFF' };
}

// Pill avatar — delegates to the shared <AssetIcon /> so crypto pills
// render the real coin logo, forex pills get stacked country flags, and
// commodity/index pills keep their colored tile glyph.
function PillAvatar({ row }) {
  return <AssetIcon row={row} size={28} round />;
}

export default function InstrumentStrip() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeSymbol = searchParams.get('symbol') || null;
  const { rows, loading, error } = useInstruments();
  const scrollerRef = useRef(null);

  // Live prices for visible rows. The hook hands us the static catalog;
  // ticker updates live in a parallel map so we don't have to mutate the
  // shared cache and bother every other consumer of useInstruments.
  const [priceMap, setPriceMap] = useState({});

  const symbolsKey = useMemo(() => rows.map((r) => r.symbol).sort().join('|'), [rows]);
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

  const visible = rows;

  // ── Click → navigate to Trade with the selected symbol ────────────────
  const onSelect = (sym) => {
    navigate(`/trade?symbol=${encodeURIComponent(sym)}`);
  };

  return (
    <div
      ref={scrollerRef}
      className="flex items-center gap-2.5 overflow-x-auto no-scrollbar px-4 sm:px-6 lg:px-8 py-3 scroll-smooth"
      style={{ WebkitOverflowScrolling: 'touch' }}
    >
      {loading && <SkeletonPills count={10} />}
      {!loading && error && (
        <div className="text-xs text-bear px-3 py-2">{error}</div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div className="text-xs text-text-muted px-3 py-2">No instruments match this filter.</div>
      )}
      {!loading && !error && visible.map((r) => (
        <InstrumentPill
          key={r.symbol}
          row={priceMap[r.symbol] ? { ...r, lastPrice: priceMap[r.symbol] } : r}
          active={r.symbol === activeSymbol}
          onClick={() => onSelect(r.symbol)}
        />
      ))}
    </div>
  );
}

function InstrumentPill({ row, active, onClick }) {
  const change = Number(row.change24h);
  const positive = !Number.isFinite(change) ? null : change >= 0;
  const tone = positive == null ? '#6B7280' : positive ? '#16A34A' : '#DC2626';
  const last = Number(row.lastPrice);
  const priceStr = Number.isFinite(last)
    ? fmtNum(last, Math.min(row.pricePrecision || 2, 5))
    : '—';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 inline-flex items-center gap-2.5 pl-2 pr-3 py-2 rounded-full border transition-all duration-150 ${
        active
          ? 'border-primary-500 bg-primary-500/5 shadow-card'
          : 'border-border-dark bg-white hover:border-primary-500/40 hover:shadow-card hover:-translate-y-px'
      }`}
    >
      <PillAvatar row={row} />
      <span className="flex flex-col items-start leading-none">
        <span className="text-[12px] font-semibold tracking-tight text-text-primary">
          {row.symbol}
        </span>
        <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-mono">
          <span className="text-text-primary">{priceStr}</span>
          {Number.isFinite(change) && (
            <span className="inline-flex items-center gap-0.5 font-semibold" style={{ color: tone }}>
              {positive ? (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17l10-10" /><path d="M7 7h10v10" /></svg>
              ) : (
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M17 7L7 17" /><path d="M17 17H7V7" /></svg>
              )}
              {(change >= 0 ? '+' : '') + change.toFixed(2)}%
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function SkeletonPills({ count = 8 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="shrink-0 inline-flex items-center gap-2.5 pl-2 pr-3 py-2 rounded-full border border-border-dark bg-white animate-pulse"
        >
          <div className="w-7 h-7 rounded-full bg-bg-hover" />
          <div className="flex flex-col gap-1.5">
            <div className="h-2.5 w-16 rounded bg-bg-hover" />
            <div className="h-2.5 w-20 rounded bg-bg-hover" />
          </div>
        </div>
      ))}
    </>
  );
}
