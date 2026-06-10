import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useAuthStore } from '../store/auth';

/**
 * Access Control → Manager Permissions.
 *
 * Super Admin (and Admins, when delegation is enabled) toggle each manager's
 * module access in a single matrix. Backend enforces every change + audits it;
 * managers' sidebar/routes/APIs update on their next /auth/me (≤60s, no logout).
 */
export default function ManagerPermissions() {
  const { user } = useAuthStore();
  const isSuper = user?.role === 'SUPER_ADMIN';

  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState({}); // managerId → bool

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
  const withBusy = async (id, fn) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try { await fn(); } finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const toggle = (row, key) => {
    if (!editable) return;
    const next = !row.permissions[key];
    const prev = row.permissions;
    patchRow(row._id, { permissions: { ...prev, [key]: next } }); // optimistic
    withBusy(row._id, async () => {
      try { const { data } = await api.put(`/admin/manager-access/${row._id}`, { permissions: { [key]: next } }); patchRow(row._id, { permissions: data.data }); }
      catch (e) { patchRow(row._id, { permissions: prev }); toast.error(errorMessage(e)); }
    });
  };
  const setAll = (row, value) => {
    if (!editable) return;
    const patch = {}; perms.forEach((p) => { patch[p.key] = value; });
    const prev = row.permissions;
    patchRow(row._id, { permissions: { ...prev, ...patch } });
    withBusy(row._id, async () => {
      try { const { data } = await api.put(`/admin/manager-access/${row._id}`, { permissions: patch }); patchRow(row._id, { permissions: data.data }); toast.success(value ? 'All enabled' : 'All removed'); }
      catch (e) { patchRow(row._id, { permissions: prev }); toast.error(errorMessage(e)); }
    });
  };
  const toggleAccess = (row) => {
    if (!editable) return;
    const next = !row.accessEnabled;
    const prev = row.accessEnabled;
    patchRow(row._id, { accessEnabled: next });
    withBusy(row._id, async () => {
      try { await api.post(`/admin/manager-access/${row._id}/access`, { enabled: next }); toast.success(next ? 'Manager access enabled' : 'Manager access disabled'); }
      catch (e) { patchRow(row._id, { accessEnabled: prev }); toast.error(errorMessage(e)); }
    });
  };
  const toggleDelegation = async () => {
    const next = !meta.allowAdminManagePerms;
    try { await api.put('/admin/manager-access/settings', { enabled: next }); setMeta({ ...meta, allowAdminManagePerms: next }); toast.success(`Admin delegation ${next ? 'enabled' : 'disabled'}`); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-4 max-w-[1700px]">
      <PageHero
        eyebrow="Access Control"
        title="Manager Permissions"
        subtitle="Toggle each manager's module access. Disabled modules vanish from their sidebar, return 403 on direct URL, and their APIs are blocked. Changes apply without logout."
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

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
              <th className="text-left p-2.5 sticky left-0 bg-bg-card z-10">Manager</th>
              <th className="text-left p-2.5">Admin</th>
              <th className="text-center p-2.5">Access</th>
              <th className="text-center p-2.5">Bulk</th>
              {perms.map((p) => (
                <th key={p.key} className="p-2 text-center align-bottom">
                  <div className="whitespace-nowrap text-[9px] font-bold text-text-secondary">{p.label}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length && <tr><td colSpan={4 + perms.length} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && !rows.length && <tr><td colSpan={4 + perms.length} className="py-10 text-center text-text-muted">No managers found</td></tr>}
            {rows.map((row) => (
              <tr key={row._id} className={`border-b border-border-subtle hover:bg-bg-hover/30 ${busy[row._id] ? 'opacity-60' : ''} ${!row.accessEnabled ? 'opacity-50' : ''}`}>
                <td className="p-2.5 sticky left-0 bg-bg-card z-10">
                  <div className="font-semibold text-text-primary whitespace-nowrap">{row.name}</div>
                  <div className="text-[10px] text-text-muted font-mono">{row.email}</div>
                </td>
                <td className="p-2.5 text-xs text-text-secondary whitespace-nowrap">{row.adminName}</td>
                <td className="p-2.5 text-center">
                  <button onClick={() => toggleAccess(row)} disabled={!editable}
                    className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${row.accessEnabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-bear/20 text-bear'} ${editable ? 'hover:opacity-80' : 'cursor-not-allowed'}`}>
                    {row.accessEnabled ? 'ON' : 'OFF'}
                  </button>
                </td>
                <td className="p-2.5 text-center whitespace-nowrap">
                  <button onClick={() => setAll(row, true)} disabled={!editable} className="text-[10px] text-emerald-400 hover:underline disabled:opacity-40">All</button>
                  <span className="text-text-muted mx-1">/</span>
                  <button onClick={() => setAll(row, false)} disabled={!editable} className="text-[10px] text-bear hover:underline disabled:opacity-40">None</button>
                </td>
                {perms.map((p) => {
                  const on = !!row.permissions[p.key];
                  return (
                    <td key={p.key} className="p-1 text-center">
                      <button onClick={() => toggle(row, p.key)} disabled={!editable} title={`${p.label}: ${on ? 'ON' : 'OFF'}`}
                        className={`w-7 h-6 rounded text-xs font-bold transition-colors ${on ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bg-hover text-text-muted'} ${editable ? 'hover:ring-1 hover:ring-border-accent' : 'cursor-not-allowed'}`}>
                        {on ? '✓' : '·'}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-muted">
        Master <span className="font-semibold">Access</span> OFF disables the manager's login entirely. Every change is recorded in the Audit Log
        (changed-by, manager, permission, old → new value, IP, time).
      </p>
    </div>
  );
}
