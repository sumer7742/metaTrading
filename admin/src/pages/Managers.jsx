import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';

/**
 * Managers — SuperAdmin sees/creates all managers (must pick the parent
 * admin); an Admin sees/creates only their own (max 10).
 * Backend: GET/POST/DELETE /hierarchy/managers + GET /hierarchy/workload + /hierarchy/admins.
 */
export default function Managers() {
  const { user } = useAuthStore();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [managers, setManagers] = useState([]);
  const [workload, setWorkload] = useState({ managers: [] });
  const [admins, setAdmins] = useState([]); // super: for the parent picker
  const [adminFilter, setAdminFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = { limit: 200 };
      if (isSuper && adminFilter) params.adminId = adminFilter;
      const reqs = [api.get('/hierarchy/managers', { params }), api.get('/hierarchy/workload')];
      if (isSuper) reqs.push(api.get('/hierarchy/admins', { params: { limit: 100 } }));
      const [m, w, a] = await Promise.all(reqs);
      setManagers(m.data.data.items || []);
      setWorkload(w.data.data || { managers: [] });
      if (a) setAdmins(a.data.data.items || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [adminFilter]);

  const wlById = useMemo(() => new Map((workload.managers || []).map((x) => [String(x.id), x])), [workload]);
  const adminName = useMemo(() => new Map(admins.map((a) => [String(a._id), [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email])), [admins]);

  const deactivate = async (m) => {
    const strategy = window.prompt(
      `Deactivate ${m.email}. Strategy:\n` +
      `  toAdminPool  — keep users under the admin (no manager)\n` +
      `  keep         — leave users on this (inactive) manager\n` +
      `  reassign:<managerId>  — move users to another manager under the same admin\n`,
      'toAdminPool'
    );
    if (!strategy) return;
    try {
      await api.delete(`/hierarchy/managers/${m._id}`, { params: { strategy } });
      toast.success('Manager deactivated');
      load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-5 max-w-[1400px]">
      <PageHero
        eyebrow="Hierarchy"
        title="Managers"
        subtitle={isSuper ? `${managers.length} managers across all admins.` : `Your managers (max 10). Assign users to them from Assignments.`}
        actions={<button onClick={() => setCreateOpen(true)} className="btn-primary text-sm">+ Create Manager</button>}
      />

      {isSuper && (
        <div className="card p-3 flex items-center gap-3 flex-wrap">
          <span className="label">Filter by admin</span>
          <select className="input max-w-[260px]" value={adminFilter} onChange={(e) => setAdminFilter(e.target.value)}>
            <option value="">All admins</option>
            {admins.map((a) => <option key={a._id} value={a._id}>{adminName.get(String(a._id))}</option>)}
          </select>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
              <th className="text-left py-2.5 px-3">Manager</th>
              <th className="text-left py-2.5 px-3">Email</th>
              {isSuper && <th className="text-left py-2.5 px-3">Admin</th>}
              <th className="text-center py-2.5 px-3">Users</th>
              <th className="text-center py-2.5 px-3">Verified</th>
              <th className="text-center py-2.5 px-3">Pending KYC</th>
              <th className="text-center py-2.5 px-3">Status</th>
              <th className="text-right py-2.5 px-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && managers.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && managers.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-text-muted">No managers yet</td></tr>}
            {managers.map((m) => {
              const wl = wlById.get(String(m._id)) || {};
              return (
                <tr key={m._id} className="table-row">
                  <td className="py-2 px-3 text-text-primary font-semibold">{[m.firstName, m.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="py-2 px-3 text-text-secondary">{m.email}</td>
                  {isSuper && <td className="py-2 px-3 text-text-secondary">{adminName.get(String(m.adminId)) || '—'}</td>}
                  <td className="py-2 px-3 text-center font-mono">{wl.totalUsers || 0} / {wl.userCapacity || 100}</td>
                  <td className="py-2 px-3 text-center font-mono text-bull">{wl.verifiedUsers || 0}</td>
                  <td className="py-2 px-3 text-center font-mono text-warn">{wl.pendingKycUsers || 0}</td>
                  <td className="py-2 px-3 text-center">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${m.isActive !== false ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>
                      {m.isActive !== false ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right">
                    <button onClick={() => deactivate(m)} className="btn-ghost text-xs text-rose-400">Deactivate</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createOpen && <CreateManagerModal isSuper={isSuper} admins={admins} onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); load(); }} />}
    </div>
  );
}

function CreateManagerModal({ isSuper, admins, onClose, onSaved }) {
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', password: '', parentId: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.email) return toast.error('Email required');
    if (isSuper && !form.parentId) return toast.error('Pick the parent admin');
    setBusy(true);
    try {
      const { data } = await api.post('/hierarchy/managers', form);
      const pw = data.data.generatedPassword;
      toast.success(pw ? `Manager created · temp password: ${pw}` : 'Manager created', { duration: pw ? 9000 : 3000 });
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Create Manager</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          {isSuper && (
            <label className="block"><div className="label mb-1">Parent admin *</div>
              <select className="input" value={form.parentId} onChange={set('parentId')}>
                <option value="">Select admin…</option>
                {admins.map((a) => <option key={a._id} value={a._id}>{[a.firstName, a.lastName].filter(Boolean).join(' ') || a.email}</option>)}
              </select>
            </label>
          )}
          <label className="block"><div className="label mb-1">Email *</div><input className="input" value={form.email} onChange={set('email')} placeholder="manager@company.com" autoFocus /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><div className="label mb-1">First name</div><input className="input" value={form.firstName} onChange={set('firstName')} /></label>
            <label className="block"><div className="label mb-1">Last name</div><input className="input" value={form.lastName} onChange={set('lastName')} /></label>
          </div>
          <label className="block"><div className="label mb-1">Password (optional)</div><input className="input" value={form.password} onChange={set('password')} placeholder="Auto-generated if blank" /></label>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary text-sm disabled:opacity-50">{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}
