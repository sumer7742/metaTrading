import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { fmtDate } from '../utils/format';
import { useAuthStore } from '../store/auth';

/**
 * Audit & Compliance dashboard — Audit Manager (+ Super Admin) workspace.
 * Read-only oversight: random audits, risk detection, user inspection, KYC,
 * staff-activity audit, reports. Allowed writes: flag a user, submit a freeze
 * request (Super Admin actions the freeze).
 */
const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v) => `${Number(v) < 0 ? '-' : '+'}${money(Math.abs(Number(v) || 0))}`;

const TABS = [
  { k: 'overview', label: 'Overview' },
  { k: 'analysis', label: 'User Analysis' },
  { k: 'random', label: 'Random Audits' },
  { k: 'risk', label: 'Risk Detection' },
  { k: 'flags', label: 'Flags & Freeze' },
  { k: 'kyc', label: 'KYC Review' },
  { k: 'activity', label: 'Staff Activity' },
];

export default function Audit() {
  const { user } = useAuthStore();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [tab, setTab] = useState('overview');
  const [inspectId, setInspectId] = useState(null);

  return (
    <div className="space-y-4 max-w-[1500px]">
      <PageHero
        eyebrow="Compliance · Audit Manager"
        title="Audit & Compliance"
        subtitle="Random audits, fraud/anomaly detection, user inspection, KYC review and staff-activity audit. Read-only oversight + flag / freeze-request actions."
      />

      <div className="card p-1 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)}
            className={`px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors ${tab === t.k ? 'bg-primary-500 text-bg-dark' : 'text-text-secondary hover:text-white hover:bg-bg-hover'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview onInspect={setInspectId} />}
      {tab === 'analysis' && <UserAnalysis />}
      {tab === 'random' && <RandomAudits onInspect={setInspectId} />}
      {tab === 'risk' && <RiskDetection onInspect={setInspectId} />}
      {tab === 'flags' && <FlagsFreeze isSuper={isSuper} onInspect={setInspectId} />}
      {tab === 'kyc' && <KycReview onInspect={setInspectId} />}
      {tab === 'activity' && <Activity />}

      {inspectId && <InspectModal id={inspectId} onClose={() => setInspectId(null)} />}
    </div>
  );
}

// ── shared bits ──
const useFetch = (url, deps = []) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    api.get(url).then(({ data }) => setData(data.data)).catch((e) => toast.error(errorMessage(e))).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, loading, reload };
};

function Card({ children, className = '' }) { return <div className={`card p-4 ${className}`}>{children}</div>; }
function Empty({ msg }) { return <div className="p-8 text-center text-text-muted text-sm">{msg}</div>; }
function Loading() { return <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-bg-hover animate-pulse" />)}</div>; }
function UserCell({ u, onInspect }) {
  return (
    <button onClick={() => u?._id && onInspect?.(u._id)} className="text-left hover:underline">
      <div className="text-white font-medium">{u?.name || '—'}</div>
      <div className="text-[11px] text-text-muted font-mono">{u?.userUid || u?.email}</div>
    </button>
  );
}
function Tbl({ cols, children }) {
  return (
    <table className="w-full text-sm whitespace-nowrap">
      <thead className="text-xs text-gray-500 uppercase"><tr>{cols.map((c, i) => <th key={i} className={`p-2.5 ${c.r ? 'text-right' : c.c ? 'text-center' : 'text-left'}`}>{typeof c === 'object' ? (c.t || '') : c}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// ── Overview + Reports ──
function Overview({ onInspect }) {
  const { data, loading } = useFetch('/audit/overview');
  const [period, setPeriod] = useState('weekly');
  const [report, setReport] = useState(null);
  const [genLoading, setGenLoading] = useState(false);
  const gen = async () => {
    setGenLoading(true);
    try { const { data } = await api.get('/audit/report', { params: { period } }); setReport(data.data); }
    catch (e) { toast.error(errorMessage(e)); } finally { setGenLoading(false); }
  };
  const exportReport = () => {
    if (!report) return;
    const rows = [
      ['Audit Report', report.period], ['From', fmtDate(report.from)], ['To', fmtDate(report.to)], [],
      ['Metric', 'Count', 'Amount (USD)'],
      ['Deposits (confirmed)', report.deposits.count, report.deposits.amount],
      ['Withdrawals (completed)', report.withdrawals.count, report.withdrawals.amount],
      ['Balance adjustments', report.balanceAdjustments.count, report.balanceAdjustments.amount],
      ['New users', report.newUsers, ''], ['New flags', report.newFlags, ''],
      ['Freeze requests', report.freezeRequests, ''], ['KYC approved', report.kycApproved, ''], ['KYC rejected', report.kycRejected, ''],
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '')}"`).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `audit_report_${report.period}.csv`; a.click();
  };
  const k = data || {};
  return (
    <div className="space-y-4">
      {loading ? <Loading /> : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Kpi label="Flagged Users" value={k.flaggedUsers} tone="amber" />
          <Kpi label="Pending Freezes" value={k.pendingFreezeRequests} tone="rose" />
          <Kpi label="Pending KYC" value={k.pendingKyc} tone="blue" />
          <Kpi label="Shared-IP Groups" value={k.sharedIpGroups} tone="violet" />
          <Kpi label="Fraud Alerts 24h" value={k.fraudAlerts24h} tone="rose" />
          <Kpi label="P&L Anomalies" value={k.pnlAnomalies} tone="rose" />
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-bold text-white">Audit Report</h3>
          <div className="flex items-center gap-2">
            <select className="input w-32" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
            </select>
            <button onClick={gen} disabled={genLoading} className="btn-primary text-xs">Generate</button>
            {report && <button onClick={exportReport} className="btn-ghost text-xs">⭳ CSV</button>}
          </div>
        </div>
        {!report ? <Empty msg="Generate a daily / weekly / monthly audit report." /> : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="Deposits" main={report.deposits.count} sub={money(report.deposits.amount)} />
            <Stat label="Withdrawals" main={report.withdrawals.count} sub={money(report.withdrawals.amount)} />
            <Stat label="Balance Adj." main={report.balanceAdjustments.count} sub={money(report.balanceAdjustments.amount)} />
            <Stat label="New Users" main={report.newUsers} />
            <Stat label="New Flags" main={report.newFlags} />
            <Stat label="Freeze Requests" main={report.freezeRequests} />
            <Stat label="KYC Approved" main={report.kycApproved} />
            <Stat label="KYC Rejected" main={report.kycRejected} />
          </div>
        )}
      </Card>
    </div>
  );
}
function Kpi({ label, value, tone }) {
  const c = { amber: 'text-amber-400', rose: 'text-rose-400', blue: 'text-blue-400', violet: 'text-violet-400', emerald: 'text-emerald-400' }[tone] || 'text-white';
  return <div className="card p-4"><div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{label}</div><div className={`text-2xl font-extrabold mt-1 ${c}`}>{value ?? '—'}</div></div>;
}
function Stat({ label, main, sub }) {
  return <div className="rounded-lg border border-border-dark bg-bg-dark/40 p-3"><div className="text-[11px] uppercase tracking-wider text-text-muted">{label}</div><div className="text-lg font-bold text-white mt-0.5">{main}</div>{sub && <div className="text-xs text-text-secondary font-mono">{sub}</div>}</div>;
}

