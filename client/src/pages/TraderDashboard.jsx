import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { useAuthStore } from '../store/auth';
import CopySetupModal from '../components/CopySetupModal';

/**
 * TraderDashboard — premium, read-only trader profile/analytics page.
 * Consumes the additive analytics endpoints:
 *   GET /copy-trading/trader/:id            → profile + performance + risk + charts + followers
 *   GET /copy-trading/trader/:id/positions  → live open positions
 *   GET /copy-trading/trader/:id/history     → paginated closed-trade history
 * Real-time: polls positions + subscribes to ticker:* to live-recompute PnL.
 * Copy action reuses the existing CopySetupModal / /copy-trading/copy flow.
 */

// ─── formatters ──────────────────────────────────────────────────────
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const usd = (v, d = 2) => `$${num(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const usdCompact = (v) => {
  const n = num(v);
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return usd(n);
};
const pct = (v) => `${num(v) >= 0 ? '+' : ''}${num(v).toFixed(2)}%`;
const signed = (v, d = 2) => `${num(v) >= 0 ? '+' : ''}${num(v).toFixed(d)}`;
const tone = (v) => (num(v) >= 0 ? 'text-bull' : 'text-bear');
function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const m = ms / 60000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}
function relTime(d) {
  if (!d) return '—';
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const RISK_TONE = {
  LOW: { fg: '#16A34A', bg: 'rgba(22,163,74,0.12)', label: 'Low Risk' },
  MEDIUM: { fg: '#D97706', bg: 'rgba(217,119,6,0.12)', label: 'Medium Risk' },
  HIGH: { fg: '#DC2626', bg: 'rgba(220,38,38,0.12)', label: 'High Risk' },
};
const RANGES = ['1D', '1W', '1M', '3M', '6M', '1Y', 'ALL'];
const RANGE_MS = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5, '3M': 90 * 864e5, '6M': 180 * 864e5, '1Y': 365 * 864e5, ALL: Infinity };

export default function TraderDashboard() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const accountId = sp.get('account') || '';
  const { user } = useAuthStore();
  const myId = String(user?._id || user?.id || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copyOpen, setCopyOpen] = useState(false);

  const load = async () => {
    try {
      const { data: r } = await api.get(`/copy-trading/trader/${id}`, { params: accountId ? { accountId } : {} });
      setData(r.data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [id, accountId]);

  if (loading) return <div className="max-w-[1500px] mx-auto p-6 text-text-muted">Loading trader…</div>;
  if (!data) {
    return (
      <div className="max-w-[1500px] mx-auto p-6">
        <Link to="/copy-trading" className="text-sm font-semibold text-primary-600 hover:underline">← Back to Copy Trading</Link>
        <div className="mt-6 bg-white border border-border-dark rounded-2xl p-10 text-center text-text-muted">This trader profile is unavailable or private.</div>
      </div>
    );
  }

  const { trader, performance: pf, risk, charts, followers } = data;
  const isSelf = myId && String(trader.userId) === myId;

  return (
    <div className="space-y-5 max-w-[1500px] mx-auto pb-10">
      <Link to="/copy-trading" className="inline-flex items-center gap-1 text-sm font-semibold text-primary-600 hover:underline">← Copy Trading</Link>

      <HeroCard trader={trader} pf={pf} isSelf={isSelf} onCopy={() => setCopyOpen(true)} />

      {/* ── Headline cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <HeadlineCard label="Total ROI" value={pct(pf.totalROI)} tint={pf.totalROI >= 0 ? 'green' : 'red'} sub={`${usd(pf.totalPnL)} net`} />
        <HeadlineCard label="Followers" value={Number(followers.total).toLocaleString()} tint="blue" sub={`${followers.active} active`} />
        <HeadlineCard label="Copied AUM" value={usdCompact(trader.aum)} tint="violet" sub={`${followers.copiedTrades} copied trades`} />
        <RiskCard risk={risk} />
      </div>

      {/* ── Equity curve ── */}
      <EquityCurveCard series={charts.equityCurve} initialEquity={data.initialEquity} />

      {/* ── Performance metrics ── */}
      <PerformanceMetrics pf={pf} />

      {/* ── Risk analytics + period bars ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <RiskAnalytics risk={risk} />
        <ChartCard title="Monthly Performance" sub="Realized PnL per month · last 12">
          <BarChart data={charts.monthly} />
        </ChartCard>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ChartCard title="Weekly Performance" sub="Realized PnL per week · last 12">
          <BarChart data={charts.weekly} />
        </ChartCard>
        <ChartCard title="Profit Distribution" sub="Trades by PnL bucket (USD)">
          <DistributionChart data={charts.distribution} />
        </ChartCard>
      </div>

      {/* ── Open positions (live) ── */}
      <OpenPositions traderId={id} />

      {/* ── Trade history ── */}
      <TradeHistory traderId={id} />

      {/* ── Master earnings (performance fee) — owner only ── */}
      {isSelf && data.earnings && <MasterEarnings earnings={data.earnings} />}

      {/* ── Follower analytics + copy panel ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2"><FollowerAnalytics followers={followers} performanceFeePercent={trader.performanceFeePercent} /></div>
        <CopyPanel trader={trader} isSelf={isSelf} onCopy={() => setCopyOpen(true)} />
      </div>

      {copyOpen && (
        <CopySetupModal
          trader={{ userId: trader.userId, accountId: trader.accountId, accountNumber: trader.accountNumber, accountType: trader.accountType, displayName: trader.displayName, riskBadge: trader.riskBadge, roiPct: pf.totalROI, winRate: pf.winRate, performanceFeePercent: trader.performanceFeePercent }}
          onClose={() => setCopyOpen(false)}
          onStarted={() => { setCopyOpen(false); toast.success(`Now copying ${trader.displayName}`); }}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// HERO
// ═══════════════════════════════════════════════════════════════════
function HeroCard({ trader, pf, isSelf, onCopy }) {
  const rt = RISK_TONE[trader.riskBadge] || RISK_TONE.MEDIUM;
  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 shadow-elevated"
         style={{ background: 'linear-gradient(135deg,#0B1220 0%,#111A2E 55%,#1B2740 100%)' }}>
      <div className="absolute -top-24 -right-16 w-96 h-96 rounded-full blur-3xl opacity-50 pointer-events-none"
           style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.35), transparent 65%)' }} />
      <div className="relative p-6 sm:p-7 flex flex-col lg:flex-row lg:items-center gap-6">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <span className="w-20 h-20 rounded-2xl flex items-center justify-center text-2xl font-extrabold shrink-0 keep-white"
                style={{ color: '#fff', background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)' }}>
            {trader.avatarUrl
              ? <img src={trader.avatarUrl} alt="" className="w-full h-full object-cover rounded-2xl" />
              : (trader.displayName || 'T').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight truncate keep-white" style={{ color: '#fff' }}>{trader.displayName}</h1>
              {trader.verified && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full keep-white"
                      style={{ color: '#fff', background: 'rgba(59,130,246,0.3)', border: '1px solid rgba(147,197,253,0.5)' }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 14.9 7.2 17l.9-5.4L4.2 7.7l5.4-.8z"/></svg>
                  Verified
                </span>
              )}
              {trader.activeStatus
                ? <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full keep-white" style={{ color: '#fff', background: 'rgba(16,185,129,0.25)' }}><span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />Active</span>
                : <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full keep-white" style={{ color: 'rgba(255,255,255,0.6)', background: 'rgba(255,255,255,0.1)' }}>Inactive</span>}
            </div>
            <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-xs keep-white" style={{ color: 'rgba(255,255,255,0.75)' }}>
              <span>{trader.tradingStyle}</span>
              <span>· Joined {trader.joinedAt ? new Date(trader.joinedAt).toLocaleDateString() : '—'}</span>
              {trader.country && <span>· {trader.country}</span>}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold" style={{ color: rt.fg, background: rt.bg }}>
                Risk {trader.riskScore}/10
              </span>
            </div>
            {trader.bio && <p className="mt-2 text-sm max-w-xl keep-white" style={{ color: 'rgba(255,255,255,0.7)' }}>{trader.bio}</p>}
          </div>
        </div>

        <div className="flex items-center gap-5 shrink-0">
          <HeroStat label="Followers" value={Number(trader.followers).toLocaleString()} />
          <HeroStat label="AUM" value={usdCompact(trader.aum)} />
          <HeroStat label="Total ROI" value={pct(pf.totalROI)} accent={pf.totalROI >= 0 ? '#34D399' : '#F87171'} />
          {isSelf ? (
            <Link to="/copy-trading" className="px-5 py-2.5 rounded-xl text-sm font-bold keep-white" style={{ color: '#fff', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)' }}>Your profile</Link>
          ) : (
            <button onClick={onCopy} className="px-6 py-2.5 rounded-xl text-sm font-bold text-white shadow-lg active:scale-95 transition-transform"
                    style={{ background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)' }}>
              <span className="keep-white" style={{ color: '#fff' }}>Copy Trader</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
function HeroStat({ label, value, accent }) {
  return (
    <div className="text-right hidden sm:block">
      <div className="text-[10px] uppercase tracking-wider font-bold keep-white" style={{ color: 'rgba(255,255,255,0.5)' }}>{label}</div>
      <div className="text-lg font-extrabold font-mono tabular-nums keep-white" style={{ color: accent || '#fff' }}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CARDS
// ═══════════════════════════════════════════════════════════════════
const TINTS = {
  green: { fg: '#16A34A', bg: 'rgba(0,200,83,0.10)' },
  red: { fg: '#DC2626', bg: 'rgba(220,38,38,0.10)' },
  blue: { fg: '#2563EB', bg: 'rgba(37,99,235,0.10)' },
  violet: { fg: '#7C3AED', bg: 'rgba(124,58,237,0.10)' },
};
function HeadlineCard({ label, value, sub, tint = 'blue' }) {
  const t = TINTS[tint] || TINTS.blue;
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-4 shadow-card">
      <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className="mt-1.5 text-2xl font-extrabold font-mono tabular-nums" style={{ color: t.fg }}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}
function RiskCard({ risk }) {
  const rt = RISK_TONE[risk.riskTier] || RISK_TONE.MEDIUM;
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-card" style={{ borderColor: rt.fg + '55' }}>
      <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Risk Score</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-2xl font-extrabold tabular-nums" style={{ color: rt.fg }}>{risk.riskScore}<span className="text-base text-text-muted font-bold">/10</span></span>
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ color: rt.fg, background: rt.bg }}>{rt.label}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-bg-hover overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${risk.riskScore * 10}%`, background: rt.fg }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EQUITY CURVE
// ═══════════════════════════════════════════════════════════════════
function EquityCurveCard({ series, initialEquity }) {
  const [range, setRange] = useState('ALL');
  const filtered = useMemo(() => {
    if (range === 'ALL' || !series.length) return series;
    const cutoff = Date.now() - RANGE_MS[range];
    const f = series.filter((p) => new Date(p.t).getTime() >= cutoff);
    return f.length >= 2 ? f : series.slice(-2);
  }, [series, range]);
  const first = filtered[0]?.equity ?? initialEquity;
  const last = filtered[filtered.length - 1]?.equity ?? initialEquity;
  const change = first ? ((last - first) / first) * 100 : 0;

  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-bold text-text-primary">Equity Curve</h3>
          <p className="text-[11px] text-text-muted mt-0.5">Account growth from {usd(initialEquity)} base</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-lg font-extrabold font-mono tabular-nums text-text-primary">{usd(last)}</div>
            <div className={`text-[11px] font-bold ${tone(change)}`}>{pct(change)} <span className="text-text-muted font-medium">({range})</span></div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {RANGES.map((r) => (
          <button key={r} onClick={() => setRange(r)}
            className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition-colors ${range === r ? 'bg-primary-500 text-white' : 'bg-bg-hover text-text-secondary hover:text-text-primary'}`}>{r}</button>
        ))}
      </div>
      <AreaChart data={filtered.map((p) => ({ label: new Date(p.t).toLocaleDateString(), value: p.equity }))} baseline={initialEquity} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE METRICS
// ═══════════════════════════════════════════════════════════════════
function PerformanceMetrics({ pf }) {
  const items = [
    { label: 'Total ROI', value: pct(pf.totalROI), tone: pf.totalROI >= 0 ? 'bull' : 'bear' },
    { label: 'Monthly ROI', value: pct(pf.monthlyROI), tone: pf.monthlyROI >= 0 ? 'bull' : 'bear' },
    { label: 'Weekly ROI', value: pct(pf.weeklyROI), tone: pf.weeklyROI >= 0 ? 'bull' : 'bear' },
    { label: 'Daily ROI', value: pct(pf.dailyROI), tone: pf.dailyROI >= 0 ? 'bull' : 'bear' },
    { label: 'Total P/L', value: usd(pf.totalPnL), tone: pf.totalPnL >= 0 ? 'bull' : 'bear' },
    { label: 'Win Rate', value: `${pf.winRate.toFixed(1)}%` },
    { label: 'Total Trades', value: pf.totalTrades },
    { label: 'Winning Trades', value: pf.wins, tone: 'bull' },
    { label: 'Losing Trades', value: pf.losses, tone: 'bear' },
    { label: 'Avg Trade Profit', value: usd(pf.avgWin), tone: 'bull' },
    { label: 'Avg Trade Loss', value: usd(pf.avgLoss), tone: 'bear' },
    { label: 'Profit Factor', value: pf.profitFactor >= 999 ? '∞' : pf.profitFactor.toFixed(2) },
    { label: 'Avg Trade Duration', value: fmtDuration(pf.avgDurationMs) },
  ];
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card">
      <h3 className="text-sm font-bold text-text-primary mb-3.5">Performance Metrics</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {items.map((m) => (
          <div key={m.label} className="rounded-xl bg-bg-hover/40 border border-border-subtle p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{m.label}</div>
            <div className={`mt-1 text-base font-extrabold font-mono tabular-nums ${m.tone === 'bull' ? 'text-bull' : m.tone === 'bear' ? 'text-bear' : 'text-text-primary'}`}>{m.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// RISK ANALYTICS
// ═══════════════════════════════════════════════════════════════════
function RiskAnalytics({ risk }) {
  const rt = RISK_TONE[risk.riskTier] || RISK_TONE.MEDIUM;
  const rows = [
    { label: 'Risk Score', value: `${risk.riskScore}/10`, color: rt.fg },
    { label: 'Max Drawdown', value: `${risk.maxDrawdownPct.toFixed(2)}%`, color: '#DC2626' },
    { label: 'Avg Drawdown', value: `${risk.avgDrawdownPct.toFixed(2)}%`, color: '#D97706' },
    { label: 'Sharpe Ratio', value: risk.sharpe.toFixed(2) },
    { label: 'Recovery Factor', value: risk.recoveryFactor >= 999 ? '∞' : risk.recoveryFactor.toFixed(2) },
    { label: 'Avg Leverage', value: `${risk.avgLeverage.toFixed(1)}×` },
    { label: 'Stop-Loss Usage', value: `${risk.slUsagePct.toFixed(0)}%` },
    { label: 'Max Consecutive Wins', value: risk.maxWinStreak, color: '#16A34A' },
    { label: 'Max Consecutive Losses', value: risk.maxLossStreak, color: '#DC2626' },
  ];
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-sm font-bold text-text-primary">Risk Analytics</h3>
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ color: rt.fg, background: rt.bg }}>{rt.label}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {rows.map((r) => (
          <div key={r.label} className="rounded-xl bg-bg-hover/40 border border-border-subtle p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{r.label}</div>
            <div className="mt-1 text-base font-extrabold font-mono tabular-nums" style={{ color: r.color || undefined }}>{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// OPEN POSITIONS (live)
// ═══════════════════════════════════════════════════════════════════
function OpenPositions({ traderId }) {
  const [sp] = useSearchParams();
  const accountId = sp.get('account') || '';
  const [rows, setRows] = useState([]);
  const [live, setLive] = useState({}); // symbol -> last price
  const rowsRef = useRef([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const load = async () => {
    try { const { data } = await api.get(`/copy-trading/trader/${traderId}/positions`, { params: accountId ? { accountId } : {} }); setRows(data.data || []); }
    catch (_) { /* keep prior */ }
  };
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [traderId, accountId]);

  // Live price subscriptions per open symbol → recompute PnL client-side.
  const symbolsKey = useMemo(() => [...new Set(rows.map((r) => r.symbol))].sort().join('|'), [rows]);
  useEffect(() => {
    if (!symbolsKey) return undefined;
    const subs = symbolsKey.split('|').filter(Boolean).map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (d) => {
        const p = Number(d.lastPrice);
        if (Number.isFinite(p) && p > 0) setLive((prev) => (prev[sym] === p ? prev : { ...prev, [sym]: p }));
      }));
    return () => subs.forEach((u) => u && u());
  }, [symbolsKey]);

  const computed = rows.map((r) => {
    const cur = live[r.symbol] ?? num(r.currentPrice);
    const entry = num(r.entryPrice);
    const qty = num(r.quantity);
    const dir = r.side === 'BUY' ? 1 : -1;
    const pnl = (cur - entry) * qty * dir;
    return { ...r, cur, pnl };
  });

  return (
    <div className="rounded-2xl border border-border-dark bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
        <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
          Open Positions <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" /><span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Live</span>
        </h3>
        <span className="text-[11px] text-text-muted">{computed.length} open</span>
      </div>
      {computed.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-text-muted">No open positions right now.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-[0.14em] font-bold text-text-muted bg-bg-card">
              <tr>
                <th className="text-left px-5 py-3">Instrument</th>
                <th className="text-left px-3 py-3">Side</th>
                <th className="text-right px-3 py-3">Entry</th>
                <th className="text-right px-3 py-3">Current</th>
                <th className="text-right px-3 py-3">Size</th>
                <th className="text-right px-3 py-3">Running PnL</th>
                <th className="text-right px-5 py-3 hidden sm:table-cell">Open</th>
              </tr>
            </thead>
            <tbody>
              {computed.map((r) => (
                <tr key={r._id} className="border-t border-border-subtle hover:bg-bg-hover transition-colors">
                  <td className="px-5 py-3 font-semibold text-text-primary">{r.symbol}</td>
                  <td className="px-3 py-3">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${r.side === 'BUY' ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'}`}>{r.side === 'BUY' ? 'Buy' : 'Sell'}</span>
                  </td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-text-secondary">{num(r.entryPrice).toFixed(Math.min(r.pricePrecision || 2, 6))}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-text-primary">{num(r.cur).toFixed(Math.min(r.pricePrecision || 2, 6))}</td>
                  <td className="px-3 py-3 text-right font-mono tabular-nums text-text-secondary">{num(r.quantity)}</td>
                  <td className={`px-3 py-3 text-right font-mono tabular-nums font-bold ${tone(r.pnl)}`}>{signed(r.pnl)}</td>
                  <td className="px-5 py-3 text-right text-xs text-text-muted hidden sm:table-cell">{relTime(r.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TRADE HISTORY
// ═══════════════════════════════════════════════════════════════════
const HISTORY_PERIODS = [{ k: 'today', label: 'Today' }, { k: 'week', label: 'This Week' }, { k: 'month', label: 'This Month' }, { k: 'all', label: 'All' }, { k: 'custom', label: 'Custom' }];
function TradeHistory({ traderId }) {
  const [sp] = useSearchParams();
  const accountId = sp.get('account') || '';
  const [period, setPeriod] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0, page: 1, pages: 1 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = { period, page, limit: 10 };
    if (accountId) params.accountId = accountId;
    if (period === 'custom') {
      if (from) params.from = from;
      // Make the end date inclusive of the whole selected day.
      if (to) params.to = `${to}T23:59:59.999`;
    }
    api.get(`/copy-trading/trader/${traderId}/history`, { params })
      .then(({ data: r }) => { if (!cancelled) setData(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [traderId, period, page, from, to, accountId]);

  return (
    <div className="rounded-2xl border border-border-dark bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-bold text-text-primary">Trade History</h3>
        <div className="flex gap-1 flex-wrap items-center">
          {HISTORY_PERIODS.map((p) => (
            <button key={p.k} onClick={() => { setPeriod(p.k); setPage(1); }}
              className={`text-[11px] font-bold px-2.5 py-1 rounded-lg transition-colors ${period === p.k ? 'bg-primary-500 text-white' : 'bg-bg-hover text-text-secondary hover:text-text-primary'}`}>{p.label}</button>
          ))}
        </div>
      </div>
      {period === 'custom' && (
        <div className="px-5 py-3 border-b border-border-subtle flex items-center gap-2 flex-wrap bg-bg-card/50">
          <label className="text-[11px] font-bold text-text-muted uppercase tracking-wider">From</label>
          <input type="date" value={from} max={to || undefined}
            onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none" />
          <label className="text-[11px] font-bold text-text-muted uppercase tracking-wider">To</label>
          <input type="date" value={to} min={from || undefined}
            onChange={(e) => { setTo(e.target.value); setPage(1); }}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-border-dark bg-white text-text-primary focus:border-primary-500 focus:outline-none" />
          {(from || to) && (
            <button onClick={() => { setFrom(''); setTo(''); setPage(1); }}
              className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-border-dark text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">Clear</button>
          )}
        </div>
      )}
      {loading ? (
        <div className="px-5 py-10 text-center text-sm text-text-muted">Loading…</div>
      ) : data.items.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-text-muted">No closed trades in this period.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase tracking-[0.14em] font-bold text-text-muted bg-bg-card">
                <tr>
                  <th className="text-left px-5 py-3">Date</th>
                  <th className="text-left px-3 py-3">Symbol</th>
                  <th className="text-left px-3 py-3">Side</th>
                  <th className="text-right px-3 py-3">Entry</th>
                  <th className="text-right px-3 py-3">Exit</th>
                  <th className="text-right px-3 py-3 hidden sm:table-cell">Duration</th>
                  <th className="text-right px-5 py-3">P/L</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => (
                  <tr key={t._id} className="border-t border-border-subtle hover:bg-bg-hover transition-colors">
                    <td className="px-5 py-3 text-xs text-text-secondary whitespace-nowrap">{new Date(t.closedAt).toLocaleDateString()}</td>
                    <td className="px-3 py-3 font-semibold text-text-primary">{t.symbol}</td>
                    <td className="px-3 py-3"><span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${t.side === 'BUY' ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'}`}>{t.side === 'BUY' ? 'Buy' : 'Sell'}</span></td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-text-secondary">{num(t.entryPrice).toFixed(4)}</td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-text-secondary">{t.exitPrice != null ? num(t.exitPrice).toFixed(4) : '—'}</td>
                    <td className="px-3 py-3 text-right text-xs text-text-muted hidden sm:table-cell">{fmtDuration(t.durationMs)}</td>
                    <td className={`px-5 py-3 text-right font-mono tabular-nums font-bold ${tone(t.realizedPnl)}`}>{signed(t.realizedPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-between text-xs">
            <span className="text-text-muted">{data.total} trades · page {data.page}/{data.pages || 1}</span>
            <div className="flex gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-3 py-1.5 rounded-lg border border-border-dark text-text-primary disabled:opacity-40 hover:bg-bg-hover transition-colors">Prev</button>
              <button disabled={page >= (data.pages || 1)} onClick={() => setPage((p) => p + 1)} className="px-3 py-1.5 rounded-lg border border-border-dark text-text-primary disabled:opacity-40 hover:bg-bg-hover transition-colors">Next</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FOLLOWER ANALYTICS + COPY PANEL
// ═══════════════════════════════════════════════════════════════════
function FollowerAnalytics({ followers, performanceFeePercent }) {
  const items = [
    { label: 'Total Followers', value: Number(followers.total).toLocaleString() },
    { label: 'Active Followers', value: Number(followers.active).toLocaleString(), tone: 'bull' },
    { label: 'New This Month', value: `+${followers.newThisMonth}`, tone: 'bull' },
    { label: 'Copied Volume (AUM)', value: usdCompact(followers.aum) },
    { label: 'Master Earnings', value: followers.generatedCommission == null ? '—' : usd(followers.generatedCommission), tone: 'bull' },
    { label: 'Avg Follower ROI', value: pct(followers.avgFollowerRoi), tone: followers.avgFollowerRoi >= 0 ? 'bull' : 'bear' },
  ];
  if (performanceFeePercent != null) {
    items.push({ label: 'Performance Fee', value: `${Number(performanceFeePercent)}%`, tone: 'bull' });
  }
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card">
      <h3 className="text-sm font-bold text-text-primary mb-3.5">Follower Analytics</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {items.map((m) => (
          <div key={m.label} className="rounded-xl bg-bg-hover/40 border border-border-subtle p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{m.label}</div>
            <div className={`mt-1 text-base font-extrabold font-mono tabular-nums ${m.tone === 'bull' ? 'text-bull' : m.tone === 'bear' ? 'text-bear' : 'text-text-primary'}`}>{m.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
/* Master Trader Earnings — performance-fee rollup (owner-only view). */
function MasterEarnings({ earnings }) {
  const items = [
    { label: 'Total Copy Earnings', value: usd(earnings.total), tone: 'bull' },
    { label: 'Earnings Today',      value: usd(earnings.today), tone: earnings.today > 0 ? 'bull' : undefined },
    { label: 'Earnings This Month', value: usd(earnings.month), tone: earnings.month > 0 ? 'bull' : undefined },
    { label: 'Performance Fee',     value: `${Number(earnings.performanceFeePercent || 0)}%` },
    { label: 'Fee Events',          value: Number(earnings.count).toLocaleString() },
    { label: 'Avg Fee Applied',     value: `${Number(earnings.avgFeePercent || 0).toFixed(1)}%` },
  ];
  return (
    <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50/80 to-white p-5 shadow-card">
      <div className="flex items-center justify-between mb-3.5">
        <h3 className="text-sm font-bold text-text-primary">Master Earnings</h3>
        <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
          Performance fee → Bonus Wallet
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {items.map((m) => (
          <div key={m.label} className="rounded-xl bg-white/70 border border-amber-100 p-3">
            <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{m.label}</div>
            <div className={`mt-1 text-base font-extrabold font-mono tabular-nums ${m.tone === 'bull' ? 'text-bull' : 'text-text-primary'}`}>{m.value}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-text-muted mt-3 leading-snug">
        You earn a share of each follower's <span className="font-semibold text-text-secondary">profit</span> on winning copied trades, credited to your Bonus Wallet (USD). Losing and breakeven trades never generate a fee.
      </p>
    </div>
  );
}
function CopyPanel({ trader, isSelf, onCopy }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card flex flex-col">
      <h3 className="text-sm font-bold text-text-primary">Copy this trader</h3>
      <p className="text-xs text-text-muted mt-1 flex-1">
        Mirror {trader.displayName}'s trades automatically. Set your investment, sizing mode and risk limits — the platform copies entries, closes and SL/TP for you.
      </p>
      <ul className="text-[11px] text-text-muted mt-3 space-y-1">
        <li>• Fixed / proportional / multiplier sizing</li>
        <li>• Max risk & drawdown protection</li>
        <li>• Pause, resume or stop any time</li>
      </ul>
      {isSelf ? (
        <div className="mt-4 text-center text-xs text-text-muted rounded-xl bg-bg-hover/50 border border-border-subtle py-3">This is your own profile.</div>
      ) : (
        <button onClick={onCopy} className="mt-4 w-full py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 text-white text-sm font-bold transition-colors">Copy Trader</button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// CHARTS (hand-rolled SVG)
// ═══════════════════════════════════════════════════════════════════
function ChartCard({ title, sub, children }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-5 shadow-card">
      <h3 className="text-sm font-bold text-text-primary">{title}</h3>
      {sub && <p className="text-[11px] text-text-muted mt-0.5 mb-3">{sub}</p>}
      {children}
    </div>
  );
}
function AreaChart({ data = [], baseline }) {
  const W = 600, H = 160, P = 4;
  if (data.length < 2) return <div className="h-[160px] flex items-center justify-center text-xs text-text-muted">Not enough data yet.</div>;
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals, baseline ?? Infinity);
  const max = Math.max(...vals, baseline ?? -Infinity);
  const span = Math.max(max - min, 1);
  const stepX = (W - P * 2) / (data.length - 1);
  const y = (v) => H - P - ((v - min) / span) * (H - P * 2);
  const pts = data.map((d, i) => [P + i * stepX, y(d.value)]);
  const up = vals[vals.length - 1] >= vals[0];
  const stroke = up ? '#16A34A' : '#DC2626';
  const fill = up ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)';
  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H - P} L ${pts[0][0].toFixed(1)} ${H - P} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 170 }} preserveAspectRatio="none">
      {baseline != null && baseline >= min && baseline <= max && (
        <line x1={P} x2={W - P} y1={y(baseline)} y2={y(baseline)} stroke="#9CA3AF" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
      )}
      <path d={area} fill={fill} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BarChart({ data = [] }) {
  if (!data.length) return <div className="h-[150px] flex items-center justify-center text-xs text-text-muted">No data yet.</div>;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  return (
    <div>
      <div className="flex items-end justify-between gap-1.5" style={{ height: 130 }}>
        {data.map((d, i) => {
          const h = Math.max(2, (Math.abs(d.value) / max) * 100);
          const pos = d.value >= 0;
          return (
            <div key={i} className="flex-1 flex flex-col items-center justify-end h-full group relative" title={`${d.label}: ${usd(d.value)}`}>
              <div className="w-full max-w-[28px] rounded-t-md transition-all" style={{ height: `${h}%`, background: pos ? '#16A34A' : '#DC2626', opacity: 0.85 }} />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-2">
        {data.map((d, i) => <span key={i} className="text-[9px] text-text-muted flex-1 text-center truncate">{d.label}</span>)}
      </div>
    </div>
  );
}
function DistributionChart({ data = [] }) {
  if (!data.length) return <div className="h-[150px] flex items-center justify-center text-xs text-text-muted">No trades yet.</div>;
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div>
      <div className="flex items-end justify-between gap-1.5" style={{ height: 130 }}>
        {data.map((d, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end h-full" title={`${d.bucket}: ${d.count} trades`}>
            <span className="text-[9px] font-bold text-text-secondary mb-0.5">{d.count}</span>
            <div className="w-full max-w-[40px] rounded-t-md" style={{ height: `${Math.max(2, (d.count / max) * 100)}%`, background: d.positive ? '#16A34A' : '#DC2626', opacity: 0.85 }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2">
        {data.map((d, i) => <span key={i} className="text-[8px] text-text-muted flex-1 text-center">{d.bucket}</span>)}
      </div>
    </div>
  );
}
