import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import AssetIcon from '../components/AssetIcon';
import { wsClient } from '../services/ws';
import { fmtMoney, fmtMoneyDual, fmtMoneyBoth, currencySymbol } from '../utils/format';
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
  // The server's `balance.live` only counts the wallet in the primary
  // currency — which leaves equity reading $0 / ₹0 when the user's
  // money is held in a different currency (e.g. INR-primary user with
  // $2 659 USD). Fall back to summing every currency in
  // `liveByCurrency` and converting into the primary currency via fxRate.
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
      // Unknown pairing → assume already in primary so we don't drop it.
      return sum + bal;
    }, 0);
  })();
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
  const recentActivity = data.recentActivity || [];

  return (
    <div className="space-y-6 max-w-[1600px]">
      {/* ─── Hero card ─────────────────────────────────────────────────
          Single prominent card at the top: welcome on the left, big live
          equity figure on the right, with a subtle radial yellow glow
          spilling from the top-right corner so the brand color carries
          through without dominating the page. KYC chip sits inline as a
          status indicator instead of taking a separate card slot. */}
      {(() => {
        // Hero equity + balance = headline totals — show BOTH USD and INR.
        // Unrealized PnL is a sub-figure, USD-only.
        const eq = fmtMoneyBoth(equity, primaryCur, fxRate);
        const bal = fmtMoneyBoth(liveBalance, primaryCur, fxRate);
        const ur = fmtMoneyDual(unrealized, primaryCur, fxRate, true);
        const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
        return (
          <div className="relative overflow-hidden rounded-2xl border border-border-dark bg-bg-card p-6 sm:p-8">
            {/* Decorative glow + grid pattern — pure CSS, no images */}
            <div
              className="absolute inset-0 pointer-events-none opacity-50"
              style={{ background: 'radial-gradient(circle at 100% 0%, rgba(252, 213, 53, 0.12), transparent 55%)' }}
            />
            <div
              className="absolute inset-0 pointer-events-none opacity-[0.03]"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)',
                backgroundSize: '32px 32px',
              }}
            />

            <div className="relative flex items-start justify-between gap-6 flex-wrap">
              {/* Left — welcome */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] font-bold text-primary-500 mb-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
                  Live · {today}
                </div>
                <h1 className="text-3xl sm:text-4xl font-bold text-white">
                  Welcome back, <span className="text-primary-500">{fullName}</span>
                </h1>
                <p className="text-sm text-text-secondary mt-2 max-w-xl">
                  Here's your portfolio at a glance — equity, P&L, and recent activity all in one view.
                </p>

                {/* KYC inline chip */}
                <div className="mt-4 flex items-center gap-2">
                  {data.user.kycStatus === 'APPROVED' && (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-bull/15 text-bull border border-bull/30">
                      <CheckIcon /> KYC Verified
                    </span>
                  )}
                  {data.user.kycStatus === 'PENDING' && (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-warn/15 text-warn border border-warn/30">
                      <ShieldIcon /> KYC Under Review
                    </span>
                  )}
                  {data.user.kycStatus !== 'APPROVED' && data.user.kycStatus !== 'PENDING' && (
                    <Link
                      to="/profile"
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-bear/10 text-bear border border-bear/30 hover:bg-bear/20 transition-colors"
                    >
                      <ShieldIcon /> Verify Identity
                    </Link>
                  )}
                  <Link
                    to="/trade"
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-primary-500/10 text-primary-500 border border-primary-500/30 hover:bg-primary-500/20 transition-colors"
                  >
                    <ChartIcon /> Open Chart
                  </Link>
                </div>
              </div>

              {/* Right — big equity readout */}
              <div className="text-right shrink-0">
                <div className="text-[10px] uppercase tracking-[0.25em] text-text-muted font-bold mb-2">
                  Equity (Live)
                </div>
                <div className="text-4xl sm:text-5xl font-bold text-white font-mono leading-none">
                  {eq.primary}
                </div>
                {eq.secondary && (
                  <div className="text-sm font-mono text-text-muted mt-1.5">{eq.secondary}</div>
                )}
                {Math.abs(unrealized) > 0.005 && (
                  <div className={`inline-flex items-center gap-1 mt-2 text-sm font-mono ${unrealized >= 0 ? 'text-bull' : 'text-bear'}`}>
                    <span>{unrealized >= 0 ? '↑' : '↓'}</span>
                    <span>{ur.primary}</span>
                    <span className="text-text-muted text-xs">unrealized</span>
                  </div>
                )}
                <div className="text-[11px] font-mono text-text-muted mt-2 border-t border-border-subtle pt-2">
                  Balance <span className="text-text-secondary">{bal.primary}</span>
                  {bal.secondary && <span className="text-text-muted/70 ml-1">({bal.secondary})</span>}
                  {Object.keys(liveByCur).length > 1 && (
                    <span> · {Object.entries(liveByCur)
                      .filter(([c]) => c !== primaryCur)
                      .map(([c, t]) => `${currencySymbol(c)}${Math.round(t.balance).toLocaleString()}`)
                      .join(' · ')}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* KYC banner — refined, only when truly not started */}
      {kycPending && data.user.kycStatus !== 'PENDING' && (
        <div className="relative overflow-hidden rounded-xl border border-primary-500/40 bg-gradient-to-r from-primary-500/10 to-transparent p-5 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-lg bg-primary-500 flex items-center justify-center text-bg-dark">
              <ShieldIcon />
            </div>
            <div>
              <div className="text-base font-bold text-white">Complete Identity Verification</div>
              <div className="text-xs text-text-secondary mt-0.5 max-w-2xl">
                Unlock higher transaction limits, new payment methods, and additional trading accounts.
              </div>
            </div>
          </div>
          <Link
            to="/profile"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg font-semibold text-sm text-bg-dark transition-transform hover:scale-105"
            style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
          >
            <CheckCircleIcon />
            Verify Now
          </Link>
        </div>
      )}

      {/* Hero stats — four key metrics. Equity already lives in the hero
          card above, so this row covers complementary numbers: P&L today,
          P&L lifetime, win rate, and total live trades. Each tile gets an
          icon pill keyed to its tone. */}
      {(() => {
        const heroToday = fmtMoneyDual(todayPnl, primaryCur, fxRate, true);
        const heroLife = fmtMoneyDual(lifetimePnl, primaryCur, fxRate, true);
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <HeroStat
              icon={<TrendingUpIcon />}
              label="P&L Today"
              value={heroToday.primary}
              secondary={heroToday.secondary}
              tone={todayPnl > 0 ? 'bull' : todayPnl < 0 ? 'bear' : 'neutral'}
            />
            <HeroStat
              icon={<PieChartIcon />}
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
              icon={<ActivityIcon />}
              label="Trades (Live)"
              value={data.trades.totalLive}
              subline={`${data.trades.totalLiveToday} today · ${data.trades.openLive} open`}
              tone="primary"
            />
            <HeroStat
              icon={<TrendingUpIcon />}
              label="P&L (Lifetime)"
              value={heroLife.primary}
              secondary={heroLife.secondary}
              tone={lifetimePnl > 0 ? 'bull' : lifetimePnl < 0 ? 'bear' : 'neutral'}
            />
          </div>
        );
      })()}

      {/* Performance Overview — small heading with a horizontal accent rule
          so the section break is visible without taking a full row of space. */}
      <div className="flex items-end justify-between gap-4 pt-2">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-primary-500 font-bold mb-1">
            <span className="w-6 h-px bg-primary-500" />
            Analytics
          </div>
          <h2 className="text-2xl font-bold text-white">Performance Overview</h2>
          <p className="text-sm text-text-secondary mt-1">Real-time metrics, account analytics, and trading activity breakdown.</p>
        </div>
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
          <div className="px-5 py-3.5 border-b border-border-dark flex items-center justify-between bg-gradient-to-r from-bg-card to-bg-card/50">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
              <h3 className="text-white font-semibold">Recent Activity</h3>
            </div>
            <Link to="/orders" className="text-xs text-primary-500 hover:underline">View all →</Link>
          </div>
          {recentActivity.length === 0 ? (
            <div className="p-10 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-bg-hover flex items-center justify-center text-text-muted mb-3">
                <ChartIcon />
              </div>
              <div className="text-sm text-text-secondary">No trades yet</div>
              <div className="text-xs text-text-muted mt-1">Your trade history will appear here.</div>
              <Link to="/trade" className="inline-flex mt-4 btn-primary text-xs px-4 py-2">
                Start Trading
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {recentActivity.map((t) => (
                <div key={t.id} className="px-5 py-3.5 flex items-center justify-between hover:bg-bg-hover transition-colors group">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold border transition-transform group-hover:scale-110 ${
                      t.side === 'BUY'
                        ? 'bg-bull/15 text-bull border-bull/30'
                        : 'bg-bear/15 text-bear border-bear/30'
                    }`}>
                      {t.side === 'BUY' ? '↑' : '↓'}
                    </span>
                    <div className="min-w-0 flex items-center gap-2">
                      <AssetIcon symbol={t.symbol} size={22} round />
                      <div className="min-w-0">
                        <div className="text-sm text-white font-semibold">{t.symbol}</div>
                        <div className="text-[11px] text-text-muted font-mono">
                          {Number(t.quantity).toFixed(4)} @ {Number(t.price).toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`text-[10px] uppercase font-bold tracking-wider ${t.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>
                      {t.side}
                    </div>
                    <div className="text-[11px] text-text-muted">{timeAgo(t.executedAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions — premium hover with yellow glow + arrow slide */}
        <div className="space-y-3">
          <QuickAction to="/trade" icon={<ChartIcon />} title="Start Trading" desc="Open new positions" tone="primary" />
          <QuickAction to="/wallet" icon={<WalletIcon />} title="Manage Funds" desc="Deposit, withdraw, transfer" tone="bull" />
          <QuickAction to="/accounts" icon={<BriefcaseIcon />} title="Trading Accounts" desc="Leverage, mode, history" tone="info" />
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

function HeroStat({ icon, label, value, secondary, subline, sublineColor = 'text-text-muted', tone = 'neutral' }) {
  // Each tone gets a coordinated accent palette: gradient pill behind the
  // icon, value color, and a subtle glow ring on hover.
  const palette =
    tone === 'bull' ? {
      iconBg: 'bg-bull/10 text-bull border-bull/30',
      valueClass: 'text-bull',
      accent: 'before:bg-bull/40',
    } :
    tone === 'bear' ? {
      iconBg: 'bg-bear/10 text-bear border-bear/30',
      valueClass: 'text-bear',
      accent: 'before:bg-bear/40',
    } :
    tone === 'primary' ? {
      iconBg: 'bg-primary-500/10 text-primary-500 border-primary-500/30',
      valueClass: 'text-white',
      accent: 'before:bg-primary-500/40',
    } : {
      iconBg: 'bg-bg-hover text-text-secondary border-border-dark',
      valueClass: 'text-white',
      accent: 'before:bg-border-dark',
    };
  return (
    <div className={`relative card p-5 overflow-hidden transition-all hover:border-border-accent/50 group
                     before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${palette.accent}`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${palette.iconBg} mb-3 transition-transform group-hover:scale-110`}>
        {icon}
      </div>
      <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">{label}</div>
      <div className={`text-2xl font-bold mt-1 font-mono ${palette.valueClass}`}>{value}</div>
      {secondary && <div className="text-[11px] mt-0.5 font-mono text-text-muted">{secondary}</div>}
      {subline && <div className={`text-[11px] mt-1.5 ${sublineColor}`}>{subline}</div>}
    </div>
  );
}

// ============= Helpers =============

function MetricCard({ icon, iconBg, value, today, label }) {
  return (
    <div className="card p-5 relative overflow-hidden transition-all hover:border-border-accent/40 hover:-translate-y-0.5 group">
      {/* Subtle radial glow on hover, anchored top-right so multiple
          adjacent cards don't compete visually. */}
      <div
        className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: 'radial-gradient(circle at 100% 0%, rgba(252, 213, 53, 0.08), transparent 60%)' }}
      />
      <div className="relative">
        <div className="flex items-start justify-between mb-5">
          <div className={`w-11 h-11 rounded-lg flex items-center justify-center transition-transform group-hover:scale-110 ${iconBg}`}>
            {icon}
          </div>
          {today != null && (
            <span className="text-[11px] text-text-secondary bg-bg-hover px-2.5 py-1 rounded-full border border-border-subtle font-mono">
              +{today} today
            </span>
          )}
        </div>
        <div className="text-3xl sm:text-4xl font-bold text-white mb-1 font-mono">{value}</div>
        <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">{label}</div>
      </div>
    </div>
  );
}

/** Quick-action card on the right rail. Tone drives the icon pill color
 *  + the arrow that slides in on hover so each tile has visual identity. */
function QuickAction({ to, icon, title, desc, tone = 'primary' }) {
  const toneCls =
    tone === 'bull' ? 'bg-bull/10 text-bull border-bull/30 group-hover:bg-bull/20' :
    tone === 'info' ? 'bg-info/10 text-info border-info/30 group-hover:bg-info/20' :
    'bg-primary-500/10 text-primary-500 border-primary-500/30 group-hover:bg-primary-500/20';
  return (
    <Link
      to={to}
      className="card p-4 hover:border-border-accent/60 transition-all flex items-center gap-3 group hover:-translate-y-0.5"
    >
      <div className={`w-11 h-11 rounded-lg flex items-center justify-center border transition-colors ${toneCls}`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-white font-semibold text-sm">{title}</div>
        <div className="text-[11px] text-text-muted">{desc}</div>
      </div>
      <span className="text-text-muted text-xl opacity-0 group-hover:opacity-100 group-hover:text-primary-500 transition-all -translate-x-2 group-hover:translate-x-0">
        →
      </span>
    </Link>
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
