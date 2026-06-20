import { useMemo, useState } from 'react';
import { parseMaKey, labelForActive, INDICATORS } from './indicatorCatalog';
import IndicatorSettingsModal from './IndicatorSettingsModal';

/**
 * ChartIndicatorLegend — TradingView-style on-chart legend listing every active
 * indicator below the symbol/OHLC line. Each row shows a colour dot + label
 * ("EMA (21)", "RSI (14)") with hover controls to edit (settings modal) or
 * delete the indicator. Edits update the model instantly → chart updates live.
 *
 * props: { indicators, onChange(next), theme }
 */
export default function ChartIndicatorLegend({ indicators, onChange, theme }) {
  const dark = theme === 'dark';
  const [modal, setModal] = useState(null); // { target, cfg, isActive, key }

  const cfgOf = (key) => (typeof indicators[key] === 'object' && indicators[key] ? indicators[key] : {});
  const keys = useMemo(
    () => Object.keys(indicators).filter((k) => indicators[k])
      .sort((a, b) => labelForActive(a, cfgOf(a)).localeCompare(labelForActive(b, cfgOf(b)))),
    [indicators],
  );

  if (!keys.length) return null;

  const dotColor = (key) => {
    const ma = parseMaKey(key);
    if (ma) return cfgOf(key).color || ma.def.color;
    return cfgOf(key).color || INDICATORS.find((i) => i.key === key)?.color || '#1D4ED8';
  };

  const openEdit = (key) => {
    const ma = parseMaKey(key);
    if (ma) { setModal({ target: { type: 'ma', ma: ma.def }, cfg: { ...cfgOf(key), period: ma.period }, isActive: true, key }); return; }
    const ind = INDICATORS.find((i) => i.key === key);
    if (ind) setModal({ target: { type: 'ind', ind }, cfg: cfgOf(key), isActive: true, key });
  };

  const applyModal = (params) => {
    const next = { ...indicators };
    if (modal.target.type === 'ma') {
      const key = `${modal.target.ma.code}${params.period}`;
      if (modal.key && modal.key !== key) delete next[modal.key];
      next[key] = { color: params.color, lineWidth: params.lineWidth, lineStyle: params.lineStyle };
    } else {
      const key = modal.target.ind.key;
      next[key] = {
        color: params.color, lineWidth: params.lineWidth, lineStyle: params.lineStyle,
        ...(params.length != null ? { length: params.length } : {}),
      };
    }
    onChange(next);
    setModal(null);
  };

  const removeKey = (key) => { const next = { ...indicators }; delete next[key]; onChange(next); };

  const rowBg = dark ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.78)';
  const txt = dark ? '#E2E8F0' : '#0F172A';
  const muted = dark ? '#94A3B8' : '#64748B';

  return (
    <div className="flex flex-col items-start gap-0.5 pointer-events-none">
      {keys.map((key) => (
        <div
          key={key}
          className="group pointer-events-auto inline-flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded text-[11px] font-semibold backdrop-blur-sm"
          style={{ background: rowBg, color: txt }}
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotColor(key) }} />
          <span className="truncate max-w-[200px]">{labelForActive(key, cfgOf(key))}</span>
          {/* hover controls */}
          <button
            type="button"
            onClick={() => openEdit(key)}
            title="Settings"
            className="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: muted }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          </button>
          <button
            type="button"
            onClick={() => removeKey(key)}
            title="Remove"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: '#ef4444' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      ))}

      {modal && (
        <IndicatorSettingsModal
          target={modal.target}
          cfg={modal.cfg}
          isActive={modal.isActive}
          theme={theme}
          onApply={applyModal}
          onRemove={modal.key ? () => { removeKey(modal.key); setModal(null); } : null}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
