import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import AssetIcon from '../components/AssetIcon';
import { useConfirm } from '../components/ConfirmProvider';

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

function CreateAlertModal({ instruments, onClose, onCreated }) {
  const [form, setForm] = useState({
    symbol: instruments[0]?.symbol || '',
    direction: 'ABOVE',
    targetPrice: '',
    note: '',
    repeatable: false,
  });
  const [loading, setLoading] = useState(false);

  const selectedInst = useMemo(() => instruments.find((i) => i.symbol === form.symbol) || null, [instruments, form.symbol]);
  const selectedPriceStr = selectedInst?.lastPrice != null ? String(selectedInst.lastPrice) : '—';
  const copyPrice = async () => {
    if (selectedInst?.lastPrice == null) return;
    try { await navigator.clipboard.writeText(String(selectedInst.lastPrice)); toast.success('Price copied'); }
    catch { toast.error('Could not copy'); }
  };

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
            <SymbolCombobox
              instruments={instruments}
              value={form.symbol}
              onChange={(sym) => setForm((f) => ({ ...f, symbol: sym }))}
            />
            {selectedInst && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs flex-wrap">
                <span className="text-text-muted">Current price</span>
                <span className="font-mono font-semibold text-text-primary tabular-nums">{selectedPriceStr}</span>
                <button
                  type="button" onClick={copyPrice} title="Copy price"
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-text-muted hover:text-primary-600 hover:bg-primary-500/10 transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  Copy
                </button>
                <button
                  type="button" onClick={() => setForm((f) => ({ ...f, targetPrice: String(selectedInst.lastPrice ?? '') }))}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-semibold text-primary-600 hover:bg-primary-500/10 transition-colors"
                >
                  Use as target →
                </button>
              </div>
            )}
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

// Searchable symbol picker — replaces the plain <select> so users can filter
// a long instrument list by typing. Shows each symbol's icon + live price.
function SymbolCombobox({ instruments, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const selected = instruments.find((i) => i.symbol === value) || null;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = s
      ? instruments.filter((i) => i.symbol.toLowerCase().includes(s) || (i.name || '').toLowerCase().includes(s))
      : instruments;
    return base.slice(0, 300);
  }, [instruments, q]);

  const pick = (sym) => { onChange(sym); setOpen(false); setQ(''); };

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="input w-full flex items-center justify-between gap-2 text-left">
        <span className="truncate">
          {selected ? (
            <>
              <span className="font-semibold text-text-primary">{selected.symbol}</span>
              {selected.lastPrice != null && <span className="text-text-muted font-mono ml-1.5">({selected.lastPrice})</span>}
            </>
          ) : <span className="text-text-muted">Select symbol</span>}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-[60] mt-1 bg-bg-card border border-border-dark rounded-xl shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border-subtle">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered[0]) { e.preventDefault(); pick(filtered[0].symbol); }
                if (e.key === 'Escape') setOpen(false);
              }}
              placeholder="Search symbol…"
              className="input text-sm w-full"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && <div className="px-3 py-4 text-sm text-text-muted text-center">No symbols match &quot;{q}&quot;</div>}
            {filtered.map((i) => (
              <button
                key={i.symbol}
                type="button"
                onClick={() => pick(i.symbol)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${i.symbol === value ? 'bg-primary-500/10' : 'hover:bg-bg-hover'}`}
              >
                <AssetIcon row={i} size={22} round />
                <span className="font-semibold text-text-primary flex-1 truncate">{i.symbol}</span>
                {i.lastPrice != null && <span className="font-mono text-text-muted tabular-nums">{i.lastPrice}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
