import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';
import { fmtDate } from '../utils/format';

/**
 * My Users — a manager's scoped dashboard: their assigned users + workload
 * summary (basic analytics). Read-only support view; assignment changes are
 * driven from the Assignments page by admins/superadmins.
 * Backend: GET /hierarchy/users (scoped to caller) + GET /hierarchy/workload.
 */
export default function ManagerDashboard() {
  const { user } = useAuthStore();
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [u, w] = await Promise.all([
        api.get('/hierarchy/users', { params: { search, limit: 100 } }),
        api.get('/hierarchy/workload'),
      ]);
      setUsers(u.data.data.items || []);
      // Manager sees their own row; admin/super may see several — sum them.
      const mine = (w.data.data.managers || []);
      const own = mine.find((m) => String(m.id) === String(user?._id || user?.id));
      setStats(own || mine.reduce((acc, m) => ({
        totalUsers: acc.totalUsers + m.totalUsers, activeUsers: acc.activeUsers + m.activeUsers,
        verifiedUsers: acc.verifiedUsers + m.verifiedUsers, pendingKycUsers: acc.pendingKycUsers + m.pendingKycUsers,
        userCapacity: 100,
      }), { totalUsers: 0, activeUsers: 0, verifiedUsers: 0, pendingKycUsers: 0, userCapacity: 100 }));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const tiles = useMemo(() => ([
    { label: 'Total users', value: stats?.totalUsers ?? 0 },
    { label: 'Active', value: stats?.activeUsers ?? 0, tone: 'text-bull' },
    { label: 'Verified', value: stats?.verifiedUsers ?? 0, tone: 'text-bull' },
    { label: 'Pending KYC', value: stats?.pendingKycUsers ?? 0, tone: 'text-warn' },
  ]), [stats]);

  return (
    <div className="space-y-5 max-w-[1400px]">
      <PageHero eyebrow="Hierarchy" title="My Users"
        subtitle={`Your assigned users${stats ? ` · ${stats.totalUsers} / ${stats.userCapacity || 100}` : ''}. Support + KYC view.`} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div key={t.label} className="card p-4">
            <div className="label">{t.label}</div>
            <div className={`mt-1 text-2xl font-extrabold tabular-nums ${t.tone || 'text-text-primary'}`}>{t.value}</div>
          </div>
        ))}
      </div>

      <div className="card p-3 flex items-center gap-3">
        <input className="input flex-1" placeholder="Search your users…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button onClick={load} className="btn-primary text-xs">Search</button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle bg-bg-hover/40">
              <th className="text-left py-2.5 px-3">User</th>
              <th className="text-left py-2.5 px-3">Email</th>
              <th className="text-center py-2.5 px-3">KYC</th>
              <th className="text-center py-2.5 px-3">Status</th>
              <th className="text-left py-2.5 px-3">Joined</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && users.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-text-muted">No users assigned to you yet</td></tr>}
            {users.map((u) => (
              <tr key={u._id} className="table-row">
                <td className="py-2 px-3 text-text-primary">{[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}</td>
                <td className="py-2 px-3 text-text-secondary">{u.email}</td>
                <td className="py-2 px-3 text-center">
                  <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${u.kycStatus === 'APPROVED' ? 'bg-emerald-500/15 text-emerald-500' : u.kycStatus === 'PENDING' ? 'bg-amber-500/15 text-amber-500' : 'bg-bg-hover text-text-muted'}`}>{u.kycStatus || '—'}</span>
                </td>
                <td className="py-2 px-3 text-center">
                  <span className={`text-[10px] font-bold uppercase ${u.isActive !== false ? 'text-bull' : 'text-bear'}`}>{u.isActive !== false ? 'Active' : 'Inactive'}</span>
                </td>
                <td className="py-2 px-3 text-text-secondary">{fmtDate(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
