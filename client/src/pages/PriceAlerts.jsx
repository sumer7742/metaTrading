import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import AssetIcon from '../components/AssetIcon';
import { useConfirm } from '../components/ConfirmProvider';
import CreateAlertModal from '../components/CreateAlertModal';

export default function PriceAlerts() {
  const confirm = useConfirm();
  const [alerts, setAlerts] = useState([]);
  const [instruments, setInstruments] = useState([]);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = async () => {
    try {
      const [a, i] = await Promise.all([api.get('/reports/alerts'), api.get('/instruments')]);
      setAlerts(a.data.data);
      setInstruments(i.data.data);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { refresh(); }, []);

  const remove = async (id) => {
    if (!(await confirm('Delete this alert?'))) return;
    try { await api.delete(`/reports/alerts/${id}`); toast.success('Alert deleted'); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  const toggle = async (id) => {
    try { await api.put(`/reports/alerts/${id}/toggle`); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6 max-w-[1200px]">
      <PageHero
        eyebrow="Notifications"
        title="Price Alerts"
        subtitle="Get notified the moment an instrument crosses your target price — via in-app, email, and push."
        actions={
          <button onClick={() => setShowCreate(true)} className="btn-primary text-sm">+ New Alert</button>
        }
      />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-500 bg-bg-card">
                <th className="text-left py-2 px-4">Symbol</th>
                <th className="text-left py-2 px-4">Direction</th>
                <th className="text-right py-2 px-4">Target</th>
                <th className="text-left py-2 px-4">Note</th>
                <th className="text-left py-2 px-4">Status</th>
                <th className="text-right py-2 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {alerts.length === 0 && (
                <tr><td colSpan={6} className="text-center py-6 text-gray-500">No alerts yet</td></tr>
              )}
              {alerts.map((a) => (
                <tr key={a._id} className="table-row">
                  <td className="py-2 px-4 text-white font-medium">
                    <div className="flex items-center gap-2">
                      <AssetIcon
                        row={instruments.find((i) => i.symbol === a.symbol) || { symbol: a.symbol }}
                        size={20}
                        round
                      />
                      <span>{a.symbol}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4">
                    <span className={a.direction === 'ABOVE' ? 'text-bull' : 'text-bear'}>
                      {a.direction === 'ABOVE' ? '↑ Above' : '↓ Below'}
                    </span>
                  </td>
                  <td className="py-2 px-4 text-right font-mono text-white">{a.targetPrice}</td>
                  <td className="py-2 px-4 text-gray-400">{a.note || '—'}</td>
                  <td className="py-2 px-4">
                    {a.triggeredAt ? (
                      <span className="px-2 py-0.5 rounded bg-bull/15 text-bull text-xs">Triggered @ {a.triggeredPrice}</span>
                    ) : a.isActive ? (
                      <span className="px-2 py-0.5 rounded bg-warn/15 text-warn text-xs">Active</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-gray-700 text-gray-400 text-xs">Paused</span>
                    )}
                  </td>
                  <td className="py-2 px-4 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => toggle(a._id)} className="btn-ghost text-xs px-2 py-1">
                        {a.isActive ? 'Pause' : 'Resume'}
                      </button>
                      <button onClick={() => remove(a._id)} className="btn-ghost text-xs px-2 py-1 text-bear">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && (
        <CreateAlertModal
          instruments={instruments}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); refresh(); }}
        />
      )}
    </div>
  );
}
