import { useState } from 'react';
import { CHART_TYPES, TF_OPTIONS, buildIndicatorList } from './PriceChart';

/**
 * MultiChartToolbar — a single shared toolbar rendered ABOVE the multi-chart
 * grid (TradingView-style). It drives the ACTIVE pane: chart-type, indicators
 * and timeframe come in as controlled values + setters, plus the layout picker
 * and expand / fullscreen actions. Each pane itself renders only the chart
 * (hideHeader), so there is exactly one set of controls for the whole layout.
 */
const INDICATOR_LIST = buildIndicatorList();

export default function MultiChartToolbar({
  activeSymbol,
  chartType,
  onChartType,
  indicators = {},
  onToggleIndicator,
  timeframe,
  onTimeframe,
  layoutPicker = null,
  expanded,
  onToggleExpand,
  fullscreen,
  onToggleFullscreen,
}) {
  const [menu, setMenu] = useState(null); // 'type' | 'ind' | 'tf' | null
  const [q, setQ] = useState('');
  const close = () => { setMenu(null); setQ(''); };
  const currentType = CHART_TYPES.find((t) => t.id === chartType) || CHART_TYPES[0];
  const activeCount = INDICATOR_LIST.filter((i) => indicators[i.key]).length;
  const visible = q ? INDICATOR_LIST.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())) : INDICATOR_LIST;

  const btn = 'inline-flex items-center gap-1.5 h-8 px-3 rounded border border-border-dark bg-white text-[11px] font-semibold text-text-primary hover:bg-bg-hover hover:border-border-accent transition-colors';
  const iconBtn = 'inline-flex items-center justify-center h-8 w-8 rounded border border-border-dark bg-white text-text-secondary hover:text-text-primary hover:bg-bg-hover hover:border-border-accent transition-colors';

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-border-dark bg-gradient-to-r from-bg-card to-bg-card/50 flex-wrap shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
      {activeSymbol && (
        <span className="text-[11px] font-bold text-text-primary mr-1 tabular-nums">{activeSymbol}</span>
      )}

      {/* Chart type */}
      <div className="relative">
        <button type="button" className={btn} onClick={() => setMenu((m) => (m === 'type' ? null : 'type'))}>
          <span className="text-text-muted">{currentType.glyph}</span>
          <span>{currentType.label}</span>
          <span className={`text-text-muted text-[10px] transition-transform ${menu === 'type' ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {menu === 'type' && (
          <>
            <div className="fixed inset-0 z-30" onClick={close} />
            <div className="absolute left-0 top-full mt-1 z-40 w-48 bg-white border border-border-dark rounded-lg shadow-elevated overflow-hidden py-1">
              {CHART_TYPES.map((t) => {
                const active = t.id === chartType;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { onChartType?.(t.id); close(); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors ${active ? 'bg-primary-500/10 text-primary-600' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
                  >
                    <span className={active ? 'text-primary-500' : 'text-text-muted'}>{t.glyph}</span>
                    <span className="flex-1 text-left">{t.label}</span>
                    {active && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Indicators */}
      <div className="relative">
        <button type="button" className={btn} onClick={() => setMenu((m) => (m === 'ind' ? null : 'ind'))}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l4-4 4 4 6-7" /></svg>
          Indicators
          {activeCount > 0 && <span className="text-[9px] font-bold px-1.5 py-px rounded-full bg-primary-500 text-white">{activeCount}</span>}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        {menu === 'ind' && (
          <>
            <div className="fixed inset-0 z-30" onClick={close} />
            <div className="absolute left-0 top-full mt-1 z-40 w-60 bg-white border border-border-dark rounded-lg shadow-elevated overflow-hidden max-h-[420px] overflow-y-auto">
              <div className="sticky top-0 z-10 bg-white border-b border-border-subtle p-2">
                <div className="relative">
                  <svg className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search indicators…"
                    className="w-full pl-7 pr-2 py-1.5 text-[12px] rounded border border-border-dark bg-white text-text-primary focus:outline-none focus:border-border-accent"
                  />
                </div>
              </div>
              {visible.map((ind) => {
                const on = !!indicators[ind.key];
                return (
                  <button
                    key={ind.key}
                    type="button"
                    onClick={() => onToggleIndicator?.(ind.key)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[12px] hover:bg-bg-hover transition-colors text-left"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: ind.color }} />
                      <span className="truncate text-text-secondary">{ind.label}</span>
                    </span>
                    <span className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border ${on ? 'bg-primary-500 border-primary-500 text-white' : 'border-border-dark'}`}>
                      {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
                    </span>
                  </button>
                );
              })}
              {visible.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-text-muted">No match</div>}
            </div>
          </>
        )}
      </div>

      {/* Timeframe */}
      <div className="relative">
        <button type="button" className={btn} onClick={() => setMenu((m) => (m === 'tf' ? null : 'tf'))}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <span className="uppercase">{timeframe}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
        </button>
        {menu === 'tf' && (
          <>
            <div className="fixed inset-0 z-30" onClick={close} />
            <div className="absolute left-0 top-full mt-1 z-40 w-28 bg-white border border-border-dark rounded-lg shadow-elevated overflow-hidden py-1">
              {TF_OPTIONS.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => { onTimeframe?.(tf); close(); }}
                  className={`w-full px-3 py-1.5 text-[12px] text-left uppercase transition-colors ${tf === timeframe ? 'bg-primary-500/10 text-primary-600 font-bold' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Right cluster — layout picker + expand / fullscreen */}
      <div className="ml-auto flex items-center gap-2">
        {layoutPicker}
        {onToggleExpand && (
          <button type="button" onClick={onToggleExpand} title={expanded ? 'Show panels (E)' : 'Expand — hide panels (E)'} className={iconBtn}>
            {expanded
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>}
          </button>
        )}
        {onToggleFullscreen && (
          <button type="button" onClick={onToggleFullscreen} title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'} className={iconBtn}>
            {fullscreen
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3" /><path d="M21 8h-3a2 2 0 0 1-2-2V3" /><path d="M3 16h3a2 2 0 0 1 2 2v3" /><path d="M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h6v2H5v4H3V3z" /><path d="M21 3v6h-2V5h-4V3h6z" /><path d="M3 21v-6h2v4h4v2H3z" /><path d="M21 21h-6v-2h4v-4h2v6z" /></svg>}
          </button>
        )}
      </div>
    </div>
  );
}
