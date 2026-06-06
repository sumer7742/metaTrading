import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import DateFilter, { useDateFilter } from '../components/DateFilter';

/**
 * Portfolio — platform-wide statistics. SUPER_ADMIN only (route-gated by
 * RoleGate + backend requireRole; backend also returns 403 directly).
 * Premium WHITE-theme dashboard, intentionally distinct from the dark admin.
 */
const money =(v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtD = (d) => (d ? new Date(d).toLocaleDateString() : '—');
const csvEscape = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const download = (content, filename, type) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

export default function Portfolio() {
  const [range, setRange] = useDateFilter('portfolio.range', '7d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const { data: r } = await api.get('/admin/portfolio', { params: { fromDate: range.fromDate, toDate: range.toDate, period: range.period } });
      setData(r.data);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [range]);

  const k = data?.kpis;
  const series = data?.series || [];

  const cards = useMemo(() => k ? [
    { label: 'Total User Balance', value: money(k.totalUserBalance), tone: 'slate' },
    { label: 'Total Deposits', value: money(k.totalDeposits), tone: 'emerald', sub: `${k.depositCount} deposits` },
    { label: 'Total Withdrawals', value: money(k.totalWithdrawals), tone: 'rose', sub: `${k.withdrawalCount} withdrawals` },
    { label: 'Total Open PnL', value: money(k.totalOpenPnl), tone: k.totalOpenPnl >= 0 ? 'emerald' : 'rose', signed: k.totalOpenPnl },
    { label: 'Total Closed PnL', value: money(k.totalClosedPnl), tone: k.totalClosedPnl >= 0 ? 'emerald' : 'rose', signed: k.totalClosedPnl },
    { label: 'A-Book Exposure', value: money(k.aBookExposure), tone: 'blue' },
    { label: 'B-Book Exposure', value: money(k.bBookExposure), tone: 'amber' },
    { label: 'Internal Matching Exposure', value: money(k.internalMatchingExposure), tone: 'violet' },
    { label: 'Platform Revenue', value: money(k.platformRevenue), tone: k.platformRevenue >= 0 ? 'emerald' : 'rose', signed: k.platformRevenue },
    { label: 'Commission Earnings', value: money(k.commissionEarnings), tone: 'indigo' },
    { label: 'Partner / Referral Paid', value: money(k.partnerReferralPaid), tone: 'rose' },
  ] : [], [k]);

  const exportCSV = () => {
    if (!k) return;
    const rows = [
      ['Platform Portfolio Report'],
      ['Range', `${fmtD(data.range.from)} - ${fmtD(data.range.to)}`, `(${data.range.period})`],
      [],
      ['Metric', 'Value (USD)'],
      ...cards.map((c) => [c.label, Number(String(c.value).replace(/[$,]/g, ''))]),
      [],
      ['Date', 'Deposits', 'Withdrawals', 'Closed PnL'],
      ...series.map((s) => [s.date, s.deposits, s.withdrawals, s.closedPnl]),
    ];
    download(rows.map((r) => r.map(csvEscape).join(',')).join('\n'), `portfolio_${data.range.period}.csv`, 'text/csv;charset=utf-8;');
    toast.success('CSV exported');
  };

  const exportExcel = () => {
    if (!k) return;
    const kpiRows = cards.map((c) => `<tr><td>${c.label}</td><td>${String(c.value).replace(/[$,]/g, '')}</td></tr>`).join('');
    const serRows = series.map((s) => `<tr><td>${s.date}</td><td>${s.deposits}</td><td>${s.withdrawals}</td><td>${s.closedPnl}</td></tr>`).join('');
    const html = `<html><head><meta charset="utf-8"></head><body>
      <h3>Platform Portfolio Report</h3>
      <p>Range: ${fmtD(data.range.from)} - ${fmtD(data.range.to)} (${data.range.period})</p>
      <table border="1"><tr><th>Metric</th><th>Value (USD)</th></tr>${kpiRows}</table>
      <br/><table border="1"><tr><th>Date</th><th>Deposits</th><th>Withdrawals</th><th>Closed PnL</th></tr>${serRows}</table>
      </body></html>`;
    download(html, `portfolio_${data.range.period}.xls`, 'application/vnd.ms-excel');
    toast.success('Excel exported');
  };

  return (
    <div className="bg-bg-card text-text-primary rounded-2xl border border-border-dark p-6 max-w-[1500px]">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-indigo-400">Super Admin</div>
          <h1 className="text-2xl font-extrabold text-white">Platform Portfolio</h1>
          <p className="text-sm text-text-muted mt-0.5">Platform-wide financial overview{data ? ` · ${fmtD(data.range.from)} – ${fmtD(data.range.to)}` : ''}.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} disabled={!k} className="text-xs font-semibold px-3 py-2 rounded-lg border border-border-dark text-text-secondary hover:bg-bg-hover hover:text-white disabled:opacity-40">⭳ CSV</button>
          <button onClick={exportExcel} disabled={!k} className="text-xs font-semibold px-3 py-2 rounded-lg border border-border-dark text-text-secondary hover:bg-bg-hover hover:text-white disabled:opacity-40">⭳ Excel</button>
        </div>
      </div>

      {/* Period filter — global reusable DateFilter */}
      <div className="mb-6">
        <DateFilter value={range} onChange={setRange} />
      </div>

      {/* KPI cards */}
      {loading && !data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
          {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-bg-hover animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5">
          {cards.map((c) => <KpiCard key={c.label} {...c} />)}
        </div>
      )}

      {/* Chart */}
      <div className="mt-6 rounded-xl border border-border-dark bg-bg-dark/40 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white">Daily Deposits vs Withdrawals</h3>
          <div className="flex items-center gap-3 text-[11px] text-text-muted">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" /> Deposits</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500" /> Withdrawals</span>
          </div>
        </div>
        <FlowChart series={series} />
      </div>

      <p className="text-[11px] text-text-muted mt-4">
        Open PnL & exposures are live snapshots; deposits, withdrawals, closed PnL, revenue & commission are within the selected range.
        Platform Revenue = commissions + B-book counterparty result (broker gains user losses on internalised flow).
      </p>
    </div>
  );
}