// ── Random audits ──
function RandomAudits({ onInspect }) {
  const dep = useFetch('/audit/deposits/sample?n=10');
  const wd = useFetch('/audit/withdrawals/sample?n=10');
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card>
        <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-bold text-white">Random Deposit Audit</h3><button onClick={dep.reload} className="btn-ghost text-xs">↻ Re-sample</button></div>
        {dep.loading ? <Loading /> : !dep.data?.length ? <Empty msg="No deposits." /> : (
          <div className="overflow-x-auto"><Tbl cols={['User', { t: 'Amount', r: 1 }, 'Method', { t: 'Date', r: 1 }]}>
            {dep.data.map((r) => <tr key={r._id} className="table-row"><td className="p-2.5"><UserCell u={r.user} onInspect={onInspect} /></td><td className="p-2.5 text-right font-mono text-emerald-400">{money(r.amount)}</td><td className="p-2.5 text-xs">{r.method || '—'}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(r.at)}</td></tr>)}
          </Tbl></div>
        )}
      </Card>
      <Card>
        <div className="flex items-center justify-between mb-2"><h3 className="text-sm font-bold text-white">Random Withdrawal Audit</h3><button onClick={wd.reload} className="btn-ghost text-xs">↻ Re-sample</button></div>
        {wd.loading ? <Loading /> : !wd.data?.length ? <Empty msg="No withdrawals." /> : (
          <div className="overflow-x-auto"><Tbl cols={['User', { t: 'Amount', r: 1 }, { t: 'Fee', r: 1 }, { t: 'Date', r: 1 }]}>
            {wd.data.map((r) => <tr key={r._id} className="table-row"><td className="p-2.5"><UserCell u={r.user} onInspect={onInspect} /></td><td className="p-2.5 text-right font-mono text-rose-400">{money(r.amount)}</td><td className="p-2.5 text-right font-mono text-text-muted">{money(r.fee)}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(r.at)}</td></tr>)}
          </Tbl></div>
        )}
      </Card>
    </div>
  );
}

