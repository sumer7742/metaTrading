import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';
import { useAuthStore } from '../store/auth';
import { ROLES, roleHome } from '../config/roles';
import PageHero from '../components/PageHero';
import DateFilter, { useDateFilter, DASHBOARD_PRESETS, fmtRange } from '../components/DateFilter';

// ── formatters ───────────────────────────────────────────────────────
const usd = (v) => '$' + Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedUsd = (v) => (Number(v) > 0 ? '+' : '') + usd(v);
const cnt = (v) => fmtNum(Number(v || 0), 0);
const fmtD = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function Dashboard() {
  const { user } = useAuthStore();
  const role = user?.role;
  const isManager = role === ROLES.MANAGER;

  const [range, setRange] = useDateFilter('admin.dashboard.range', '7d');
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(!isManager);
  const [error, setError] = useState(false);

  const load = () => {
    if (isManager) { setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    // Presets → send `period` so the backend applies precise time logic
    // (e.g. rolling 24h). Custom → send concrete dates.
    const params = range.period === 'custom'
      ? { period: 'custom', fromDate: range.fromDate, toDate: range.toDate }
      : { period: range.period };
    (async () => {
      try {
        const { data } = await api.get('/admin/dashboard/analytics', { params });
        if (!cancelled) setD(data.data);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  };

  useEffect(() => load(), [isManager, range]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isManager) return <Navigate to={roleHome(role)} replace />;

  const rangeLabel = d?.range
    ? (d.range.period === 'custom' ? fmtRange(range.fromDate, range.toDate) : `${fmtD(d.range.from)} – ${fmtD(d.range.to)}`)
    : '';

  return (
    <div className="space-y-6 max-w-[1600px]">
      <PageHero
        eyebrow="Executive Overview"
        title="Admin Dashboard"
        subtitle="Users, deposits, withdrawals, trading, routing, revenue & B-book profitability — for the selected period. Exposure stays live."
        actions={<DateFilter value={range} onChange={setRange} presets={DASHBOARD_PRESETS} />}
      />

      {/* Active selected range chip */}
      <div className="flex items-center gap-2 -mt-2">
        <span className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Showing</span>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-primary-500/40 bg-primary-500/10 text-primary-400">
          {rangeLabel || '…'}
        </span>
      </div>

      {error || (!loading && !d) ? (
        <Unavailable onRetry={load} />
      ) : loading && !d ? (
        <Loading />
      ) : (
        <div className="space-y-7">
          {/* Alerts (live) */}
          {(d.alerts?.kycPending > 0 || d.alerts?.withdrawPending > 0 || d.alerts?.depositPending > 0) && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card label="KYC Pending" value={cnt(d.alerts.kycPending)} tone={d.alerts.kycPending > 0 ? 'warn' : 'muted'} alert={d.alerts.kycPending > 0} />
              <Card label="Deposits Pending" value={cnt(d.alerts.depositPending)} tone={d.alerts.depositPending > 0 ? 'warn' : 'muted'} alert={d.alerts.depositPending > 0} />
              <Card label="Withdrawals Pending" value={cnt(d.alerts.withdrawPending)} tone={d.alerts.withdrawPending > 0 ? 'warn' : 'muted'} alert={d.alerts.withdrawPending > 0} />
            </div>
          )}

          {/* User Analytics */}
          <Section title="User Analytics" hint="Selected period">
            <Card label="Total Users (Lifetime)" value={cnt(d.users.totalUsers)} tone="primary" />
            <Card label="New Users (Period)" value={cnt(d.users.newUsers)} tone="info" />
            <Card label="Active Users (Period)" value={cnt(d.users.activeUsers)} tone="bull" />
          </Section>

          {/* Deposit Analytics */}
          <Section title="Deposit Analytics">
            <Card label="Total Deposits (Lifetime)" value={usd(d.deposits.totalLifetime)} tone="bull" />
            <Card label="Deposits (Period)" value={usd(d.deposits.periodAmount)} sub={`${cnt(d.deposits.periodCount)} confirmed`} tone="bull" />
            <Card label="Pending" value={cnt(d.deposits.pending)} tone={d.deposits.pending > 0 ? 'warn' : 'muted'} />
            <Card label="Successful" value={cnt(d.deposits.successful)} tone="bull" />
            <Card label="Failed" value={cnt(d.deposits.failed)} tone={d.deposits.failed > 0 ? 'bear' : 'muted'} />
          </Section>

          {/* Withdrawal Analytics */}
          <Section title="Withdrawal Analytics">
            <Card label="Total Withdrawals (Lifetime)" value={usd(d.withdrawals.totalLifetime)} tone="bear" />
            <Card label="Withdrawals (Period)" value={usd(d.withdrawals.periodAmount)} sub={`${cnt(d.withdrawals.periodCount)} completed`} tone="bear" />
            <Card label="Pending" value={cnt(d.withdrawals.pending)} tone={d.withdrawals.pending > 0 ? 'warn' : 'muted'} />
            <Card label="Approved" value={cnt(d.withdrawals.approved)} tone="bull" />
            <Card label="Rejected" value={cnt(d.withdrawals.rejected)} tone={d.withdrawals.rejected > 0 ? 'bear' : 'muted'} />
          </Section>

          {/* Trading Analytics */}
          <Section title="Trading Analytics">
            <Card label="Total Trades (Period)" value={cnt(d.trading.totalTrades)} tone="info" />
            <Card label="Trading Volume (Period)" value={usd(d.trading.tradingVolume)} tone="primary" />
            <Card label="Open Positions" value={cnt(d.trading.openPositions)} sub="live" tone="primary" />
            <Card label="Closed Positions" value={cnt(d.trading.closedPositions)} tone="muted" />
          </Section>

          {/* Routing Analytics */}
          <Section title="Routing Analytics">
            <Card label="Internal Matching Vol" value={usd(d.routing.internalMatchingVolume)} tone="info" />
            <Card label="B-Book Volume" value={usd(d.routing.bBookVolume)} tone="warn" />
            <Card label="A-Book Volume" value={usd(d.routing.aBookVolume)} tone="primary" />
            <Card label="Hybrid Routed Orders" value={cnt(d.routing.hybridRoutedOrders)} tone="violet" />
            <Card label="Total Routing Decisions" value={cnt(d.routing.totalRoutingDecisions)} tone="muted" />
          </Section>

          {/* B-Book P&L */}
          <Section title="B-Book Profit & Loss" hint="Broker counterparty result · selected period (unrealized is live)">
            <Card label="B-Book Realized P&L" value={signedUsd(d.bBookPnl.realized)} tone={d.bBookPnl.realized >= 0 ? 'bull' : 'bear'} />
            <Card label="B-Book Unrealized P&L" value={signedUsd(d.bBookPnl.unrealized)} tone={d.bBookPnl.unrealized >= 0 ? 'bull' : 'bear'} />
            <Card label="Net B-Book P&L" value={signedUsd(d.bBookPnl.net)} tone={d.bBookPnl.net >= 0 ? 'bull' : 'bear'} big />
          </Section>

          {/* Revenue Analytics */}
          <Section title="Revenue Analytics" hint="Selected period">
            <Card label="Platform Revenue" value={signedUsd(d.revenue.platformRevenue)} tone={d.revenue.platformRevenue >= 0 ? 'bull' : 'bear'} />
            <Card label="Trading Fees Collected" value={usd(d.revenue.tradingFeesCollected)} tone="bull" />
            <Card label="Commission Paid" value={usd(d.revenue.commissionPaid)} tone="bear" />
            <Card label="Partner Revenue Share" value={usd(d.revenue.partnerRevenueShare)} tone="warn" />
            <Card label="Net Revenue" value={signedUsd(d.revenue.netRevenue)} tone={d.revenue.netRevenue >= 0 ? 'bull' : 'bear'} big />
          </Section>

          {/* Exposure — LIVE */}
          <Section title="Exposure" hint="Live · current open positions (not date-filtered)" live>
            <Card label="Net Exposure" value={signedUsd(d.exposure.netExposure)} tone={d.exposure.netExposure >= 0 ? 'bull' : 'bear'} />
            <Card label="A-Book Exposure" value={usd(d.exposure.aBookExposure)} tone="primary" />
            <Card label="B-Book Exposure" value={usd(d.exposure.bBookExposure)} tone="warn" />
            <Card label="Internal Matching Exposure" value={usd(d.exposure.internalMatchingExposure)} tone="info" />
          </Section>
        </div>
      )}
    </div>
  );
}

// ── Section wrapper ──────────────────────────────────────────────────
function Section({ title, hint, live, children }) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        {live && <span className="w-1.5 h-1.5 rounded-full bg-bull pulse-live" />}
        <h2 className="text-sm font-bold text-white uppercase tracking-wider">{title}</h2>
        {hint && <span className="text-[11px] text-text-muted ml-1">· {hint}</span>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">{children}</div>
    </section>
  );
}

// ── Metric card ──────────────────────────────────────────────────────
function Card({ label, value, sub, tone = 'primary', alert = false, big = false }) {
  const palette =
    tone === 'bull' ? { iconBg: 'before:bg-bull/50', valueClass: 'text-bull' }
    : tone === 'bear' ? { iconBg: 'before:bg-bear/50', valueClass: 'text-bear' }
    : tone === 'warn' ? { iconBg: 'before:bg-warn/60', valueClass: 'text-warn' }
    : tone === 'info' ? { iconBg: 'before:bg-info/50', valueClass: 'text-text-primary' }
    : tone === 'violet' ? { iconBg: 'before:bg-violet-500/50', valueClass: 'text-violet-400' }
    : tone === 'muted' ? { iconBg: 'before:bg-border-dark', valueClass: 'text-text-primary' }
    : { iconBg: 'before:bg-primary-500/50', valueClass: 'text-text-primary' };

  return (
    <div
      className={`relative card p-4 transition-all hover:border-border-accent/40
                 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${palette.iconBg}
                 ${big ? 'ring-1 ring-border-accent/30' : ''} ${alert ? 'animate-pulse-once' : ''}`}
    >
      <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold leading-tight">{label}</div>
      <div className={`mt-1.5 font-bold font-mono tabular-nums ${big ? 'text-2xl' : 'text-xl'} ${palette.valueClass}`}>{value}</div>
      {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      {Array.from({ length: 4 }).map((_, s) => (
        <div key={s}>
          <div className="h-4 w-40 rounded bg-bg-panel mb-3" />
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-bg-panel border border-border-dark" />)}
          </div>
        </div>
      ))}
    </div>
  );
}

function Unavailable({ onRetry }) {
  return (
    <div className="card p-10 flex flex-col items-center text-center">
      <div className="w-12 h-12 rounded-full bg-warn/10 text-warn border border-warn/30 flex items-center justify-center mb-4">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-white">Dashboard data is unavailable right now</h2>
      <p className="text-sm text-text-secondary mt-1.5 max-w-md">We couldn't load the metrics for this range. This is usually temporary — please try again.</p>
      <button type="button" onClick={onRetry} className="btn-primary mt-5 px-5">Retry</button>
    </div>
  );
}
