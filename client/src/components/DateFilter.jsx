import { useEffect, useRef, useState } from 'react';

/**
 * Global Date Range Filter — [ Today ] [ 7 Days ] [ 30 Days ] [ Custom ].
 *
 * Reusable across the client panel. Computes concrete { fromDate, toDate }
 * (YYYY-MM-DD) for every preset so APIs always receive a real range. Custom
 * opens a Start/End popover with Apply/Cancel; the active filter stays
 * highlighted and a chosen custom range shows on the button.
 *
 *   const [range, setRange] = useDateFilter('orders.range');   // persisted
 *   <DateFilter value={range} onChange={setRange} />
 */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

export function fmtRange(a, b) {
  const f = (s) => { if (!s) return '?'; const [y, m, d] = s.split('-'); return `${d} ${MON[+m - 1]} ${y}`; };
  return `${f(a)} - ${f(b)}`;
}

export function computeRange(period, fromDate, toDate) {
  const now = new Date();
  const end = toYMD(now);
  if (period === 'today') return { period: 'today', fromDate: end, toDate: end };
  if (period === '30d') { const f = new Date(now); f.setDate(f.getDate() - 29); return { period: '30d', fromDate: toYMD(f), toDate: end }; }
  if (period === 'custom') return { period: 'custom', fromDate, toDate };
  if (period == null) return { period: null, fromDate: '', toDate: '' }; // all-time / no filter
  const f = new Date(now); f.setDate(f.getDate() - 6);
  return { period: '7d', fromDate: toYMD(f), toDate: end };
}

export function useDateFilter(storageKey, defaultPeriod = '7d') {
  const [range, setRange] = useState(() => {
    if (storageKey) {
      try {
        const s = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (s && 'period' in s) return s.period === 'custom' ? s : computeRange(s.period);
      } catch { /* ignore */ }
    }
    return computeRange(defaultPeriod);
  });
  const set = (r) => {
    setRange(r);
    if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify(r)); } catch { /* quota */ } }
  };
  return [range, set];
}

const btnClass = (active) =>
  `text-xs font-bold px-3 py-1.5 rounded-lg border transition-colors whitespace-nowrap ${
    active ? 'border-primary-500 bg-primary-500/10 text-primary-600'
           : 'border-border-dark text-text-secondary hover:border-primary-500 hover:text-primary-600'
  }`;

export default function DateFilter({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(value?.fromDate || '');
  const [draftTo, setDraftTo] = useState(value?.toDate || '');
  const ref = useRef(null);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const pick = (period) => { setOpen(false); onChange(computeRange(period)); };
  const openCustom = () => { setDraftFrom(value?.fromDate || ''); setDraftTo(value?.toDate || ''); setOpen((o) => !o); };
  const apply = () => { if (!draftFrom || !draftTo) return; onChange({ period: 'custom', fromDate: draftFrom, toDate: draftTo }); setOpen(false); };

  const isCustom = value?.period === 'custom';
  const customLabel = isCustom && value?.fromDate && value?.toDate ? fmtRange(value.fromDate, value.toDate) : 'Custom';

  return (
    <div className="inline-flex items-center gap-1.5 relative flex-wrap" ref={ref}>
      {PRESETS.map((p) => (
        <button key={p.key} type="button" onClick={() => pick(p.key)} className={btnClass(value?.period === p.key)}>{p.label}</button>
      ))}
      <button type="button" onClick={openCustom} className={btnClass(isCustom)}>{customLabel}{!isCustom && ' ▾'}</button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-30 w-[260px] rounded-xl border border-border-dark bg-white shadow-xl p-3">
          <div className="text-[10px] uppercase tracking-wider text-text-muted font-bold mb-2">Custom range</div>
          <div className="space-y-2">
            <label className="block">
              <span className="text-[11px] text-text-secondary">Start date</span>
              <input type="date" value={draftFrom} max={draftTo || undefined} onChange={(e) => setDraftFrom(e.target.value)}
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-border-dark bg-white text-sm text-text-primary focus:outline-none focus:border-primary-500" />
            </label>
            <label className="block">
              <span className="text-[11px] text-text-secondary">End date</span>
              <input type="date" value={draftTo} min={draftFrom || undefined} onChange={(e) => setDraftTo(e.target.value)}
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-border-dark bg-white text-sm text-text-primary focus:outline-none focus:border-primary-500" />
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" onClick={() => setOpen(false)} className="text-xs px-3 py-1.5 rounded-lg text-text-secondary hover:text-text-primary">Cancel</button>
            <button type="button" onClick={apply} disabled={!draftFrom || !draftTo}
              className="text-xs px-3 py-1.5 rounded-lg bg-primary-500 text-white font-semibold hover:bg-primary-600 disabled:opacity-40">Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