// ── Risk detection ──
function RiskDetection({ onInspect }) {
  const [sub, setSub] = useState('multi');
  const SUBS = [{ k: 'multi', l: 'Multi-Account / IP' }, { k: 'wash', l: 'Wash Trading' }, { k: 'pnl', l: 'P&L Anomalies' }, { k: 'bonus', l: 'Bonus Abuse' }];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {SUBS.map((s) => <button key={s.k} onClick={() => setSub(s.k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${sub === s.k ? 'bg-bg-hover text-white ring-1 ring-primary-500/40' : 'text-text-secondary hover:text-white'}`}>{s.l}</button>)}
      </div>
      {sub === 'multi' && <MultiAccount onInspect={onInspect} />}
      {sub === 'wash' && <WashTrading onInspect={onInspect} />}
      {sub === 'pnl' && <PnlAnomalies onInspect={onInspect} />}
      {sub === 'bonus' && <BonusAbuse onInspect={onInspect} />}
    </div>
  );
}
function MultiAccount({ onInspect }) {
  const [by, setBy] = useState('lastLoginIp');
  const { data, loading } = useFetch(`/audit/multi-account?by=${by}`, [by]);
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-white">Shared {by === 'phone' ? 'Phone' : 'IP / Device'} — possible multi-accounts</h3>
        <select className="input w-32" value={by} onChange={(e) => setBy(e.target.value)}><option value="lastLoginIp">By IP</option><option value="phone">By Phone</option></select>
      </div>
      {loading ? <Loading /> : !data?.length ? <Empty msg="No shared-identifier groups found." /> : (
        <div className="space-y-3">
          {data.map((g) => (
            <div key={g.key} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-xs font-mono text-amber-400 mb-2">{by === 'phone' ? '📞' : '🌐'} {g.key} · {g.count} accounts</div>
              <div className="flex flex-wrap gap-2">
                {g.users.map((u) => <button key={u._id} onClick={() => onInspect(u._id)} className="text-xs px-2 py-1 rounded bg-bg-hover hover:bg-bg-panel border border-border-dark"><span className="text-white">{u.name?.trim() || u.email}</span> <span className="text-text-muted font-mono">{u.userUid}</span></button>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
function WashTrading({ onInspect }) {
  const { data, loading } = useFetch('/audit/wash-trading');
  return (
    <Card>
      <h3 className="text-sm font-bold text-white mb-2">Wash-trading suspects (rapid round-trips &lt; 5 min)</h3>
      {loading ? <Loading /> : !data?.length ? <Empty msg="No wash-trading patterns detected." /> : (
        <div className="overflow-x-auto"><Tbl cols={['User', { t: 'Rapid trades', r: 1 }, { t: 'Symbols', r: 1 }, { t: 'Net P&L', r: 1 }]}>
          {data.map((r, i) => <tr key={i} className="table-row"><td className="p-2.5"><UserCell u={r.user} onInspect={onInspect} /></td><td className="p-2.5 text-right font-mono text-amber-400">{r.rapidTrades}</td><td className="p-2.5 text-right font-mono">{r.symbols}</td><td className={`p-2.5 text-right font-mono ${r.netPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signed(r.netPnl)}</td></tr>)}
        </Tbl></div>
      )}
    </Card>
  );
}
function PnlAnomalies({ onInspect }) {
  const { data, loading } = useFetch('/audit/pnl-anomalies?threshold=1000');
  return (
    <Card>
      <h3 className="text-sm font-bold text-white mb-2">Large profit / loss anomalies (|P&L| &gt; $1,000)</h3>
      {loading ? <Loading /> : !data?.length ? <Empty msg="No anomalies above threshold." /> : (
        <div className="overflow-x-auto"><Tbl cols={['User', 'Symbol', 'Side', { t: 'Qty', r: 1 }, { t: 'P&L', r: 1 }, { t: 'Date', r: 1 }]}>
          {data.map((r) => <tr key={r._id} className="table-row"><td className="p-2.5"><UserCell u={r.user} onInspect={onInspect} /></td><td className="p-2.5 text-white">{r.symbol}</td><td className={`p-2.5 ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="p-2.5 text-right font-mono">{r.qty}</td><td className={`p-2.5 text-right font-mono font-bold ${r.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signed(r.pnl)}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(r.at)}</td></tr>)}
        </Tbl></div>
      )}
    </Card>
  );
}
function BonusAbuse({ onInspect }) {
  const { data, loading } = useFetch('/audit/bonus-abuse');
  return (
    <Card>
      <h3 className="text-sm font-bold text-white mb-2">Bonus-abuse signals (bonus balance vs trading)</h3>
      {loading ? <Loading /> : !data?.length ? <Empty msg="No bonus balances to review." /> : (
        <div className="overflow-x-auto"><Tbl cols={['User', { t: 'Bonus Balance', r: 1 }, { t: 'Trades', r: 1 }, { t: 'Signal', c: 1 }]}>
          {data.map((r, i) => <tr key={i} className="table-row"><td className="p-2.5"><UserCell u={r.user} onInspect={onInspect} /></td><td className="p-2.5 text-right font-mono text-violet-400">{money(r.bonusBalance)}</td><td className="p-2.5 text-right font-mono">{r.trades}</td><td className="p-2.5 text-center">{r.suspect ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400">SUSPECT</span> : <span className="text-text-muted text-xs">ok</span>}</td></tr>)}
        </Tbl></div>
      )}
    </Card>
  );
}

// ── Flags & Freeze ──
function FlagsFreeze({ isSuper, onInspect }) {
  const flags = useFetch('/audit/flags');
  const freezes = useFetch('/audit/freeze-requests');
  const review = async (id, decision) => {
    try { await api.post(`/audit/freeze-requests/${id}/review`, { decision }); toast.success(`Request ${decision === 'APPROVE' ? 'approved — account frozen' : 'rejected'}`); freezes.reload(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-bold text-white mb-2">Flagged Users</h3>
        {flags.loading ? <Loading /> : !flags.data?.length ? <Empty msg="No flagged users." /> : (
          <div className="overflow-x-auto"><Tbl cols={['User', 'Category', 'Reason', 'Flagged By', { t: 'When', r: 1 }]}>
            {flags.data.map((u) => <tr key={u._id} className="table-row"><td className="p-2.5"><UserCell u={u} onInspect={onInspect} /></td><td className="p-2.5"><span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/15 text-amber-400">{u.flag?.category || 'OTHER'}</span></td><td className="p-2.5 text-text-secondary max-w-[260px] truncate" title={u.flag?.reason}>{u.flag?.reason}</td><td className="p-2.5 text-xs text-text-muted">{u.flag?.flaggedByEmail}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(u.flag?.flaggedAt)}</td></tr>)}
          </Tbl></div>
        )}
      </Card>
      <Card>
        <h3 className="text-sm font-bold text-white mb-2">Account Freeze Requests</h3>
        {freezes.loading ? <Loading /> : !freezes.data?.length ? <Empty msg="No freeze requests." /> : (
          <div className="overflow-x-auto"><Tbl cols={['User', 'Reason', 'Requested By', 'Status', { t: 'Action', c: 1 }]}>
            {freezes.data.map((r) => <tr key={r._id} className="table-row">
              <td className="p-2.5"><UserCell u={r.user} onInspect={onInspect} /></td>
              <td className="p-2.5 text-text-secondary max-w-[240px] truncate" title={r.reason}>{r.reason}</td>
              <td className="p-2.5 text-xs text-text-muted">{r.requestedBy}</td>
              <td className="p-2.5"><span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r.status === 'PENDING' ? 'bg-amber-500/15 text-amber-400' : r.status === 'APPROVED' ? 'bg-rose-500/15 text-rose-400' : 'bg-bg-hover text-text-muted'}`}>{r.status}</span></td>
              <td className="p-2.5 text-center">
                {r.status === 'PENDING' && isSuper ? (
                  <div className="flex justify-center gap-1"><button onClick={() => review(r._id, 'APPROVE')} className="btn-ghost text-xs text-rose-400">Freeze</button><button onClick={() => review(r._id, 'REJECT')} className="btn-ghost text-xs">Reject</button></div>
                ) : r.status === 'PENDING' ? <span className="text-[10px] text-text-muted">awaiting Super Admin</span> : <span className="text-[10px] text-text-muted">{r.reviewedBy}</span>}
              </td>
            </tr>)}
          </Tbl></div>
        )}
      </Card>
    </div>
  );
}

// ── KYC review ──
function KycReview({ onInspect }) {
  const { data, loading } = useFetch('/audit/kyc?status=PENDING');
  return (
    <Card>
      <h3 className="text-sm font-bold text-white mb-2">KYC Verification Review (pending)</h3>
      {loading ? <Loading /> : !data?.length ? <Empty msg="No pending KYC." /> : (
        <div className="overflow-x-auto"><Tbl cols={['User', 'Country', 'Phone', { t: 'Docs', r: 1 }, { t: 'Submitted', r: 1 }]}>
          {data.map((u) => <tr key={u._id} className="table-row"><td className="p-2.5"><UserCell u={u} onInspect={onInspect} /></td><td className="p-2.5">{u.country || '—'}</td><td className="p-2.5 font-mono text-xs">{u.phone || '—'}</td><td className="p-2.5 text-right font-mono">{u.docs}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(u.at)}</td></tr>)}
        </Tbl></div>
      )}
    </Card>
  );
}

// ── Staff activity + balance adjustments ──
function Activity() {
  const act = useFetch('/audit/activity');
  const adj = useFetch('/audit/balance-adjustments');
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="text-sm font-bold text-white mb-2">Manual Balance-Adjustment Audit</h3>
        {adj.loading ? <Loading /> : !adj.data?.length ? <Empty msg="No balance adjustments." /> : (
          <div className="overflow-x-auto"><Tbl cols={['By', 'Role', { t: 'Amount', r: 1 }, 'Reason', { t: 'When', r: 1 }]}>
            {adj.data.map((r) => <tr key={r._id} className="table-row"><td className="p-2.5 text-white">{r.by}</td><td className="p-2.5 text-xs text-primary-400">{r.actorRole}</td><td className={`p-2.5 text-right font-mono ${r.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signed(r.amount)}</td><td className="p-2.5 text-text-secondary max-w-[260px] truncate" title={r.reason}>{r.reason || '—'}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(r.at)}</td></tr>)}
          </Tbl></div>
        )}
      </Card>
      <Card>
        <h3 className="text-sm font-bold text-white mb-2">Manager / Admin Activity Audit</h3>
        {act.loading ? <Loading /> : !act.data?.length ? <Empty msg="No staff activity." /> : (
          <div className="overflow-x-auto"><Tbl cols={['Actor', 'Role', 'Action', 'Target', { t: 'When', r: 1 }]}>
            {act.data.map((r) => <tr key={r._id} className="table-row"><td className="p-2.5 text-white">{r.actor}</td><td className="p-2.5 text-xs text-primary-400">{r.actorRole}</td><td className="p-2.5"><span className="text-[10px] font-bold px-2 py-0.5 rounded bg-bg-hover text-text-secondary">{r.action}</span></td><td className="p-2.5 text-xs text-text-muted font-mono">{r.targetType} {r.targetId?.slice(-6)}</td><td className="p-2.5 text-right text-xs text-text-muted">{fmtDate(r.at)}</td></tr>)}
          </Tbl></div>
        )}
      </Card>
    </div>
  );
}

// ── User Analysis — full fraud / behaviour / risk investigation ──
const riskTone = (lvl) => ({ LOW: 'text-emerald-400', MEDIUM: 'text-amber-400', HIGH: 'text-orange-400', CRITICAL: 'text-rose-400' }[lvl] || 'text-gray-400');
const riskBar = (lvl) => ({ LOW: 'bg-emerald-500', MEDIUM: 'bg-amber-500', HIGH: 'bg-orange-500', CRITICAL: 'bg-rose-500' }[lvl] || 'bg-gray-500');
const sevBadge = (s) => ({ LOW: 'bg-bg-hover text-text-muted', MEDIUM: 'bg-amber-500/15 text-amber-400', HIGH: 'bg-orange-500/15 text-orange-400', CRITICAL: 'bg-rose-500/20 text-rose-400' }[s] || 'bg-bg-hover text-text-muted');
const fmtDur = (ms) => { const m = (Number(ms) || 0) / 60000; if (m < 1) return `${((Number(ms) || 0) / 1000).toFixed(1)}s`; if (m < 60) return `${m.toFixed(1)} min`; return `${(m / 60).toFixed(1)} h`; };

function UserAnalysis() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [id, setId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const search = async (e) => {
    e?.preventDefault();
    setSearching(true);
    try {
      // No query → list all ACTIVE regular users; with query → filtered search.
      const params = query.trim()
        ? { search: query.trim(), role: 'USER', limit: 25 }
        : { role: 'USER', status: 'active', limit: 100 };
      const { data } = await api.get('/admin/users', { params });
      setResults(data.data.users || []);
    } catch (err) { toast.error(errorMessage(err)); } finally { setSearching(false); }
  };
  // Load all active users up front so the tab isn't empty.
  useEffect(() => { search(); /* eslint-disable-next-line */ }, []);
  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    api.get(`/audit/users/${id}/analysis`).then(({ data }) => setData(data.data)).catch((e) => toast.error(errorMessage(e))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, okMsg) => { try { await fn(); toast.success(okMsg); load(); } catch (e) { toast.error(errorMessage(e)); } };
  const flag = () => { const r = window.prompt('Flag reason:'); if (r) act(() => api.post(`/audit/users/${id}/flag`, { reason: r, category: 'OTHER' }), 'User flagged'); };
  const unflag = () => act(() => api.post(`/audit/users/${id}/unflag`), 'Flag removed');
  const freeze = () => { const r = window.prompt('Reason for account-freeze request:'); if (r) act(() => api.post('/audit/freeze-requests', { userId: id, reason: r }), 'Freeze request submitted'); };
  const kyc = () => { const r = window.prompt('KYC review reason:', 'Re-verify documents'); if (r !== null) act(() => api.post(`/audit/users/${id}/kyc-review`, { reason: r }), 'KYC review requested'); };
  const note = () => { const n = window.prompt('Audit note:'); if (n) act(() => api.post(`/audit/users/${id}/note`, { note: n }), 'Note added'); };
  const escalate = (to) => { const r = window.prompt(`Escalate to ${to.replace('_', ' ')} — reason:`); if (r) act(() => api.post(`/audit/users/${id}/escalate`, { to, reason: r }), `Escalated to ${to.replace('_', ' ')}`); };

  // ── Search view ──
  if (!id) {
    return (
      <Card>
        <h3 className="text-sm font-bold text-white mb-1">Investigate a user</h3>
        <p className="text-[11px] text-text-muted mb-3">Search by name, email or User ID, then open the full fraud/risk analysis.</p>
        <form onSubmit={search} className="flex gap-2 mb-3">
          <input className="input flex-1" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email, or User ID…" />
          <button className="btn-primary text-xs" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        <div className="text-[11px] text-text-muted mb-1.5">
          {searching ? 'Loading…' : `${query.trim() ? 'Results' : 'Active users'}: ${results.length}`}
        </div>
        {results.length === 0 && !searching ? <Empty msg={query.trim() ? 'No users match.' : 'No active users.'} /> : (
          <div className="overflow-x-auto"><Tbl cols={['User', 'KYC', 'Status', { t: '', r: 1 }]}>
            {results.map((u) => (
              <tr key={u._id} className="table-row">
                <td className="p-2.5"><div className="text-white font-medium">{u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email}</div><div className="text-[11px] text-text-muted font-mono">{u.userUid || u.email}</div></td>
                <td className="p-2.5 text-xs">{u.kyc?.code || u.kycStatus || '—'}</td>
                <td className="p-2.5"><span className={u.isActive === false ? 'text-rose-400 text-xs' : 'text-emerald-400 text-xs'}>{u.isActive === false ? 'Blocked' : 'Active'}</span></td>
                <td className="p-2.5 text-right"><button onClick={() => setId(u._id)} className="btn-primary text-xs">Analyze</button></td>
              </tr>
            ))}
          </Tbl></div>
        )}
      </Card>
    );
  }

  if (loading || !data) return <Loading />;
  const o = data.overview, t = data.trading, p = data.pnl, f = data.funding, r = data.risk;

  return (
    <div className="space-y-4">
      <button onClick={() => { setId(null); setData(null); }} className="text-xs text-text-secondary hover:text-white">← Back to search</button>

      {/* Risk header */}
      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-lg font-bold text-white">{o.name} <span className="text-text-muted font-mono text-sm">{o.userUid}</span></div>
          <div className="text-xs text-text-muted">{o.email} · {o.country || '—'} · joined {fmtDate(o.registeredAt)}</div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {o.auditFlag?.flagged && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">FLAGGED</span>}
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${o.status === 'BLOCKED' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400'}`}>{o.status}</span>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-bg-hover text-text-secondary">KYC: {o.kyc}</span>
          </div>
        </div>
        <div className="text-center min-w-[160px]">
          <div className="text-[11px] uppercase tracking-wider text-text-muted">Risk Score</div>
          <div className={`text-4xl font-extrabold ${riskTone(r.level)}`}>{r.score}</div>
          <div className={`text-xs font-bold ${riskTone(r.level)}`}>{r.level}</div>
          <div className="h-2 rounded-full overflow-hidden bg-bg-hover mt-1.5"><div className={`h-full ${riskBar(r.level)}`} style={{ width: `${r.score}%` }} /></div>
        </div>
      </Card>

      {/* Actions */}
      <Card>
        <div className="flex flex-wrap gap-2">
          {o.auditFlag?.flagged ? <button onClick={unflag} className="btn-ghost text-xs">Remove flag</button> : <button onClick={flag} className="btn-ghost text-xs text-amber-400">⚑ Flag user</button>}
          <button onClick={freeze} className="btn-ghost text-xs text-rose-400">🧊 Request freeze</button>
          <button onClick={kyc} className="btn-ghost text-xs text-blue-400">Request KYC review</button>
          <button onClick={note} className="btn-ghost text-xs">＋ Add note</button>
          <button onClick={() => escalate('SUPER_ADMIN')} className="btn-ghost text-xs text-violet-400">↑ Escalate · Super Admin</button>
          <button onClick={() => escalate('FINANCIAL_ADMIN')} className="btn-ghost text-xs text-violet-400">↑ Escalate · Financial Admin</button>
        </div>
      </Card>

      {/* Red flags */}
      <Card>
        <h3 className="text-sm font-bold text-white mb-2">Red Flag Center ({data.redFlags.length})</h3>
        {!data.redFlags.length ? <Empty msg="No red flags detected." /> : (
          <div className="space-y-1.5">
            {data.redFlags.map((fl, i) => (
              <div key={i} className="flex items-start gap-2 text-xs border-b border-border-subtle pb-1.5">
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 ${sevBadge(fl.severity)}`}>{fl.severity}</span>
                <div><div className="text-white">{fl.reason}</div><div className="text-text-muted">{fl.evidence}</div></div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Trading behaviour */}
        <Card>
          <h3 className="text-sm font-bold text-white mb-2">Trading Behaviour</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row l="Total Trades" v={t.totalTrades} /><Row l="Total Volume" v={`${t.totalVolume} lots`} />
            <Row l="Win Rate" v={`${t.winRate}%`} /><Row l="Avg Hold" v={fmtDur(t.avgHoldMs)} />
            <Row l="Avg Profit" v={money(t.avgProfit)} /><Row l="Avg Loss" v={money(t.avgLoss)} />
            <Row l="Max Consec. Wins" v={t.maxConsecutiveWins} /><Row l="Max Consec. Losses" v={t.maxConsecutiveLosses} />
          </div>
          <div className="text-[11px] text-text-muted mt-2">Sessions — Asia {t.sessions.ASIA} · Europe {t.sessions.EUROPE} · US {t.sessions.US}</div>
          {t.mostTraded.length > 0 && <div className="text-[11px] text-text-muted mt-1">Most traded: {t.mostTraded.map((m) => `${m.symbol} (${m.trades})`).join(', ')}</div>}
        </Card>

        {/* P&L */}
        <Card>
          <h3 className="text-sm font-bold text-white mb-2">Profit & Loss</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row l="Daily" v={signed(p.daily)} pos={p.daily} /><Row l="Weekly" v={signed(p.weekly)} pos={p.weekly} />
            <Row l="Monthly" v={signed(p.monthly)} pos={p.monthly} /><Row l="Total" v={signed(p.total)} pos={p.total} />
            <Row l="Largest Win" v={money(p.largestWin)} /><Row l="Largest Loss" v={money(p.largestLoss)} />
          </div>
        </Card>

        {/* Funding */}
        <Card>
          <h3 className="text-sm font-bold text-white mb-2">Deposits & Withdrawals</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row l="Total Deposits" v={money(f.totalDeposits)} /><Row l="Total Withdrawals" v={money(f.totalWithdrawals)} />
            <Row l="Deposit Count" v={f.depositCount} /><Row l="Withdrawal Count" v={f.withdrawalCount} />
            <Row l="Net (in−out)" v={signed(f.net)} pos={f.net} />
            <Row l="Last Deposit" v={f.lastDeposit ? `${money(f.lastDeposit.amount)} · ${fmtDate(f.lastDeposit.at)}` : '—'} />
            <Row l="Last Withdrawal" v={f.lastWithdrawal ? `${money(f.lastWithdrawal.amount)} · ${fmtDate(f.lastWithdrawal.at)}` : '—'} />
          </div>
        </Card>

        {/* Relationships */}
        <Card>
          <h3 className="text-sm font-bold text-white mb-2">Trading Relationships</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row l="Self / Wash Trades" v={data.relationships.selfTrades} />
            <Row l="Linked-account Trades" v={data.relationships.collusionTrades} />
            <Row l="Suspicious Score" v={`${data.relationships.suspiciousTradingScore}/100`} />
          </div>
        </Card>
      </div>

      {/* Linked accounts */}
      <Card>
        <h3 className="text-sm font-bold text-white mb-2">Linked Accounts ({data.linked.length})</h3>
        {!data.linked.length ? <Empty msg="No linked accounts detected (IP / phone / UPI / bank / sender name)." /> : (
          <div className="overflow-x-auto"><Tbl cols={['User', 'Shared via', { t: 'Strength', r: 1 }, 'Status']}>
            {data.linked.map((l) => (
              <tr key={l._id} className="table-row">
                <td className="p-2.5"><div className="text-white font-medium">{l.name}</div><div className="text-[11px] text-text-muted font-mono">{l.userUid}</div></td>
                <td className="p-2.5 text-xs">{l.reasons.join(', ')}</td>
                <td className="p-2.5 text-right font-mono">{'●'.repeat(Math.min(5, l.strength))}</td>
                <td className="p-2.5"><span className={l.active ? 'text-emerald-400 text-xs' : 'text-rose-400 text-xs'}>{l.active ? 'Active' : 'Blocked'}</span></td>
              </tr>
            ))}
          </Tbl></div>
        )}
      </Card>

      {/* Security + Compliance */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <h3 className="text-sm font-bold text-white mb-2">Login & Security</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Row l="Last Login" v={o.lastLoginAt ? fmtDate(o.lastLoginAt) : '—'} /><Row l="Last IP" v={o.lastLoginIp || '—'} />
          </div>
          {data.security.devices.length > 0 && <div className="text-[11px] text-text-muted mt-2">Sessions: {data.security.devices.map((d) => d.device || 'Unknown').join(' · ')}</div>}
          <div className="text-[10px] text-text-muted mt-2 italic">{data.security.note}</div>
        </Card>
        <Card>
          <h3 className="text-sm font-bold text-white mb-2">Compliance & KYC</h3>
          <Row l="KYC Status" v={data.compliance.kyc} />
          {data.compliance.docs.length > 0 && <div className="text-[11px] text-text-muted mt-1">Docs: {data.compliance.docs.map((d) => `${d.docType}(${d.status})`).join(', ')}</div>}
          {data.compliance.notes.length > 0 && (
            <div className="mt-2"><div className="text-[11px] font-semibold text-text-secondary">Audit notes</div>
              {data.compliance.notes.map((nn, i) => <div key={i} className="text-[11px] text-text-muted">• {nn.note} <span className="opacity-60">({fmtDate(nn.at)})</span></div>)}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
function Row({ l, v, pos }) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle py-1">
      <span className="text-text-muted">{l}</span>
      <span className={`font-mono ${pos === undefined ? 'text-white' : pos >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{v}</span>
    </div>
  );
}

// ── User inspection modal ──
function InspectModal({ id, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    api.get(`/audit/users/${id}/inspect`).then(({ data }) => setData(data.data)).catch((e) => toast.error(errorMessage(e))).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const flag = async () => {
    const reason = window.prompt('Flag reason (e.g. multi-account, wash trading):'); if (!reason) return;
    try { await api.post(`/audit/users/${id}/flag`, { reason, category: 'OTHER' }); toast.success('User flagged'); load(); } catch (e) { toast.error(errorMessage(e)); }
  };
  const unflag = async () => { try { await api.post(`/audit/users/${id}/unflag`); toast.success('Flag removed'); load(); } catch (e) { toast.error(errorMessage(e)); } };
  const freeze = async () => {
    const reason = window.prompt('Reason for account-freeze request:'); if (!reason) return;
    try { await api.post('/audit/freeze-requests', { userId: id, reason }); toast.success('Freeze request submitted to Super Admin'); } catch (e) { toast.error(errorMessage(e)); }
  };

  const u = data?.user;
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between sticky top-0 bg-bg-card z-10">
          <h2 className="text-base font-bold text-white">User Inspection {u?.auditFlag?.flagged && <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">FLAGGED</span>}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        {loading || !data ? <div className="p-6"><Loading /></div> : (
          <div className="p-5 space-y-4 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <F l="Name" v={u.name} /><F l="Email" v={u.email} /><F l="User ID" v={u.userUid} />
              <F l="Phone" v={u.phone} /><F l="Country" v={u.country} /><F l="KYC" v={u.kyc} />
              <F l="Status" v={u.isActive ? 'Active' : 'Blocked'} /><F l="Group" v={u.userGroup} /><F l="Last IP" v={u.lastLoginIp} />
              <F l="Last login" v={u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'} /><F l="Joined" v={fmtDate(u.createdAt)} />
            </div>
            {u.auditFlag?.flagged && <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-300">Flag: {u.auditFlag.reason} <span className="text-text-muted">· {u.auditFlag.flaggedByEmail}</span></div>}

            <Section title="Wallet balance verification">
              {!data.walletChecks.length ? <Empty msg="No wallets." /> : data.walletChecks.map((w, i) => (
                <div key={i} className="flex items-center justify-between py-1 border-b border-border-subtle text-xs">
                  <span className="font-mono">{w.currency}</span>
                  <span className="font-mono">recorded {money(w.recorded)} · ledger {money(w.expected)}</span>
                  <span className={`font-bold ${w.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{w.ok ? '✓ match' : '✗ MISMATCH'}</span>
                </div>
              ))}
            </Section>

            {data.sharedIpUsers.length > 0 && (
              <Section title={`Shares IP with ${data.sharedIpUsers.length} other account(s)`}>
                <div className="flex flex-wrap gap-1.5">{data.sharedIpUsers.map((s) => <span key={s._id} className="text-xs px-2 py-1 rounded bg-bg-hover border border-border-dark">{s.name?.trim() || s.email} <span className="text-text-muted font-mono">{s.userUid}</span></span>)}</div>
              </Section>
            )}

            <Section title="Recent trade history (verification)">
              {!data.trades.length ? <Empty msg="No closed trades." /> : (
                <Tbl cols={['Symbol', 'Side', { t: 'Qty', r: 1 }, { t: 'P&L', r: 1 }, { t: 'Closed', r: 1 }]}>
                  {data.trades.map((t, i) => <tr key={i} className="table-row"><td className="p-1.5 text-white">{t.symbol}</td><td className={`p-1.5 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td><td className="p-1.5 text-right font-mono">{t.qty}</td><td className={`p-1.5 text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signed(t.pnl)}</td><td className="p-1.5 text-right text-xs text-text-muted">{fmtDate(t.closedAt)}</td></tr>)}
                </Tbl>
              )}
            </Section>

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="Recent deposits">{!data.deposits.length ? <Empty msg="None." /> : data.deposits.map((d, i) => <div key={i} className="flex justify-between text-xs py-1 border-b border-border-subtle"><span className="text-emerald-400 font-mono">{money(d.amount)}</span><span className="text-text-muted">{d.status} · {fmtDate(d.at)}</span></div>)}</Section>
              <Section title="Recent withdrawals">{!data.withdrawals.length ? <Empty msg="None." /> : data.withdrawals.map((w, i) => <div key={i} className="flex justify-between text-xs py-1 border-b border-border-subtle"><span className="text-rose-400 font-mono">{money(w.amount)}</span><span className="text-text-muted">{w.status} · {fmtDate(w.at)}</span></div>)}</Section>
            </div>

            <Section title="Devices / sessions">
              {!data.devices.length ? <Empty msg="No active sessions." /> : data.devices.map((d, i) => <div key={i} className="text-xs text-text-secondary py-0.5">{d.device || 'Unknown device'} <span className="text-text-muted">· {fmtDate(d.at)}</span></div>)}
            </Section>
          </div>
        )}
        <div className="px-5 py-3 border-t border-border-dark flex flex-wrap justify-end gap-2 sticky bottom-0 bg-bg-card">
          {u?.auditFlag?.flagged ? <button onClick={unflag} className="btn-ghost text-xs">Remove flag</button> : <button onClick={flag} className="btn-ghost text-xs text-amber-400">⚑ Flag user</button>}
          <button onClick={freeze} className="btn-ghost text-xs text-rose-400">🧊 Request freeze</button>
          <button onClick={onClose} className="btn-secondary text-xs">Close</button>
        </div>
      </div>
    </div>
  );
}
function F({ l, v }) { return <div><div className="text-[10px] uppercase tracking-wider text-text-muted">{l}</div><div className="text-white font-medium truncate" title={v}>{v || '—'}</div></div>; }
function Section({ title, children }) { return <div><div className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-1.5">{title}</div>{children}</div>; }
