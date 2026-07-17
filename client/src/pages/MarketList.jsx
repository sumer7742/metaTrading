import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInstruments } from '../hooks/useInstruments';
import { wsClient } from '../services/ws';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';
import { EconomicCalendarCard } from '../components/EconomicCalendar';
import AssetIcon from '../components/AssetIcon';
import WatchlistButton from '../components/WatchlistButton';

/**
 * MarketList — full-page list opened from "See more" / "See all" links on
 * Explore. Driven by ?view=… so the same page renders different rankings
 * (most-traded / gainers / losers / volume / sectors) without duplicating
 * the surrounding chrome.
 *
 * Layout mirrors the Groww "Most bought stocks" page: a wide live table on
 * the left, plus a sticky CTA card on the right asking the user to fund
 * their account.
 */

// ─── Asset glyph (kept in sync with Explore's catalog) ────────────────────
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
function glyphFor(sym) {
  return ASSET_META[sym] || { glyph: (sym || '?').slice(0, 2).toUpperCase(), bg: '#475569' };
}

// ─── Sectors — grounded in the real backend `category` enum ───────────────
// Mirrors Explore.jsx: five real categories + two derivable refinements.
const cat = (r) => (r.category || '').toUpperCase();
const isCrypto    = (r) => cat(r) === 'CRYPTO';
const isForex     = (r) => cat(r) === 'FOREX';
const isCommodity = (r) => cat(r) === 'COMMODITY';
const isIndex     = (r) => cat(r) === 'INDEX';
const isStock     = (r) => cat(r) === 'STOCK';
const MAJOR_CCY   = new Set(['EUR','GBP','USD','JPY','CHF','AUD','NZD','CAD']);

const SECTOR_DEFS = [
  { key: 'crypto',  label: 'Crypto',          tint: '#F7931A', match: isCrypto },
  { key: 'forex',   label: 'Forex',           tint: '#10B981', match: isForex },
  { key: 'majors',  label: 'Forex Majors',    tint: '#0EA5E9',
    match: (r) => isForex(r)
      && MAJOR_CCY.has((r.baseCurrency || '').toUpperCase())
      && MAJOR_CCY.has((r.quoteCurrency || '').toUpperCase()) },
  { key: 'comm',    label: 'Commodities',     tint: '#A16207', match: isCommodity },
  { key: 'gold',    label: 'Precious Metals', tint: '#D4A017',
    match: (r) => isCommodity(r) && ['XAU','XAG'].includes((r.baseCurrency || '').toUpperCase()) },
  { key: 'indices', label: 'Indices',         tint: '#3B82F6', match: isIndex },
  { key: 'stocks',  label: 'Stocks',          tint: '#8B5CF6', match: isStock },
];

