import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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

      {/* ── Premium Equity hero ──────────────────────────────────────
          Single hero band: total equity on the left, three unique KPIs
          on the right. Lifetime P&L moved out of here (it now lives in
          the Performance stats block below) to avoid duplication. */}
      {(() => {
        const eq = fmtMoneyBoth(equity, primaryCur, fxRate);
        const bal = fmtMoneyBoth(liveBalance, primaryCur, fxRate);
        const ur = fmtMoneyDual(unrealized, primaryCur, fxRate, true);
        const pct = equity > 0 ? (unrealized / equity) * 100 : 0;
        const pos = unrealized >= 0;
        return (
          <div
            className="relative overflow-hidden rounded-3xl border border-border-dark shadow-sm p-6 sm:p-7"
            style={{
              background: 'linear-gradient(135deg, #FFFFFF 0%, #F8FAFF 60%, #EEF2FF 100%)',
            }}
          >
            {/* Decorative glow + grid pattern */}
            <span className="pointer-events-none absolute -top-20 -right-20 w-72 h-72 rounded-full opacity-60" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.16), transparent 70%)' }} />
            <span className="pointer-events-none absolute -bottom-24 -left-12 w-56 h-56 rounded-full opacity-40" style={{ background: 'radial-gradient(circle, rgba(16,185,129,0.10), transparent 70%)' }} />

            <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* ─ Left: Equity headline ─ */}
              <div className="lg:col-span-7">
                <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.22em] font-extrabold text-text-muted">
                  <span className="w-1 h-1 rounded-full bg-primary-500" />
                  Total Equity
                </div>
                <div className="mt-1.5 flex items-baseline gap-3 flex-wrap">
                  <div className="text-4xl sm:text-5xl font-extrabold font-mono tabular-nums text-text-primary leading-none tracking-tight">{eq.primary}</div>
                  {Math.abs(unrealized) > 0.005 && (
                    <span
                      className="inline-flex items-center gap-1 text-sm font-bold font-mono px-2.5 py-1 rounded-full ring-1"
                      style={{
                        color: pos ? '#16A34A' : '#DC2626',
                        background: pos ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)',
                        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.04)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        {pos ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
                      </svg>
                      {ur.primary}
                      <span className="opacity-70 font-normal">({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>
                    </span>
                  )}
                </div>
                {eq.secondary && (
                  <div className="text-xs font-mono text-text-muted mt-2">{eq.secondary}</div>
                )}

                {/* Balance row */}
                <div className="mt-5 flex items-center gap-3 flex-wrap text-[11px]">
                  <span className="inline-flex items-center gap-1.5 text-text-muted">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
                    Balance
                  </span>
                  <span className="font-mono font-bold text-text-primary">{bal.primary}</span>
                  {bal.secondary && <span className="font-mono text-text-muted">({bal.secondary})</span>}
                  {Object.entries(liveByCur).filter(([c]) => c !== primaryCur).map(([c, t]) => (
                    <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-white/80 border border-border-subtle font-mono text-text-secondary">
                      <span className="text-text-muted">{c}</span>
                      {currencySymbol(c)}{Math.round(Number(t.balance) || 0).toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>

              {/* ─ Right: 3 unique KPIs (de-duplicated) ─
                  Lifetime P&L was here; it lives in the Performance
                  block below now. We keep only the metrics that aren't
                  shown elsewhere on this page. */}
              <div className="lg:col-span-5 grid grid-cols-3 gap-3">
                <HeroKpi
                  label="Open"
                  value={positions.length}
                  caption="Positions"
                  accent="primary"
                />
                <HeroKpi
                  label="Today"
                  value={fmtMoney(todayPnl, primaryCur)}
                  caption={todayPnl >= 0 ? 'Realised gain' : 'Realised loss'}
                  accent={todayPnl > 0 ? 'bull' : todayPnl < 0 ? 'bear' : 'neutral'}
                />
                <HeroKpi
                  label="Win Rate"
                  value={winRate == null ? '—' : `${winRate.toFixed(0)}%`}
                  caption="All time"
                  accent={winRate == null ? 'neutral' : winRate >= 50 ? 'bull' : 'bear'}
                />
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Lifetime portfolio stats block — filter-aware ───────────── */}
      <PortfolioStats />

      {/* ── Monthly time-series chart ───────────────────────────────── */}
      <PortfolioChart />


      {/* ── Main grid: positions table (left) + allocation + accounts (right) ── */}
      <div className="grid grid-cols-12 gap-5">
        {/* ── Open positions — premium card grid ─────────────────── */}
        <section className="col-span-12 lg:col-span-8 space-y-3">
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
          {/* Allocation breakdown */}
          <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
            <div className="px-5 py-3.5 border-b border-border-subtle">
              <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Exposure</div>
              <h3 className="text-sm font-bold text-text-primary mt-0.5">Allocation</h3>
              <p className="text-[11px] text-text-muted mt-0.5">By asset class</p>
            </div>
            <div className="p-5">
              {allocation.total === 0 ? (
                <div className="text-center py-6">
                  <div className="text-xs text-text-muted">No exposure yet</div>
                  <div className="text-[11px] text-text-muted mt-1">Open a position to see allocation breakdown.</div>
                </div>
              ) : (
                <>
                  {/* Stacked bar */}
                  <div className="flex h-2.5 rounded-full overflow-hidden bg-bg-hover">
                    {Object.entries(allocation.buckets).map(([cat, val]) => {
                      if (val <= 0) return null;
                      const pct = (val / allocation.total) * 100;
                      return (
                        <div
                          key={cat}
                          className="transition-all duration-500"
                          style={{ width: `${pct}%`, background: CAT_COLORS[cat] || '#9CA3AF' }}
                          title={`${cat} · ${pct.toFixed(1)}%`}
                        />
                      );
                    })}
                  </div>
                  {/* Legend */}
                  <div className="mt-4 space-y-2.5">
                    {Object.entries(allocation.buckets)
                      .filter(([, v]) => v > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([cat, val]) => {
                        const pct = (val / allocation.total) * 100;
                        return (
                          <div key={cat} className="flex items-center gap-2.5 text-xs">
                            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: CAT_COLORS[cat] || '#9CA3AF' }} />
                            <span className="font-semibold text-text-primary capitalize flex-1">{cat.toLowerCase()}</span>
                            <span className="font-mono tabular-nums font-bold text-text-primary">{pct.toFixed(1)}%</span>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Account split */}
          <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
            <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Wallet</div>
                <h3 className="text-sm font-bold text-text-primary mt-0.5">Accounts</h3>
              </div>
              <Link to="/wallet" className="text-[11px] font-semibold text-primary-600 hover:underline">Manage →</Link>
            </div>
            <div className="grid grid-cols-2 divide-x divide-border-subtle">
              <div className="px-5 py-4 text-center">
                <div className="text-2xl font-bold font-mono tabular-nums text-text-primary">{data.accounts.live}</div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mt-1">Live</div>
              </div>
              <div className="px-5 py-4 text-center">
                <div className="text-2xl font-bold font-mono tabular-nums text-text-primary">{data.accounts.demo}</div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mt-1">Demo</div>
              </div>
            </div>
          </div>

          {/* "Trades" breakdown card removed — its 4 rows (Winning /
              Losing / Closed / Open) were exact duplicates of the
              Lifetime stats block above. */}
        </aside>
      </div>

      {/* ── Recent activity (full-width row) ──────────────────────── */}
      <section className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] font-extrabold text-text-muted">Live</div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
              <h2 className="text-sm font-bold text-text-primary">Recent activity</h2>
            </div>
          </div>
          <Link to="/reports" className="text-xs font-semibold text-primary-600 hover:underline">View all →</Link>
        </div>
        {recentActivity.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-bg-hover flex items-center justify-center text-text-muted">
              <ChartIcon />
            </div>
            <div className="mt-3 text-sm font-semibold text-text-primary">No trades yet</div>
            <div className="mt-1 text-xs text-text-muted">Your trade history will appear here.</div>
            <Link to="/trade" className="mt-4 inline-flex items-center gap-1.5 bg-primary-500 hover:bg-primary-600 active:scale-[0.98] text-white text-xs font-bold px-4 py-2 rounded-xl transition-all">
              Start Trading
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {recentActivity.slice(0, 8).map((t) => (
              <div key={t.id} className="px-5 py-3 flex items-center justify-between hover:bg-bg-hover transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold border"
                    style={{
                      background: t.side === 'BUY' ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)',
                      color: t.side === 'BUY' ? '#16A34A' : '#DC2626',
                      borderColor: t.side === 'BUY' ? 'rgba(22,163,74,0.30)' : 'rgba(220,38,38,0.30)',
                    }}
                  >
                    {t.side === 'BUY' ? '↑' : '↓'}
                  </span>
                  <AssetIcon symbol={t.symbol} size={26} round />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{t.symbol}</div>
                    <div className="text-[11px] font-mono text-text-muted">
                      {Number(t.quantity).toLocaleString('en-US', { maximumFractionDigits: 6 })} @ {Number(t.price).toFixed(2)}
                    </div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div
                    className="text-[10px] uppercase font-bold tracking-wider"
                    style={{ color: t.side === 'BUY' ? '#16A34A' : '#DC2626' }}
                  >
                    {t.side}
                  </div>
                  <div className="text-[11px] text-text-muted">{timeAgo(t.executedAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
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

function PortfolioChart({ accountId }) {
  const [buckets, setBuckets] = useState([]);
  const [tab, setTab] = useState('netProfit');
  const [range, setRange] = useState('1y');
  const [loading, setLoading] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(null);

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
