import { useMemo, useState } from 'react';
import { useTradeSettings } from '../../store/tradeSettings';
import {
  Toggle, Checkbox, Dropdown,
  SettingsSection, SettingsRow,
} from './SettingsControls';

/**
 * Inline Settings panel — rendered inside the same 280px sidebar area
 * as Watchlist / About / Performance / Depth / Movers. No drawer
 * overlay, no backdrop — just plain content that flex-fits the panel.
 */
export default function TradeSettingsPanel() {
  const s = useTradeSettings();
  const setVal = s.set;
  const [query, setQuery] = useState('');

  const matches = (txt) => txt.toLowerCase().includes(query.trim().toLowerCase());
  const hits = useMemo(() => {
    if (!query.trim()) return null;
    const set = new Set();
    SECTION_INDEX.forEach((sec) => {
      if (matches(sec.title) || sec.labels.some((l) => matches(l))) set.add(sec.id);
    });
    return set;
  }, [query]);
  const visible = (id) => !hits || hits.has(id);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Search */}
      <div className="px-3 py-2.5 border-b border-border-subtle shrink-0">
        <div className="relative">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-white border border-border-dark text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 transition-all"
          />
        </div>
      </div>

      {/* Scrollable body */}
      <div className="trade-settings-scroll flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {visible('chart') && (
          <SettingsSection id="chart" title="Show on Chart">
            <SettingsRow label="Signals">
              <Toggle label="Signals" checked={s.showOnChart.signals} onChange={(v) => setVal('showOnChart.signals', v)} />
            </SettingsRow>
            <SettingsRow label="HMR periods">
              <Toggle label="HMR" checked={s.showOnChart.hmr} onChange={(v) => setVal('showOnChart.hmr', v)} />
            </SettingsRow>
            <SettingsRow label="Price alerts">
              <Toggle label="Alerts" checked={s.showOnChart.alerts} onChange={(v) => setVal('showOnChart.alerts', v)} />
            </SettingsRow>
            <SettingsRow label="Open positions">
              <Toggle label="Positions" checked={s.showOnChart.positions} onChange={(v) => setVal('showOnChart.positions', v)} />
            </SettingsRow>
            <SettingsRow label="TP / SL on positions">
              <Toggle label="TP/SL" checked={s.showOnChart.tpsl} onChange={(v) => setVal('showOnChart.tpsl', v)} />
            </SettingsRow>
            <SettingsRow label="Pending orders">
              <Toggle label="Pending" checked={s.showOnChart.stopLimit} onChange={(v) => setVal('showOnChart.stopLimit', v)} />
            </SettingsRow>
            <SettingsRow label="Economic calendar">
              <Toggle label="Calendar" checked={s.showOnChart.calendar} onChange={(v) => setVal('showOnChart.calendar', v)} />
            </SettingsRow>
          </SettingsSection>
        )}

        {visible('calendar') && (
          <SettingsSection id="calendar" title="Economic Calendar Filters">
            <div className="px-3 py-3 grid grid-cols-2 gap-y-2 gap-x-3">
              <Checkbox label="High impact"   checked={s.calendarFilters.high}   onChange={(v) => setVal('calendarFilters.high', v)} />
              <Checkbox label="Medium impact" checked={s.calendarFilters.medium} onChange={(v) => setVal('calendarFilters.medium', v)} />
              <Checkbox label="Low impact"    checked={s.calendarFilters.low}    onChange={(v) => setVal('calendarFilters.low', v)} />
              <Checkbox label="Lowest impact" checked={s.calendarFilters.lowest} onChange={(v) => setVal('calendarFilters.lowest', v)} />
            </div>
          </SettingsSection>
        )}

        {visible('sound') && (
          <SettingsSection id="sound" title="Sound Effects">
            <SettingsRow label="Price alerts sound">
              <Toggle label="Alerts sound" checked={s.sounds.alerts} onChange={(v) => setVal('sounds.alerts', v)} />
            </SettingsRow>
            <SettingsRow label="TP / SL / SO closing sound">
              <Toggle label="Closing sound" checked={s.sounds.tpsl} onChange={(v) => setVal('sounds.tpsl', v)} />
            </SettingsRow>
          </SettingsSection>
        )}

        {visible('trading') && (
          <SettingsSection id="trading" title="Trading Settings">
            <SettingsRow label="Open order mode">
              <Dropdown
                label="Open order mode"
                value={s.trading.openOrderMode}
                onChange={(v) => setVal('trading.openOrderMode', v)}
                options={[
                  { value: 'regular',   label: 'Regular form' },
                  { value: 'oneClick',  label: 'One-click form' },
                  { value: 'riskCalc',  label: 'Risk calculator' },
                ]}
              />
            </SettingsRow>
            <SettingsRow label="Price source">
              <Dropdown
                label="Price source"
                value={s.trading.priceSource}
                onChange={(v) => setVal('trading.priceSource', v)}
                options={[
                  { value: 'bid', label: 'Bid' },
                  { value: 'ask', label: 'Ask' },
                  { value: 'mid', label: 'Mid Price' },
                ]}
              />
            </SettingsRow>
            <SettingsRow label="Appearance">
              <Dropdown
                label="Appearance"
                value={s.trading.appearance}
                onChange={(v) => setVal('trading.appearance', v)}
                options={[
                  { value: 'light',  label: 'Light' },
                  { value: 'dark',   label: 'Dark' },
                  { value: 'system', label: 'System' },
                ]}
              />
            </SettingsRow>
            <SettingsRow label="Time zone">
              <Dropdown
                label="Time zone"
                value={s.trading.timeZone}
                onChange={(v) => setVal('trading.timeZone', v)}
                options={[
                  { value: 'utc',   label: 'UTC' },
                  { value: 'gmt',   label: 'GMT' },
                  { value: 'local', label: 'Local Time' },
                ]}
              />
            </SettingsRow>
          </SettingsSection>
        )}

        {visible('auto') && (
          <SettingsSection id="auto" title="Auto Trading Preferences">
            <SettingsRow label="Set TP/SL automatically">
              <Toggle label="Auto TP/SL" checked={s.autoTrading.autoTpSl} onChange={(v) => setVal('autoTrading.autoTpSl', v)} />
            </SettingsRow>
            <SettingsRow label="Confirm before order">
              <Toggle label="Confirm" checked={s.autoTrading.confirmOrder} onChange={(v) => setVal('autoTrading.confirmOrder', v)} />
            </SettingsRow>
            <SettingsRow label="Enable one-click trading">
              <Toggle label="One-click" checked={s.autoTrading.oneClick} onChange={(v) => setVal('autoTrading.oneClick', v)} />
            </SettingsRow>
            <SettingsRow label="Auto save chart layout">
              <Toggle label="Save layout" checked={s.autoTrading.autoSaveLayout} onChange={(v) => setVal('autoTrading.autoSaveLayout', v)} />
            </SettingsRow>
          </SettingsSection>
        )}

        {hits && hits.size === 0 && (
          <div className="text-center py-8">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <p className="mt-2 text-[11px] text-text-muted">No settings match "{query}"</p>
            <button onClick={() => setQuery('')} className="mt-1 text-[10px] font-semibold text-primary-600 hover:underline">Clear search</button>
          </div>
        )}
      </div>

      {/* Sticky footer — Reset */}
      <div className="border-t border-border-subtle px-3 py-2 shrink-0 flex items-center justify-between gap-2 bg-bg-hover/30">
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Reset all trading settings to defaults?')) s.reset();
          }}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-dark text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-[11px] font-semibold"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
          Reset all
        </button>
        <span className="text-[9px] text-text-muted">Auto-saved</span>
      </div>

      <style>{`
        .trade-settings-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgba(148,163,184,0.5) transparent;
        }
        .trade-settings-scroll::-webkit-scrollbar { width: 4px; }
        .trade-settings-scroll::-webkit-scrollbar-track { background: transparent; }
        .trade-settings-scroll::-webkit-scrollbar-thumb {
          background: rgba(148,163,184,0.45);
          border-radius: 9999px;
        }
        .trade-settings-scroll::-webkit-scrollbar-thumb:hover {
          background: rgba(100,116,139,0.7);
        }
      `}</style>
    </div>
  );
}

const SECTION_INDEX = [
  { id: 'chart',    title: 'Show on Chart',              labels: ['Signals', 'HMR periods', 'Price alerts', 'Open positions', 'TP / SL on positions', 'Pending orders', 'Economic calendar'] },
  { id: 'calendar', title: 'Economic Calendar Filters',  labels: ['High impact', 'Medium impact', 'Low impact', 'Lowest impact'] },
  { id: 'sound',    title: 'Sound Effects',              labels: ['Price alerts sound', 'TP / SL / SO closing sound'] },
  { id: 'trading',  title: 'Trading Settings',           labels: ['Open order mode', 'Regular form', 'One-click form', 'Risk calculator', 'Price source', 'Bid', 'Ask', 'Mid Price', 'Appearance', 'Light', 'Dark', 'System', 'Time zone', 'UTC', 'GMT', 'Local Time'] },
  { id: 'auto',     title: 'Auto Trading Preferences',   labels: ['Set TP/SL automatically', 'Confirm before order', 'Enable one-click trading', 'Auto save chart layout'] },
];