// ─── View configs — title + sort fn per ?view= value ──────────────────────
const VIEWS = {
  'most-traded': {
    title: 'Most traded markets',
    caption: 'Highest liquidity across crypto, forex, indices and commodities.',
    sort: (a, b) => {
      const va = Number(a.volume24h) || 0;
      const vb = Number(b.volume24h) || 0;
      if (vb !== va) return vb - va;
      return Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0);
    },
  },
  'gainers': {
    title: 'Top gainers',
    caption: 'Best 24h performers across the platform.',
    sort: (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
  },
  'losers': {
    title: 'Top losers',
    caption: 'Worst 24h performers across the platform.',
    sort: (a, b) => (Number(a.change24h) || Infinity) - (Number(b.change24h) || Infinity),
  },
  'volume': {
    title: 'Highest volume',
    caption: 'Where the money is flowing right now.',
    sort: (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function synthSpark(change, seed = 0) {
  const ch = Number(change);
  const dir = !Number.isFinite(ch) ? 0 : ch >= 0 ? 1 : -1;
  const N = 24;
  const start = 50 - dir * 12;
  const end   = 50 + dir * 12;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const wiggle = Math.sin((i + seed) * 0.9) * 3 + Math.sin((i + seed) * 2.1) * 1.5;
    pts.push(start + (end - start) * t + wiggle);
  }
  return pts;
}

function Sparkline({ points, positive, width = 130, height = 36 }) {
  if (!points?.length) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(max - min, 1);
  const step = width / (points.length - 1);
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(height - ((p - min) / span) * (height - 4) - 2).toFixed(2)}`)
    .join(' ');
  const stroke = positive ? '#16A34A' : '#DC2626';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Thin wrapper kept for backwards compat. When the caller passes the full
// `row` we hand it to <AssetIcon /> for the real crypto logo / forex flags;
// otherwise we fall back to the symbol-only colored tile.
function AssetGlyph({ sym, row, size = 40 }) {
  if (row) return <AssetIcon row={row} size={size} />;
  const meta = glyphFor(sym);
  return (
    <span
      className="rounded-lg flex items-center justify-center font-bold text-white shrink-0"
      style={{ width: size, height: size, background: meta.bg, fontSize: Math.round(size * 0.4) }}
    >
      {meta.glyph}
    </span>
  );
}

function fmtVolume(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(0);
}
function fmtPrice(raw, precision) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(precision) || 2, 6));
}

// ─── Page ────────────────────────────────────────────────────────────────
export default function MarketList() {
  const [params] = useSearchParams();
  const view = params.get('view') || 'most-traded';
  const navigate = useNavigate();
  const { rows: instruments, loading } = useInstruments();
  const [priceMap, setPriceMap] = useState({});

  // Live WS subs for every instrument we'll render.
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

  const lived = useMemo(
    () => instruments.map((r) => priceMap[r.symbol] ? { ...r, lastPrice: priceMap[r.symbol] } : r),
    [instruments, priceMap]
  );

  // Sector view uses a different layout entirely — handle separately.
  if (view === 'sectors') {
    return <SectorsListView instruments={lived} loading={loading} />;
  }

  const cfg = VIEWS[view] || VIEWS['most-traded'];
  const list = useMemo(() => [...lived].sort(cfg.sort), [lived, cfg]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* ── Main table ─────────────────────────────────────────────────── */}
      <div className="lg:col-span-8">
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-text-primary">{cfg.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{cfg.caption}</p>
        </div>

        <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
          {/* Column header */}
          <div className="grid grid-cols-12 gap-4 px-6 py-3 text-xs text-text-muted bg-bg-card border-b border-border-subtle">
            <div className="col-span-5">Company</div>
            <div className="col-span-4 text-right">Market Price (1D)</div>
            <div className="col-span-3 text-right">Volume</div>
          </div>

          {loading && (
            <div className="px-6 py-10 text-center text-sm text-text-muted">Loading markets…</div>
          )}

          {!loading && list.length === 0 && (
            <div className="px-6 py-10 text-center text-sm text-text-muted">
              No instruments available.
            </div>
          )}

          {!loading && list.map((r, idx) => {
            const change = Number(r.change24h);
            const price = Number(r.lastPrice);
            const absChange = Number.isFinite(change) && Number.isFinite(price)
              ? (price * change) / 100
              : NaN;
            const positive = Number.isFinite(change) ? change >= 0 : true;
            return (
              <button
                key={r.symbol}
                type="button"
                onClick={() => navigate(`/stock/${encodeURIComponent(r.symbol)}`)}
                className="group w-full grid grid-cols-12 gap-4 items-center px-6 py-4 text-left border-b border-border-subtle last:border-b-0 hover:bg-bg-hover transition-colors"
              >
                <div className="col-span-5 flex items-center gap-3 min-w-0">
                  <AssetGlyph sym={r.symbol} row={r} />
                  <div className="min-w-0">
                    <div className="text-sm text-text-primary truncate">{r.name || r.symbol}</div>
                    <div className="text-[11px] text-text-muted truncate">{r.symbol}</div>
                  </div>
                  <WatchlistButton symbol={r.symbol} row={r} variant="ghost" className="ml-auto" />
                </div>

                <div className="col-span-4 text-right">
                  <div className="flex items-center justify-end gap-4">
                    <div className="hidden sm:block">
                      <Sparkline points={synthSpark(change, idx)} positive={positive} width={110} height={32} />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-text-primary font-mono">
                        {fmtPrice(r.lastPrice, r.pricePrecision)}
                      </div>
                      <div
                        className="text-xs font-semibold font-mono"
                        style={{ color: positive ? '#16A34A' : '#DC2626' }}
                      >
                        {Number.isFinite(absChange) ? (
                          <>
                            {positive ? '+' : '-'}{fmtNum(Math.abs(absChange), Math.min(Number(r.pricePrecision) || 2, 4))}{' '}
                            <span className="font-medium">
                              ({positive ? '+' : '-'}{Math.abs(change).toFixed(2)}%)
                            </span>
                          </>
                        ) : '—'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="col-span-3 text-right text-sm font-mono text-text-primary">
                  {fmtVolume(r.volume24h)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Right sidebar — 4-card stack (portfolio, movers, news, links) ─ */}
      <aside className="lg:col-span-4 space-y-4">
        <PortfolioCard />
        <TopMoversCard lived={lived} />
        <EconomicCalendarCard />
        <ExploreLinksCard />
      </aside>
    </div>
  );
}

// ─── Sectors view ────────────────────────────────────────────────────────
function SectorsListView({ instruments, loading }) {
  const navigate = useNavigate();
  const sectors = useMemo(() => {
    return SECTOR_DEFS
      .map((s) => {
        const matches = instruments.filter(s.match);
        if (!matches.length) return null;
        const changes = matches.map((r) => Number(r.change24h)).filter(Number.isFinite);
        const perf = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
        const gainers = matches.filter((r) => Number(r.change24h) > 0).length;
        const losers  = matches.filter((r) => Number(r.change24h) < 0).length;
        const top = [...matches].sort(
          (a, b) => (Number(b.change24h) || 0) - (Number(a.change24h) || 0)
        )[0];
        return { ...s, matches, perf, gainers, losers, top };
      })
      .filter(Boolean)
      .sort((a, b) => b.perf - a.perf);
  }, [instruments]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <div className="lg:col-span-8">
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-text-primary">All sectors</h1>
          <p className="text-sm text-text-secondary mt-1">
            Sector performance over the last 24 hours.
          </p>
        </div>

        <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
          <div className="grid grid-cols-12 gap-4 px-6 py-3 text-xs text-text-muted bg-bg-card border-b border-border-subtle">
            <div className="col-span-5 sm:col-span-4">Sector</div>
            <div className="col-span-4 sm:col-span-5">Gainers/Losers</div>
            <div className="col-span-3 text-right">1D price change</div>
          </div>

          {loading && (
            <div className="px-6 py-10 text-center text-sm text-text-muted">Loading sectors…</div>
          )}

          {!loading && sectors.length === 0 && (
            <div className="px-6 py-10 text-center text-sm text-text-muted">No sectors available.</div>
          )}

          {!loading && sectors.map((s) => {
            const positive = s.perf >= 0;
            const total = s.gainers + s.losers || 1;
            const gPct = (s.gainers / total) * 100;
            const lPct = (s.losers / total) * 100;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  if (s.top?.symbol) {
                    navigate(`/stock/${encodeURIComponent(s.top.symbol)}`);
                  }
                }}
                className="w-full grid grid-cols-12 gap-4 items-center px-6 py-4 text-left border-b border-border-subtle last:border-b-0 hover:bg-bg-hover transition-colors"
              >
                <div className="col-span-5 sm:col-span-4 flex items-center gap-3 min-w-0">
                  <span
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold"
                    style={{ background: `${s.tint}15`, color: s.tint }}
                  >
                    {s.label.slice(0, 1)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{s.label}</div>
                    <div className="text-[11px] text-text-muted truncate hidden sm:block">
                      {s.matches.length} instruments · Top {s.top?.symbol || '—'}
                    </div>
                  </div>
                </div>

                <div className="col-span-4 sm:col-span-5">
                  <div className="w-full max-w-[260px]">
                    <div className="flex items-center justify-between text-sm font-semibold mb-1">
                      <span className="text-[#16A34A]">{s.gainers}</span>
                      <span className="text-[#DC2626]">{s.losers}</span>
                    </div>
                    <div className="flex h-[3px] rounded-full overflow-hidden bg-bg-hover">
                      <div className="bg-[#16A34A]" style={{ width: `${gPct}%` }} />
                      <div className="bg-[#DC2626]" style={{ width: `${lPct}%` }} />
                    </div>
                  </div>
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
      </div>

      <aside className="lg:col-span-4 space-y-4">
        <PortfolioCard />
        <TopMoversCard lived={instruments} />
        <EconomicCalendarCard />
        <ExploreLinksCard />
      </aside>
    </div>
  );
}

// ─── Sidebar cards ──────────────────────────────────────────────────────

const ChevR = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
);
const EyeOn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></svg>
);
const EyeOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.06 10.06 0 0 1 12 20c-7 0-11-8-11-8a18.55 18.55 0 0 1 4.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.31 18.31 0 0 1-2.16 3.19" /><path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" /><path d="M1 1l22 22" /></svg>
);

/**
 * Live portfolio summary. Pulls /user/dashboard once and shows whatever the
 * backend returns. If the user is unfunded the numbers stay at zero — we
 * explicitly DO NOT show a KYC prompt or paywall here. Visibility toggle
 * masks the values for in-person privacy.
 */
function PortfolioCard() {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.get('/user/dashboard');
        if (!cancelled) setData(res.data?.data || null);
      } catch (_) { /* leave empty — render zeros */ }
    };
    load();
    // Re-fetch live on the same WS events the Dashboard uses, so deposits,
    // fills and position changes propagate to this card within a second.
    const u1 = wsClient.subscribe('wallet', load);
    const u2 = wsClient.subscribe('positions', load);
    const u3 = wsClient.subscribe('orders', load);
    return () => { cancelled = true; u1 && u1(); u2 && u2(); u3 && u3(); };
  }, []);

  // /user/dashboard shape:
  //   balance: { live, primaryCurrency, liveByCurrency: { CCY: { balance } } }
  //   equity:  { unrealizedPnl, openPositions: [{ entryPrice, quantity, side, margin }] }
  //   pnl:     { realizedToday, realizedLifetime }
  //   deposits: { totalNet?, lifetimeNet?, total? }   ← optional
  //
  // We compute:
  //   currentValue   = live cash balance (multi-currency summed) + unrealised PnL
  //   investedValue  = lifetime net deposits if reported, else the margin
  //                    actually posted on currently-open positions
  //   totalReturns   = currentValue − investedValue
  const balance = data?.balance || {};
  const eq = data?.equity || {};
  const liveByCur = balance.liveByCurrency || {};

  let liveCash = Number(balance.live || 0);
  if (liveCash === 0) {
    // Server reports primary-currency wallet only — sum the rest as a
    // fallback so cards never read 0 when the user actually has funds
    // in a non-primary currency.
    liveCash = Object.values(liveByCur).reduce(
      (sum, t) => sum + (Number(t?.balance) || 0),
      0,
    );
  }
  const unrealised = Number(eq.unrealizedPnl || 0);
  const currentValue = liveCash + unrealised;

  // Invested value — try the most natural fields first; fall back to
  // the cost basis of open positions (entry × qty − margin proxy).
  let investedValue = Number(
    data?.deposits?.totalNet
      ?? data?.deposits?.lifetimeNet
      ?? data?.deposits?.total
      ?? data?.invested?.amount
      ?? 0
  );
  if (!investedValue && Array.isArray(eq.openPositions) && eq.openPositions.length) {
    investedValue = eq.openPositions.reduce((sum, p) => {
      const m = Number(p.margin);
      if (Number.isFinite(m) && m > 0) return sum + m;
      // No margin field → derive from entry × qty / leverage (default 1×).
      const entry = Number(p.entryPrice) || 0;
      const qty = Number(p.quantity) || 0;
      const lev = Math.max(Number(p.leverage) || 1, 1);
      return sum + (entry * qty) / lev;
    }, 0);
  }

  const totalReturns = Number.isFinite(currentValue - investedValue) ? currentValue - investedValue : 0;
  const returnsPct = investedValue > 0 ? (totalReturns / investedValue) * 100 : 0;
  const positive = totalReturns >= 0;

  const fmt = (v) => hidden ? '••••••' : '$' + fmtNum(Number(v) || 0, 2);

  return (
    <Link to="/dashboard" className="block bg-white border border-border-dark rounded-2xl p-5 hover:shadow-card transition-shadow">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-primary">Your Portfolio</h3>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); setHidden((h) => !h); }}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label={hidden ? 'Show values' : 'Hide values'}
          >
            {hidden ? <EyeOff /> : <EyeOn />}
          </button>
        </div>
        <span className="text-text-muted"><ChevR /></span>
      </div>

      <div className="mt-4">
        <div className="text-[11px] uppercase tracking-wider text-text-muted font-medium">Current Value</div>
        <div className="mt-1 text-2xl font-bold text-text-primary font-mono">{fmt(currentValue)}</div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-text-muted font-medium">Invested Value</div>
          <div className="mt-1 text-sm font-semibold text-text-primary font-mono">{fmt(investedValue)}</div>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wider text-text-muted font-medium">Total Returns</div>
          <div className="mt-1 text-sm font-semibold font-mono" style={{ color: positive ? '#16A34A' : '#DC2626' }}>
            {hidden ? '••••' : (
              <>
                {positive ? '+' : ''}{fmtNum(totalReturns, 2)}
                <span className="font-medium ml-1">
                  ({positive ? '+' : ''}{returnsPct.toFixed(2)}%)
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

/** Mini top-movers card — reuses the parent page's live instrument data,
 *  no extra network calls. Three rows max with mini tab pills above. */
function TopMoversCard({ lived }) {
  const [tab, setTab] = useState('Gainers');
  const list = useMemo(() => {
    const pool = [...(lived || [])];
    const sorters = {
      Gainers: (a, b) => (Number(b.change24h) || -Infinity) - (Number(a.change24h) || -Infinity),
      Losers:  (a, b) => (Number(a.change24h) ||  Infinity) - (Number(b.change24h) ||  Infinity),
      'Most Active': (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0),
    };
    return pool.sort(sorters[tab] || sorters.Gainers).slice(0, 3);
  }, [lived, tab]);

  return (
    <div className="bg-white border border-border-dark rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-text-primary">Top Movers</h3>

      <div className="mt-3 flex items-center gap-2">
        {['Gainers', 'Losers', 'Most Active'].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
              tab === t
                ? 'bg-primary-500/10 border-primary-500/30 text-primary-600 font-semibold'
                : 'bg-white border-border-dark text-text-secondary hover:text-text-primary hover:border-text-primary/30'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-1">
        {list.length === 0 && (
          <div className="py-3 text-center text-xs text-text-muted">Loading…</div>
        )}
        {list.map((r) => {
          const change = Number(r.change24h);
          const price = Number(r.lastPrice);
          const absChange = Number.isFinite(change) && Number.isFinite(price) ? (price * change) / 100 : NaN;
          const positive = Number.isFinite(change) ? change >= 0 : true;
          return (
            <Link
              key={r.symbol}
              to={`/stock/${encodeURIComponent(r.symbol)}`}
              className="group flex items-center gap-3 -mx-2 px-2 py-2 rounded-lg hover:bg-bg-hover transition-colors"
            >
              <AssetGlyph sym={r.symbol} row={r} size={28} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary truncate">{r.symbol}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-mono text-text-primary">{fmtPrice(r.lastPrice, r.pricePrecision)}</div>
                {Number.isFinite(change) && (
                  <div
                    className="text-[11px] font-mono font-semibold"
                    style={{ color: positive ? '#16A34A' : '#DC2626' }}
                  >
                    {positive ? '+' : ''}{fmtNum(Math.abs(absChange), Math.min(Number(r.pricePrecision) || 2, 4))} ({positive ? '+' : ''}{change.toFixed(2)}%)
                  </div>
                )}
              </div>
              <WatchlistButton symbol={r.symbol} row={r} variant="ghost" size={14} className="shrink-0" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}


/** Bottom card — 4 quick-link tiles to the major asset classes. */
function ExploreLinksCard() {
  const tiles = [
    { label: 'Crypto',       tint: '#F7931A', to: '/markets?view=most-traded', icon:
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h12l4 6-10 12L2 9z" /><path d="M2 9h20" /><path d="M12 3l4 6-4 12-4-12z" /></svg> },
    { label: 'Forex',        tint: '#10B981', to: '/markets?view=most-traded', icon:
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg> },
    { label: 'Commodities',  tint: '#D4A017', to: '/markets?view=most-traded', icon:
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8h16l-2 12H6z" /><path d="M6 4h12l2 4H4z" /></svg> },
    { label: 'Indices',      tint: '#3B82F6', to: '/markets?view=most-traded', icon:
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></svg> },
  ];
  return (
    <div className="bg-white border border-border-dark rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Explore</h3>
        <Link to="/explore" className="text-text-muted hover:text-text-primary transition-colors"><ChevR /></Link>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3">
        {tiles.map((t) => (
          <Link
            key={t.label}
            to={t.to}
            className="flex flex-col items-center gap-2 group"
          >
            <span
              className="w-12 h-12 rounded-2xl flex items-center justify-center transition-transform group-hover:-translate-y-0.5"
              style={{ background: `${t.tint}15`, color: t.tint }}
            >
              {t.icon}
            </span>
            <span className="text-[11px] font-medium text-text-secondary group-hover:text-text-primary text-center">
              {t.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
