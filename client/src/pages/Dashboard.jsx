import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtMoney, fmtMoneyDual, currencySymbol } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // symbol → live last price. Populated from ticker:<symbol> subs and used to
  // mark-to-market open positions client-side, so the equity card moves on
  // every tick rather than only on the 15s polling cycle.
  const [priceMap, setPriceMap] = useState({});
  const fxRate = useFxRate();

  // Polling: refresh every 15s, but pause when the tab is hidden so we don't
  // hammer the server when the user isn't looking. Resumes immediately when
  // they come back so they never see stale numbers on focus.
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

    const startPoll = () => {
      if (intervalId) return;
      intervalId = setInterval(load, 15000);
    };
    const stopPoll = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) stopPoll();
      else { load(); startPoll(); }
    };

    load();
    if (!document.hidden) startPoll();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Refresh dashboard immediately whenever a server-side wallet/position
  // event fires — closes a polling-cycle gap so realized PnL hits the UI
  // within a second, not up to 15s later.
  useEffect(() => {
    const refetch = async () => {
      try {
        const res = await api.get('/user/dashboard');
        setData(res.data.data);
      } catch (_) {}
    };
    const w = wsClient.subscribe('wallet', refetch);
    const p = wsClient.subscribe('positions', refetch);
    return () => {
      w && w();
      p && p();
    };
  }, []);

  // Subscribe to ticker for every symbol the user holds open, so unrealized
  // PnL (and thus equity) moves on every price tick.
  const openSymbols = useMemo(() => {
    const list = data?.equity?.openPositions || [];
    return [...new Set(list.map((p) => p.symbol))];
  }, [data]);
  useEffect(() => {
    if (!openSymbols.length) return;
    const unsubs = openSymbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (tick) => {
        setPriceMap((prev) => ({ ...prev, [sym]: tick.lastPrice }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [openSymbols]);

  if (loading) return <div className="text-gray-400 p-4">Loading dashboard…</div>;
  if (!data) return <div className="text-bear p-4">Failed to load dashboard.</div>;

  const fullName = [data.user?.firstName, data.user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const kycPending = data.user?.kycStatus !== 'APPROVED';
  const kycStep = data.user?.kycStatus === 'PENDING' ? 1 : data.user?.kycStatus === 'APPROVED' ? 2 : 0;
  const primaryCur = data.balance?.primaryCurrency || 'INR';
  const liveBalance = Number(data.balance?.live || 0);
  // Recompute unrealized client-side using live ticker prices when available;
  // fall back to the server-computed number for symbols we haven't received
  // a tick for yet. This is what makes the equity number move tick-by-tick.
  const openPositionsList = data.equity?.openPositions || [];
  const liveUnrealized = openPositionsList.reduce((sum, p) => {
    const mark = Number(priceMap[p.symbol] ?? 0);
    if (!mark) return sum; // no live tick yet for this symbol — skip
    const entry = Number(p.entryPrice);
    const qty = Number(p.quantity);
    return sum + (p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty);
  }, 0);
  const haveAllTicks = openPositionsList.length > 0
    && openPositionsList.every((p) => priceMap[p.symbol] != null);
  const unrealized = haveAllTicks ? liveUnrealized : Number(data.equity?.unrealizedPnl || 0);
  const equity = liveBalance + unrealized;
  const todayPnl = Number(data.pnl?.realizedToday || 0);
  const lifetimePnl = Number(data.pnl?.realizedLifetime || 0);
  const winRate = data.pnl?.winRate;
  const liveByCur = data.balance?.liveByCurrency || {};
  const recentActivity = data.recentActivity || [];

  return (
    <div className="space-y-6 max-w-[1600px]">
      {/* Top header row: welcome + pending review + live balance */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold text-white">
            Welcome back, <span className="text-white">{fullName}</span>
          </h1>
          <p className="text-sm text-gray-400 mt-2">Here is your portfolio overview for today.</p>
        </div>

        <div className="flex items-center gap-3">
          {data.user.kycStatus === 'PENDING' && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-warn/40 bg-warn/5">
              <ShieldIcon />
              <span className="text-warn font-medium text-sm">Pending Review</span>
            </div>
          )}
          {data.user.kycStatus === 'APPROVED' && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg border border-bull/40 bg-bull/5">
              <CheckIcon />
              <span className="text-bull font-medium text-sm">Verified</span>
            </div>
          )}

          {/* Header card now leads with EQUITY (balance + unrealized PnL of
              open positions) — this is the number traders watch move tick-by-
              tick. Wallet balance alone only changes on deposit/withdraw or
              when a position closes (realized PnL), which made the headline
              feel "stuck" while a position was open. Balance is shown below
              as a secondary line so the user can still see settled funds. */}
          {(() => {
            const eq = fmtMoneyDual(equity, primaryCur, fxRate);
            const ur = fmtMoneyDual(unrealized, primaryCur, fxRate, true);
            const bal = fmtMoneyDual(liveBalance, primaryCur, fxRate);
            return (
              <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border-dark bg-bg-card min-w-[240px]">
                <div className="w-10 h-10 rounded-md bg-bg-hover flex items-center justify-center text-teal-accent">
                  <WalletIcon />
                </div>
                <div className="text-right flex-1">
                  <div className="text-[11px] uppercase tracking-wider text-gray-500">Equity (Live)</div>
                  <div className="text-2xl font-bold text-white">{eq.primary}</div>
                  {eq.secondary && (
                    <div className="text-[11px] font-mono text-gray-500">{eq.secondary}</div>
                  )}
                  {Math.abs(unrealized) > 0.005 && (
                    <div className={`text-[11px] font-mono mt-0.5 ${unrealized >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {ur.primary} open
                    </div>
                  )}
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    Bal {bal.primary}
                    {bal.secondary && <span className="ml-1">({bal.secondary})</span>}
                    {Object.keys(liveByCur).length > 1 && (
                      <> · {Object.entries(liveByCur)
                        .filter(([c]) => c !== primaryCur)
                        .map(([c, t]) => `${currencySymbol(c)}${Math.round(t.balance).toLocaleString()}`)
                        .join(' · ')}</>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* KYC banner */}
      {kycPending && (
        <div className="rounded-xl bg-teal-accent text-bg-dark px-6 py-5 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-5">
            <ProgressRing step={kycStep} total={2} />
            <div>
              <div className="text-xl font-bold">Complete Your Identity Verification</div>
              <div className="text-sm opacity-80 mt-1 max-w-2xl">
                Unlock higher transaction limits, gain access to new payment methods, and enable additional trading accounts
              </div>
            </div>
          </div>
          <Link
            to="/profile"
            className="inline-flex items-center gap-2 bg-white text-bg-dark px-5 py-2.5 rounded-md font-semibold hover:bg-gray-100"
          >
            <CheckCircleIcon />
            Verify Now
          </Link>
        </div>
      )}

      {/* Hero stats — the four numbers a trader actually checks first.
          Each money card shows INR primary + USD secondary (small gray). */}
      {(() => {
        const heroEq = fmtMoneyDual(equity, primaryCur, fxRate);
        const heroUr = fmtMoneyDual(unrealized, primaryCur, fxRate, true);
        const heroToday = fmtMoneyDual(todayPnl, primaryCur, fxRate, true);
        const heroLife = fmtMoneyDual(lifetimePnl, primaryCur, fxRate, true);
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <HeroStat
              label="Equity"
              value={heroEq.primary}
              secondary={heroEq.secondary}
              subline={`Unrealized ${heroUr.primary}`}
              sublineColor={unrealized >= 0 ? 'text-bull' : 'text-bear'}
              tone="primary"
            />
            <HeroStat
              label="P&L Today"
              value={heroToday.primary}
              secondary={heroToday.secondary}
              tone={todayPnl > 0 ? 'bull' : todayPnl < 0 ? 'bear' : 'neutral'}
            />
            <HeroStat
              label="Win Rate"
              value={winRate == null ? '—' : `${winRate.toFixed(1)}%`}
              subline={
                winRate == null
                  ? 'No closed trades yet'
                  : `${data.trades.winningLive}W · ${data.trades.losingLive}L`
              }
              tone={winRate == null ? 'neutral' : winRate >= 50 ? 'bull' : 'bear'}
            />
            <HeroStat
              label="P&L (Lifetime)"
              value={heroLife.primary}
              secondary={heroLife.secondary}
              tone={lifetimePnl > 0 ? 'bull' : lifetimePnl < 0 ? 'bear' : 'neutral'}
            />
          </div>
        );
      })()}

      {/* Performance Overview */}
      <div>
        <h2 className="text-2xl font-bold text-white">Performance Overview</h2>
        <p className="text-sm text-gray-400 mt-1">Real-time metrics, account analytics, and trading activity breakdown.</p>
      </div>

      {/* Metric cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={<BriefcaseIcon />}
          iconBg="bg-teal-accent/10 text-teal-accent border border-teal-accent/30"
          value={data.accounts.live}
          label="Accounts (Live)"
        />
        <MetricCard
          icon={<BriefcaseIcon />}
          iconBg="bg-teal-accent/10 text-teal-accent border border-teal-accent/30"
          value={data.accounts.demo}
          label="Accounts (Demo)"
        />
        <MetricCard
          icon={<ActivityIcon />}
          iconBg="bg-bg-hover text-gray-300"
          value={data.trades.totalLive}
          today={data.trades.totalLiveToday}
          label="Total Trades (Live)"
        />
        <MetricCard
          icon={<PieChartIcon />}
          iconBg="bg-warn/10 text-warn border border-warn/30"
          value={data.trades.openLive}
          // No "Today" badge — open count is point-in-time, not a delta.
          label="Open Trades (Live)"
        />
        <MetricCard
          icon={<CheckSquareIcon />}
          iconBg="bg-bg-hover text-gray-300"
          value={data.trades.closedLive}
          today={data.trades.closedLiveToday}
          label="Closed Trades (Live)"
        />
        <MetricCard
          icon={<TrendingUpIcon />}
          iconBg="bg-bull/10 text-bull border border-bull/30"
          value={data.trades.winningLive}
          today={data.trades.winningLiveToday}
          label="Winning Trades (Live)"
        />
        <MetricCard
          icon={<TrendingDownIcon />}
          iconBg="bg-bear/10 text-bear border border-bear/30"
          value={data.trades.losingLive}
          today={data.trades.losingLiveToday}
          label="Losing Trades (Live)"
        />
        <MetricCard
          icon={<ActivityIcon />}
          iconBg="bg-bg-hover text-gray-300"
          value={data.trades.totalDemo}
          today={data.trades.totalDemoToday}
          label="Total Trades (Demo)"
        />
      </div>

      {/* Recent activity + quick actions side-by-side on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent activity feed — last 10 fills */}
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
            <h3 className="text-white font-semibold">Recent Activity</h3>
            <Link to="/orders" className="text-xs text-teal-accent hover:underline">View all →</Link>
          </div>
          {recentActivity.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              No trades yet. Place your first order from the Trade page.
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {recentActivity.map((t) => (
                <div key={t.id} className="px-5 py-3 flex items-center justify-between hover:bg-bg-hover transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                      t.side === 'BUY' ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'
                    }`}>
                      {t.side}
                    </span>
                    <span className="text-white font-medium">{t.symbol}</span>
                    <span className="text-xs text-gray-500 font-mono">
                      {Number(t.quantity).toFixed(4)} @ {Number(t.price).toFixed(2)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 ml-3 whitespace-nowrap">
                    {timeAgo(t.executedAt)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions — stacked on the right column */}
        <div className="space-y-3">
          <Link to="/trade" className="card p-4 hover:border-teal-accent transition-colors flex items-center gap-3">
            <div className="text-teal-accent"><ChartIcon /></div>
            <div className="flex-1">
              <div className="text-white font-semibold text-sm">Start Trading</div>
              <div className="text-[11px] text-gray-400">Open new positions</div>
            </div>
          </Link>
          <Link to="/wallet" className="card p-4 hover:border-teal-accent transition-colors flex items-center gap-3">
            <div className="text-teal-accent"><WalletIcon /></div>
            <div className="flex-1">
              <div className="text-white font-semibold text-sm">Manage Funds</div>
              <div className="text-[11px] text-gray-400">Deposit / Withdraw</div>
            </div>
          </Link>
          <Link to="/accounts" className="card p-4 hover:border-teal-accent transition-colors flex items-center gap-3">
            <div className="text-teal-accent"><BriefcaseIcon /></div>
            <div className="flex-1">
              <div className="text-white font-semibold text-sm">Trading Accounts</div>
              <div className="text-[11px] text-gray-400">Leverage, mode, history</div>
            </div>
          </Link>
        </div>
      </div>
    </div>
  );
}

// Relative-time helper: "5m ago", "2h ago", "3d ago".
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

function HeroStat({ label, value, secondary, subline, sublineColor = 'text-gray-500', tone = 'neutral' }) {
  // Tone drives the accent color of the value + the left border. Keeps the
  // grid coherent visually while still letting bull/bear stand out.
  const valueClass =
    tone === 'bull' ? 'text-bull' :
    tone === 'bear' ? 'text-bear' :
    tone === 'primary' ? 'text-white' :
    'text-white';
  const accent =
    tone === 'bull' ? 'border-l-bull' :
    tone === 'bear' ? 'border-l-bear' :
    tone === 'primary' ? 'border-l-teal-accent' :
    'border-l-border-dark';
  return (
    <div className={`card p-5 border-l-4 ${accent}`}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-2 font-mono ${valueClass}`}>{value}</div>
      {secondary && <div className="text-[11px] mt-0.5 font-mono text-gray-500">{secondary}</div>}
      {subline && <div className={`text-[11px] mt-1 ${sublineColor}`}>{subline}</div>}
    </div>
  );
}

// ============= Helpers =============

function MetricCard({ icon, iconBg, value, today, label }) {
  return (
    <div className="card p-5 relative overflow-hidden">
      <div className="flex items-start justify-between mb-6">
        <div className={`w-11 h-11 rounded-lg flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        {today != null && (
          <span className="text-[11px] text-gray-400 bg-bg-hover px-2.5 py-1 rounded-full border border-border-subtle">
            {today} Today
          </span>
        )}
      </div>
      <div className="text-4xl font-bold text-white mb-1">{value}</div>
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
    </div>
  );
}

function ProgressRing({ step, total }) {
  const pct = (step / total) * 100;
  const r = 22;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <div className="relative w-14 h-14">
      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 60 60">
        <circle cx="30" cy="30" r={r} stroke="rgba(255,255,255,0.25)" strokeWidth="4" fill="none" />
        <circle
          cx="30" cy="30" r={r}
          stroke="white" strokeWidth="4" fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-bg-dark font-bold text-sm">
        {step}/{total}
      </div>
    </div>
  );
}

// ============ Icons ============
const Svg = ({ children, ...p }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
);

const ShieldIcon = () => <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Svg>;
const CheckIcon = () => <Svg><polyline points="20 6 9 17 4 12" /></Svg>;
const CheckCircleIcon = () => <Svg><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></Svg>;
const WalletIcon = () => <Svg><path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1" /><path d="M16 12h4" /></Svg>;
const BriefcaseIcon = () => <Svg><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></Svg>;
const ActivityIcon = () => <Svg><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></Svg>;
const PieChartIcon = () => <Svg><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></Svg>;
const CheckSquareIcon = () => <Svg><polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></Svg>;
const TrendingUpIcon = () => <Svg><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></Svg>;
const TrendingDownIcon = () => <Svg><polyline points="23 18 13.5 8.5 8.5 13.5 1 6" /><polyline points="17 18 23 18 23 12" /></Svg>;
const ChartIcon = () => <Svg><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></Svg>;
