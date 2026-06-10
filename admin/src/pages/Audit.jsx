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
      <thead className="text-xs text-gray-500 uppercase"><tr>{cols.map((c, i) => <th key={i} className={`p-2.5 ${c.r ? 'text-right' : c.c ? 'text-center' : 'text-left'}`}>{c.t || c}</th>)}</tr></thead>
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
          <Kpi label="Deposits 24h" value={k.deposits24h} tone="emerald" />
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
