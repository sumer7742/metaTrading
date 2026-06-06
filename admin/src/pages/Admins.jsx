import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import LimitsModal from '../components/LimitsModal';
import { useAuthStore } from '../store/auth';
import { ROLES } from '../config/roles';

/**
 * Admins — SuperAdmin-only management of the platform admins. The max-admins
 * cap is configurable by the Super Admin (setting hierarchy.maxAdmins).
 * Backend: GET/POST/DELETE /hierarchy/admins + GET/PUT /hierarchy/admins/cap.
 */
export default function Admins() {
  const { user } = useAuthStore();
  const isSuper = user?.role === ROLES.SUPER_ADMIN;

  const [admins, setAdmins] = useState([]);
  const [workload, setWorkload] = useState({ admins: [] });
  const [maxAdmins, setMaxAdmins] = useState(4);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [limitsFor, setLimitsFor] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [a, w, cap] = await Promise.all([
        api.get('/hierarchy/admins', { params: { limit: 100 } }),
        api.get('/hierarchy/workload'),
        api.get('/hierarchy/admins/cap').catch(() => null),
      ]);
      setAdmins(a.data.data.items || []);
      setWorkload(w.data.data || { admins: [] });
      if (cap?.data?.data?.maxAdmins) setMaxAdmins(Number(cap.data.data.maxAdmins));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const editCap = async () => {
    const v = window.prompt(`Set the maximum number of platform admins (current: ${maxAdmins}).\nEnter a whole number between 1 and 100:`, String(maxAdmins));
    if (v == null) return;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100) { toast.error('Enter a whole number between 1 and 100'); return; }
    if (n < admins.length) { toast.error(`There are already ${admins.length} admins — set a limit ≥ ${admins.length}.`); return; }
    try {
      const { data } = await api.put('/hierarchy/admins/cap', { maxAdmins: n });
      setMaxAdmins(Number(data.data.maxAdmins));
      toast.success(`Admin limit updated to ${data.data.maxAdmins}`);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const wlById = useMemo(() => new Map((workload.admins || []).map((x) => [String(x.id), x])), [workload]);

  const deactivate = async (a) => {
    const strategy = window.prompt(
      `Deactivate ${a.email}. Choose strategy:\n` +
      `  toSuperPool  — detach managers + users to the SuperAdmin pool\n` +
      `  reassignManagers:<adminId>  — move team to another admin\n`,
      'toSuperPool'
    );
    if (!strategy) return;
    try {
      await api.delete(`/hierarchy/admins/${a._id}`, { params: { strategy } });
      toast.success('Admin deactivated');
      load();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-5 max-w-[1400px]">
      <PageHero
        eyebrow="Hierarchy"
        title="Admins"
        subtitle={`${admins.length} / ${maxAdmins} admins · create and manage top-level admins. Each admin runs their own managers + users.`}
        actions={
          <div className="flex items-center gap-2">
            {isSuper && (
              <button onClick={editCap} className="btn-ghost text-sm" title="Change the maximum number of admins">
                ⚙ Edit limit
              </button>
            )}
            <button onClick={() => setCreateOpen(true)} disabled={admins.length >= maxAdmins}
              className="btn-primary text-sm disabled:opacity-50" title={admins.length >= maxAdmins ? `Max ${maxAdmins} admins reached` : ''}>
              + Create Admin
            </button>
          </div>
        }
      />

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
              <th className="text-left py-2.5 px-3">Admin</th>
              <th className="text-left py-2.5 px-3">Email</th>
              <th className="text-center py-2.5 px-3">Managers</th>
              <th className="text-center py-2.5 px-3">Users</th>
              <th className="text-center py-2.5 px-3">Verified</th>
              <th className="text-center py-2.5 px-3">Pending KYC</th>
              <th className="text-center py-2.5 px-3">Status</th>
              <th className="text-right py-2.5 px-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && admins.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && admins.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-text-muted">No admins yet</td></tr>}
            {admins.map((a) => {
              const wl = wlById.get(String(a._id)) || {};
              const cap = wl.userCapacity || 500;
              return (
                <tr key={a._id} className="table-row">
                  <td className="py-2 px-3 text-text-primary font-semibold">{[a.firstName, a.lastName].filter(Boolean).join(' ') || '—'}</td>
                  <td className="py-2 px-3 text-text-secondary">{a.email}</td>
                  <td className="py-2 px-3 text-center font-mono">{wl.managerCount || 0} / {a.hierarchyLimits?.maxManagers ?? 10}</td>
                  <td className="py-2 px-3 text-center font-mono">{wl.totalUsers || 0} / {a.hierarchyLimits?.maxUsers ?? cap}</td>
                  <td className="py-2 px-3 text-center font-mono text-bull">{wl.verifiedUsers || 0}</td>
                  <td className="py-2 px-3 text-center font-mono text-warn">{wl.pendingKycUsers || 0}</td>
                  <td className="py-2 px-3 text-center">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${a.isActive !== false ? 'bg-emerald-500/15 text-emerald-500' : 'bg-rose-500/15 text-rose-500'}`}>
                      {a.isActive !== false ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right space-x-1">
                    <button onClick={() => setLimitsFor(a)} className="btn-ghost text-xs text-primary-400">Limits</button>
                    <button onClick={() => deactivate(a)} className="btn-ghost text-xs text-rose-400">Deactivate</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createOpen && <CreateAdminModal onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); load(); }} />}
      {limitsFor && <LimitsModal userId={limitsFor._id} onClose={() => { setLimitsFor(null); load(); }} />}
    </div>
  );
}

function CreateAdminModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.email) return toast.error('Email required');
    setBusy(true);
    try {
      const { data } = await api.post('/hierarchy/admins', form);
      const pw = data.data.generatedPassword;
      toast.success(pw ? `Admin created · temp password: ${pw}` : 'Admin created', { duration: pw ? 9000 : 3000 });
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Create Admin</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <label className="block"><div className="label mb-1">Email *</div><input className="input" value={form.email} onChange={set('email')} placeholder="admin@company.com" autoFocus /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><div className="label mb-1">First name</div><input className="input" value={form.firstName} onChange={set('firstName')} /></label>
            <label className="block"><div className="label mb-1">Last name</div><input className="input" value={form.lastName} onChange={set('lastName')} /></label>
          </div>
          <label className="block"><div className="label mb-1">Password (optional)</div><input className="input" value={form.password} onChange={set('password')} placeholder="Auto-generated if blank" /></label>
          <p className="text-[11px] text-text-muted">Existing user with this email is promoted to Admin; otherwise a new admin account is created.</p>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary text-sm disabled:opacity-50">{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}
