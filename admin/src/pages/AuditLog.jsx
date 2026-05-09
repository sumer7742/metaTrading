import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { fmtDate } from '../utils/format';

export default function AuditLog() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    (async () => {
      const { data } = await api.get('/admin/audit-log', { params: { limit: 200 } });
      setItems(data.data);
    })();
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">Audit Log</h1>
      <p className="text-sm text-gray-400">Last 200 admin actions (immutable, append-only).</p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
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
                <td className="p-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(l.createdAt)}</td>
                <td className="p-3 text-xs font-mono">{l.actorId.toString().slice(-6)}</td>
                <td className="p-3 text-xs text-primary-500">{l.actorRole}</td>
                <td className="p-3 text-xs font-medium">{l.action}</td>
                <td className="p-3 text-xs text-gray-400">{l.targetType}: {l.targetId?.toString().slice(-8) || '-'}</td>
                <td className="p-3 text-xs text-gray-500 max-w-xs truncate">
                  {l.metadata ? JSON.stringify(l.metadata) : '-'}
                </td>
                <td className="p-3 text-xs text-gray-500">{l.ip || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="text-center text-gray-500 py-6 text-sm">No audit entries yet</div>}
      </div>
    </div>
  );
}
