import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';

/**
 * Assignments — assign unassigned users down the chain, and reassign /
 * unassign users already under a manager. SuperAdmin assigns to an Admin
 * (and optionally a Manager under it); an Admin assigns to their own
 * Managers. Bulk + reassignment supported.
 *
 * Backend: /hierarchy/{unassigned,users,assign/admin,assign/manager,reassign,unassign,bulk,managers,admins,workload}.
 */
export default function Assignments() {
  const { user } = useAuthStore();
  const isSuper = user?.role === 'SUPER_ADMIN';

  // Admin → 'myUsers' (their own pool, the fix); Super → 'unassigned'.
  const [mode, setMode] = useState(isSuper ? 'unassigned' : 'myUsers'); // unassigned | myUsers | byAdmin | byManager
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [admins, setAdmins] = useState([]);
  const [managers, setManagers] = useState([]);
  const [byManagerId, setByManagerId] = useState('');
  const [byAdminId, setByAdminId] = useState('');           // super: view a specific admin's users
  const [managerStatus, setManagerStatus] = useState('all'); // all | unassigned | assigned (pool views)
  const [selected, setSelected] = useState(new Set());
  const [workload, setWorkload] = useState({ admins: [], managers: [] });
  const [assignTarget, setAssignTarget] = useState(null); // { userIds:[] }
  const [loading, setLoading] = useState(false);

  const loadPickers = async () => {
    try {
      const reqs = [api.get('/hierarchy/managers', { params: { limit: 200 } }), api.get('/hierarchy/workload')];
      if (isSuper) reqs.push(api.get('/hierarchy/admins', { params: { limit: 100 } }));
      const [m, w, a] = await Promise.all(reqs);
      setManagers(m.data.data.items || []);
      setWorkload(w.data.data || { admins: [], managers: [] });
      if (a) setAdmins(a.data.data.items || []);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const loadRows = async () => {
    setLoading(true); setSelected(new Set());
    try {
      if (mode === 'byManager') {
        if (!byManagerId) { setRows([]); return; }
        const { data } = await api.get('/hierarchy/users', { params: { managerId: byManagerId, search, limit: 200 } });
        setRows(data.data.items || []);
      } else if (mode === 'myUsers') {
        // Admin's own assigned users (ownership = adminId). Optional manager-status filter.
        const { data } = await api.get('/hierarchy/users', { params: { managerStatus, search, limit: 200 } });
        setRows(data.data.items || []);
      } else if (mode === 'byAdmin') {
        if (!byAdminId) { setRows([]); return; }
        const { data } = await api.get('/hierarchy/users', { params: { adminId: byAdminId, managerStatus, search, limit: 200 } });
        setRows(data.data.items || []);
      } else { // 'unassigned' (super) — users not yet under any admin
        const { data } = await api.get('/hierarchy/unassigned', { params: { search, limit: 200 } });
        setRows(data.data.items || []);
      }
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadPickers(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { loadRows(); /* eslint-disable-next-line */ }, [mode, byManagerId, byAdminId, managerStatus]);

  const adminName = useMemo(() => new Map(admins.map((a) => [String(a._id), [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email])), [admins]);
  const managerName = useMemo(() => new Map(managers.map((m) => [String(m._id), [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email])), [managers]);
  const poolMode = mode === 'myUsers' || mode === 'byAdmin';
  // Admin pool summary (requirement #7) — derived from the workload rollup.
  const adminStats = useMemo(() => {
    const total = workload.admins?.[0]?.totalUsers || 0;
    const withMgr = (workload.managers || []).reduce((s, m) => s + (m.totalUsers || 0), 0);
    return { total, withMgr, noMgr: Math.max(0, total - withMgr) };
  }, [workload]);
  const cols = 5 + (poolMode ? 1 : 0) + (mode === 'byManager' && isSuper ? 1 : 0);
  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(String(r._id)));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => String(r._id))));

  const doUnassign = async (userId) => {
    try { await api.post('/hierarchy/unassign', { userId }); toast.success('Unassigned'); loadRows(); loadPickers(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-5 max-w-[1400px]">
      <PageHero eyebrow="Hierarchy" title="User Assignment"
        subtitle="Assign unassigned users to managers (and admins), reassign across managers, and bulk-assign in one go." />

      {/* Workload counters */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {isSuper && (
          <WorkloadCard title="Admin workload" rows={workload.admins} cap={500} />
        )}
        <WorkloadCard title="Manager workload" rows={workload.managers} cap={100} />
      </div>

      {/* Admin pool summary (requirement #7) */}
      {!isSuper && (
        <div className="grid grid-cols-3 gap-3">
          <StatPill label="Total assigned to you" value={adminStats.total} />
          <StatPill label="No manager yet" value={adminStats.noMgr} accent />
          <StatPill label="Under a manager" value={adminStats.withMgr} />
        </div>
      )}

      {/* Mode + filters + search */}
      <div className="card p-3 flex items-center gap-3 flex-wrap">
        <div className="inline-flex p-1 bg-bg-hover rounded-lg border border-border-dark">
          {(isSuper
            ? [{ id: 'unassigned', label: 'Unassigned' }, { id: 'byAdmin', label: "An admin's users" }, { id: 'byManager', label: "A manager's users" }]
            : [{ id: 'myUsers', label: 'My users' }, { id: 'byManager', label: "A manager's users" }]
          ).map((t) => (
            <button key={t.id} onClick={() => setMode(t.id)} className={`px-3 py-1.5 text-sm font-bold rounded ${mode === t.id ? 'bg-bg-card text-text-primary' : 'text-text-secondary'}`}>{t.label}</button>
          ))}
        </div>
        {mode === 'byAdmin' && (
          <select className="input max-w-[240px]" value={byAdminId} onChange={(e) => setByAdminId(e.target.value)}>
            <option value="">Select admin…</option>
            {admins.map((a) => <option key={a._id} value={a._id}>{[a.firstName, a.lastName].filter(Boolean).join(' ') || a.email}</option>)}
          </select>
        )}
        {mode === 'byManager' && (
          <select className="input max-w-[240px]" value={byManagerId} onChange={(e) => setByManagerId(e.target.value)}>
            <option value="">Select manager…</option>
            {managers.map((m) => <option key={m._id} value={m._id}>{[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}</option>)}
          </select>
        )}
        {poolMode && (
          <select className="input max-w-[180px]" value={managerStatus} onChange={(e) => setManagerStatus(e.target.value)}>
            <option value="all">All users</option>
            <option value="unassigned">No manager yet</option>
            <option value="assigned">Under a manager</option>
          </select>
        )}
        <input className="input flex-1 min-w-[200px]" placeholder="Search users…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadRows()} />
        <button onClick={loadRows} className="btn-primary text-xs">Search</button>
        {selected.size > 0 && (
          <button onClick={() => setAssignTarget({ userIds: [...selected] })} className="btn-primary text-xs">Assign {selected.size} selected →</button>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
              <th className="py-2.5 px-3"><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
              <th className="text-left py-2.5 px-3">User</th>
              <th className="text-left py-2.5 px-3">Email</th>
              <th className="text-center py-2.5 px-3">KYC</th>
              {poolMode && <th className="text-left py-2.5 px-3">Manager</th>}
              {mode === 'byManager' && isSuper && <th className="text-left py-2.5 px-3">Admin</th>}
              <th className="text-right py-2.5 px-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={cols} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={cols} className="py-10 text-center text-text-muted">{mode === 'byManager' && !byManagerId ? 'Pick a manager' : mode === 'byAdmin' && !byAdminId ? 'Pick an admin' : 'No users'}</td></tr>}
            {rows.map((u) => (
              <tr key={u._id} className="table-row">
                <td className="py-2 px-3 text-center"><input type="checkbox" checked={selected.has(String(u._id))} onChange={() => toggle(String(u._id))} /></td>
                <td className="py-2 px-3 text-text-primary">
                  <div>{[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}</div>
                  {u.userUid && <div className="text-[10px] font-mono text-primary-500/80">{u.userUid}</div>}
                </td>
                <td className="py-2 px-3 text-text-secondary">{u.email}</td>
                <td className="py-2 px-3 text-center"><span className="text-[10px] font-bold uppercase text-text-muted">{u.kycStatus || '—'}</span></td>
                {poolMode && <td className="py-2 px-3 text-text-secondary">{u.managerId ? (managerName.get(String(u.managerId)) || 'Manager') : <span className="text-text-muted italic">No manager</span>}</td>}
                {mode === 'byManager' && isSuper && <td className="py-2 px-3 text-text-secondary">{adminName.get(String(u.adminId)) || '—'}</td>}
                <td className="py-2 px-3 text-right space-x-2">
                  <button onClick={() => setAssignTarget({ userIds: [String(u._id)] })} className="btn-ghost text-xs text-primary-500">{mode === 'byManager' ? 'Reassign' : (u.managerId ? 'Change' : 'Assign')}</button>
                  {mode === 'byManager' && <button onClick={() => doUnassign(String(u._id))} className="btn-ghost text-xs text-rose-400">Unassign</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {assignTarget && (
        <AssignModal
          userIds={assignTarget.userIds} isSuper={isSuper} admins={admins} managers={managers}
          reassign={mode === 'byManager'} presetAdminId={mode === 'byAdmin' ? byAdminId : ''}
          onClose={() => setAssignTarget(null)}
          onSaved={() => { setAssignTarget(null); loadRows(); loadPickers(); }}
        />
      )}
    </div>
  );
}

function StatPill({ label, value, accent }) {
  return (
    <div className={`card p-4 ${accent ? 'border-primary-500/40' : ''}`}>
      <div className={`text-2xl font-extrabold ${accent ? 'text-primary-500' : 'text-text-primary'}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function WorkloadCard({ title, rows, cap }) {
  return (
    <div className="card p-4">
      <div className="label mb-2">{title}</div>
      {(!rows || rows.length === 0) ? <div className="text-xs text-text-muted">No data yet</div> : (
        <div className="space-y-1.5 max-h-40 overflow-y-auto">
          {rows.map((r) => {
            const pct = Math.min(100, Math.round((r.totalUsers / (r.userCapacity || cap)) * 100));
            return (
              <div key={r.id} className="flex items-center gap-2 text-xs">
                <span className="text-text-primary truncate flex-1">{r.name}</span>
                <span className="font-mono text-text-secondary">{r.totalUsers} / {r.userCapacity || cap}</span>
                <div className="w-20 h-1.5 rounded-full bg-bg-hover overflow-hidden"><div className="h-full bg-primary-500" style={{ width: `${pct}%` }} /></div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssignModal({ userIds, isSuper, admins, managers, reassign, presetAdminId = '', onClose, onSaved }) {
  const [adminId, setAdminId] = useState(presetAdminId);
  const [managerId, setManagerId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Super can scope the manager list to the chosen admin.
  const mgrOptions = isSuper && adminId ? managers.filter((m) => String(m.adminId) === String(adminId)) : managers;

  const submit = async () => {
    setBusy(true);
    try {
      if (userIds.length > 1) {
        const body = { userIds, reason };
        if (managerId) body.managerId = managerId; else if (isSuper && adminId) body.adminId = adminId;
        else throw new Error('Pick a target');
        const { data } = await api.post('/hierarchy/bulk', body);
        toast.success(`Assigned ${data.data.ok}/${userIds.length}${data.data.failed ? ` (${data.data.failed} failed)` : ''}`);
      } else {
        const userId = userIds[0];
        if (managerId) await api.post(reassign ? '/hierarchy/reassign' : '/hierarchy/assign/manager', { userId, managerId, reason });
        else if (isSuper && adminId) await api.post('/hierarchy/assign/admin', { userId, adminId, reason });
        else throw new Error('Pick a target');
        toast.success(reassign ? 'Reassigned' : 'Assigned');
      }
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">{reassign ? 'Reassign' : 'Assign'} {userIds.length > 1 ? `${userIds.length} users` : 'user'}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          {isSuper && !reassign && (
            <label className="block"><div className="label mb-1">Admin {`(${admins.length})`}</div>
              <select className="input" value={adminId} onChange={(e) => { setAdminId(e.target.value); setManagerId(''); }}>
                <option value="">Select admin…</option>
                {admins.map((a) => <option key={a._id} value={a._id}>{[a.firstName, a.lastName].filter(Boolean).join(' ') || a.email}</option>)}
              </select>
            </label>
          )}
          <label className="block"><div className="label mb-1">Manager {reassign ? '(required)' : '(optional)'}</div>
            <select className="input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">{reassign ? 'Select manager…' : 'No manager (admin pool)'}</option>
              {mgrOptions.map((m) => <option key={m._id} value={m._id}>{[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}</option>)}
            </select>
          </label>
          <label className="block"><div className="label mb-1">Reason / notes</div><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional — logged to the assignment history" /></label>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}
