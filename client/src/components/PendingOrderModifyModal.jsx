import { useEffect, useState } from 'react';

/**
 * Modify a pending (LIMIT / STOP) order — edit its trigger price, quantity and
 * SL/TP, or cancel it outright. Shared by the Trade page and the Explore
 * dashboard so the edit UX is identical everywhere.
 *
 * Props:
 *   order         — the pending order ({ type, side, price/stopPrice, quantity, stopLoss, takeProfit })
 *   instrument    — matching instrument (for symbol chrome; optional)
 *   onClose       — () => void
 *   onSave        — (order, fields) => Promise  (PUTs the changed fields)
 *   onCancelOrder — (order) => void             (cancels the order)
 */
export default function PendingOrderModifyModal({ order, instrument, onClose, onSave, onCancelOrder }) {
  const isStop = order.type === 'STOP';
  const isBuy = order.side === 'BUY';
  const [price, setPrice] = useState(String(isStop ? (order.stopPrice ?? '') : (order.price ?? '')));
  const [qty, setQty]     = useState(String(order.quantity ?? ''));
  const [sl, setSl]       = useState(order.stopLoss != null ? String(order.stopLoss) : '');
  const [tp, setTp]       = useState(order.takeProfit != null ? String(order.takeProfit) : '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e) => {
    e.preventDefault();
    const fields = {};
    if (isStop) fields.stopPrice = price; else fields.price = price;
    fields.quantity = qty;
    fields.stopLoss = sl === '' ? null : sl;
    fields.takeProfit = tp === '' ? null : tp;
    setSaving(true);
    await onSave(order, fields);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Modify order">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-white rounded-2xl border border-border-dark shadow-elevated overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded tracking-wide ${isBuy ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white'}`}>{isBuy ? '↑ BUY' : '↓ SELL'}</span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 tracking-wide">{order.type}</span>
            <span className="text-sm font-extrabold text-text-primary truncate">{order.symbol}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-3">
          <div>
            <label className="label">{isStop ? 'Trigger price' : 'Limit price'}</label>
            <input className="input font-mono" type="number" step="any" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="label">Quantity</label>
            <input className="input font-mono" type="number" step="any" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Stop loss</label>
              <input className="input font-mono" type="number" step="any" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="—" />
            </div>
            <div>
              <label className="label">Take profit</label>
              <input className="input font-mono" type="number" step="any" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="—" />
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={() => onCancelOrder(order)} className="px-3 py-2 rounded-xl text-sm font-bold text-bear border border-bear/30 hover:bg-bear/10 transition-colors">
              Cancel order
            </button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 disabled:opacity-50 disabled:cursor-not-allowed">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
