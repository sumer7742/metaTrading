import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import AssetIcon from '../components/AssetIcon';
import { wsClient } from '../services/ws';
import { fmtMoney, fmtMoneyDual, fmtMoneyBoth, currencySymbol, fmtNum } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import { useInstruments } from '../hooks/useInstruments';

// ─── Portfolio page ──────────────────────────────────────────────────
// Replaces the old "Welcome back" landing — login now goes straight to
// /explore, so this view focuses purely on the user's portfolio:
// equity, P&L, allocation, open positions, recent activity.

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [priceMap, setPriceMap] = useState({});
  const [positions, setPositions] = useState([]);
  const fxRate = useFxRate();
  const { rows: instruments } = useInstruments();

  // ── Dashboard polling (every 15s, paused when tab hidden) ─────────
  useEffect(() => {
    let cancelled = false;
    let intervalId = null;
    const load = async () => {
      try {
        const res = await api.get('/user/dashboard');
        if (!cancelled) setData(res.data.data);
      } catch (e) {
        if (!cancelled) setData((prev) => prev ?? null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const startPoll = () => { if (!intervalId) intervalId = setInterval(load, 15000); };
    const stopPoll = () => { if (intervalId) { clearInterval(intervalId); intervalId = null; } };
    const onVisibility = () => { if (document.hidden) stopPoll(); else { load(); startPoll(); } };
    load();
    if (!document.hidden) startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { cancelled = true; stopPoll(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  // ── Open positions — full payload (includes markPrice + currentPnl) ─
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await api.get('/trading/positions');
        if (!cancelled) setPositions(Array.isArray(data?.data) ? data.data : []);
      } catch (_) { /* keep prior */ }
    };
    load();
    const p = wsClient.subscribe('positions', load);
    return () => { cancelled = true; p && p(); };
  }, []);

  // ── WS auto-refresh on wallet/position events ─────────────────────
  useEffect(() => {
    const refetch = async () => {
      try { const res = await api.get('/user/dashboard'); setData(res.data.data); } catch (_) {}
    };
    const w = wsClient.subscribe('wallet', refetch);
    const p = wsClient.subscribe('positions', refetch);
    return () => { w && w(); p && p(); };
  }, []);

  // ── Subscribe to live ticker for every held symbol ────────────────
  const openSymbols = useMemo(() => {
    const fromDash = data?.equity?.openPositions || [];
    const fromPos = positions || [];
    return [...new Set([...fromDash.map((p) => p.symbol), ...fromPos.map((p) => p.symbol)])];
  }, [data, positions]);
  useEffect(() => {
    if (!openSymbols.length) return;
    const unsubs = openSymbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (tick) => {
        const px = Number(tick?.lastPrice ?? tick?.price ?? tick?.last);
        if (Number.isFinite(px)) setPriceMap((prev) => (prev[sym] === px ? prev : { ...prev, [sym]: px }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [openSymbols]);

  // ── Hooks MUST run unconditionally, BEFORE any early return — React
  // requires the same hook order on every render or it bails with
  // "Rendered more hooks than during the previous render".
  // We compute livePositions + allocation from `positions` alone so they
  // are safe to compute even when `data` is null (initial load).
  const livePositions = useMemo(() => positions.map((p) => {
    const markPx = Number(priceMap[p.symbol] ?? p.markPrice ?? p.entryPrice);
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    const pnl = (p.side === 'BUY' ? (markPx - entry) * qty : (entry - markPx) * qty) || 0;
    const inst = instruments.find((i) => i.symbol === p.symbol);
    const notional = Math.abs(qty * markPx);
    return { ...p, markPrice: markPx, unrealizedPnl: pnl, category: p.category || inst?.category || 'OTHER', notional, _inst: inst };
  }), [positions, priceMap, instruments]);

  const allocation = useMemo(() => {
    const buckets = { CRYPTO: 0, FOREX: 0, STOCK: 0, COMMODITY: 0, INDEX: 0, OTHER: 0 };
    let total = 0;
    for (const p of livePositions) {
      const cat = (p.category || 'OTHER').toUpperCase();
      const bucket = buckets[cat] != null ? cat : 'OTHER';
      buckets[bucket] += p.notional;
      total += p.notional;
    }
    return { buckets, total };
  }, [livePositions]);

  if (loading) {
    return <DashboardSkeleton />;
  }
  if (!data) {
    return (
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-12">
        <div className="bg-white border border-bear/30 rounded-2xl p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-bear/15 text-bear flex items-center justify-center mb-3">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 className="text-text-primary font-bold text-lg mb-1">Couldn't load your portfolio</h2>
          <p className="text-sm text-text-secondary mb-4">Check your connection and try again.</p>
          <button
            onClick={() => { setLoading(true); api.get('/user/dashboard').then((r) => setData(r.data.data)).catch(() => {}).finally(() => setLoading(false)); }}
            className="btn-primary"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Derived figures (only reached when data is non-null) ──────────
  const fullName = [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const primaryCur = data.balance?.primaryCurrency || 'INR';
  const liveByCur = data.balance?.liveByCurrency || {};
  const liveBalance = (() => {
    const direct = Number(data.balance?.live || 0);
    if (direct !== 0) return direct;
    const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
    return Object.entries(liveByCur).reduce((sum, [cur, t]) => {
      const bal = Number(t?.balance || 0);
      if (!Number.isFinite(bal) || bal === 0) return sum;
      if (cur === primaryCur) return sum + bal;
      if (cur === 'USD' && primaryCur === 'INR') return sum + bal * rate;
      if (cur === 'INR' && primaryCur === 'USD') return sum + bal / rate;
      return sum + bal;
    }, 0);
  })();
  const openPositionsList = data.equity?.openPositions || [];
  const liveUnrealized = openPositionsList.reduce((sum, p) => {
    const mark = Number(priceMap[p.symbol] ?? 0);
    if (!mark) return sum;
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    return sum + (p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty);
  }, 0);
  const haveAllTicks = openPositionsList.length > 0 && openPositionsList.every((p) => priceMap[p.symbol] != null);
  const unrealized = haveAllTicks ? liveUnrealized : Number(data.equity?.unrealizedPnl || 0);
  const equity = liveBalance + unrealized;
  const todayPnl = Number(data.pnl?.realizedToday || 0);
  const lifetimePnl = Number(data.pnl?.realizedLifetime || 0);
  const winRate = data.pnl?.winRate;
  const recentActivity = data.recentActivity || [];

  // KYC chip — refined to just three states, no full banner card
  const kycStatus = data.user?.kycStatus;

  // (livePositions + allocation already computed above — outside the
  // early-return guard.)

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-6">

      {/* ── Header ────────────────────────────────────────────────── */}
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Portfolio</h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-border-dark text-[10px] font-semibold text-text-secondary">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-bull opacity-60 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-bull" />
              </span>
              Live
            </span>
          </div>
          <p className="text-sm text-text-secondary mt-1">
            {fullName} · Equity, P&amp;L, open positions and activity — all in one view
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {kycStatus === 'APPROVED' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-bull/10 text-bull border border-bull/30">
              <CheckIcon /> KYC Verified
            </span>
          )}
          {kycStatus === 'PENDING' && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-warn/10 text-warn border border-warn/30">
              <ShieldIcon /> KYC Under Review
            </span>
          )}
          {kycStatus !== 'APPROVED' && kycStatus !== 'PENDING' && (
            <Link
              to="/profile"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-bear/10 text-bear border border-bear/30 hover:bg-bear/20 transition-colors"
            >
              <ShieldIcon /> Verify Identity
            </Link>
          )}
          <Link
            to="/wallet"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl border border-border-dark text-text-primary text-xs font-semibold hover:border-primary-500/50 hover:bg-primary-500/5 transition-colors"
          >
            <WalletIcon /> Add Funds
          </Link>
          <Link
            to="/trade"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white text-xs font-bold shadow-sm hover:shadow-card active:scale-[0.98] transition-all"
          >
            <ChartIcon /> Trade
          </Link>
        </div>
      </header>

      {/* ── Premium Equity hero — 5-tile portfolio band ──────────────
          Portfolio Value · Total P&L (Floating) · Today's P&L (Closed) ·
          Open Positions · Win Rate — plus a Balance footer row. */}
      {(() => {
        const eq = fmtMoneyBoth(equity, primaryCur, fxRate);
        const bal = fmtMoneyBoth(liveBalance, primaryCur, fxRate);
        const floatPnl = fmtMoneyBoth(unrealized, primaryCur, fxRate, true);
        const today = fmtMoneyBoth(todayPnl, primaryCur, fxRate, true);
        const eqPct = equity > 0 ? (unrealized / equity) * 100 : 0;
        const todayPct = equity > 0 ? (todayPnl / equity) * 100 : 0;
        return (
          <div
            className="relative overflow-hidden rounded-3xl border border-border-dark shadow-sm p-4 sm:p-5"
            style={{ background: '#F7F9FC' }}
          >
            <div className="relative grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-2 xl:gap-3 items-stretch">
              <PnlTile
                tint="#3B82F6"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></svg>}
                label="Portfolio Value (Equity)"
                value={eq.primary}
                valueColor="#0F172A"
                secondary={eq.secondary}
                pct={eqPct}
              />
              <PnlTile
                tint="#16A34A"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>}
                label="Total P&L (Floating)"
                value={floatPnl.primary}
                valueColor={unrealized >= 0 ? '#16A34A' : '#DC2626'}
                secondary={floatPnl.secondary}
                pct={eqPct}
              />
              <PnlTile
                tint={todayPnl >= 0 ? '#16A34A' : '#DC2626'}
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v20" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}
                label="Today's P&L"
                badge="CLOSED"
                value={today.primary}
                valueColor={todayPnl >= 0 ? '#16A34A' : '#DC2626'}
                secondary={today.secondary}
                pct={todayPct}
              />
              <StatBox dotTint="#3B82F6" label="Open" value={positions.length} caption="Positions" />
              <StatBox
                dotTint={winRate == null ? '#94A3B8' : winRate >= 50 ? '#16A34A' : '#DC2626'}
                label="Win Rate"
                value={winRate == null ? '—' : `${winRate.toFixed(0)}%`}
                caption="All time"
              />
            </div>

            {/* Balance footer */}
            <div className="relative mt-4 pt-3 border-t border-border-subtle flex items-center gap-2 text-[11px] text-text-muted flex-wrap">
              <span className="inline-flex items-center gap-1.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
                Balance
              </span>
              <span className="font-mono font-bold text-text-primary">{bal.primary}</span>
              {bal.secondary && <span className="font-mono">(= {bal.secondary.replace('≈ ', '')})</span>}
              {Object.entries(liveByCur).filter(([c]) => c !== primaryCur).map(([c, t]) => (
                <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/80 border border-border-subtle font-mono text-text-secondary">
                  <span className="text-text-muted">{c}</span>
                  {currencySymbol(c)}{Math.round(Number(t.balance) || 0).toLocaleString()}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ── Lifetime portfolio stats block — filter-aware ───────────── */}
      <PortfolioStats />

      {/* ── Monthly time-series chart ───────────────────────────────── */}
      <PortfolioChart fxRate={fxRate} />


      {/* ── Main grid: positions table (left) + allocation + accounts (right) ── */}
      <div className="grid grid-cols-12 gap-5">
        {/* ── Left: Accounts table + Open positions ──────────────── */}
        <section className="col-span-12 lg:col-span-8 space-y-5">
          {/* Your Trading Accounts */}
          <AccountsTable positions={livePositions} fxRate={fxRate} />

          {/* Section header */}
          <div className="flex items-end justify-between gap-2 px-1">
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Live</div>
              <div className="flex items-center gap-2 mt-0.5">
                <h2 className="text-base font-bold text-text-primary tracking-tight">Open positions</h2>
                <span className="inline-flex items-center justify-center min-w-[22px] h-[18px] px-1.5 rounded-full bg-primary-500/10 text-primary-600 text-[10px] font-bold">
                  {livePositions.length}
                </span>
              </div>
            </div>
            <Link to="/trade" className="text-xs font-semibold text-primary-600 hover:underline">Manage →</Link>
          </div>

          {livePositions.length === 0 ? (
            <div className="bg-white border border-border-dark rounded-2xl px-6 py-12 flex flex-col items-center text-center shadow-sm">
              <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" />
              </svg>
              <p className="mt-3 text-sm font-semibold text-text-primary">No open positions</p>
              <p className="mt-1 text-xs text-text-muted max-w-sm">Open a long or short trade and your live positions will appear here with mark-to-market P&amp;L.</p>
              <Link
                to="/explore"
                className="mt-4 inline-flex items-center gap-1.5 bg-primary-500 hover:bg-primary-600 active:scale-[0.98] text-white text-xs font-bold px-4 py-2 rounded-xl transition-all"
              >
                Explore Markets
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
              </Link>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {livePositions.slice(0, 6).map((p) => (
                  <PositionCard key={p._id || `${p.symbol}-${p.entryPrice}`} p={p} />
                ))}
              </div>
              {livePositions.length > 6 && (
                <Link
                  to="/trade"
                  className="block w-full text-center text-xs font-semibold text-primary-600 bg-white border border-border-dark rounded-xl py-2.5 hover:bg-primary-500/5 hover:border-primary-500/40 transition-all"
                >
                  View all {livePositions.length} positions →
                </Link>
              )}
            </>
          )}
        </section>

        {/* ── Right rail ─────────────────────────────────────────── */}
        <aside className="col-span-12 lg:col-span-4 space-y-5">
          {/* Asset Allocation — donut + account filter */}
          <AssetAllocationCard positions={livePositions} fxRate={fxRate} />
        </aside>
      </div>

      {/* ── Recent Closed Trades (full-width row) ─────────────────── */}
      <RecentClosedTrades fxRate={fxRate} />
    </div>
  );
}

// ─── Premium position card ───────────────────────────────────────────
// Each open position renders as its own self-contained tile — soft
// gradient backdrop tinted by P&L direction, side-coloured accent rail,
// big live P&L readout with % change pill, entry/mark/qty footer, and a
// subtle radial glow that follows the user on hover.
function PositionCard({ p }) {
  const prec = Math.min(p._inst?.pricePrecision || 2, 5);
  const pnl = Number(p.unrealizedPnl || 0);
  const isWin = pnl >= 0;
  const sideBull = p.side === 'BUY';
  const qty = Number(p.quantity);
  const entry = Number(p.entryPrice);
  const mark = Number(p.markPrice || entry);
  const pnlPct = entry > 0 ? (pnl / (qty * entry)) * 100 : 0;
  // Subtle 5% price-change indicator on the mark line
  const movePct = entry > 0 ? ((mark - entry) / entry) * 100 * (sideBull ? 1 : -1) : 0;

  const tone = isWin ? '#16A34A' : '#DC2626';
  const sideTone = sideBull ? '#16A34A' : '#DC2626';

  return (
    <Link
      to={`/trade?symbol=${encodeURIComponent(p.symbol)}`}
      className="group relative bg-white border border-border-dark rounded-2xl p-4 shadow-sm hover:shadow-card hover:-translate-y-0.5 hover:border-primary-500/40 transition-all duration-200 overflow-hidden block"
    >
      {/* Side accent rail */}
      <span
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl"
        style={{ background: `linear-gradient(180deg, ${sideTone} 0%, ${sideTone}00 100%)` }}
      />
      {/* Soft P&L-coloured glow top-right */}
      <span
        className="pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: `radial-gradient(circle, ${tone}22, transparent 70%)` }}
      />

      {/* Top row — icon + symbol + side badge */}
      <div className="relative flex items-start gap-3">
        <AssetIcon row={p._inst || { symbol: p.symbol, category: p.category }} size={36} round />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-text-primary truncate">{p.symbol}</span>
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded inline-flex items-center gap-0.5"
              style={{ background: `${sideTone}1A`, color: sideTone }}
            >
              {sideBull ? '▲' : '▼'} {sideBull ? 'Long' : 'Short'}
            </span>
          </div>
          <div className="text-[11px] text-text-muted truncate mt-0.5">{p._inst?.name || (p.category ? p.category.charAt(0) + p.category.slice(1).toLowerCase() : 'Position')}</div>
        </div>
      </div>

      {/* Big P&L readout */}
      <div className="relative mt-4">
        <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Unrealised P&amp;L</div>
        <div className="flex items-baseline gap-2 flex-wrap mt-0.5">
          <div className="text-2xl sm:text-[26px] font-bold font-mono tabular-nums leading-none" style={{ color: tone }}>
            {isWin ? '+' : ''}{pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <span
            className="inline-flex items-center gap-0.5 text-[11px] font-bold font-mono px-1.5 py-0.5 rounded"
            style={{ color: tone, background: `${tone}1A` }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              {isWin ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
            </svg>
            {isWin ? '+' : ''}{pnlPct.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Footer — entry → mark with arrow + qty */}
      <div className="relative mt-4 pt-3 border-t border-border-subtle grid grid-cols-3 gap-2 text-[11px]">
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-wider font-bold text-text-muted">Entry</div>
          <div className="font-mono tabular-nums font-semibold text-text-secondary mt-0.5 truncate">{fmtNum(entry, prec)}</div>
        </div>
        <div className="min-w-0 flex flex-col items-center">
          <div className="text-[9px] uppercase tracking-wider font-bold text-text-muted">→</div>
          <div className="text-[9px] font-bold font-mono tabular-nums mt-0.5" style={{ color: movePct >= 0 ? '#16A34A' : '#DC2626' }}>
            {movePct >= 0 ? '+' : ''}{movePct.toFixed(2)}%
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[9px] uppercase tracking-wider font-bold text-text-muted">Mark</div>
          <div className="font-mono tabular-nums font-bold text-text-primary mt-0.5 truncate">{fmtNum(mark, prec)}</div>
        </div>
      </div>

      <div className="relative mt-2 flex items-center justify-between text-[10px] text-text-muted">
        <span className="font-mono">Qty · {qty.toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>
        <span className="inline-flex items-center gap-1 font-semibold text-primary-600 opacity-0 group-hover:opacity-100 transition-opacity">
          View chart
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
        </span>
      </div>
    </Link>
  );
}

// ─── Component helpers ───────────────────────────────────────────────

/**
 * PortfolioStats — filterable stats card. Two dropdown filters at the
 * top: time-window (Lifetime / 7 / 30 / 90 / 365 days) and account
 * (All accounts / pick one). Refetches /user/dashboard/lifetime-stats
 * whenever a filter changes.
 */
const TIME_RANGES = [
  { id: 0,   label: 'Lifetime' },
  { id: 7,   label: 'Last 7 days' },
  { id: 30,  label: 'Last 30 days' },
  { id: 90,  label: 'Last 90 days' },
  { id: 365, label: 'Last year' },
];

function PortfolioStats() {
  const [accounts, setAccounts] = useState([]);
  const [days, setDays] = useState(0);
  const [accountId, setAccountId] = useState(''); // '' = All
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  // Custom date range (in addition to the preset windows).
  const [customMode, setCustomMode] = useState(false);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [customFrom, setCustomFrom] = useState(''); // applied range
  const [customTo, setCustomTo] = useState('');

  // Load account list once for the dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get('/user/accounts');
        if (!cancelled) setAccounts(r.data.data || []);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch filtered stats whenever the filters change.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (customMode && customFrom && customTo) {
          params.set('fromDate', customFrom);
          params.set('toDate', customTo);
        } else if (!customMode && days) {
          params.set('days', String(days));
        }
        if (accountId)  params.set('accountId', accountId);
        const r = await api.get(`/user/dashboard/lifetime-stats?${params.toString()}`);
        if (!cancelled) setStats(r.data.data);
      } catch { /* non-fatal — keep previous numbers */ }
      finally { if (!cancelled) setLoading(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [days, accountId, customMode, customFrom, customTo]);

  const sign = (n) => (n > 0 ? '+' : '') + n.toFixed(2);
  const toneOf = (n) => n > 0 ? 'bull' : n < 0 ? 'bear' : 'neutral';
  const num = (k) => Number(stats?.[k] || 0);

  const netProfit     = num('netProfit');
  const profit        = num('profit');
  const loss          = num('loss');
  const unrealized    = num('unrealizedPnl');
  const closedOrders  = Number(stats?.closedOrders || 0);
  const profitable    = Number(stats?.profitable   || 0);
  const unprofitable  = Number(stats?.unprofitable || 0);
  const tradingVolume = num('tradingVolume');
  const lossDisp      = Math.abs(loss);

  // 8 cells (Net profit emphasised). "Lifetime" row removed — was a
  // verbatim duplicate of Net profit when no date filter is set.
  const rows = [
    { label: 'Net profit',     value: `${sign(netProfit)} USD`,            tone: toneOf(netProfit),  emphasis: true },
    { label: 'Profit',         value: `+${profit.toFixed(2)} USD`,         tone: 'bull' },
    { label: 'Loss',           value: `-${lossDisp.toFixed(2)} USD`,       tone: 'bear' },
    { label: 'Unrealised P/L', value: `${sign(unrealized)} USD`,           tone: toneOf(unrealized) },
    { label: 'Closed orders',  value: closedOrders.toLocaleString() },
    { label: 'Profitable',     value: profitable.toLocaleString(),         tone: 'bull' },
    { label: 'Unprofitable',   value: unprofitable.toLocaleString(),       tone: 'bear' },
    { label: 'Trading volume', value: `${tradingVolume.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD` },
  ];

  return (
    <section className="rounded-2xl border border-border-dark bg-white p-5 sm:p-6 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Performance</div>
          <h2 className="text-base font-bold text-text-primary tracking-tight mt-0.5">Trading summary</h2>
          <span className="text-[11px] text-text-muted">
            {loading ? 'Loading…' : 'Filter the window or pick an account to drill down'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={customMode ? 'custom' : String(days)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'custom') { setCustomMode(true); setDraftFrom(customFrom); setDraftTo(customTo); }
              else { setCustomMode(false); setDays(Number(v)); }
            }}
            className="text-xs font-semibold rounded-lg border border-border-dark bg-white px-2.5 py-1.5 focus:outline-none focus:border-primary-500"
          >
            {TIME_RANGES.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
            <option value="custom">Custom</option>
          </select>
          {customMode && (
            <div className="flex items-center gap-1.5">
              <input
                type="date" value={draftFrom} max={draftTo || undefined}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="text-xs rounded-lg border border-border-dark bg-white px-2 py-1.5 focus:outline-none focus:border-primary-500"
              />
              <span className="text-text-muted text-xs">to</span>
              <input
                type="date" value={draftTo} min={draftFrom || undefined}
                onChange={(e) => setDraftTo(e.target.value)}
                className="text-xs rounded-lg border border-border-dark bg-white px-2 py-1.5 focus:outline-none focus:border-primary-500"
              />
              <button
                type="button"
                onClick={() => { if (draftFrom && draftTo) { setCustomFrom(draftFrom); setCustomTo(draftTo); } }}
                disabled={!draftFrom || !draftTo}
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          )}
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="text-xs font-semibold rounded-lg border border-border-dark bg-white px-2.5 py-1.5 focus:outline-none focus:border-primary-500 max-w-[180px]"
          >
            <option value="">All accounts</option>
            {accounts.some((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL') && (
              <option value="ALL_REAL">All Real Accounts</option>
            )}
            {accounts.some((a) => a.accountType === 'DEMO' || a.accountType === 'VIRTUAL') && (
              <option value="ALL_DEMO">All Demo Accounts</option>
            )}
            {accounts.map((a) => (
              <option key={a._id} value={a._id}>
                {a.nickname || a.accountNumber} · {a.baseCurrency || 'USD'}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
        {rows.map((r) => (
          <StatCell key={r.label} {...r} />
        ))}
      </div>
    </section>
  );
}

/**
 * PortfolioChart — premium Exness-style analytics card with:
 *   • Segmented metric tabs    (Net profit · Closed orders · Trading volume · Equity)
 *   • Timeframe selector       (1D · 1W · 1M · 3M · 1Y · ALL)
 *   • Different chart per tab  (area, bars, histogram, smooth curve)
 *   • Gradient area fills, smooth Bézier curves, hover tooltip
 *   • Empty state + loading state
 *
 * Self-fetches /user/dashboard/monthly-series with the chosen `range`
 * param so bucket granularity adapts (hourly / daily / weekly / monthly).
 */
const CHART_TABS = [
  { id: 'netProfit',     label: 'Net profit',     type: 'area' },
  { id: 'closedOrders',  label: 'Closed orders',  type: 'bar' },
  { id: 'tradingVolume', label: 'Trading volume', type: 'histogram' },
  { id: 'equity',        label: 'Equity',         type: 'curve' },
];

const TIMEFRAMES = [
  { id: '1d',  label: '1D' },
  { id: '1w',  label: '1W' },
  { id: '1m',  label: '1M' },
  { id: '3m',  label: '3M' },
  { id: '1y',  label: '1Y' },
  { id: 'all', label: 'ALL' },
];

function PortfolioChart({ accountId, fxRate }) {
  const [buckets, setBuckets] = useState([]);
  const [tab, setTab] = useState('netProfit');
  const [range, setRange] = useState('1y');
  const [loading, setLoading] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);
  const [sumStats, setSumStats] = useState(null);   // /user/dashboard — win rate, profit factor, trades

  // Trade summary for the inline Best Day / Worst Day / Win Rate /
  // Profit Factor / Total Trades strip (account-scoped when a specific
  // account is selected upstream).
  useEffect(() => {
    let dead = false;
    api.get('/user/dashboard/lifetime-stats', { params: accountId ? { accountId } : {} })
      .then((r) => { if (!dead) setSumStats((prev) => ({ ...(prev || {}), lifetime: r.data.data })); })
      .catch(() => {});
    api.get('/user/dashboard')
      .then((r) => { if (!dead) setSumStats((prev) => ({ ...(prev || {}), dash: r.data.data })); })
      .catch(() => {});
    return () => { dead = true; };
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ range });
        if (accountId) params.set('accountId', accountId);
        const r = await api.get(`/user/dashboard/monthly-series?${params.toString()}`);
        if (!cancelled) setBuckets(r.data.data?.buckets || []);
      } catch { /* keep previous */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [accountId, range]);

  const activeTab = CHART_TABS.find((t) => t.id === tab) || CHART_TABS[0];

  // Y-axis bounds per chart type. Area/curve modes always render the
  // continuous value (netProfit/equity) and want a symmetric scale around
  // zero when crossing it. Bar/histogram modes use only the active metric.
  const { yMax, yMin, ticks } = useMemo(() => {
    if (!buckets.length) return { yMax: 4, yMin: 0, ticks: [0, 1, 2, 3, 4] };
    const vals = buckets.map((b) => Number(b[tab] || 0));
    const minV = Math.min(0, ...vals);
    const maxV = Math.max(0, ...vals);
    const span = Math.max(Math.abs(minV), Math.abs(maxV), 4);
    const tickStep = niceStep(span / 4);
    const top = Math.ceil(span / tickStep) * tickStep;
    if (minV < 0) {
      // Symmetric scale
      return {
        yMax: top, yMin: -top,
        ticks: [-top, -top / 2, 0, top / 2, top],
      };
    }
    return {
      yMax: top, yMin: 0,
      ticks: [0, top / 4, top / 2, (3 * top) / 4, top],
    };
  }, [buckets, tab]);

  // SVG geometry
  const W = 920, H = 300;
  const PAD = { top: 18, right: 28, bottom: 32, left: 44 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const n = Math.max(1, buckets.length);
  const slot = innerW / n;
  const barW = Math.min(22, slot * 0.55);
  const yRange = yMax - yMin;
  const yOf = (v) => PAD.top + innerH * (1 - (v - yMin) / yRange);
  const cxOf = (i) => PAD.left + slot * i + slot / 2;

  // Headline value for the active tab.
  const headline = useMemo(() => {
    if (!buckets.length) return null;
    if (tab === 'equity') {
      const last = buckets[buckets.length - 1]?.equity ?? 0;
      return { value: last, fmt: 'usd', tone: last >= 0 ? 'bull' : 'bear' };
    }
    if (tab === 'closedOrders') {
      const total = buckets.reduce((s, b) => s + Number(b.closedOrders || 0), 0);
      return { value: total, fmt: 'int', tone: 'neutral' };
    }
    if (tab === 'tradingVolume') {
      const total = buckets.reduce((s, b) => s + Number(b.tradingVolume || 0), 0);
      return { value: total, fmt: 'usd', tone: 'neutral' };
    }
    const total = buckets.reduce((s, b) => s + Number(b.netProfit || 0), 0);
    return { value: total, fmt: 'usd', tone: total >= 0 ? 'bull' : 'bear' };
  }, [buckets, tab]);

  const fmtHeadline = (h) => {
    if (!h) return '—';
    if (h.fmt === 'int') return h.value.toLocaleString();
    return `${h.value >= 0 ? '' : '-'}$${Math.abs(h.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const hovered = hoverIdx != null ? buckets[hoverIdx] : null;

  // Smooth Bézier path through the data points (used by area + curve).
  const smoothPath = useMemo(() => {
    if (!buckets.length) return '';
    const pts = buckets.map((b, i) => ({ x: cxOf(i), y: yOf(Number(b[tab] || 0)) }));
    return smoothPathFromPoints(pts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, tab, yMax, yMin]);

  const areaPath = useMemo(() => {
    if (!smoothPath || !buckets.length) return '';
    const lastX = cxOf(buckets.length - 1);
    const firstX = cxOf(0);
    const baseY = yOf(yMin < 0 ? 0 : yMin);
    return `${smoothPath} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothPath, buckets, yMin, yMax]);

  const totalNonZero = buckets.length > 0 && buckets.some((b) => Number(b[tab] || 0) !== 0);

  // ── Inline analytics stat strip figures ──────────────────────────
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const netVals = buckets.map((b) => Number(b.netProfit || 0));
  const bestDay = (netVals.length ? Math.max(...netVals) : 0) * rate;
  const worstDay = (netVals.length ? Math.min(...netVals) : 0) * rate;
  const lifetime = sumStats?.lifetime;
  const dash = sumStats?.dash;
  const winRate = dash?.pnl?.winRate;
  const pfProfit = Number(lifetime?.profit ?? dash?.pnl?.profit ?? 0);
  const pfLoss = Math.abs(Number(lifetime?.loss ?? dash?.pnl?.loss ?? 0));
  const profitFactor = pfLoss > 0 ? pfProfit / pfLoss : null;
  const totalTrades = lifetime?.closedOrders ?? dash?.trades?.totalLive ?? dash?.trades?.closedLive ?? 0;
  const STRIP = [
    { label: 'Best Day', value: `+₹${fmtNum(Math.max(bestDay, 0), 2)}`, cls: 'text-bull' },
    { label: 'Worst Day', value: `${worstDay < 0 ? '-' : ''}₹${fmtNum(Math.abs(worstDay), 2)}`, cls: 'text-bear' },
    { label: 'Win Rate', value: winRate != null ? `${Number(winRate).toFixed(2)}%` : '—', cls: 'text-text-primary' },
    { label: 'Profit Factor', value: profitFactor != null ? profitFactor.toFixed(2) : '—', cls: 'text-text-primary' },
    { label: 'Total Trades', value: totalTrades, cls: 'text-text-primary' },
  ];

  return (
    <section className="rounded-2xl border border-border-dark bg-white p-5 sm:p-6 shadow-sm">
      <style>{`
        @keyframes pcFade {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes pcDraw {
          from { stroke-dashoffset: 1400; }
          to   { stroke-dashoffset: 0; }
        }
      `}</style>

      {/* ── Header: eyebrow + segmented metric tabs + timeframe ── */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Analytics</div>
            <div className={`text-2xl font-extrabold tabular-nums mt-1 ${
              headline?.tone === 'bull' ? 'text-bull' : headline?.tone === 'bear' ? 'text-bear' : 'text-text-primary'
            }`}>
              {fmtHeadline(headline)}
            </div>
            <div className="text-[11px] text-text-muted mt-0.5">{activeTab.label} · {TIMEFRAMES.find((t) => t.id === range)?.label || '—'}</div>
          </div>

          {/* Inline stat strip — Best Day / Worst Day / Win Rate / Profit Factor / Total Trades */}
          <div className="flex items-stretch rounded-xl border border-border-subtle overflow-hidden order-last lg:order-none w-full lg:w-auto overflow-x-auto">
            {STRIP.map((s, i) => (
              <div key={s.label} className={`px-4 py-1.5 text-center shrink-0 ${i > 0 ? 'border-l border-border-subtle' : ''}`}>
                <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted whitespace-nowrap">{s.label}</div>
                <div className={`text-[13px] font-bold font-mono tabular-nums mt-0.5 whitespace-nowrap ${s.cls}`}>{s.value}</div>
              </div>
            ))}
          </div>

          {/* Timeframe pill row — Exness-style segmented */}
          <div className="inline-flex p-1 rounded-xl bg-bg-hover/60 border border-border-subtle">
            {TIMEFRAMES.map((t) => {
              const active = t.id === range;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setRange(t.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-bold tracking-wide transition-all ${
                    active
                      ? 'bg-white text-text-primary shadow-sm'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Metric tabs — segmented control with sliding active state */}
        <div className="inline-flex p-1 rounded-xl bg-bg-hover/60 border border-border-subtle w-full sm:w-auto overflow-x-auto">
          {CHART_TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`px-3.5 py-1.5 rounded-lg text-[12px] font-semibold whitespace-nowrap transition-all ${
                  active
                    ? 'bg-white text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── SVG chart ── */}
      <div className="relative w-full overflow-x-auto mt-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[680px] h-[300px]" preserveAspectRatio="none">
          <defs>
            <linearGradient id="pcAreaGreen" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#16A34A" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#16A34A" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="pcAreaRed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#EF4444" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#EF4444" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="pcAreaBlue" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#3B82F6" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="pcBarBlue" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#3B82F6" />
              <stop offset="100%" stopColor="#2563EB" />
            </linearGradient>
          </defs>

          {/* Grid lines + Y labels */}
          {ticks.map((v, i) => {
            const y = yOf(v);
            const isZero = Math.abs(v) < 1e-9;
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={y}
                  y2={y}
                  stroke={isZero ? '#CBD5E1' : '#F1F5F9'}
                  strokeWidth="1"
                  strokeDasharray={isZero ? '0' : '4 4'}
                />
                <text
                  x={PAD.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  fill="#94A3B8"
                  style={{ fontSize: '10.5px', fontWeight: 500, fontFamily: 'Inter, sans-serif' }}
                >
                  {fmtAxis(v)}
                </text>
              </g>
            );
          })}

          {/* Chart body — type per tab */}
          {totalNonZero && activeTab.type === 'area' && (
            <g style={{ animation: 'pcFade 240ms ease-out' }}>
              <path d={areaPath} fill={
                (headline?.value ?? 0) >= 0 ? 'url(#pcAreaGreen)' : 'url(#pcAreaRed)'
              } />
              <path
                d={smoothPath}
                fill="none"
                stroke={(headline?.value ?? 0) >= 0 ? '#16A34A' : '#EF4444'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ strokeDasharray: 1400, animation: 'pcDraw 700ms ease-out forwards' }}
              />
            </g>
          )}

          {totalNonZero && activeTab.type === 'curve' && (
            <g style={{ animation: 'pcFade 240ms ease-out' }}>
              <path d={areaPath} fill="url(#pcAreaBlue)" />
              <path
                d={smoothPath}
                fill="none"
                stroke="#3B82F6"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ strokeDasharray: 1400, animation: 'pcDraw 700ms ease-out forwards' }}
              />
            </g>
          )}

          {totalNonZero && activeTab.type === 'bar' && (
            <g style={{ animation: 'pcFade 240ms ease-out' }}>
              {buckets.map((b, i) => {
                const v = Number(b[tab] || 0);
                if (!v) return null;
                const y = yOf(v);
                const y0 = yOf(0);
                const isHovered = hoverIdx === i;
                return (
                  <rect
                    key={b.key}
                    x={cxOf(i) - barW / 2}
                    y={Math.min(y, y0)}
                    width={barW}
                    height={Math.max(2, Math.abs(y0 - y))}
                    fill="url(#pcBarBlue)"
                    rx="3"
                    style={{
                      opacity: hoverIdx == null || isHovered ? 1 : 0.4,
                      transition: 'opacity 140ms ease',
                    }}
                  />
                );
              })}
            </g>
          )}

          {totalNonZero && activeTab.type === 'histogram' && (
            <g style={{ animation: 'pcFade 240ms ease-out' }}>
              {buckets.map((b, i) => {
                const v = Number(b[tab] || 0);
                if (!v) return null;
                const y = yOf(v);
                const y0 = yOf(0);
                // Histogram tinted by the bucket's net P&L direction:
                // green-leaning months get green volume, losing months red.
                const fill = (b.netProfit || 0) >= 0 ? '#16A34A' : '#EF4444';
                const isHovered = hoverIdx === i;
                return (
                  <rect
                    key={b.key}
                    x={cxOf(i) - barW / 2}
                    y={Math.min(y, y0)}
                    width={barW}
                    height={Math.max(2, Math.abs(y0 - y))}
                    fill={fill}
                    rx="3"
                    style={{
                      opacity: hoverIdx == null || isHovered ? 0.92 : 0.4,
                      transition: 'opacity 140ms ease',
                    }}
                  />
                );
              })}
            </g>
          )}

          {/* Zero baseline (only when scale crosses zero) */}
          {yMin < 0 && (
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yOf(0)}
              y2={yOf(0)}
              stroke="#CBD5E1"
              strokeWidth="1"
            />
          )}

          {/* Hover vertical guide line + dot */}
          {hoverIdx != null && hovered && (
            <g pointerEvents="none">
              <line
                x1={cxOf(hoverIdx)}
                x2={cxOf(hoverIdx)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="#CBD5E1"
                strokeDasharray="3 4"
                strokeWidth="1"
              />
              {(activeTab.type === 'area' || activeTab.type === 'curve') && (
                <>
                  <circle
                    cx={cxOf(hoverIdx)}
                    cy={yOf(Number(hovered[tab] || 0))}
                    r="6"
                    fill="#FFFFFF"
                    stroke={
                      activeTab.type === 'curve'
                        ? '#3B82F6'
                        : (headline?.value ?? 0) >= 0 ? '#16A34A' : '#EF4444'
                    }
                    strokeWidth="2"
                  />
                </>
              )}
            </g>
          )}

          {/* X-axis labels */}
          {buckets.map((b, i) => {
            const stride = buckets.length <= 8 ? 1 : buckets.length <= 14 ? 2 : Math.ceil(buckets.length / 8);
            if (i % stride !== 0 && i !== buckets.length - 1) return null;
            const isHovered = hoverIdx === i;
            return (
              <text
                key={b.key}
                x={cxOf(i)}
                y={H - PAD.bottom + 18}
                textAnchor="middle"
                fill={isHovered ? '#0F172A' : '#94A3B8'}
                style={{ fontSize: '10.5px', fontWeight: isHovered ? 700 : 500, fontFamily: 'Inter, sans-serif' }}
              >
                {b.label}
              </text>
            );
          })}

          {/* Hit areas — invisible columns covering each bucket */}
          {buckets.map((b, i) => (
            <rect
              key={`hit-${b.key}`}
              x={PAD.left + slot * i}
              y={PAD.top}
              width={slot}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {/* Tooltip — floating card anchored to the hovered column */}
        {hovered && (
          <div
            className="absolute pointer-events-none"
            style={{
              left: `${(cxOf(hoverIdx) / W) * 100}%`,
              top: '8px',
              transform: hoverIdx > buckets.length / 2 ? 'translateX(-105%)' : 'translateX(5%)',
            }}
          >
            <div
              className="rounded-xl border border-border-subtle bg-white shadow-elevated px-3 py-2.5 text-[11px] min-w-[160px]"
              style={{ animation: 'pcFade 140ms ease-out' }}
            >
              <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{hovered.label}</div>
              {tab === 'netProfit' ? (
                <div className="mt-1.5 space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-secondary">Profit</span>
                    <span className="font-mono font-bold text-bull tabular-nums">+${hovered.profit.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-text-secondary">Loss</span>
                    <span className="font-mono font-bold text-bear tabular-nums">${hovered.loss.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-1 border-t border-border-subtle">
                    <span className="font-semibold text-text-primary">Net</span>
                    <span className={`font-mono font-extrabold tabular-nums ${hovered.netProfit >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {hovered.netProfit >= 0 ? '+' : ''}${hovered.netProfit.toFixed(2)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 flex items-center justify-between gap-3">
                  <span className="text-text-secondary">{activeTab.label}</span>
                  <span className="font-mono font-extrabold text-text-primary tabular-nums">
                    {tab === 'closedOrders'
                      ? hovered.closedOrders.toLocaleString()
                      : `$${Number(hovered[tab] || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* States */}
        {loading && buckets.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted">Loading…</div>
        )}
        {!loading && buckets.length > 0 && !totalNonZero && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-xs text-text-muted bg-white/85 backdrop-blur-sm px-3.5 py-2 rounded-lg border border-border-subtle shadow-sm">
              No data for this window — try a longer timeframe or another metric.
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// Smooth path through points using cubic Bézier with Catmull-Rom control
// points. Produces TradingView-style soft curves without sharp corners.
function smoothPathFromPoints(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  const tension = 0.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// Pick a "nice" axis step (1, 2, 5, 10, 20, 50, …) given a raw target.
function niceStep(raw) {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  let nice;
  if (m <= 1) nice = 1;
  else if (m <= 2) nice = 2;
  else if (m <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function fmtAxis(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000)     return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

/**
 * HeroKpi — premium glassmorphism KPI tile used inside the Equity hero.
 * Bigger and more polished than the legacy MiniStat (which is now only
 * used by the older sections).
 */
// PnlTile — one of the three money tiles in the hero band (Portfolio
// Value / Total P&L / Today's P&L). Icon-circle + label (+ optional badge)
// + big colored value + secondary USD figure + a ↑/↓ percent chip.
function PnlTile({ tint, icon, label, badge, value, valueColor, secondary, pct }) {
  const pos = (pct ?? 0) >= 0;
  const hasPct = Number.isFinite(pct) && Math.abs(pct) > 0.005;
  return (
    <div className="rounded-2xl p-3.5 flex items-start gap-3 min-w-0">
      <span className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: `${tint}1A`, color: tint }}>{icon}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold text-text-muted truncate">{label}</span>
          {/* Colours set inline (not via .text-white / .bg-* classes) so the
              global light-mode `.text-white → near-black !important` override
              can't hit it — otherwise the label goes black-on-black. */}
          {badge && <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full shrink-0" style={{ background: '#0F172A', color: '#FFFFFF' }}>{badge}</span>}
        </div>
        <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums leading-tight mt-1 truncate" style={{ color: valueColor || '#0F172A' }}>{value}</div>
        <div className="flex items-center gap-1.5 mt-1 min-w-0">
          {secondary && <span className="text-[11px] font-mono text-text-muted truncate">{secondary}</span>}
          {hasPct && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-bold shrink-0" style={{ color: pos ? '#16A34A' : '#DC2626' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">{pos ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}</svg>
              {pos ? '+' : ''}{pct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// StatBox — the bordered Open / Win Rate cells on the right of the hero.
function StatBox({ dotTint, label, value, caption }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-3.5 flex flex-col justify-center min-w-0">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotTint }} />
        <span className="text-[10px] uppercase tracking-wider font-bold text-text-muted truncate">{label}</span>
      </div>
      <div className="text-2xl font-extrabold text-text-primary mt-1 leading-none tabular-nums">{value}</div>
      <div className="text-[11px] text-text-muted mt-1">{caption}</div>
    </div>
  );
}

function HeroKpi({ label, value, caption, accent }) {
  const palette = accent === 'bull' ? '#16A34A'
    : accent === 'bear' ? '#DC2626'
    : accent === 'primary' ? '#3B82F6'
    : '#0F172A';
  return (
    <div
      className="relative rounded-2xl p-3.5 sm:p-4 border border-white/70 backdrop-blur-sm"
      style={{ background: 'rgba(255,255,255,0.78)' }}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-1 h-1 rounded-full" style={{ background: palette }} />
        <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      </div>
      <div
        className="mt-1.5 text-lg sm:text-xl font-extrabold tabular-nums leading-tight"
        style={{ color: palette }}
      >
        {value}
      </div>
      <div className="text-[10px] text-text-muted mt-0.5">{caption}</div>
    </div>
  );
}

function StatCell({ label, value, tone, emphasis }) {
  const toneCls = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text-primary';
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">{label}</div>
      <div className={`${emphasis ? 'text-xl' : 'text-base'} font-bold tabular-nums mt-1 ${toneCls}`}>
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value, accent = 'neutral' }) {
  const palette = accent === 'bull' ? 'text-bull' : accent === 'bear' ? 'text-bear' : accent === 'primary' ? 'text-primary-600' : 'text-text-primary';
  const dotBg = accent === 'bull' ? 'bg-bull' : accent === 'bear' ? 'bg-bear' : accent === 'primary' ? 'bg-primary-500' : 'bg-text-muted';
  return (
    <div className="bg-bg-hover/50 rounded-xl px-3 py-2.5 hover:bg-bg-hover transition-colors">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-text-muted">
        <span className={`w-1.5 h-1.5 rounded-full ${dotBg}`} />
        {label}
      </div>
      <div className={`mt-1 text-base font-bold font-mono tabular-nums ${palette}`}>{value}</div>
    </div>
  );
}

function TradeBreakdownRow({ label, value, today, tone = 'neutral' }) {
  const valueClass = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : tone === 'primary' ? 'text-primary-600' : 'text-text-primary';
  const dotClass = tone === 'bull' ? 'bg-bull' : tone === 'bear' ? 'bg-bear' : tone === 'primary' ? 'bg-primary-500' : 'bg-text-muted';
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-bg-hover transition-colors">
      <span className="inline-flex items-center gap-2 text-xs font-semibold text-text-primary">
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
        {label}
      </span>
      <span className="flex items-baseline gap-2">
        <span className={`text-base font-bold font-mono tabular-nums ${valueClass}`}>{value}</span>
        {today != null && today > 0 && (
          <span className="text-[10px] text-text-muted font-mono">+{today} today</span>
        )}
      </span>
    </div>
  );
}

// ─── Allocation category palette ─────────────────────────────────────
const CAT_COLORS = {
  CRYPTO:    '#F7931A',
  FOREX:     '#3B82F6',
  STOCK:     '#10B981',
  COMMODITY: '#F59E0B',
  INDEX:     '#8B5CF6',
  OTHER:     '#9CA3AF',
};

const CAT_NAME = { FOREX: 'Forex', INDEX: 'Indices', COMMODITY: 'Commodities', CRYPTO: 'Crypto', STOCK: 'Stocks', OTHER: 'Other' };

const fmtCloseTime = (d) => d
  ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\b(am|pm)\b/i, (x) => x.toUpperCase())
  : '-';

// ─── Asset Allocation card — donut + account filter + legend ─────────
// Image-matched palette (Forex blue · Indices green · Commodities amber ·
// Crypto purple · Stocks cyan). Kept local so it doesn't disturb any
// other consumer of CAT_COLORS.
const ALLOC_COLORS = { FOREX: '#3B82F6', INDEX: '#22C55E', COMMODITY: '#F59E0B', CRYPTO: '#8B5CF6', STOCK: '#38BDF8', OTHER: '#9CA3AF' };
const InfoIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>;

function AssetAllocationCard({ positions = [], fxRate }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const [accounts, setAccounts] = useState([]);
  const [sel, setSel] = useState('all');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    let dead = false;
    api.get('/user/accounts').then((r) => { if (!dead) setAccounts(r.data.data || []); }).catch(() => {});
    return () => { dead = true; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const isDemo = (t) => t === 'DEMO' || t === 'VIRTUAL';
  const typeById = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(String(a._id), a.accountType);
    return m;
  }, [accounts]);

  const filtered = positions.filter((p) => {
    if (sel === 'all') return true;
    const t = typeById.get(String(p.accountId));
    if (sel === 'real') return !isDemo(t);
    if (sel === 'demo') return isDemo(t);
    return String(p.accountId) === sel;
  });

  const { entries, total } = useMemo(() => {
    const b = {}; let tot = 0;
    for (const p of filtered) {
      const cat = (p.category || 'OTHER').toUpperCase();
      const key = ALLOC_COLORS[cat] ? cat : 'OTHER';
      const v = Math.abs(Number(p.notional) || 0);
      b[key] = (b[key] || 0) + v; tot += v;
    }
    return { entries: Object.entries(b).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]), total: tot };
  }, [filtered]);

  const options = [
    { k: 'all', label: 'All Accounts' },
    { k: 'real', label: 'All Real Accounts' },
    { k: 'demo', label: 'All Demo Accounts' },
    ...accounts.map((a) => ({ k: String(a._id), label: `${a.accountNumber || a._id.slice(-6)} (${isDemo(a.accountType) ? 'Demo' : 'Live'})` })),
  ];
  const selLabel = options.find((o) => o.k === sel)?.label || 'All Accounts';

  const R = 58, SW = 22, C = 2 * Math.PI * R, cx = 80, cy = 80;
  let off = 0;
  const segs = entries.map(([cat, val]) => { const len = (val / total) * C; const s = { cat, len, off }; off += len; return s; });

  return (
    <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
      <div className="px-5 pt-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-base font-bold text-text-primary">Asset Allocation</h3>
          <span className="text-text-muted" title="Live exposure across your open positions"><InfoIcon /></span>
        </div>
        <div className="relative" ref={ref}>
          <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-text-primary bg-white border border-border-dark rounded-lg px-2.5 py-1.5 hover:border-primary-500/40 transition-colors">
            <span className="truncate max-w-[120px]">{selLabel}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
          </button>
          {open && (
            <div className="absolute right-0 z-30 mt-1.5 w-52 bg-white border border-border-dark rounded-xl shadow-elevated p-1.5 max-h-72 overflow-y-auto">
              {options.map((o, i) => (
                <div key={o.k}>
                  {i === 3 && <div className="my-1 border-t border-border-subtle" />}
                  <button onClick={() => { setSel(o.k); setOpen(false); }} className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left text-[12px] ${sel === o.k ? 'bg-primary-500/10 text-primary-600 font-semibold' : 'text-text-primary hover:bg-bg-hover'}`}>
                    <span className="truncate">{o.label}</span>
                    {sel === o.k && <span className="text-primary-600 shrink-0"><CheckIcon /></span>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-5">
        {total === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">No exposure yet — open a position to see allocation.</div>
        ) : (
          <>
            <div className="flex justify-center">
              <div className="relative">
                <svg width="190" height="190" viewBox="0 0 160 160">
                  <circle cx={cx} cy={cy} r={R} fill="none" stroke="#EEF2F6" strokeWidth={SW} />
                  {segs.map((s) => (
                    <circle key={s.cat} cx={cx} cy={cy} r={R} fill="none"
                      stroke={ALLOC_COLORS[s.cat] || '#9CA3AF'} strokeWidth={SW}
                      strokeDasharray={`${s.len} ${C - s.len}`} strokeDashoffset={-s.off}
                      transform={`rotate(-90 ${cx} ${cy})`} />
                  ))}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="text-[11px] text-text-muted">Total</div>
                  <div className="text-xl font-extrabold font-mono tabular-nums text-text-primary">₹{fmtNum(total * rate, 0)}</div>
                </div>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {entries.map(([cat, val]) => {
                const pct = (val / total) * 100;
                return (
                  <div key={cat} className="flex items-center text-[13px]">
                    <span className="w-2.5 h-2.5 rounded-full mr-2.5 shrink-0" style={{ background: ALLOC_COLORS[cat] || '#9CA3AF' }} />
                    <span className="flex-1 font-semibold text-text-primary truncate">{CAT_NAME[cat] || cat}</span>
                    <span className="w-28 text-right font-mono tabular-nums font-bold text-text-primary">₹{fmtNum(val * rate, 2)}</span>
                    <span className="w-16 text-right font-mono tabular-nums text-text-muted">{pct.toFixed(2)}%</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div className="px-5 pb-4">
        <Link to="/reports" className="block w-full text-center text-[12px] font-semibold text-primary-600 bg-bg-hover/60 rounded-xl py-2.5 hover:bg-primary-500/5 transition-colors">View Detailed Allocation →</Link>
      </div>
    </div>
  );
}

// ─── Compact position card for the expanded account row ──────────────
function MiniPositionCard({ p, cur, rate }) {
  const buy = p.side === 'BUY';
  const entry = Number(p.entryPrice);
  const mark = Number(p.markPrice || entry);
  const qty = Number(p.quantity);
  const prec = Math.min(p._inst?.pricePrecision || 2, 5);
  const pnlNative = Number(p.unrealizedPnl || 0);
  const pnlInr = cur === 'USD' ? pnlNative * rate : pnlNative;
  const movePct = entry > 0 ? ((mark - entry) / entry) * 100 * (buy ? 1 : -1) : 0;
  const win = pnlInr >= 0;
  const tone = win ? '#16A34A' : '#DC2626';
  return (
    <div className="bg-white border border-border-dark rounded-xl p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <AssetIcon row={p._inst || { symbol: p.symbol, category: p.category }} size={26} round />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-bold text-text-primary truncate">{p.symbol}</span>
            <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded shrink-0" style={{ background: `${buy ? '#16A34A' : '#DC2626'}15`, color: buy ? '#15803D' : '#B91C1C' }}>{buy ? '▲ Long' : '▼ Short'}</span>
          </div>
          <div className="text-[9px] text-text-muted truncate">{p._inst?.name || (p.category ? p.category.charAt(0) + p.category.slice(1).toLowerCase() : 'Position')}</div>
        </div>
      </div>
      <div className="mt-2.5">
        <div className="text-[9px] uppercase tracking-wider font-bold text-text-muted">Unrealised P&L</div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-base font-bold font-mono tabular-nums" style={{ color: tone }}>{win ? '+' : '-'}₹{fmtNum(Math.abs(pnlInr), 2)}</span>
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color: tone, background: `${tone}15` }}>{movePct >= 0 ? '+' : ''}{movePct.toFixed(2)}%</span>
        </div>
      </div>
      <div className="mt-2.5 pt-2 border-t border-border-subtle grid grid-cols-3 items-center text-[10px]">
        <div className="min-w-0">
          <div className="text-[8px] uppercase tracking-wider font-bold text-text-muted">Entry</div>
          <div className="font-mono tabular-nums font-semibold text-text-secondary truncate">{fmtNum(entry, prec)}</div>
        </div>
        <div className="text-center text-[8px] font-bold font-mono" style={{ color: movePct >= 0 ? '#16A34A' : '#DC2626' }}>{movePct >= 0 ? '+' : ''}{movePct.toFixed(2)}%</div>
        <div className="min-w-0 text-right">
          <div className="text-[8px] uppercase tracking-wider font-bold text-text-muted">Mark</div>
          <div className="font-mono tabular-nums font-bold text-text-primary truncate">{fmtNum(mark, prec)}</div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px]">
        <span className="font-mono text-text-muted">Qty {fmtNum(qty, 2)}</span>
        <Link to={`/trade?symbol=${encodeURIComponent(p.symbol)}`} className="font-semibold text-primary-600 hover:text-primary-700">View Chart →</Link>
      </div>
    </div>
  );
}

// ─── Your Trading Accounts table ─────────────────────────────────────
function AccountsTable({ positions = [], fxRate }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const toInr = (a, c) => { const n = Number(a) || 0; return c === 'USD' ? n * rate : n; };
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [todayByAcc, setTodayByAcc] = useState({});
  const [sel, setSel] = useState('all');
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [closing, setClosing] = useState(null);
  const ref = useRef(null);

  const closeAll = async (acc) => {
    const label = acc.accountNumber || acc._id.slice(-6);
    if (!window.confirm(`Close ALL open positions on ${label}?\n\nThis places market orders to exit every open position and cannot be undone.`)) return;
    setClosing(acc._id);
    try {
      const { data } = await api.post('/trading/positions/close-all', { accountId: acc._id });
      const d = data?.data || {};
      if (d.failed?.length) toast.error(`Closed ${d.closed}/${d.total} — ${d.failed.length} failed`);
      else toast.success(`Closed ${d.closed ?? 0} position${(d.closed ?? 0) === 1 ? '' : 's'}`);
    } catch (e) {
      toast.error(e?.response?.data?.message || 'Failed to close positions');
    } finally {
      setClosing(null);
    }
  };

  useEffect(() => {
    let dead = false;
    api.get('/user/accounts').then((r) => { if (!dead) setAccounts(r.data.data || []); }).catch(() => {});
    api.get('/wallet/balances').then((r) => { if (!dead) setBalances(r.data.data || []); }).catch(() => {});
    const start = new Date(); start.setHours(0, 0, 0, 0);
    api.get('/trading/positions/history', { params: { from: start.toISOString(), limit: 500 } })
      .then((r) => {
        if (dead) return;
        const m = {};
        for (const it of (r.data.data?.items || [])) { const k = String(it.accountId); m[k] = (m[k] || 0) + Number(it.realizedPnl || 0); }
        setTodayByAcc(m);
      }).catch(() => {});
    return () => { dead = true; };
  }, []);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const isDemo = (t) => t === 'DEMO' || t === 'VIRTUAL';
  const live = accounts.filter((a) => !isDemo(a.accountType)).length;
  const demo = accounts.length - live;

  const rows = accounts.filter((a) => {
    if (sel === 'all') return true;
    if (sel === 'real') return !isDemo(a.accountType);
    if (sel === 'demo') return isDemo(a.accountType);
    return String(a._id) === sel;
  }).map((a) => {
    const cur = a.baseCurrency || 'INR';
    const bal = balances.filter((b) => String(b.accountId) === String(a._id)).reduce((s, b) => s + toInr(b.balance, b.currency), 0);
    const accPos = positions.filter((p) => String(p.accountId) === String(a._id));
    const flo = accPos.reduce((s, p) => s + toInr(p.unrealizedPnl, cur), 0);
    const equity = bal + flo;
    const pct = bal > 0 ? (flo / bal) * 100 : 0;
    const today = toInr(todayByAcc[String(a._id)] || 0, cur);
    return { a, cur, bal, flo, equity, pct, today, openN: accPos.length, accPos };
  });

  const options = [
    { k: 'all', label: 'All Accounts' },
    { k: 'real', label: 'All Real Accounts' },
    { k: 'demo', label: 'All Demo Accounts' },
    ...accounts.map((a) => ({ k: String(a._id), label: `${a.accountNumber || a._id.slice(-6)} (${isDemo(a.accountType) ? 'Demo' : 'Live'})` })),
  ];
  const selLabel = options.find((o) => o.k === sel)?.label || 'All Accounts';

  const money = (n) => `₹${fmtNum(n, 2)}`;
  const usdSmall = (n) => `≈ $${fmtNum(n / rate, 2)}`;
  const Both = ({ n, colored }) => (
    <div>
      <div className={`font-mono tabular-nums font-bold ${colored ? (n >= 0 ? 'text-bull' : 'text-bear') : 'text-text-primary'}`}>{colored && n >= 0 ? '+' : ''}{money(n)}</div>
      <div className="text-[10px] font-mono text-text-muted">{colored && n >= 0 ? '+' : ''}{usdSmall(n)}</div>
    </div>
  );

  return (
    <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
      <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Wallet</div>
          <h3 className="text-sm font-bold text-text-primary mt-0.5">Accounts</h3>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="text-center"><div className="text-lg font-bold font-mono tabular-nums text-text-primary leading-none">{live}</div><div className="text-[9px] uppercase font-bold text-text-muted mt-0.5">Live</div></div>
            <div className="text-center"><div className="text-lg font-bold font-mono tabular-nums text-text-primary leading-none">{demo}</div><div className="text-[9px] uppercase font-bold text-text-muted mt-0.5">Demo</div></div>
          </div>
          <div className="relative" ref={ref}>
            <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-text-primary bg-white border border-border-dark rounded-lg px-2.5 py-1.5 hover:border-primary-500/40 transition-colors">
              <span className="truncate max-w-[110px]">{selLabel}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {open && (
              <div className="absolute right-0 z-30 mt-1.5 w-52 bg-white border border-border-dark rounded-xl shadow-elevated p-1.5 max-h-72 overflow-y-auto">
                {options.map((o, i) => (
                  <div key={o.k}>
                    {i === 3 && <div className="my-1 border-t border-border-subtle" />}
                    <button onClick={() => { setSel(o.k); setOpen(false); }} className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left text-[12px] ${sel === o.k ? 'bg-primary-500/10 text-primary-600 font-semibold' : 'text-text-primary hover:bg-bg-hover'}`}>
                      <span className="truncate">{o.label}</span>
                      {sel === o.k && <span className="text-primary-600 shrink-0"><CheckIcon /></span>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
            <tr>
              <th className="text-left px-4 py-2.5">Account</th>
              <th className="text-left px-4 py-2.5">Account Type</th>
              <th className="text-right px-4 py-2.5">Balance</th>
              <th className="text-right px-4 py-2.5">Equity</th>
              <th className="text-right px-4 py-2.5">P&L (Floating)</th>
              <th className="text-right px-4 py-2.5">P&L %</th>
              <th className="text-right px-4 py-2.5">Today's P&L</th>
              <th className="text-center px-4 py-2.5">Open</th>
              <th className="text-center px-4 py-2.5">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.length === 0 ? (
              <tr><td colSpan={9} className="py-8 text-center text-text-muted text-xs">No accounts</td></tr>
            ) : rows.map(({ a, cur, bal, flo, equity, pct, today, openN, accPos }) => {
              const dem = isDemo(a.accountType);
              const isOpen = expandedId === a._id;
              return (
                <Fragment key={a._id}>
                  <tr className={`transition-colors align-top ${isOpen ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-[11px] font-bold" style={{ background: '#1D4ED815', color: '#1D4ED8' }}>{(a.accountNumber || 'AC').slice(-2)}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] font-bold text-text-primary truncate">{a.accountNumber || a._id.slice(-6)}</span>
                            <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded" style={{ background: dem ? '#D9770615' : '#16A34A15', color: dem ? '#B45309' : '#15803D' }}>{dem ? 'Demo' : 'Live'}</span>
                          </div>
                          <div className="text-[10px] text-text-muted truncate">{a.nickname || 'Trading Account'}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[12px] text-text-secondary">{a.customTypeName || a.nickname || a.accountType}</td>
                    <td className="px-4 py-3 text-right"><Both n={bal} /></td>
                    <td className="px-4 py-3 text-right"><Both n={equity} /></td>
                    <td className="px-4 py-3 text-right"><Both n={flo} colored /></td>
                    <td className={`px-4 py-3 text-right font-mono tabular-nums font-bold ${pct >= 0 ? 'text-bull' : 'text-bear'}`}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</td>
                    <td className="px-4 py-3 text-right"><Both n={today} colored /></td>
                    <td className="px-4 py-3 text-center font-mono tabular-nums text-text-primary">{openN}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-center gap-1.5">
                        <Link to="/wallet" className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 px-2 py-1 rounded-lg border border-border-dark">View</Link>
                        <button
                          type="button"
                          title={isOpen ? 'Hide positions' : 'Show open positions'}
                          onClick={() => setExpandedId(isOpen ? null : a._id)}
                          disabled={openN === 0}
                          className={`w-7 h-7 inline-flex items-center justify-center rounded-lg border border-border-dark transition-colors ${openN === 0 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-bg-hover text-text-secondary'}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={9} className="p-0 bg-bg-hover/40 border-b border-border-subtle">
                        <div className="p-4">
                          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                            <div className="flex items-center gap-2 text-[13px]">
                              <span className="w-1 h-4 rounded bg-primary-600" />
                              <span className="font-bold text-text-primary">{a.accountNumber || a._id.slice(-6)} - {a.nickname || 'Trading Account'}</span>
                              <span className="text-text-muted">·</span>
                              <span className="font-bold text-text-primary">Open Positions ({openN})</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-[12px] text-text-muted">Total Floating P&L</span>
                              <span className={`text-[13px] font-bold font-mono tabular-nums ${flo >= 0 ? 'text-bull' : 'text-bear'}`}>{flo >= 0 ? '+' : ''}₹{fmtNum(Math.abs(flo), 2)} ({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>
                              <button
                                type="button"
                                disabled={closing === a._id || openN === 0}
                                onClick={() => closeAll(a)}
                                className="text-[11px] font-semibold text-bear bg-white border border-bear/40 rounded-lg px-3 py-1.5 hover:bg-bear/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {closing === a._id ? 'Closing…' : 'Close All Positions'}
                              </button>
                            </div>
                          </div>
                          {accPos.length === 0 ? (
                            <div className="py-6 text-center text-xs text-text-muted">No open positions on this account</div>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                              {accPos.map((p) => <MiniPositionCard key={p._id || `${p.symbol}-${p.entryPrice}`} p={p} cur={cur} rate={rate} />)}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Recent Closed Trades table ──────────────────────────────────────
function RecentClosedTrades({ fxRate }) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let dead = false;
    api.get('/trading/positions/history', { params: { limit: 6 } })
      .then((r) => { if (!dead) setRows(r.data.data?.items || []); })
      .catch(() => {})
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, []);
  return (
    <section className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
      <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between">
        <h2 className="text-sm font-bold text-text-primary">Recent Closed Trades</h2>
        <Link to="/reports" className="text-xs font-semibold text-primary-600 hover:underline">View All Closed Trades →</Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
            <tr>
              <th className="text-left px-4 py-2.5">Symbol</th>
              <th className="text-left px-4 py-2.5">Type</th>
              <th className="text-left px-4 py-2.5">Account</th>
              <th className="text-right px-4 py-2.5">Lot Size</th>
              <th className="text-right px-4 py-2.5">Open Price</th>
              <th className="text-right px-4 py-2.5">Close Price</th>
              <th className="text-right px-4 py-2.5">P&L (₹)</th>
              <th className="text-right px-4 py-2.5">P&L (USD)</th>
              <th className="text-left px-4 py-2.5">Close Time</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {loading ? (
              <tr><td colSpan={9} className="py-8 text-center text-text-muted text-xs">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="py-8 text-center text-text-muted text-xs">No closed trades yet</td></tr>
            ) : rows.map((t) => {
              const pnl = Number(t.realizedPnl || 0);
              const buy = String(t.side).toUpperCase() === 'BUY';
              return (
                <tr key={t._id || `${t.symbol}-${t.closedAt}`} className="hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <AssetIcon symbol={t.symbol} size={22} round />
                      <span className="font-semibold text-text-primary">{t.symbol}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded" style={{ background: buy ? '#16A34A15' : '#DC262615', color: buy ? '#15803D' : '#B91C1C' }}>{buy ? 'Buy' : 'Sell'}</span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary">{t.accountNumber || String(t.accountId || '').slice(-6) || '—'}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-text-secondary">{fmtNum(t.quantity, 2)}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-text-secondary">{fmtNum(t.entryPrice, 4)}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-text-secondary">{t.closePrice != null ? fmtNum(t.closePrice, 4) : '—'}</td>
                  <td className={`px-4 py-3 text-right font-mono tabular-nums font-bold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>{pnl >= 0 ? '+' : '-'}₹{fmtNum(Math.abs(pnl) * rate, 2)}</td>
                  <td className={`px-4 py-3 text-right font-mono tabular-nums ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>{pnl >= 0 ? '+' : '-'}${fmtNum(Math.abs(pnl), 2)}</td>
                  <td className="px-4 py-3 text-[12px] text-text-muted whitespace-nowrap">{fmtCloseTime(t.closedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Time-ago helper ─────────────────────────────────────────────────
// Skeleton placeholder used while the dashboard is loading. Mirrors the
// final layout (header + 4 stat cards + chart + 2 lists) so the page
// shape appears immediately rather than a centered spinner.
function DashboardSkeleton() {
  const Block = ({ className = '' }) => (
    <div className={`bg-bg-hover/60 rounded-lg animate-pulse ${className}`} />
  );
  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-2">
          <Block className="h-8 w-40" />
          <Block className="h-4 w-72" />
        </div>
        <Block className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-white border border-border-subtle rounded-2xl p-5 space-y-3">
            <Block className="h-3 w-20" />
            <Block className="h-8 w-32" />
            <Block className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white border border-border-subtle rounded-2xl p-5 space-y-3">
          <Block className="h-4 w-32" />
          <Block className="h-48 w-full" />
        </div>
        <div className="bg-white border border-border-subtle rounded-2xl p-5 space-y-3">
          <Block className="h-4 w-24" />
          {[0, 1, 2, 3].map((i) => <Block key={i} className="h-10 w-full" />)}
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'just now';
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ─── Icons ───────────────────────────────────────────────────────────
const Svg = ({ children, w = 14, ...p }) => (
  <svg width={w} height={w} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
);
const ShieldIcon = () => <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Svg>;
const CheckIcon = () => <Svg><polyline points="20 6 9 17 4 12" /></Svg>;
const WalletIcon = () => <Svg><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1" /><path d="M16 12h4" /></Svg>;
const ChartIcon = () => <Svg><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></Svg>;
