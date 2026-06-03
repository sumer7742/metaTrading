import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Hierarchy Tree — SuperAdmin visualization of the full
 * SuperAdmin → Admin → Manager → Users structure (with per-node user
 * counts). Backend: GET /hierarchy/tree.
 */
export default function HierarchyTree() {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try { const { data } = await api.get('/hierarchy/tree'); setTree(data.data); }
      catch (e) { toast.error(errorMessage(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const totalAdmins = tree?.admins?.length || 0;
  const totalManagers = (tree?.admins || []).reduce((n, a) => n + (a.managers?.length || 0), 0);

  return (
    <div className="space-y-5 max-w-[1100px]">
      <PageHero eyebrow="Hierarchy" title="Hierarchy Tree"
        subtitle={tree ? `${totalAdmins} admins · ${totalManagers} managers · ${tree.unassignedUsers} unassigned users` : 'Org structure overview'} />

      <div className="card p-5">
        {loading ? <div className="text-text-muted">Loading…</div> : !tree ? <div className="text-text-muted">No data</div> : (
          <div className="space-y-2 font-mono text-sm">
            <Node label="SuperAdmin" tone="primary" badge={`${tree.unassignedUsers} unassigned`} depth={0} />
            {tree.admins.map((a) => (
              <div key={a.id}>
                <Node label={a.name} role="ADMIN" badge={`${a.userCount} users`} depth={1} />
                {(a.managers || []).map((m) => (
                  <Node key={m.id} label={m.name} role="MANAGER" badge={`${m.userCount} users`} depth={2} />
                ))}
                {(a.managers || []).length === 0 && <Node label="(no managers)" muted depth={2} />}
              </div>
            ))}
            {tree.admins.length === 0 && <Node label="(no admins yet)" muted depth={1} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Node({ label, role, badge, tone, muted, depth = 0 }) {
  const roleChip = role === 'ADMIN' ? 'bg-info/15 text-info' : role === 'MANAGER' ? 'bg-primary-500/15 text-primary-500' : '';
  return (
    <div className="flex items-center gap-2" style={{ paddingLeft: `${depth * 24}px` }}>
      {depth > 0 && <span className="text-text-muted">{'└─'}</span>}
      <span className={`px-2 py-1 rounded-md border border-border-dark ${tone === 'primary' ? 'bg-primary-500/10 text-primary-500 font-bold' : muted ? 'text-text-muted' : 'bg-bg-panel text-text-primary'}`}>{label}</span>
      {role && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${roleChip}`}>{role}</span>}
      {badge && <span className="text-[11px] text-text-muted">{badge}</span>}
    </div>
  );
}
