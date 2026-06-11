import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useAuthStore } from '../store/auth';

/**
 * Access Control → Manager Permissions (card layout, same style as Admin
 * Access). Super Admin (and Admins when delegation is ON) toggle each
 * manager's module access + master login switch. Backend enforces + audits;
 * managers' sidebar/routes/APIs update on their next /auth/me (no logout).
 */
export default function ManagerPermissions() {
  const { user } = useAuthStore();
  const isSuper = user?.role === 'SUPER_ADMIN';

  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null); // `${id}:${key}`

  const load = async () => {
    setLoading(true);
    try {
      const [m, mx] = await Promise.all([
        api.get('/admin/manager-access/meta'),
        api.get('/admin/manager-access'),
      ]);
      setMeta(m.data.data);
      setRows(mx.data.data || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const perms = meta?.permissions || [];
  const editable = isSuper || (meta?.allowAdminManagePerms && user?.role === 'ADMIN');
  const patchRow = (id, fields) => setRows((rs) => rs.map((r) => (r._id === id ? { ...r, ...fields } : r)));

  const toggle = async (row, key, next) => {
    if (!editable) return;
    setSavingKey(`${row._id}:${key}`);
    try { const { data } = await api.put(`/admin/manager-access/${row._id}`, { permissions: { [key]: next } }); patchRow(row._id, { permissions: data.data }); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSavingKey(null); }
  };
  const setAll = async (row, value) => {
    if (!editable) return;
    setSavingKey(`${row._id}:ALL`);
    try {
      const patch = {}; perms.forEach((p) => { patch[p.key] = value; });
      const { data } = await api.put(`/admin/manager-access/${row._id}`, { permissions: patch });
      patchRow(row._id, { permissions: data.data }); toast.success(value ? 'All modules granted' : 'All modules revoked');
    } catch (e) { toast.error(errorMessage(e)); } finally { setSavingKey(null); }
  };
  const toggleAccess = async (row) => {
    if (!editable) return;
    const next = !row.accessEnabled;
    setSavingKey(`${row._id}:ACCESS`);
    try { await api.post(`/admin/manager-access/${row._id}/access`, { enabled: next }); patchRow(row._id, { accessEnabled: next }); toast.success(next ? 'Login enabled' : 'Login disabled'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSavingKey(null); }
  };
  const toggleDelegation = async () => {
    const next = !meta.allowAdminManagePerms;
    try { await api.put('/admin/manager-access/settings', { enabled: next }); setMeta({ ...meta, allowAdminManagePerms: next }); toast.success(`Admin delegation ${next ? 'enabled' : 'disabled'}`); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-4 max-w-[1500px]">
      <PageHero
        eyebrow="Access Control"
        title="Manager Permissions"
        subtitle="Grant or revoke each manager's module access + master login. Disabled modules vanish from their sidebar, 403 on direct API, applied without logout."
        actions={isSuper && meta && (
          <button onClick={toggleDelegation}
            className={`text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${meta.allowAdminManagePerms ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400' : 'border-border-dark text-text-secondary hover:text-white'}`}
            title="When ON, Admins can manage permissions of managers under them">
            Admin delegation: {meta.allowAdminManagePerms ? 'ON' : 'OFF'}
          </button>
        )}
      />

      {!editable && meta && (
        <div className="card p-3 text-xs text-warn border border-warn/30">
          Read-only — only the Super Admin can change manager permissions (delegation is OFF).
        </div>
      )}

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-xl bg-bg-hover animate-pulse" />)}</div>
      ) : !rows.length ? (
        <div className="card p-8 text-center text-text-muted text-sm">No managers found.</div>
      ) : (
        rows.map((row) => {
          const busy = savingKey && savingKey.startsWith(`${row._id}:`);
          return (
            <div key={row._id} className={`card p-4 ${row.accessEnabled ? '' : 'opacity-70'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <div className="text-sm font-bold text-white">{row.name} <span className="text-text-muted font-normal">· {row.email}</span></div>
                  <div className="text-[11px] text-text-muted">
                    Admin: {row.adminName} · {perms.filter((p) => row.permissions[p.key]).length}/{perms.length} modules
                    {!row.accessEnabled && <span className="text-rose-400 ml-2">· login disabled</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => toggleAccess(row)} disabled={!editable || busy}
                    className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg border ${row.accessEnabled ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400' : 'border-rose-500/40 bg-rose-500/15 text-rose-400'} disabled:opacity-50`}>
                    Login: {row.accessEnabled ? 'ON' : 'OFF'}
                  </button>
                  <button onClick={() => setAll(row, true)} disabled={!editable || busy} className="btn-ghost text-xs">Grant all</button>
                  <button onClick={() => setAll(row, false)} disabled={!editable || busy} className="btn-ghost text-xs text-rose-400">Revoke all</button>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                {perms.map((p) => {
                  const on = !!row.permissions[p.key];
                  const cellBusy = savingKey === `${row._id}:${p.key}` || savingKey === `${row._id}:ALL`;
                  return (
                    <button key={p.key} type="button" disabled={!editable || cellBusy} onClick={() => toggle(row, p.key, !on)}
                      className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg border text-xs transition-colors ${
                        on ? 'border-emerald-500/40 bg-emerald-500/10 text-white' : 'border-border-dark bg-bg-dark text-text-muted'} ${(!editable || cellBusy) ? 'opacity-60' : 'hover:border-primary-500'}`}>
                      <span className="truncate">{p.label}</span>
                      <span className={`shrink-0 w-8 h-4 rounded-full relative transition-colors ${on ? 'bg-emerald-500' : 'bg-bg-hover'}`}>
                        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${on ? 'left-4' : 'left-0.5'}`} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
      <p className="text-[11px] text-text-muted">
        <span className="font-semibold">Login</span> OFF disables the manager's sign-in entirely. Every change is recorded in the Audit Log
        (changed-by, manager, permission, old → new, IP, time).
      </p>
    </div>
  );
}
