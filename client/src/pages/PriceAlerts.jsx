import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

export default function PriceAlerts() {
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
    if (!confirm('Delete this alert?')) return;
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
              <tr className="text-xs uppercase text-gray-500 bg-bg-dark">
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
                  <td className="py-2 px-4 text-white font-medium">{a.symbol}</td>
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

function CreateAlertModal({ instruments, onClose, onCreated }) {
  const [form, setForm] = useState({
    symbol: instruments[0]?.symbol || '',
    direction: 'ABOVE',
    targetPrice: '',
    note: '',
    repeatable: false,
  });
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!form.symbol || !form.targetPrice) return toast.error('Symbol and target price are required');
    setLoading(true);
    try {
      await api.post('/reports/alerts', form);
      toast.success('Alert created');
      onCreated();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-xl border border-border-dark p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">New Price Alert</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Symbol</label>
            <select className="input" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })}>
              {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol} ({i.lastPrice})</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Direction</label>
              <select className="input" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                <option value="ABOVE">Price goes ABOVE</option>
                <option value="BELOW">Price goes BELOW</option>
              </select>
            </div>
            <div>
              <label className="label">Target Price</label>
              <input type="number" step="any" className="input" value={form.targetPrice} onChange={(e) => setForm({ ...form, targetPrice: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label">Note (optional)</label>
            <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. resistance breakout" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={form.repeatable} onChange={(e) => setForm({ ...form, repeatable: e.target.checked })} />
            Repeatable (re-arm after each trigger)
          </label>
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button onClick={submit} disabled={loading} className="btn-primary flex-1">
              {loading ? 'Creating…' : 'Create alert'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
