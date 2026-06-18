import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * TradingView / Exness-style chart Settings dialog. Tabs on the left
 * (Symbol · Status line · Scales and lines · Canvas), live-applied controls,
 * and a Cancel / Ok footer (Cancel reverts to the snapshot taken on open).
 *
 * Props: { prefs, onChange(patch), onClose, theme }.
 * Only options that lightweight-charts actually supports are wired.
 */
const TABS = [
  { id: 'symbol', label: 'Symbol', icon: 'sym' },
  { id: 'status', label: 'Status line', icon: 'status' },
  { id: 'scales', label: 'Scales and lines', icon: 'scales' },
  { id: 'canvas', label: 'Canvas', icon: 'canvas' },
];

export default function ChartSettings({ prefs, onChange, onReset, onClose, theme }) {
  const dark = theme === 'dark';
  const [tab, setTab] = useState('scales');
  const snapshot = useRef(prefs);   // for Cancel revert

  const c = dark
    ? { bg: '#0F172A', panel: '#0B1220', border: '#334155', text: '#F1F5F9', muted: '#94A3B8', hover: '#1E293B', input: '#1E293B' }
    : { bg: '#FFFFFF', panel: '#F8FAFC', border: '#E2E8F0', text: '#0F172A', muted: '#64748B', hover: '#F1F5F9', input: '#FFFFFF' };

  const cancel = () => { onChange(snapshot.current); onClose(); };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" style={{ background: 'rgba(2,6,23,0.55)' }} onMouseDown={cancel}>
      <div
        className="w-full max-w-[760px] rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text, maxHeight: '88vh' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: `1px solid ${c.border}` }}>
          <span className="text-lg font-bold">Settings</span>
          <button type="button" onClick={cancel} style={{ color: c.muted }} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* tab rail */}
          <div className="w-[190px] shrink-0 py-3" style={{ borderRight: `1px solid ${c.border}` }}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className="w-full flex items-center gap-2.5 px-5 py-2.5 text-sm font-semibold text-left transition-colors"
                style={{ background: tab === t.id ? c.hover : 'transparent', color: tab === t.id ? c.text : c.muted }}
              >
                <TabIcon name={t.icon} /> {t.label}
              </button>
            ))}
          </div>

          {/* content */}
          <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
            {tab === 'symbol' && <SymbolTab prefs={prefs} onChange={onChange} c={c} />}
            {tab === 'status' && <StatusTab prefs={prefs} onChange={onChange} c={c} />}
            {tab === 'scales' && <ScalesTab prefs={prefs} onChange={onChange} c={c} />}
            {tab === 'canvas' && <CanvasTab prefs={prefs} onChange={onChange} c={c} />}
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5" style={{ borderTop: `1px solid ${c.border}` }}>
          {onReset && (
            <button type="button" onClick={() => onReset()} className="px-4 py-2 rounded-lg text-sm font-semibold mr-auto" style={{ border: `1px solid ${c.border}`, color: c.muted }}>Reset to defaults</button>
          )}
          <button type="button" onClick={cancel} className="px-5 py-2 rounded-lg text-sm font-semibold" style={{ border: `1px solid ${c.border}`, color: c.text }}>Cancel</button>
          <button type="button" onClick={onClose} className="px-6 py-2 rounded-lg text-sm font-bold text-white" style={{ background: '#1D4ED8' }}>Ok</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── tabs ── */
