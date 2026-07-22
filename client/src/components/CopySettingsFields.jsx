import { useState } from 'react';

/**
 * CopySettingsFields — the shared lot-size + copy-settings block used by both
 * the Copy dialog (CopySetupModal) and the Edit dialog (EditCopyModal).
 *
 * Props:
 *   settings: { lotMode, customLot, lotMultiplier, riskMultiplier, maxLot,
 *               maxOpenTrades, copySL, copyTP, copyPending }
 *   set(key, value): update one field
 *   advancedDefault: whether the "Copy settings" section starts expanded
 */

export const LOT_MODES = [
  { id: 'LOW',    label: 'Low',    note: '0.5× master lot' },
  { id: 'MEDIUM', label: 'Medium', note: '1× master lot' },
  { id: 'HIGH',   label: 'High',   note: '1.5× master lot' },
  { id: 'CUSTOM', label: 'Custom', note: 'Fixed lot' },
];

const inputCls = 'w-full px-3 py-2 rounded-lg border border-border-dark bg-white text-sm font-mono font-bold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15';

export default function CopySettingsFields({ settings: s, set, advancedDefault = false }) {
  const [showAdvanced, setShowAdvanced] = useState(advancedDefault);
  return (
    <>
      {/* Lot size */}
      <div>
        <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Lot size</label>
        <div className="grid grid-cols-2 gap-2">
          {LOT_MODES.map((m) => (
            <button key={m.id} type="button" onClick={() => set('lotMode', m.id)}
              className={`rounded-xl border-2 p-2.5 text-left transition-all ${
                s.lotMode === m.id ? 'border-primary-500 bg-primary-500/5 text-primary-600 shadow-sm' : 'border-border-dark bg-white text-text-secondary hover:border-primary-500'}`}>
              <div className="text-sm font-extrabold">{m.label}</div>
              <div className="text-[10px] mt-0.5 opacity-80">{m.note}</div>
            </button>
          ))}
        </div>
        {s.lotMode === 'CUSTOM' && (
          <div className="mt-2">
            <div className="relative">
              <input type="number" step="0.01" min="0.01" value={s.customLot ?? ''} onChange={(e) => set('customLot', e.target.value)}
                className="w-full pl-3 pr-14 py-2.5 rounded-xl border border-border-dark bg-white text-base font-mono font-bold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-text-muted font-semibold">lots</span>
            </div>
            <p className="text-[11px] text-text-muted mt-1">Fixed lot per copied trade — e.g. 0.10, 0.25, 1.00, 1.52.</p>
          </div>
        )}
      </div>

      {/* Copy settings (advanced) */}
      <div>
        <button type="button" onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-bold text-text-muted hover:text-text-primary transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}><path d="M9 18l6-6-6-6" /></svg>
          Copy settings
        </button>
        {showAdvanced && (
          <div className="mt-2.5 space-y-3">
            <div className="space-y-2">
              <Toggle label="Copy Stop Loss" checked={s.copySL} onChange={(v) => set('copySL', v)} />
              <Toggle label="Copy Take Profit" checked={s.copyTP} onChange={(v) => set('copyTP', v)} />
              <Toggle label="Copy Pending Orders" checked={s.copyPending} onChange={(v) => set('copyPending', v)} />
            </div>
            <Field label="Max lot per trade (blank = no limit)">
              <input type="number" step="0.01" min="0" placeholder="—" value={s.maxLot ?? ''} onChange={(e) => set('maxLot', e.target.value)} className={inputCls} />
            </Field>
          </div>
        )}
      </div>
    </>
  );
}

/** Build the API payload from a settings object (shared by copy + edit). */
export function settingsPayload(s) {
  return {
    lotMode: s.lotMode,
    customLot: s.lotMode === 'CUSTOM' ? Number(s.customLot) : undefined,
    maxLot: s.maxLot === '' || s.maxLot == null ? undefined : Number(s.maxLot),
    copySL: !!s.copySL,
    copyTP: !!s.copyTP,
    copyPending: !!s.copyPending,
  };
}

/** Default settings for a fresh copy. */
export const defaultSettings = () => ({
  lotMode: 'MEDIUM', customLot: '0.10', maxLot: '',
  copySL: true, copyTP: true, copyPending: false,
});

export function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between gap-2 cursor-pointer text-sm">
      <span className="text-text-primary">{label}</span>
      <button type="button" onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition ${checked ? 'bg-primary-500' : 'bg-bg-hover border border-border-dark'}`}>
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </label>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1">{label}</div>
      {children}
    </label>
  );
}
