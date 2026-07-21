import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import AssetIcon from './AssetIcon';

/**
 * New Price Alert modal — shared by the Price Alerts page AND the notification
 * bell's "+ Price alert" quick action. Portaled to <body> so it sits above any
 * dropdown / transformed ancestor. Posts to /reports/alerts.
 *
 * props: instruments[]  onClose()  onCreated()
 */
export default function CreateAlertModal({ instruments, onClose, onCreated }) {
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

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
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
    </div>,
    document.body,
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
