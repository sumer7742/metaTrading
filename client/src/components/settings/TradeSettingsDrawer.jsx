import { useEffect, useMemo, useState } from 'react';
import { useTradeSettings } from '../../store/tradeSettings';
import {
  Toggle, Checkbox, Dropdown,
  SettingsSection, SettingsRow,
} from './SettingsControls';

/**
 * Right-side sliding Trade Settings drawer.
 *
 * Behavior:
 *   - Slide-in from the right with Tailwind transition
 *   - Backdrop blur + dim
 *   - Closes on: ESC key, backdrop click, close button
 *   - Body scroll-locked while open
 *   - Sticky search bar + footer (Reset)
 *   - Mobile responsive (full width on small screens, 420px on lg)
 */
export default function TradeSettingsDrawer() {
  const s = useTradeSettings();
  const open = s.drawerOpen;
  const close = s.closeDrawer;
  const setVal = s.set;
  const [query, setQuery] = useState('');

  // ── ESC + body scroll lock ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  // ── Section visibility based on search query ────────────────────
  // Empty query → show all. Otherwise filter section titles + row labels
  // (case-insensitive substring match).
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

  // Always render the JSX shell so close-transition can animate.
  return (
    <>
      {/* Backdrop — blur + dim, click to close */}
      <div
        onClick={close}
        aria-hidden={!open}
        className={`fixed inset-0 z-40 transition-all duration-300 ${
          open
            ? 'bg-black/30 backdrop-blur-sm pointer-events-auto'
            : 'bg-black/0 backdrop-blur-0 pointer-events-none'
        }`}
      />

      {/* Drawer panel — slides in from right */}
      <aside
        role="dialog"
        aria-label="Trading settings"
        aria-modal="true"
        className={`fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[420px] bg-bg-card border-l border-border-dark shadow-2xl flex flex-col transform transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="px-5 py-4 border-b border-border-dark flex items-center justify-between shrink-0 bg-white/60 backdrop-blur-sm">
          <div>
            <h2 className="text-sm font-bold text-text-primary tracking-tight">Trading Settings</h2>
            <p className="text-[10px] text-text-muted mt-0.5">Personalise your terminal</p>
          </div>
          <button
            type="button"
            onClick={close}
            title="Close (Esc)"
            aria-label="Close settings"
            className="w-8 h-8 rounded-full bg-bg-hover hover:bg-border-dark/40 flex items-center justify-center text-text-secondary hover:text-text-primary transition-all hover:rotate-90 duration-300"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>

        {/* ── Search ─────────────────────────────────────────────── */}
        <div className="px-5 py-3 border-b border-border-subtle shrink-0">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-white border border-border-dark text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 transition-all"
            />
          </div>
        </div>

        {/* ── Body (scrollable) ──────────────────────────────────── */}
        <div className="trade-settings-scroll flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* 1. Show on Chart */}
          {visible('chart') && (
            <SettingsSection id="chart" title="Show on Chart">
              <SettingsRow label="Signals" desc="Trade signal overlays from indicators">
                <Toggle label="Signals" checked={s.showOnChart.signals} onChange={(v) => setVal('showOnChart.signals', v)} />
              </SettingsRow>
              <SettingsRow label="HMR periods" desc="High-momentum reversal zones">
                <Toggle label="HMR" checked={s.showOnChart.hmr} onChange={(v) => setVal('showOnChart.hmr', v)} />
              </SettingsRow>
              <SettingsRow label="Price alerts" desc="Lines for your active alerts">
                <Toggle label="Alerts" checked={s.showOnChart.alerts} onChange={(v) => setVal('showOnChart.alerts', v)} />
              </SettingsRow>
              <SettingsRow label="Open positions" desc="Entry / mark / SL / TP">
                <Toggle label="Positions" checked={s.showOnChart.positions} onChange={(v) => setVal('showOnChart.positions', v)} />
              </SettingsRow>
              <SettingsRow label="TP / SL / Stop / Limit" desc="Pending order overlays">
                <Toggle label="TP/SL/Stop/Limit" checked={s.showOnChart.tpsl} onChange={(v) => setVal('showOnChart.tpsl', v)} />
              </SettingsRow>
              <SettingsRow label="Economic calendar" desc="Major events on the time axis">
                <Toggle label="Calendar" checked={s.showOnChart.calendar} onChange={(v) => setVal('showOnChart.calendar', v)} />
              </SettingsRow>
            </SettingsSection>
          )}

          {/* 2. Economic Calendar Filters */}
          {visible('calendar') && (
            <SettingsSection id="calendar" title="Economic Calendar Filters">
              <div className="px-3.5 py-3 grid grid-cols-2 gap-y-2 gap-x-3">
                <Checkbox label="High impact"   checked={s.calendarFilters.high}   onChange={(v) => setVal('calendarFilters.high', v)} />
                <Checkbox label="Medium impact" checked={s.calendarFilters.medium} onChange={(v) => setVal('calendarFilters.medium', v)} />
                <Checkbox label="Low impact"    checked={s.calendarFilters.low}    onChange={(v) => setVal('calendarFilters.low', v)} />
                <Checkbox label="Lowest impact" checked={s.calendarFilters.lowest} onChange={(v) => setVal('calendarFilters.lowest', v)} />
              </div>
            </SettingsSection>
          )}

          {/* 3. Sound Effects */}
          {visible('sound') && (
            <SettingsSection id="sound" title="Sound Effects">
              <SettingsRow label="Price alerts sound" desc="Ding when an alert triggers">
                <Toggle label="Alerts sound" checked={s.sounds.alerts} onChange={(v) => setVal('sounds.alerts', v)} />
              </SettingsRow>
              <SettingsRow label="TP / SL / SO closing sound" desc="Chime on position close">
                <Toggle label="Closing sound" checked={s.sounds.tpsl} onChange={(v) => setVal('sounds.tpsl', v)} />
              </SettingsRow>
            </SettingsSection>
          )}

          {/* 4. Trading Settings */}
          {visible('trading') && (
            <SettingsSection id="trading" title="Trading Settings">
              <SettingsRow label="Open order mode" desc="Default order panel layout">
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
              <SettingsRow label="Price source" desc="Reference for live PnL & charts">
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
              <SettingsRow label="Appearance" desc="Light, dark or follow system">
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
              <SettingsRow label="Time zone" desc="Used across charts & timestamps">
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

          {/* 5. Auto Trading Preferences */}
          {visible('auto') && (
            <SettingsSection id="auto" title="Auto Trading Preferences">
              <SettingsRow label="Set TP/SL automatically" desc="Suggest values based on volatility">
                <Toggle label="Auto TP/SL" checked={s.autoTrading.autoTpSl} onChange={(v) => setVal('autoTrading.autoTpSl', v)} />
              </SettingsRow>
              <SettingsRow label="Confirm before order" desc="Show a confirmation step on submit">
                <Toggle label="Confirm" checked={s.autoTrading.confirmOrder} onChange={(v) => setVal('autoTrading.confirmOrder', v)} />
              </SettingsRow>
              <SettingsRow label="Enable one-click trading" desc="Skip the confirmation overlay">
                <Toggle label="One-click" checked={s.autoTrading.oneClick} onChange={(v) => setVal('autoTrading.oneClick', v)} />
              </SettingsRow>
              <SettingsRow label="Auto save chart layout" desc="Persist indicators + drawings across sessions">
                <Toggle label="Save layout" checked={s.autoTrading.autoSaveLayout} onChange={(v) => setVal('autoTrading.autoSaveLayout', v)} />
              </SettingsRow>
            </SettingsSection>
          )}

          {/* Empty-state — search didn't match anything */}
          {hits && hits.size === 0 && (
            <div className="text-center py-10">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <p className="mt-3 text-xs text-text-muted">No settings match "{query}"</p>
              <button onClick={() => setQuery('')} className="mt-2 text-[11px] font-semibold text-primary-600 hover:underline">Clear search</button>
            </div>
          )}
        </div>

        {/* ── Sticky footer ──────────────────────────────────────── */}
        <div className="border-t border-border-dark px-5 py-3 flex items-center justify-between gap-3 bg-white/60 backdrop-blur-sm shrink-0">
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Reset all trading settings to defaults?')) s.reset();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border-dark text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-xs font-semibold"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
            Reset all
          </button>
          <div className="text-[10px] text-text-muted">
            Saved · <kbd className="px-1 py-0.5 rounded border border-border-dark bg-bg-hover font-mono">Esc</kbd> to close
          </div>
        </div>

        {/* Custom thin scrollbar */}
        <style>{`
          .trade-settings-scroll {
            scrollbar-width: thin;
            scrollbar-color: rgba(148,163,184,0.5) transparent;
          }
          .trade-settings-scroll::-webkit-scrollbar { width: 5px; }
          .trade-settings-scroll::-webkit-scrollbar-track { background: transparent; }
          .trade-settings-scroll::-webkit-scrollbar-thumb {
            background: rgba(148,163,184,0.45);
            border-radius: 9999px;
          }
          .trade-settings-scroll::-webkit-scrollbar-thumb:hover {
            background: rgba(100,116,139,0.7);
          }
        `}</style>
      </aside>
    </>
  );
}

// ─── Search index ───────────────────────────────────────────────────
// Cheap flat index for the search bar — matches against section titles +
// individual row labels. Keep this in sync with the JSX above.
const SECTION_INDEX = [
  { id: 'chart',    title: 'Show on Chart',              labels: ['Signals', 'HMR periods', 'Price alerts', 'Open positions', 'TP / SL / Stop / Limit', 'Economic calendar'] },
  { id: 'calendar', title: 'Economic Calendar Filters',  labels: ['High impact', 'Medium impact', 'Low impact', 'Lowest impact'] },
  { id: 'sound',    title: 'Sound Effects',              labels: ['Price alerts sound', 'TP / SL / SO closing sound'] },
  { id: 'trading',  title: 'Trading Settings',           labels: ['Open order mode', 'Regular form', 'One-click form', 'Risk calculator', 'Price source', 'Bid', 'Ask', 'Mid Price', 'Appearance', 'Light', 'Dark', 'System', 'Time zone', 'UTC', 'GMT', 'Local Time'] },
  { id: 'auto',     title: 'Auto Trading Preferences',   labels: ['Set TP/SL automatically', 'Confirm before order', 'Enable one-click trading', 'Auto save chart layout'] },
];