const TONE = {
  slate:   'text-white',
  emerald: 'text-emerald-400',
  rose:    'text-rose-400',
  blue:    'text-blue-400',
  amber:   'text-amber-400',
  violet:  'text-violet-400',
  indigo:  'text-indigo-400',
};
function KpiCard({ label, value, tone = 'slate', sub, signed }) {
  const display = signed != null && signed > 0 ? `+${value}` : value;
  return (
    <div className="rounded-xl border border-border-dark bg-bg-dark/40 p-4 hover:border-border-accent transition-colors">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-1.5 text-xl font-extrabold tabular-nums ${TONE[tone] || TONE.slate}`}>{display}</div>
      {sub && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function FlowChart({ series }) {
  if (!series || series.length === 0) return <div className="text-text-muted text-sm py-10 text-center">No data in this range.</div>;
  const W = 900, H = 220, pad = 28;
  const max = Math.max(1, ...series.map((s) => Math.max(s.deposits, s.withdrawals)));
  const n = series.length;
  const groupW = (W - pad * 2) / n;
  const barW = Math.max(2, Math.min(14, groupW / 2 - 2));
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 240 }}>
      {/* baseline */}
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#3a3a4a" />
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={pad} y1={y(max * f)} x2={W - pad} y2={y(max * f)} stroke="#2a2a38" />
          <text x={4} y={y(max * f) + 3} fontSize="9" fill="#8b8b9e">{Math.round(max * f).toLocaleString()}</text>
        </g>
      ))}
      {series.map((s, i) => {
        const cx = pad + groupW * i + groupW / 2;
        return (
          <g key={s.date}>
            <rect x={cx - barW - 1} y={y(s.deposits)} width={barW} height={H - pad - y(s.deposits)} fill="#10b981" rx="1.5">
              <title>{s.date} · Deposits {s.deposits}</title>
            </rect>
            <rect x={cx + 1} y={y(s.withdrawals)} width={barW} height={H - pad - y(s.withdrawals)} fill="#f43f5e" rx="1.5">
              <title>{s.date} · Withdrawals {s.withdrawals}</title>
            </rect>
            {(n <= 16 || i % Math.ceil(n / 16) === 0) && (
              <text x={cx} y={H - pad + 12} fontSize="8" fill="#9ca3af" textAnchor="middle">{s.date.slice(5)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
