import { useEffect, useRef, useState } from 'react';

/**
 * Global Date Range Filter — [ Today ] [ 7 Days ] [ 30 Days ] [ Custom ].
 *
 * Drop-in for any date-filtered page. Computes a CONCRETE { fromDate, toDate }
 * (YYYY-MM-DD) for every preset, so every API just receives a real range
 * regardless of which button is active. Custom opens a popover with Start/End
 * + Apply/Cancel. The active filter stays highlighted; a chosen custom range
 * shows on the button (e.g. "01 Jun 2026 - 30 Jun 2026").
 *
 *   const [range, setRange] = useDateFilter('orders.range', '7d');
 *   <DateFilter value={range} onChange={setRange} />
 *   api.get('/...', { params: { fromDate: range.fromDate, toDate: range.toDate } })
 */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const toYMD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

// Fuller preset set for the executive dashboard global filter.
export const DASHBOARD_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24H' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'this_month', label: 'This Month' },
  { key: 'previous_month', label: 'Prev Month' },
];

export function fmtRange(a, b) {
  const f = (s) => { if (!s) return '?'; const [y, m, d] = s.split('-'); return `${d} ${MON[+m - 1]} ${y}`; };
  return `${f(a)} - ${f(b)}`;
}

// Resolve a preset (or custom) into concrete YYYY-MM-DD bounds. Rolling
// presets (24h) are date-approximated here for display/other pages; the
// dashboard sends `period` so the backend can apply precise time logic.
export function computeRange(period, fromDate, toDate) {
  const now = new Date();
  const end = toYMD(now);
  const daysAgo = (n) => { const f = new Date(now); f.setDate(f.getDate() - n); return toYMD(f); };
  switch (period) {
    case null:
    case undefined: return { period: null, fromDate: '', toDate: '' }; // all-time / no filter
    case 'today': return { period: 'today', fromDate: end, toDate: end };
    case '24h': return { period: '24h', fromDate: daysAgo(1), toDate: end };
    case '30d': return { period: '30d', fromDate: daysAgo(29), toDate: end };
    case 'this_month': { const f = new Date(now.getFullYear(), now.getMonth(), 1); return { period: 'this_month', fromDate: toYMD(f), toDate: end }; }
    case 'previous_month': {
      const f = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const l = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
      return { period: 'previous_month', fromDate: toYMD(f), toDate: toYMD(l) };
    }
    case 'custom': return { period: 'custom', fromDate, toDate };
    case '7d':
    default: return { period: '7d', fromDate: daysAgo(6), toDate: end };
  }
}

// State hook with optional per-page localStorage persistence (survives refresh).
export function useDateFilter(storageKey, defaultPeriod = '7d') {
  const [range, setRange] = useState(() => {
    if (storageKey) {
      try {
        const s = JSON.parse(localStorage.getItem(storageKey) || 'null');
        if (s && s.period) return s.period === 'custom' ? s : computeRange(s.period);
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

// Theme tokens so the same component fits dark admin pages AND the white
// Portfolio dashboard.
const THEMES = {
  dark: {
    btn: (a) => a ? 'border-primary-500 bg-primary-500/10 text-primary-400' : 'border-border-dark text-text-secondary hover:text-white hover:border-primary-500',
    pop: 'border-border-dark bg-bg-card', label: 'text-text-muted', sub: 'text-text-secondary',
    input: 'border-border-dark bg-bg-dark text-white', cancel: 'text-text-secondary hover:text-white', apply: 'bg-primary-500 hover:bg-primary-600',
  },
  light: {
    btn: (a) => a ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50',
    pop: 'border-gray-200 bg-white', label: 'text-gray-500', sub: 'text-gray-600',
    input: 'border-gray-300 bg-white text-gray-900', cancel: 'text-gray-500 hover:text-gray-900', apply: 'bg-indigo-600 hover:bg-indigo-700',
  },
};

export default function DateFilter({ value, onChange, theme = 'dark', presets = PRESETS }) {
  const t = THEMES[theme] || THEMES.dark;
  const btnClass = (active) => `text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors whitespace-nowrap ${t.btn(active)}`;
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
      {presets.map((p) => (
        <button key={p.key} type="button" onClick={() => pick(p.key)} className={btnClass(value?.period === p.key)}>{p.label}</button>
      ))}
      <button type="button" onClick={openCustom} className={btnClass(isCustom)}>{customLabel}{!isCustom && ' ▾'}</button>

      {open && (
        <div className={`absolute top-full right-0 mt-1.5 z-30 w-[260px] rounded-xl border shadow-2xl p-3 ${t.pop}`}>
          <div className={`text-[10px] uppercase tracking-wider font-bold mb-2 ${t.label}`}>Custom range</div>
          <div className="space-y-2">
            <label className="block">
              <span className={`text-[11px] ${t.sub}`}>Start date</span>
              <input type="date" value={draftFrom} max={draftTo || undefined} onChange={(e) => setDraftFrom(e.target.value)}
                className={`w-full mt-0.5 px-2.5 py-1.5 rounded-lg border text-sm focus:outline-none focus:border-primary-500 ${t.input}`} />
            </label>
            <label className="block">
              <span className={`text-[11px] ${t.sub}`}>End date</span>
              <input type="date" value={draftTo} min={draftFrom || undefined} onChange={(e) => setDraftTo(e.target.value)}
                className={`w-full mt-0.5 px-2.5 py-1.5 rounded-lg border text-sm focus:outline-none focus:border-primary-500 ${t.input}`} />
            </label>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button type="button" onClick={() => setOpen(false)} className={`text-xs px-3 py-1.5 rounded-lg ${t.cancel}`}>Cancel</button>
            <button type="button" onClick={apply} disabled={!draftFrom || !draftTo}
              className={`text-xs px-3 py-1.5 rounded-lg text-white font-semibold disabled:opacity-40 ${t.apply}`}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
