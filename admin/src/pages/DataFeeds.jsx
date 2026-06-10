import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import { useConfirm } from '../components/ConfirmProvider';

export default function DataFeeds() {
  const confirm = useConfirm();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const r = await api.get('/admin/data-feeds');
      setStatus(r.data.data);
    } catch (e) { /* ignore */ }
    finally { setLoading(false); }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const forceSwitch = async (provider) => {
    if (!(await confirm(`Force switch to ${provider}?`))) return;
    try {
      await api.post('/admin/data-feeds/force-switch', { provider });
      toast.success(`Switched to ${provider}`);
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  if (loading) return <div className="text-gray-400 p-4">Loading…</div>;
  if (!status) return <div className="text-bear p-4">Could not load feed status</div>;

  const statusClass = (s) => ({
    HEALTHY: 'bg-green-900/30 text-green-400',
    DEGRADED: 'bg-yellow-900/30 text-yellow-400',
    DOWN: 'bg-red-900/30 text-red-400',
    INIT: 'bg-gray-700 text-gray-400',
  })[s] || 'bg-gray-700 text-gray-400';

  return (
    <div className="space-y-6 max-w-[1200px]">
      <PageHero
        eyebrow="Infra"
        title="Data Feed Status"
        subtitle="Real-time price provider monitoring with automatic failover. Switch providers, force reconnect, view per-symbol coverage."
      />

      {/* Current active provider */}
      <div className="card p-5">
        <div className="text-xs uppercase text-gray-500 mb-1">Currently Active</div>
        <div className="text-2xl font-bold text-white">
          {status.activeProvider || <span className="text-bear">None - Emergency Mode</span>}
        </div>
        {!status.activeProvider && (
          <div className="text-sm text-bear mt-2">
            ⚠️ No healthy provider. Check provider configs and restart server.
          </div>
        )}
      </div>

      {/* Provider list */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border-dark">
          <h3 className="text-white font-semibold">Providers (priority order)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-500 bg-bg-dark">
                <th className="text-left py-2 px-4">Priority</th>
                <th className="text-left py-2 px-4">Provider</th>
                <th className="text-left py-2 px-4">Status</th>
                <th className="text-left py-2 px-4">Last Tick</th>
                <th className="text-left py-2 px-4">Errors</th>
                <th className="text-right py-2 px-4">Action</th>
              </tr>
            </thead>
            <tbody>
              {status.providers.map((p) => (
                <tr key={p.name} className="table-row">
                  <td className="py-2 px-4 text-gray-400">#{p.priority}</td>
                  <td className="py-2 px-4 text-white font-medium">
                    {p.name}
                    {status.activeProvider === p.name && (
                      <span className="ml-2 text-xs bg-teal-accent text-bg-dark px-2 py-0.5 rounded">ACTIVE</span>
                    )}
                  </td>
                  <td className="py-2 px-4">
                    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusClass(p.status)}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="py-2 px-4 text-gray-400">{p.lastTickAge || '—'}</td>
                  <td className="py-2 px-4 text-gray-400">{p.consecutiveErrors}</td>
                  <td className="py-2 px-4 text-right">
                    {p.status === 'HEALTHY' && status.activeProvider !== p.name && (
                      <button onClick={() => forceSwitch(p.name)} className="btn-secondary text-xs">
                        Force Switch
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent events */}
      <div className="card p-5">
        <h3 className="text-white font-semibold mb-3">Recent Events</h3>
        {status.recentEvents.length === 0 ? (
          <div className="text-gray-500 text-sm">No events yet</div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {status.recentEvents.map((e, i) => (
              <div key={i} className="text-xs p-2 rounded bg-bg-dark border border-border-dark">
                <span className="text-gray-500 font-mono">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-gray-300 ml-3">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card p-4 bg-blue-900/20 border-blue-700/30 text-sm">
        <p className="text-blue-300">
          ℹ️ Failover is automatic. Health checks run every 30s. If primary provider goes down or
          stops sending ticks for 60+ seconds, the system auto-switches to the next healthy backup.
        </p>
      </div>
    </div>
  );
}
