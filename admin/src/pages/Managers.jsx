import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';
import LimitsModal from '../components/LimitsModal';
import ResetPasswordModal from '../components/ResetPasswordModal';
import EditStaffModal from '../components/EditStaffModal';

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
  const [limitsFor, setLimitsFor] = useState(null);
  const [resetFor, setResetFor] = useState(null);
  const [editFor, setEditFor] = useState(null);
  const [selected, setSelected] = useState(() => new Set()); // manager ids picked for bulk move
  const [moveOpen, setMoveOpen] = useState(false);           // bulk "move to another admin" modal
  const [preferredId, setPreferredId] = useState(null); // manager all new signups route to (until full)

  const load = async () => {
    setLoading(true);
    try {
      const params = { limit: 200 };
      if (isSuper && adminFilter) params.adminId = adminFilter;
      const reqs = [
        api.get('/hierarchy/managers', { params }),
        api.get('/hierarchy/workload'),
        api.get('/hierarchy/preferred-manager').catch(() => null),
      ];
      if (isSuper) reqs.push(api.get('/hierarchy/admins', { params: { limit: 100 } }));
      const [m, w, pref, a] = await Promise.all(reqs);
      setManagers(m.data.data.items || []);
      setWorkload(w.data.data || { managers: [] });
      setPreferredId(pref?.data?.data?.managerId || null);
      if (a) setAdmins(a.data.data.items || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [adminFilter]);

  const wlById = useMemo(() => new Map((workload.managers || []).map((x) => [String(x.id), x])), [workload]);
  const adminName = useMemo(() => new Map(admins.map((a) => [String(a._id), [a.firstName, a.lastName].filter(Boolean).join(' ') || a.email])), [admins]);
  const preferredMgr = useMemo(() => managers.find((m) => String(m._id) === String(preferredId)), [managers, preferredId]);
  const preferredName = preferredMgr ? ([preferredMgr.firstName, preferredMgr.lastName].filter(Boolean).join(' ') || preferredMgr.email) : 'the selected manager';

  // Multi-select for bulk "move to another admin".
  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = managers.length > 0 && managers.every((m) => selected.has(m._id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(managers.map((m) => m._id)));
  const selectedManagers = managers
    .filter((m) => selected.has(m._id))
    .map((m) => ({ ...m, userCount: (wlById.get(String(m._id))?.totalUsers) || 0 }));

  // Route ALL new signups to one manager until full (or clear → auto-balance).
  const togglePreferred = async (m) => {
    const makeDefault = String(preferredId) !== String(m._id);
    try {
      const { data } = await api.put('/hierarchy/preferred-manager', { managerId: makeDefault ? m._id : null });
      setPreferredId(data.data.managerId || null);
      toast.success(makeDefault
        ? `New signups will now go to ${[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email} until full`
        : 'Default intake cleared — back to auto-balancing');
    } catch (e) { toast.error(errorMessage(e)); }
  };

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

      {preferredId && (
        <div className="card p-3 text-sm text-text-secondary flex items-center gap-2 flex-wrap">
          <span className="text-amber-500 text-base leading-none">★</span>
          <span>New signups are routing to <span className="font-semibold text-text-primary">{preferredName}</span> until it's full — then auto-balancing resumes.</span>
          {isSuper && <button onClick={() => togglePreferred(preferredMgr || { _id: preferredId })} className="ml-auto btn-ghost text-xs text-rose-400">Clear</button>}
        </div>
      )}

      {isSuper && selectedManagers.length > 0 && (
        <div className="card p-3 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{selectedManagers.length}</span> manager{selectedManagers.length === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelected(new Set())} className="btn-ghost text-xs">Clear</button>
            <button onClick={() => setMoveOpen(true)} className="btn-primary text-xs">Move to another admin →</button>
          </div>
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
              {isSuper && (
                <th className="text-center py-2.5 px-3 w-10">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all" className="accent-primary-500 cursor-pointer" />
                </th>
              )}
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
            {loading && managers.length === 0 && <tr><td colSpan={9} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && managers.length === 0 && <tr><td colSpan={9} className="py-10 text-center text-text-muted">No managers yet</td></tr>}
            {managers.map((m) => {
              const wl = wlById.get(String(m._id)) || {};
              return (
                <tr key={m._id} className={`table-row ${isSuper && selected.has(m._id) ? 'bg-primary-500/5' : ''}`}>
                  {isSuper && (
                    <td className="py-2 px-3 text-center">
                      <input type="checkbox" checked={selected.has(m._id)} onChange={() => toggleOne(m._id)} className="accent-primary-500 cursor-pointer" />
                    </td>
                  )}
                  <td className="py-2 px-3 text-text-primary font-semibold">
                    {[m.firstName, m.lastName].filter(Boolean).join(' ') || '—'}
                    {String(preferredId) === String(m._id) && (
                      <span className="ml-2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 align-middle">★ Default intake</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-text-secondary">{m.email}</td>
                  {isSuper && <td className="py-2 px-3 text-text-secondary">{adminName.get(String(m.adminId)) || '—'}</td>}
                  <td className="py-2 px-3 text-center font-mono">{wl.totalUsers || 0} / {m.hierarchyLimits?.maxUsers ?? (wl.userCapacity || 100)}</td>
                  <td className="py-2 px-3 text-center font-mono text-bull">{wl.verifiedUsers || 0}</td>
                  <td className="py-2 px-3 text-center font-mono text-warn">{wl.pendingKycUsers || 0}</td>
                  <td className="py-2 px-3 text-center">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${m.isActive !== false ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>
                      {m.isActive !== false ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right space-x-1">
                    {isSuper && (
                      <button onClick={() => togglePreferred(m)}
                        className={`btn-ghost text-xs ${String(preferredId) === String(m._id) ? 'text-amber-400' : 'text-text-muted'}`}
                        title={String(preferredId) === String(m._id) ? 'All new signups route here — click to clear' : 'Route all new signups to this manager until full'}>
                        {String(preferredId) === String(m._id) ? '★ Default' : 'Set default'}
                      </button>
                    )}
                    {isSuper && <button onClick={() => setLimitsFor(m)} className="btn-ghost text-xs text-primary-400">Limits</button>}
                    <button onClick={() => setEditFor(m)} className="btn-ghost text-xs text-text-secondary">Edit</button>
                    <button onClick={() => setResetFor(m)} className="btn-ghost text-xs text-amber-400">Reset password</button>
                    <button onClick={() => deactivate(m)} className="btn-ghost text-xs text-rose-400">Deactivate</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createOpen && <CreateManagerModal isSuper={isSuper} admins={admins} onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); load(); }} />}
      {limitsFor && <LimitsModal userId={limitsFor._id} onClose={() => { setLimitsFor(null); load(); }} />}
      {resetFor && <ResetPasswordModal staff={resetFor} onClose={() => setResetFor(null)} onDone={load} />}
      {editFor && <EditStaffModal staff={editFor} onClose={() => setEditFor(null)} onSaved={load} />}
      {moveOpen && selectedManagers.length > 0 && (
        <MoveManagersModal
          managers={selectedManagers}
          admins={admins}
          onClose={() => setMoveOpen(false)}
          onSaved={() => { setMoveOpen(false); setSelected(new Set()); load(); }}
        />
      )}
    </div>
  );
}

// Transfer one or more managers (and every user under them) to a different
// admin. Backend: POST /hierarchy/transfer-manager (SuperAdmin only), called
// once per selected manager — validates the target admin's manager cap and
// re-parents the manager + all their users.
function MoveManagersModal({ managers, admins, onClose, onSaved }) {
  const [adminId, setAdminId] = useState('');
  const [busy, setBusy] = useState(false);
  const totalUsers = managers.reduce((s, m) => s + (m.userCount || 0), 0);
  // Target list = all admins (a manager already under the target is a safe no-op).
  const options = admins || [];

  const submit = async () => {
    if (!adminId) return toast.error('Pick the target admin');
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        managers.map((m) => api.post('/hierarchy/transfer-manager', { managerId: m._id, adminId }))
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (failed) toast.error(`Moved ${ok}/${results.length} manager(s). ${failed} failed (e.g. target admin at capacity).`);
      else toast.success(`Moved ${ok} manager${ok === 1 ? '' : 's'} (+ their users) to the selected admin`);
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Move {managers.length} manager{managers.length === 1 ? '' : 's'} to another admin</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <p className="text-text-secondary">
            Moving <span className="font-semibold text-text-primary">{managers.length}</span> manager{managers.length === 1 ? '' : 's'}
            {totalUsers > 0 && <> along with all <span className="font-semibold text-text-primary">{totalUsers}</span> of their user{totalUsers === 1 ? '' : 's'}</>} to the chosen admin.
          </p>
          <div className="max-h-28 overflow-y-auto rounded-lg border border-border-dark bg-bg-hover/40 p-2 text-xs text-text-secondary space-y-0.5">
            {managers.map((m) => (
              <div key={m._id} className="flex items-center justify-between gap-2">
                <span className="truncate">{[m.firstName, m.lastName].filter(Boolean).join(' ') || m.email}</span>
                <span className="font-mono text-text-muted shrink-0">{m.userCount || 0} user{(m.userCount || 0) === 1 ? '' : 's'}</span>
              </div>
            ))}
          </div>
          <label className="block">
            <div className="label mb-1">Target admin *</div>
            <select className="input" value={adminId} onChange={(e) => setAdminId(e.target.value)} autoFocus>
              <option value="">Select admin…</option>
              {options.map((a) => <option key={a._id} value={a._id}>{[a.firstName, a.lastName].filter(Boolean).join(' ') || a.email}</option>)}
            </select>
          </label>
          {options.length === 0 && <p className="text-[12px] text-warn">No admins available to move to.</p>}
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={busy || !adminId} className="btn-primary text-sm disabled:opacity-50">{busy ? 'Moving…' : `Move ${managers.length} manager${managers.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
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
