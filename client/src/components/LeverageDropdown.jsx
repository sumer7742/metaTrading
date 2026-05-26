import { useEffect, useRef, useState } from 'react';

/**
 * LeverageDropdown — premium custom dropdown with the canonical
 * leverage ladder. Options above `maxLeverage` render faded + 🔒.
 *
 * Props:
 *   value        Number — current leverage (use 999999 to represent "1:Unlimited")
 *   onChange     (n: Number) => void
 *   maxLeverage  Number | null — null = unlimited (no options locked)
 *
 * Behaviour:
 *   • Custom option opens an inline numeric input below the trigger
 *   • ESC / outside-click closes the dropdown
 *   • Animated open via scoped @keyframes
 *
 * The full ladder is exported separately so consumers can drive their
 * own UI (chip rows, comparison tables, etc.) off the same source.
 */
export const LEVERAGE_LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 400, 500, 600, 800, 1000, 2000];
export const UNLIMITED_LEVERAGE = 999999;

export default function LeverageDropdown({ value, onChange, maxLeverage }) {
  const OPTIONS = [
    { kind: 'CUSTOM', label: 'Custom' },
    ...LEVERAGE_LADDER.map((n) => ({ kind: 'FIXED', value: n })),
    { kind: 'UNLIMITED', label: '1:Unlimited' },
  ];
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const rootRef = useRef(null);

  // Coerce maxLeverage to a finite positive number. null / undefined /
  // 0 / NaN / negative all mean "no cap" (unlimited allowed).
  const capNum = Number(maxLeverage);
  const hasCap = Number.isFinite(capNum) && capNum > 0;

  // If the current value is above the cap (e.g. parent passed 999999
  // before the cap arrived from the API), snap it down. Done in a
  // useEffect so it runs only when the cap or value actually changes.
  useEffect(() => {
    if (!hasCap) return;
    if (Number(value) > capNum) onChange(capNum);
  }, [hasCap, capNum, value, onChange]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const isLocked = (opt) => {
    if (!hasCap) return false;
    if (opt.kind === 'FIXED')     return opt.value > capNum;
    if (opt.kind === 'UNLIMITED') return true;
    return false;
  };

  // When a cap is in force, NEVER show "1:Unlimited" — even if the
  // value is somehow above the threshold during the snap-down tick.
  const display = custom
    ? `Custom · 1:${value}`
    : (!hasCap && value >= UNLIMITED_LEVERAGE)
      ? '1:Unlimited'
      : `1:${hasCap ? Math.min(Number(value) || 1, capNum) : value}`;

  const pick = (opt) => {
    if (isLocked(opt)) return;
    if (opt.kind === 'CUSTOM') {
      setCustom(true);
    } else if (opt.kind === 'UNLIMITED') {
      setCustom(false);
      onChange(UNLIMITED_LEVERAGE);
    } else {
      setCustom(false);
      onChange(opt.value);
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3.5 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold tabular-nums flex items-center justify-between hover:border-primary-500/50 focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 focus:outline-none transition-all"
      >
        <span className="truncate">{display}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {custom && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-sm font-bold text-text-muted">1:</span>
          <input
            type="number"
            min={1}
            max={hasCap ? capNum : UNLIMITED_LEVERAGE}
            value={value}
            onChange={(e) => {
              let v = Number(e.target.value) || 1;
              if (v < 1) v = 1;
              if (hasCap && v > capNum) v = capNum;
              onChange(v);
            }}
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-border-dark bg-white text-sm font-mono focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 focus:outline-none"
            placeholder={hasCap ? `up to ${capNum}` : 'e.g. 75'}
          />
          <button type="button" onClick={() => setCustom(false)} className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            ×
          </button>
        </div>
      )}

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1.5 rounded-xl border border-border-dark bg-white shadow-elevated overflow-hidden animate-[ldOpen_0.18s_ease-out]">
          <div className="max-h-64 overflow-y-auto py-1">
            {OPTIONS.map((opt, i) => {
              const locked = isLocked(opt);
              const selected = !custom && (
                (opt.kind === 'FIXED' && opt.value === value) ||
                (opt.kind === 'UNLIMITED' && value >= UNLIMITED_LEVERAGE)
              ) || (custom && opt.kind === 'CUSTOM');
              const label = opt.kind === 'FIXED' ? `1:${opt.value}` : opt.label;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pick(opt)}
                  disabled={locked}
                  className={`w-full px-3.5 py-2 text-left text-sm font-semibold flex items-center justify-between transition-colors ${
                    locked
                      ? 'text-text-muted/50 cursor-not-allowed'
                      : selected
                        ? 'bg-primary-500/10 text-primary-600'
                        : 'text-text-primary hover:bg-bg-hover'
                  }`}
                >
                  <span className="tabular-nums">{label}</span>
                  {locked ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                      <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  ) : selected ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        @keyframes ldOpen {
          from { opacity: 0; transform: translateY(-4px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
