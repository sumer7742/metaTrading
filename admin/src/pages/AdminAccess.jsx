import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Admin Access Control — Super Admin decides each admin's module access.
 * Admins have no fixed access; toggle modules per admin. Backend enforces
 * (an admin hitting a disabled module's API gets 403).
 */
export default function AdminAccess() {
  const [perms, setPerms] = useState([]);     // catalog [{key,label,route}]
  const [admins, setAdmins] = useState([]);   // [{_id,name,email,permissions}]
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null); // `${adminId}:${key}`

  const load = async () => {
    setLoading(true);
    try {
      const [m, mx] = await Promise.all([
        api.get('/admin/admin-access/meta'),
        api.get('/admin/admin-access'),
      ]);
      setPerms(m.data.data.permissions || []);
      setAdmins(mx.data.data || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (admin, key, next) => {
    setSavingKey(`${admin._id}:${key}`);
    try {
      const { data } = await api.put(`/admin/admin-access/${admin._id}`, { permissions: { [key]: next } });
      setAdmins((prev) => prev.map((a) => a._id === admin._id ? { ...a, permissions: data.data.permissions } : a));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSavingKey(null); }
  };
  const setAll = async (admin, value) => {
    setSavingKey(`${admin._id}:ALL`);
    try {
      const patch = {}; perms.forEach((p) => { patch[p.key] = value; });
      const { data } = await api.put(`/admin/admin-access/${admin._id}`, { permissions: patch });
      setAdmins((prev) => prev.map((a) => a._id === admin._id ? { ...a, permissions: data.data.permissions } : a));
      toast.success(value ? 'All modules granted' : 'All modules revoked');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSavingKey(null); }
  };

  return (
    <div className="space-y-4 max-w-[1500px]">
      <PageHero
        eyebrow="Access Control · Super Admin"
        title="Admin Access Control"
        subtitle="Admins have no fixed access. Grant or revoke each module per admin — changes apply on their next login / refresh and are enforced on the backend."
      />

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-xl bg-bg-hover animate-pulse" />)}</div>
      ) : !admins.length ? (
        <div className="card p-8 text-center text-text-muted text-sm">No admins found. Create admins under Hierarchy → Admins.</div>
      ) : (
        admins.map((admin) => (
          <div key={admin._id} className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <div className="text-sm font-bold text-white">{admin.name} <span className="text-text-muted font-normal">· {admin.email}</span></div>
                <div className="text-[11px] text-text-muted">
                  {perms.filter((p) => admin.permissions[p.key]).length}/{perms.length} modules granted
                  {admin.isActive === false && <span className="text-rose-400 ml-2">· account blocked</span>}
                </div>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => setAll(admin, true)} disabled={savingKey === `${admin._id}:ALL`} className="btn-ghost text-xs">Grant all</button>
                <button onClick={() => setAll(admin, false)} disabled={savingKey === `${admin._id}:ALL`} className="btn-ghost text-xs text-rose-400">Revoke all</button>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
              {perms.map((p) => {
                const on = admin.permissions[p.key] !== false;
                const busy = savingKey === `${admin._id}:${p.key}` || savingKey === `${admin._id}:ALL`;
                return (
                  <button key={p.key} type="button" disabled={busy} onClick={() => toggle(admin, p.key, !on)}
                    className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                      on ? 'border-emerald-500/40 bg-emerald-500/10 text-white' : 'border-border-dark bg-bg-dark text-text-muted'} ${busy ? 'opacity-50' : 'hover:border-primary-500'}`}>
                    <span className="truncate">{p.label}</span>
                    <span className={`shrink-0 w-8 h-4 rounded-full relative transition-colors ${on ? 'bg-emerald-500' : 'bg-bg-hover'}`}>
                      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? 'left-4' : 'left-0.5'}`} />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
