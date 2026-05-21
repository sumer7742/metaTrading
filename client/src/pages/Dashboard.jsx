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

      {/* ── Equity hero card ─────────────────────────────────────── */}
      {(() => {
        const eq = fmtMoneyBoth(equity, primaryCur, fxRate);
        const bal = fmtMoneyBoth(liveBalance, primaryCur, fxRate);
        const ur = fmtMoneyDual(unrealized, primaryCur, fxRate, true);
        const pct = equity > 0 ? (unrealized / equity) * 100 : 0;
        const pos = unrealized >= 0;
        return (
          <div className="bg-white border border-border-dark rounded-2xl p-6 shadow-sm relative overflow-hidden">
            {/* Soft blue glow top-right */}
            <span className="pointer-events-none absolute -top-12 -right-12 w-48 h-48 rounded-full" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.12), transparent 70%)' }} />

            <div className="relative grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Total equity */}
              <div className="lg:col-span-2">
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold text-text-muted">Total Equity</div>
                <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                  <div className="text-4xl sm:text-5xl font-bold font-mono tabular-nums text-text-primary leading-none">{eq.primary}</div>
                  {Math.abs(unrealized) > 0.005 && (
                    <span
                      className="inline-flex items-center gap-1 text-sm font-bold font-mono px-2 py-1 rounded-lg"
                      style={{
                        color: pos ? '#16A34A' : '#DC2626',
                        background: pos ? 'rgba(22,163,74,0.10)' : 'rgba(220,38,38,0.10)',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        {pos ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
                      </svg>
                      {ur.primary}
                      <span className="text-text-muted/80 font-normal">({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>
                    </span>
                  )}
                </div>
                {eq.secondary && (
                  <div className="text-xs font-mono text-text-muted mt-2">{eq.secondary}</div>
                )}

                {/* Balance breakdown — primary currency + any non-primary wallets */}
                <div className="mt-4 pt-4 border-t border-border-subtle flex items-center gap-4 flex-wrap text-[11px]">
                  <span className="text-text-muted">Balance</span>
                  <span className="font-mono font-semibold text-text-primary">{bal.primary}</span>
                  {bal.secondary && <span className="font-mono text-text-muted">({bal.secondary})</span>}
                  {Object.entries(liveByCur).filter(([c]) => c !== primaryCur).map(([c, t]) => (
                    <span key={c} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-hover font-mono text-text-secondary">
                      <span className="text-text-muted">{c}</span>
                      {currencySymbol(c)}{Math.round(Number(t.balance) || 0).toLocaleString()}
                    </span>
                  ))}
                </div>
              </div>

              {/* Mini metrics — won't overflow because hero card is wide */}
              <div className="grid grid-cols-2 gap-3">
                <MiniStat label="Open" value={positions.length} accent="primary" />
                <MiniStat
                  label="Today"
                  value={fmtMoney(todayPnl, primaryCur)}
                  accent={todayPnl > 0 ? 'bull' : todayPnl < 0 ? 'bear' : 'neutral'}
                />
                <MiniStat
                  label="Lifetime"
                  value={fmtMoney(lifetimePnl, primaryCur)}
                  accent={lifetimePnl > 0 ? 'bull' : lifetimePnl < 0 ? 'bear' : 'neutral'}
                />
                <MiniStat
                  label="Win Rate"
                  value={winRate == null ? '—' : `${winRate.toFixed(1)}%`}
                  accent={winRate == null ? 'neutral' : winRate >= 50 ? 'bull' : 'bear'}
                />
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Main grid: positions table (left) + allocation + accounts (right) ── */}
      <div className="grid grid-cols-12 gap-5">
        {/* ── Open positions — premium card grid ─────────────────── */}
        <section className="col-span-12 lg:col-span-8 space-y-3">
          {/* Section header */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-text-primary">Open Positions</h2>
              <span className="inline-flex items-center justify-center min-w-[24px] h-[20px] px-1.5 rounded-full bg-primary-500/10 text-primary-600 text-[10px] font-bold">
                {livePositions.length}
              </span>
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
              <h3 className="text-sm font-bold text-text-primary">Allocation</h3>
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
              <h3 className="text-sm font-bold text-text-primary">Accounts</h3>
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

          {/* Trades breakdown — winning/losing/open compact */}
          <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
            <div className="px-5 py-3.5 border-b border-border-subtle">
              <h3 className="text-sm font-bold text-text-primary">Trades</h3>
              <p className="text-[11px] text-text-muted mt-0.5">Live account · all-time</p>
            </div>
            <div className="p-3 space-y-1">
              <TradeBreakdownRow label="Winning" value={data.trades.winningLive} today={data.trades.winningLiveToday} tone="bull" />
              <TradeBreakdownRow label="Losing" value={data.trades.losingLive} today={data.trades.losingLiveToday} tone="bear" />
              <TradeBreakdownRow label="Closed" value={data.trades.closedLive} today={data.trades.closedLiveToday} tone="neutral" />
              <TradeBreakdownRow label="Open" value={data.trades.openLive} tone="primary" />
            </div>
          </div>
        </aside>
      </div>

      {/* ── Recent activity (full-width row) ──────────────────────── */}
      <section className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm">
        <div className="px-5 py-3.5 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
            <h2 className="text-base font-bold text-text-primary">Recent Activity</h2>
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
