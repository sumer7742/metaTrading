import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';
import { useAuthStore } from '../store/auth';

/**
 * Financial Department workspace — role-aware.
 *
 *  • DEPOSIT_MANAGER → deposit queue + act on assigned requests.
 *  • WITHDRAWAL_MANAGER → withdrawal queue + act on assigned requests.
 *  • FINANCIAL_ADMIN / SUPER_ADMIN → everything + overview + create managers.
 *  • AUDIT_MANAGER → read-only oversight: regular checking, fraud detection,
 *    random inspection audits across all requests.
 *
 * Backend (/api/finance/*) enforces every permission + the per-request scope;
 * this UI only shows/hides controls accordingly.
 */
const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CREATABLE = {
  SUPER_ADMIN: ['FINANCIAL_ADMIN', 'DEPOSIT_MANAGER', 'WITHDRAWAL_MANAGER', 'AUDIT_MANAGER'],
  FINANCIAL_ADMIN: ['DEPOSIT_MANAGER', 'WITHDRAWAL_MANAGER', 'AUDIT_MANAGER'],
};

export default function Finance() {
  const { user } = useAuthStore();
  const role = user?.role;
  const isSuper = role === 'SUPER_ADMIN';
  const isFinAdmin = role === 'FINANCIAL_ADMIN' || isSuper;
  const canActDep = role === 'DEPOSIT_MANAGER' || isFinAdmin;
  const canActWd = role === 'WITHDRAWAL_MANAGER' || isFinAdmin;
  // Reassign (between managers) is a financial-admin / super-admin power.
  const canReassignDep = isFinAdmin;
  const canReassignWd = isFinAdmin;
  const canStaff = role === 'FINANCIAL_ADMIN' || isSuper;

  const [tab, setTab] = useState('deposits');
  const [status, setStatus] = useState('PENDING');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState(null);
  const [officers, setOfficers] = useState([]);

  const kind = tab === 'withdrawals' ? 'withdrawal' : 'deposit';
  const canAct = kind === 'withdrawal' ? canActWd : canActDep;
  const canReassign = kind === 'withdrawal' ? canReassignWd : canReassignDep;

  const loadQueue = async () => {
    if (tab === 'staff') return;
    setLoading(true);
    try {
      const params = status ? { status } : {};
      const { data } = await api.get(`/finance/${tab}`, { params });
      setRows(data.data || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadQueue(); /* eslint-disable-next-line */ }, [tab, status]);
  useEffect(() => {
    if (isFinAdmin) api.get('/finance/overview').then((r) => setOverview(r.data.data)).catch(() => {});
  }, [isFinAdmin]);
  useEffect(() => {
    if (canReassign) api.get('/finance/officers', { params: { kind } }).then((r) => setOfficers(r.data.data || [])).catch(() => setOfficers([]));
  }, [kind, canReassign]);

  const act = async (path, body, okMsg) => {
    try { await api.post(path, body || {}); toast.success(okMsg); loadQueue(); if (isFinAdmin) api.get('/finance/overview').then((r) => setOverview(r.data.data)).catch(() => {}); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const confirm = (r) => act(`/finance/deposits/${r._id}/confirm`, {}, 'Deposit confirmed');
  const approve = (r) => act(`/finance/withdrawals/${r._id}/approve`, {}, 'Withdrawal approved');
  const reject = (r) => {
    const reason = window.prompt('Rejection reason?') || '';
    if (reason === null) return;
    act(`/finance/${tab}/${r._id}/reject`, { reason, rejectionReason: reason, rejectedReason: reason }, 'Request rejected');
  };
  const reassign = (r, officerId) => {
    if (!officerId) return;
    act(`/finance/${tab}/${r._id}/reassign`, { officerId }, 'Request reassigned');
  };

  return (
    <div className="space-y-5 max-w-[1500px]">
      <PageHero
        eyebrow="Financial Department"
        title="Finance Workspace"
        subtitle={`Signed in as ${role?.replaceAll('_', ' ')} · requests are auto-distributed by workload. ${role === 'AUDIT_MANAGER' ? 'Read-only audit: checking, fraud detection & random inspection.' : ''}`}
      />

      {isFinAdmin && overview && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Kpi label="Pending Deposits" value={overview.pendingDeposits} tone="warn" />
          <Kpi label="Pending Withdrawals" value={overview.pendingWithdrawals} tone="warn" />
          <Kpi label="Deposits Today" value={overview.processedDepositsToday} tone="bull" />
          <Kpi label="Withdrawals Today" value={overview.processedWithdrawalsToday} tone="bull" />
          <Kpi label="Deposit Managers" value={overview.depositManagers} />
          <Kpi label="Withdrawal Managers" value={overview.withdrawalManagers} />
        </div>
      )}

      {/* Tabs */}
      <div className="inline-flex p-1 bg-bg-hover rounded-xl border border-border-dark">
        {[['deposits', 'Deposit Queue'], ['withdrawals', 'Withdrawal Queue'], ...(canStaff ? [['staff', 'Staff']] : [])].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`px-4 py-1.5 text-sm font-bold rounded-lg transition-all ${tab === id ? 'bg-bg-card text-text-primary shadow' : 'text-text-secondary'}`}>{label}</button>
        ))}
      </div>

      {tab === 'staff' ? (
        <StaffPanel role={role} />
      ) : (
        <>
          <div className="card p-3 flex items-center gap-3 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input text-xs max-w-[180px]">
              <option value="">All</option>
              {(kind === 'deposit'
                ? ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED']
                : ['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED']
              ).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={loadQueue} className="btn-ghost text-xs">↻ Refresh</button>
            <span className="text-[11px] text-text-muted ml-auto">{rows.length} request(s)</span>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[10px] text-text-muted uppercase tracking-[0.14em] font-bold bg-bg-hover/40">
                <tr>
                  <th className="text-left p-3">When</th>
                  <th className="text-left p-3">User</th>
                  <th className="text-right p-3">Amount</th>
                  <th className="text-left p-3">Method</th>
                  <th className="text-left p-3">Assigned Manager</th>
                  <th className="text-center p-3">Status</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !rows.length && <tr><td colSpan={7} className="py-10 text-center text-text-muted">Loading…</td></tr>}
                {!loading && !rows.length && <tr><td colSpan={7} className="py-10 text-center text-text-muted">No requests in your queue</td></tr>}
                {rows.map((r) => {
                  const pending = r.status === 'PENDING';
                  return (
                    <tr key={r._id} className="border-b border-border-subtle hover:bg-bg-hover/40">
                      <td className="p-3 text-xs text-text-secondary whitespace-nowrap font-mono">{fmtDate(r.createdAt)}</td>
                      <td className="p-3 text-xs">
                        <div className="font-semibold text-text-primary">{r.user?.name || '—'}</div>
                        <div className="text-text-muted text-[10px] font-mono">{r.user?.email}</div>
                      </td>
                      <td className="p-3 text-right font-mono text-text-primary whitespace-nowrap">
                        {r.amount} <span className="text-[10px] text-text-muted">{r.currency}</span>
                        {Number(r.baseAmount) > 0 && <div className="text-[10px] text-text-muted">${money(r.baseAmount)}</div>}
                      </td>
                      <td className="p-3 text-xs text-text-secondary">{r.method || '—'}</td>
                      <td className="p-3 text-xs">
                        {r.assignedOfficer ? (
                          <span className="text-text-secondary">{r.assignedOfficer.name}</span>
                        ) : <span className="text-text-muted italic">unassigned</span>}
                        {pending && canReassign && officers.length > 0 && (
                          <select defaultValue="" onChange={(e) => reassign(r, e.target.value)} className="block mt-1 text-[11px] bg-bg-dark border border-border-dark rounded px-1.5 py-1 text-white">
                            <option value="" disabled>Reassign →</option>
                            {officers.map((o) => <option key={o._id} value={o._id}>{o.name}</option>)}
                          </select>
                        )}
                      </td>
                      <td className="p-3 text-center">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                          ['CONFIRMED', 'COMPLETED', 'APPROVED'].includes(r.status) ? 'bg-emerald-500/15 text-emerald-400'
                          : ['REJECTED', 'CANCELLED'].includes(r.status) ? 'bg-rose-500/15 text-rose-400'
                          : 'bg-amber-500/15 text-amber-400'}`}>{r.status}</span>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        {pending && canAct ? (
                          <div className="inline-flex gap-1">
                            <button onClick={() => (kind === 'deposit' ? confirm(r) : approve(r))} className="text-[11px] font-bold px-2 py-1 rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25">
                              {kind === 'deposit' ? 'Confirm' : 'Approve'}
                            </button>
                            <button onClick={() => reject(r)} className="text-[11px] font-bold px-2 py-1 rounded bg-rose-500/15 text-rose-400 hover:bg-rose-500/25">Reject</button>
                          </div>
                        ) : <span className="text-text-muted text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }) {
  const t = { warn: 'text-warn', bull: 'text-bull' }[tone] || 'text-text-primary';
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold tabular-nums ${t}`}>{value}</div>
    </div>
  );
}

function StaffPanel({ role }) {
  const creatable = CREATABLE[role] || [];
  const canReset = ['SUPER_ADMIN', 'FINANCIAL_ADMIN'].includes(role);
  const [staff, setStaff] = useState([]);
  const [form, setForm] = useState({ email: '', role: creatable[0] || '', firstName: '', lastName: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { const { data } = await api.get('/finance/staff'); setStaff(data.data || []); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); }, []);

  const resetPw = async (s) => {
    const pw = window.prompt(`Set a new password for ${s.email}.\nLeave blank to auto-generate one (min 6 chars).`, '');
    if (pw === null) return; // cancelled
    try {
      const { data } = await api.post(`/finance/staff/${s._id}/reset-password`, { password: pw });
      toast.success(`Password reset for ${s.email} · temp password: ${data.data.tempPassword}`, { duration: 12000 });
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const create = async (e) => {
    e.preventDefault();
    if (!form.email || !form.role) return toast.error('Email + role required');
    setSaving(true);
    try {
      const { data } = await api.post('/finance/staff', form);
      toast.success(data.data.tempPassword ? `Created · temp password: ${data.data.tempPassword}` : 'Staff updated', { duration: data.data.tempPassword ? 9000 : 3000 });
      setForm({ ...form, email: '', firstName: '', lastName: '' });
      load();
    } catch (e2) { toast.error(errorMessage(e2)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      {creatable.length > 0 && (
        <form onSubmit={create} className="card p-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
          <div className="sm:col-span-2">
            <label className="label">Email</label>
            <input className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="staff@example.com" />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {creatable.map((r) => <option key={r} value={r}>{r.replaceAll('_', ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className="label">First name</label>
            <input className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </div>
          <button type="submit" disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? 'Saving…' : '+ Add staff'}</button>
          <p className="sm:col-span-5 text-[11px] text-text-muted">Existing email is promoted; otherwise a new account is created (temp password shown once). Requests auto-distribute to officers by workload.</p>
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-[0.14em] font-bold bg-bg-hover/40">
            <tr>
              <th className="text-left p-3">Name</th>
              <th className="text-left p-3">Email</th>
              <th className="text-left p-3">Role</th>
              <th className="text-center p-3">Active</th>
              <th className="text-left p-3">Joined</th>
              <th className="text-right p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!staff.length && <tr><td colSpan={6} className="py-10 text-center text-text-muted">No finance staff yet</td></tr>}
            {staff.map((s) => (
              <tr key={s._id} className="border-b border-border-subtle hover:bg-bg-hover/40">
                <td className="p-3 font-semibold text-text-primary">{s.name}</td>
                <td className="p-3 text-xs font-mono text-text-secondary">{s.email}</td>
                <td className="p-3"><span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-primary-500/15 text-primary-400">{s.role.replaceAll('_', ' ')}</span></td>
                <td className="p-3 text-center">{s.isActive ? <span className="text-bull">●</span> : <span className="text-bear">●</span>}</td>
                <td className="p-3 text-xs text-text-secondary font-mono whitespace-nowrap">{fmtDate(s.createdAt)}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  {canReset && <button onClick={() => resetPw(s)} className="btn-ghost text-xs">🔑 Reset password</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
