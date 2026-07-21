import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Hierarchy Tree — interactive SuperAdmin drill-down of the
 * SuperAdmin → Admin → Manager → Users structure.
 *   - Click an admin  → reveal its managers (from the tree payload).
 *   - Click a manager → lazy-load & reveal its users (GET /hierarchy/users?managerId).
 *   - Each admin also exposes any users NOT yet under a manager, so the
 *     per-admin user count always reconciles with what you can drill into.
 * Backend: GET /hierarchy/tree + GET /hierarchy/users.
 */
export default function HierarchyTree() {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openA, setOpenA] = useState({});        // adminId  -> expanded?
  const [openM, setOpenM] = useState({});        // managerId -> expanded?
  const [openDirect, setOpenDirect] = useState({}); // adminId -> "no-manager users" expanded?
  const [usersCache, setUsersCache] = useState({}); // key -> { loading, items, total, error }

  useEffect(() => {
    (async () => {
      try { const { data } = await api.get('/hierarchy/tree'); setTree(data.data); }
      catch (e) { toast.error(errorMessage(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  // Lazy-load a user list once per key (manager or admin-direct); cached after.
  const fetchUsers = async (key, params) => {
    setUsersCache((prev) => {
      if (prev[key]) return prev; // already loading/loaded
      return { ...prev, [key]: { loading: true } };
    });
    try {
      const { data } = await api.get('/hierarchy/users', { params: { ...params, limit: 100 } });
      setUsersCache((s) => ({ ...s, [key]: { loading: false, items: data.data.items || [], total: data.data.total || 0 } }));
    } catch (e) {
      setUsersCache((s) => ({ ...s, [key]: { loading: false, items: [], error: errorMessage(e) } }));
    }
  };

  const toggleAdmin = (id) => setOpenA((s) => ({ ...s, [id]: !s[id] }));
  const toggleManager = (m) => {
    const willOpen = !openM[m.id];
    setOpenM((s) => ({ ...s, [m.id]: willOpen }));
    if (willOpen && !usersCache[`mgr:${m.id}`]) fetchUsers(`mgr:${m.id}`, { managerId: m.id });
  };
  const toggleDirect = (a) => {
    const willOpen = !openDirect[a.id];
    setOpenDirect((s) => ({ ...s, [a.id]: willOpen }));
    if (willOpen && !usersCache[`adm:${a.id}`]) fetchUsers(`adm:${a.id}`, { adminId: a.id, managerStatus: 'unassigned' });
  };

  const totalAdmins = tree?.admins?.length || 0;
  const totalManagers = (tree?.admins || []).reduce((n, a) => n + (a.managers?.length || 0), 0);

  return (
    <div className="space-y-5 max-w-[1000px]">
      <PageHero eyebrow="Hierarchy" title="Hierarchy Tree"
        subtitle={tree ? `${totalAdmins} admins · ${totalManagers} managers · ${tree.unassignedUsers} unassigned users` : 'Org structure overview'} />

      <div className="card p-4 sm:p-5">
        {loading ? (
          <div className="text-text-muted py-10 text-center">Loading…</div>
        ) : !tree ? (
          <div className="text-text-muted py-10 text-center">No data</div>
        ) : (
          <div className="space-y-1">
            {/* ── Root ─────────────────────────────────────────────── */}
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="w-6 h-6 rounded-md bg-primary-500/15 text-primary-500 grid place-items-center text-xs font-black">S</span>
              <span className="font-bold text-text-primary">SuperAdmin</span>
              <span className="text-[11px] text-text-muted">· {tree.unassignedUsers} unassigned users</span>
            </div>

            {tree.admins.length === 0 && <div className="pl-9 py-2 text-text-muted text-sm">No admins yet</div>}

            {/* ── Admins ───────────────────────────────────────────── */}
            {tree.admins.map((a) => {
              const aOpen = !!openA[a.id];
              const mgrUsers = (a.managers || []).reduce((n, m) => n + (m.userCount || 0), 0);
              const directCount = Math.max(0, (a.userCount || 0) - mgrUsers);
              const dOpen = !!openDirect[a.id];
              const dKey = `adm:${a.id}`;
              return (
                <div key={a.id} className="pl-2">
                  <Row onClick={() => toggleAdmin(a.id)} open={aOpen} hasChildren>
                    <Chip tone="admin">Admin</Chip>
                    <span className="font-semibold text-text-primary truncate">{a.name}</span>
                    <span className="ml-auto flex items-center gap-3 text-[11px] text-text-muted shrink-0">
                      <span>{(a.managers || []).length} managers</span>
                      <span>{a.userCount} users</span>
                    </span>
                  </Row>

                  {aOpen && (
                    <div className="ml-[13px] border-l border-border-dark pl-3 py-0.5 space-y-0.5">
                      {(a.managers || []).length === 0 && directCount === 0 && (
                        <div className="pl-7 py-1.5 text-text-muted text-sm">No managers or users under this admin</div>
                      )}

                      {/* Managers → users */}
                      {(a.managers || []).map((m) => {
                        const mOpen = !!openM[m.id];
                        const mKey = `mgr:${m.id}`;
                        return (
                          <div key={m.id}>
                            <Row onClick={() => toggleManager(m)} open={mOpen} hasChildren>
                              <Chip tone="manager">Manager</Chip>
                              <span className="font-semibold text-text-primary truncate">{m.name}</span>
                              <span className="ml-auto text-[11px] text-text-muted shrink-0">{m.userCount} users</span>
                            </Row>
                            {mOpen && (
                              <div className="ml-[13px] border-l border-border-dark pl-3">
                                <UserList entry={usersCache[mKey]} empty="No users under this manager" />
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Admin's users not yet under a manager */}
                      {directCount > 0 && (
                        <div>
                          <Row onClick={() => toggleDirect(a)} open={dOpen} hasChildren>
                            <Chip tone="muted">No manager</Chip>
                            <span className="text-text-secondary truncate">Users not assigned to a manager</span>
                            <span className="ml-auto text-[11px] text-text-muted shrink-0">{directCount} users</span>
                          </Row>
                          {dOpen && (
                            <div className="ml-[13px] border-l border-border-dark pl-3">
                              <UserList entry={usersCache[dKey]} empty="No unassigned users" />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* A clickable tree row with a rotating chevron. */
function Row({ children, onClick, open, hasChildren }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-bg-hover text-left transition-colors">
      <span className={`text-text-muted shrink-0 ${hasChildren ? '' : 'opacity-0'}`}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-90' : ''}`}>
          <path d="M9 18l6-6-6-6" />
        </svg>
      </span>
      {children}
    </button>
  );
}

function Chip({ tone, children }) {
  const cls = tone === 'admin' ? 'bg-info/15 text-info'
    : tone === 'manager' ? 'bg-primary-500/15 text-primary-500'
    : 'bg-bg-hover text-text-muted';
  return <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${cls}`}>{children}</span>;
}

/* Renders a lazy-loaded user list entry ({loading,items,total,error}). */
function UserList({ entry, empty }) {
  if (!entry || entry.loading) return <div className="pl-7 py-1.5 text-text-muted text-sm">Loading users…</div>;
  if (entry.error) return <div className="pl-7 py-1.5 text-rose-400 text-sm">{entry.error}</div>;
  if (!entry.items.length) return <div className="pl-7 py-1.5 text-text-muted text-sm">{empty}</div>;
  return (
    <div className="py-0.5">
      {entry.items.map((u) => (
        <div key={u._id} className="flex items-center gap-2 px-2 py-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted/50 ml-1 shrink-0" />
          <span className="text-sm text-text-primary truncate">{[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}</span>
          <span className="text-[12px] text-text-muted truncate">{u.email}</span>
          <KycBadge status={u.kycStatus} />
        </div>
      ))}
      {entry.total > entry.items.length && (
        <div className="pl-3 py-1 text-[11px] text-text-muted">+{entry.total - entry.items.length} more…</div>
      )}
    </div>
  );
}

function KycBadge({ status }) {
  if (!status) return null;
  const cls = status === 'APPROVED' ? 'bg-emerald-500/15 text-emerald-500'
    : status === 'PENDING' ? 'bg-amber-500/15 text-amber-500'
    : 'bg-bg-hover text-text-muted';
  const label = status === 'APPROVED' ? 'Verified' : status === 'PENDING' ? 'Pending KYC' : status;
  return <span className={`ml-auto text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${cls}`}>{label}</span>;
}