function SymbolTab({ prefs, onChange, c }) {
  return (
    <>
      <Section title="Candles" c={c}>
        <ColorRow label="Body / wick up" value={prefs.upColor} onChange={(v) => onChange({ upColor: v })} c={c} />
        <ColorRow label="Body / wick down" value={prefs.downColor} onChange={(v) => onChange({ downColor: v })} c={c} />
        <Toggle label="Last value label" checked={prefs.lastValueVisible} onChange={(v) => onChange({ lastValueVisible: v })} c={c} />
      </Section>
      <Section title="Order lines (entry / TP / SL)" c={c}>
        <ColorRow label="Entry / preview" value={prefs.entryColor} onChange={(v) => onChange({ entryColor: v })} c={c} />
        <ColorRow label="Take Profit" value={prefs.tpColor} onChange={(v) => onChange({ tpColor: v })} c={c} />
        <ColorRow label="Stop Loss" value={prefs.slColor} onChange={(v) => onChange({ slColor: v })} c={c} />
      </Section>
    </>
  );
}
function StatusTab({ prefs, onChange, c }) {
  return (
    <Section title="Status line" c={c}>
      <Toggle label="Countdown to bar close" checked={prefs.countdown} onChange={(v) => onChange({ countdown: v })} c={c} />
      <Toggle label="Last value label" checked={prefs.lastValueVisible} onChange={(v) => onChange({ lastValueVisible: v })} c={c} />
    </Section>
  );
}
function ScalesTab({ prefs, onChange, c }) {
  return (
    <>
      <Section title="Price scale" c={c}>
        <SelectRow
          label="Scale mode" value={prefs.scaleMode} onChange={(v) => onChange({ scaleMode: v })} c={c}
          options={[['normal', 'Regular'], ['log', 'Logarithmic'], ['percent', 'Percent'], ['indexed', 'Indexed to 100']]}
        />
        <Toggle label="Invert scale" checked={prefs.invert} onChange={(v) => onChange({ invert: v })} c={c} />
        <Toggle label="Auto (fit data to screen)" checked={prefs.autoScale} onChange={(v) => onChange({ autoScale: v })} c={c} />
      </Section>
      <Section title="Price labels & lines" c={c}>
        <Toggle label="No overlapping labels" checked={prefs.alignLabels} onChange={(v) => onChange({ alignLabels: v })} c={c} />
      </Section>
      <Section title="Time scale" c={c}>
        <Toggle label="Day of week on labels" checked={prefs.dayOfWeek} onChange={(v) => onChange({ dayOfWeek: v })} c={c} />
        <SelectRow
          label="Time hours format" value={prefs.hours24 ? '24' : '12'} onChange={(v) => onChange({ hours24: v === '24' })} c={c}
          options={[['24', '24-hours'], ['12', '12-hours']]}
        />
        <Toggle label="Seconds on labels" checked={prefs.secondsVisible} onChange={(v) => onChange({ secondsVisible: v })} c={c} />
      </Section>
    </>
  );
}
function CanvasTab({ prefs, onChange, c }) {
  return (
    <Section title="Canvas" c={c}>
      <Toggle label="Grid lines" checked={prefs.gridLines} onChange={(v) => onChange({ gridLines: v })} c={c} />
      <Toggle label="Candle diagnostics overlay" checked={prefs.diagnostics} onChange={(v) => onChange({ diagnostics: v })} c={c} />
    </Section>
  );
}

/* ── primitives ── */
function Section({ title, c, children }) {
  return (
    <div className="mb-6">
      <div className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: c.muted }}>{title}</div>
      <div className="space-y-3.5">{children}</div>
    </div>
  );
}
function Toggle({ label, checked, onChange, c }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-sm" style={{ color: c.text }}>{label}</span>
      <button
        type="button" role="switch" aria-checked={!!checked} onClick={() => onChange(!checked)}
        className="relative w-10 h-5.5 rounded-full transition-colors" style={{ width: 40, height: 22, background: checked ? '#1D4ED8' : c.border }}
      >
        <span className="absolute rounded-full bg-white transition-transform" style={{ width: 16, height: 16, top: 3, left: 3, transform: checked ? 'translateX(18px)' : 'none' }} />
      </button>
    </label>
  );
}
function SelectRow({ label, value, onChange, options, c }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm" style={{ color: c.text }}>{label}</span>
      <select
        value={value} onChange={(e) => onChange(e.target.value)}
        className="text-sm rounded-lg px-3 py-2 min-w-[180px] focus:outline-none"
        style={{ background: c.input, border: `1px solid ${c.border}`, color: c.text }}
      >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
function ColorRow({ label, value, onChange, c }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm" style={{ color: c.text }}>{label}</span>
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-xs" style={{ color: c.muted }}>{value}</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent p-0" />
      </span>
    </div>
  );
}
function TabIcon({ name }) {
  const p = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  switch (name) {
    case 'sym': return <svg {...p}><rect x="6" y="7" width="3" height="10" /><line x1="7.5" y1="4" x2="7.5" y2="7" /><line x1="7.5" y1="17" x2="7.5" y2="20" /><rect x="15" y="5" width="3" height="9" /><line x1="16.5" y1="3" x2="16.5" y2="5" /><line x1="16.5" y1="14" x2="16.5" y2="18" /></svg>;
    case 'status': return <svg {...p}><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="13" x2="14" y2="13" /><line x1="4" y1="18" x2="11" y2="18" /></svg>;
    case 'scales': return <svg {...p}><path d="M5 3v16h16" /><path d="M5 19l5-5 3 3 6-7" /></svg>;
    case 'canvas': return <svg {...p}><path d="M3 17l6-6 4 4 8-9" /><circle cx="18" cy="6" r="1" /></svg>;
    default: return <svg {...p}><circle cx="12" cy="12" r="9" /></svg>;
  }
}
