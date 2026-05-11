import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

export default function AuditLog() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    (async () => {
      const { data } = await api.get('/admin/audit-log', { params: { limit: 200 } });
      setItems(data.data);
    })();
  }, []);

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Insights"
        title="Audit Log"
        subtitle="Immutable, append-only record of every admin action — last 200 events shown."
      />
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold bg-bg-panel">
            <tr>
              <th className="text-left p-3">Timestamp</th>
              <th className="text-left p-3">Actor</th>
              <th className="text-left p-3">Role</th>
              <th className="text-left p-3">Action</th>
              <th className="text-left p-3">Target</th>
              <th className="text-left p-3">Metadata</th>
              <th className="text-left p-3">IP</th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={l._id} className="table-row">
                <td className="p-3 text-xs text-text-secondary whitespace-nowrap font-mono">{fmtDate(l.createdAt)}</td>
                <td className="p-3 text-xs font-mono text-text-primary">{l.actorId.toString().slice(-6)}</td>
                <td className="p-3 text-xs"><span className="chip-primary">{l.actorRole}</span></td>
                <td className="p-3 text-xs font-medium text-text-primary">{l.action}</td>
                <td className="p-3 text-xs text-text-secondary font-mono">
                  {l.targetType}: {l.targetId?.toString().slice(-8) || '-'}
                </td>
                <td className="p-3 text-[10px] text-text-muted max-w-xs truncate font-mono">
                  {l.metadata ? JSON.stringify(l.metadata) : '-'}
                </td>
                <td className="p-3 text-xs text-text-muted font-mono">{l.ip || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <div className="text-center text-text-secondary py-10 text-sm">
            <div className="text-text-muted">No audit entries yet</div>
            <div className="text-xs text-text-muted mt-1">Admin actions are logged here as they happen.</div>
          </div>
        )}
      </div>
    </div>
  );
}
