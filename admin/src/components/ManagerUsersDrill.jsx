import { useState } from 'react';
import { api, errorMessage } from '../services/api';

/**
 * Inline drill-down for an admin's subtree: renders the admin's managers, each
 * expandable to lazy-load & reveal its users (GET /hierarchy/users?managerId).
 * Used inside the Admins table's expanded row (and reusable elsewhere).
 *
 * Props: { managers: [{ id, name, userCount }] }
 */
export default function ManagerUsersDrill({ managers }) {
  const [openM, setOpenM] = useState({});
  const [usersByM, setUsersByM] = useState({}); // id -> { loading, items, total, error }

  const toggle = (m) => {
    const willOpen = !openM[m.id];
    setOpenM((s) => ({ ...s, [m.id]: willOpen }));
    if (willOpen && !usersByM[m.id]) {
      setUsersByM((s) => ({ ...s, [m.id]: { loading: true } }));
      api.get('/hierarchy/users', { params: { managerId: m.id, limit: 100 } })
        .then(({ data }) => setUsersByM((s) => ({ ...s, [m.id]: { loading: false, items: data.data.items || [], total: data.data.total || 0 } })))
        .catch((e) => setUsersByM((s) => ({ ...s, [m.id]: { loading: false, items: [], error: errorMessage(e) } })));
    }
  };

  if (!managers || managers.length === 0) {
    return <div className="pl-7 py-2 text-text-muted text-sm">No managers under this admin</div>;
  }

  return (
    <div className="py-1 space-y-0.5">
      {managers.map((m) => {
        const mOpen = !!openM[m.id];
        return (
          <div key={m.id}>
            <button onClick={() => toggle(m)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-bg-hover text-left transition-colors">
              <Chevron open={mOpen} />
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-500 shrink-0">Manager</span>
              <span className="font-semibold text-text-primary truncate">{m.name}</span>
              <span className="ml-auto text-[11px] text-text-muted shrink-0">{m.userCount} users</span>
            </button>
            {mOpen && (
              <div className="ml-[13px] border-l border-border-dark pl-3">
                <UserList entry={usersByM[m.id]} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Chevron({ open }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" className={`text-text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function UserList({ entry }) {
  if (!entry || entry.loading) return <div className="pl-7 py-1.5 text-text-muted text-sm">Loading users…</div>;
  if (entry.error) return <div className="pl-7 py-1.5 text-rose-400 text-sm">{entry.error}</div>;
  if (!entry.items.length) return <div className="pl-7 py-1.5 text-text-muted text-sm">No users under this manager</div>;
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
