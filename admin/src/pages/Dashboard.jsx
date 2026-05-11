import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';
import PageHero from '../components/PageHero';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/admin/dashboard');
        setStats(data.data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="text-text-secondary p-4">Loading dashboard…</div>;
  if (!stats) return <div className="text-bear p-4">Failed to load dashboard.</div>;

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  });

  return (
    <div className="space-y-6 max-w-[1600px]">
      <PageHero
        eyebrow={`Live · ${today}`}
        title="Admin Dashboard"
        subtitle="Real-time platform overview — users, trades, exposure, and items needing attention."
      />

      {/* Top metrics — split into "Activity" and "Needs attention" so the
          alert cards actually read as alerts (warn-bordered if non-zero). */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Stat label="Total Users" value={stats.totalUsers} icon={<UsersIcon />} tone="primary" />
        <Stat label="Active 24h" value={stats.activeUsers24h} icon={<PulseIcon />} tone="bull" />
        <Stat label="Trades 24h" value={stats.trades24h} icon={<ActivityIcon />} tone="info" />
        <Stat label="Open Positions" value={stats.openPositions} icon={<PieIcon />} tone="primary" />
        <Stat
          label="KYC Pending"
          value={stats.kycPending}
          icon={<ShieldIcon />}
          tone={stats.kycPending > 0 ? 'warn' : 'muted'}
          alert={stats.kycPending > 0}
        />
        <Stat
          label="Withdrawals Pending"
          value={stats.withdrawPending}
          icon={<DownArrowIcon />}
          tone={stats.withdrawPending > 0 ? 'warn' : 'muted'}
          alert={stats.withdrawPending > 0}
        />
      </div>

      {/* Two-column splits */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-border-dark flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-bull pulse-live" />
            <h2 className="font-semibold text-white">Trade Volume by Routing</h2>
            <span className="text-[10px] uppercase tracking-wider text-text-muted ml-auto">Last 7 days</span>
          </div>
          {!stats.volumeByRouting?.length ? (
            <Empty hint="No trades yet — once users start trading, routing breakdown appears here." />
          ) : (
            <div className="p-4 space-y-2">
              {stats.volumeByRouting.map((v) => {
                const tone =
                  v._id === 'INTERNAL' ? 'chip-info'
                  : v._id === 'B_BOOK' ? 'chip-warn'
                  : v._id === 'EXTERNAL' ? 'chip-primary'
                  : 'chip-muted';
                return (
                  <div key={v._id || 'UNKNOWN'} className="flex items-center justify-between bg-bg-panel border border-border-dark p-3 rounded-lg">
                    <span className={tone}>{v._id || 'UNKNOWN'}</span>
                    <span className="font-mono text-text-primary text-sm">
                      <span className="font-bold">{fmtNum(v.count, 0)}</span>
                      <span className="text-text-muted ml-1.5 text-xs">trades</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-border-dark flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-warn pulse-live" />
            <h2 className="font-semibold text-white">Net Exposure (Open Positions)</h2>
          </div>
          {!stats.exposure?.length ? (
            <Empty hint="No open positions — exposure heat map renders once traders have live positions." />
          ) : (
            <div className="p-4 space-y-1.5 max-h-[360px] overflow-y-auto">
              {stats.exposure.map((e, i) => (
                <div key={i} className="flex items-center justify-between bg-bg-panel border border-border-subtle p-2.5 rounded-lg text-sm">
                  <span className="font-mono text-text-secondary">{e._id.symbol}</span>
                  <span className={`font-mono font-bold ${e._id.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>
                    {e._id.side === 'BUY' ? '↑' : '↓'} {fmtNum(e.total, 4)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, icon, tone = 'primary', alert = false }) {
  const palette =
    tone === 'bull' ? { iconBg: 'bg-bull/10 text-bull border-bull/30', accent: 'before:bg-bull/40', valueClass: 'text-text-primary' }
    : tone === 'bear' ? { iconBg: 'bg-bear/10 text-bear border-bear/30', accent: 'before:bg-bear/40', valueClass: 'text-text-primary' }
    : tone === 'warn' ? { iconBg: 'bg-warn/10 text-warn border-warn/30', accent: 'before:bg-warn/60', valueClass: 'text-warn' }
    : tone === 'info' ? { iconBg: 'bg-info/10 text-info border-info/30', accent: 'before:bg-info/40', valueClass: 'text-text-primary' }
    : tone === 'muted' ? { iconBg: 'bg-bg-hover text-text-muted border-border-dark', accent: 'before:bg-border-dark', valueClass: 'text-text-primary' }
    : { iconBg: 'bg-primary-500/10 text-primary-500 border-primary-500/30', accent: 'before:bg-primary-500/40', valueClass: 'text-text-primary' };

  return (
    <div
      className={`relative card p-4 transition-all hover:border-border-accent/40 group
                 before:absolute before:left-0 before:top-0 before:h-full before:w-1 ${palette.accent}
                 ${alert ? 'animate-pulse-once' : ''}`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${palette.iconBg} mb-2.5 transition-transform group-hover:scale-110`}>
        {icon}
      </div>
      <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">{label}</div>
      <div className={`text-2xl font-bold mt-1 font-mono ${palette.valueClass}`}>{value}</div>
    </div>
  );
}

function Empty({ hint }) {
  return (
    <div className="p-8 text-center">
      <div className="text-sm text-text-secondary">No data yet</div>
      <div className="text-xs text-text-muted mt-1 max-w-sm mx-auto">{hint}</div>
    </div>
  );
}

// Inline icons
const Svg = ({ children }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const UsersIcon = () => <Svg><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M15 3.13a4 4 0 0 1 0 7.75" /></Svg>;
const PulseIcon = () => <Svg><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></Svg>;
const ActivityIcon = () => <Svg><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></Svg>;
const PieIcon = () => <Svg><path d="M21.21 15.89A10 10 0 1 1 8 2.83" /><path d="M22 12A10 10 0 0 0 12 2v10z" /></Svg>;
const ShieldIcon = () => <Svg><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></Svg>;
const DownArrowIcon = () => <Svg><path d="M12 5v14" /><polyline points="19 12 12 19 5 12" /></Svg>;
