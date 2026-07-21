import { useEffect, useMemo, useState } from 'react';
import {
  getCalendarEvents,
  getUpcomingEvents,
  useCalendarLive,
  formatDateShort,
  formatTimeShort,
  formatDateLong,
} from '../utils/economicCalendar';
import CountryFlag from './CountryFlag';
import { api } from '../services/api';

const IMPACT = {
  high:   { color: '#DC2626', label: 'High' },
  medium: { color: '#3B82F6', label: 'Med' }, // was amber #F59E0B — now blue per redesign
  low:    { color: '#9CA3AF', label: 'Low' },
};

const ChevR = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
);
const Bell = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
);

// Tone the "actual" number against the consensus — green if a print beat
// consensus, red if it missed. Direction depends on whether higher is good
// for the indicator (most are "higher is better" except jobless claims and
// unemployment rate). We keep this simple and just compare magnitude.
function actualColor(actual, consensus, indicator) {
  if (actual == null || consensus == null) return '#1F2937';
  const lowerBetter = /Claims|Unemployment Rate/i.test(indicator);
  const beat = lowerBetter ? actual < consensus : actual > consensus;
  return beat ? '#16A34A' : '#DC2626';
}

// ── Admin-managed config (show/hide toggle + custom events) ─────────────────
// Fetched once from /cms/economic-calendar, shared across every calendar view,
// revalidated every 5 min. Admin events are MERGED into the generated global
// schedule so both show together; enabled=false hides the whole calendar.
let _cfg = { enabled: true, events: [] };
let _cfgLoaded = false;
let _cfgInflight = null;
const _cfgListeners = new Set();
function _loadEconCfg() {
  if (_cfgInflight) return _cfgInflight;
  _cfgInflight = api.get('/cms/economic-calendar')
    .then((r) => {
      const d = r.data?.data || {};
      _cfg = { enabled: d.enabled !== false, events: Array.isArray(d.events) ? d.events : [] };
    })
    .catch(() => { /* keep defaults (enabled + no admin events) */ })
    .finally(() => { _cfgLoaded = true; _cfgInflight = null; _cfgListeners.forEach((fn) => fn(_cfg)); });
  return _cfgInflight;
}
function useEconConfig() {
  const [cfg, setCfg] = useState(_cfg);
  useEffect(() => {
    const on = (next) => setCfg(next);
    _cfgListeners.add(on);
    if (!_cfgLoaded) _loadEconCfg(); else setCfg(_cfg);
    const id = setInterval(_loadEconCfg, 5 * 60_000);
    return () => { _cfgListeners.delete(on); clearInterval(id); };
  }, []);
  return cfg;
}

// Label an admin-entered number (append the unit when present).
const _fmtAdmin = (v, unit) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  const s = Number.isFinite(n) ? (Math.abs(n) >= 1000 ? n.toLocaleString('en-US') : String(n)) : String(v);
  return unit ? `${s}${unit}` : s;
};
function _normAdminEvent(e) {
  const date = new Date(e.date);
  if (Number.isNaN(date.getTime())) return null;
  return {
    id: e.id || `adm-${e.date}-${e.event}`,
    date,
    country: e.country || '',
    currency: e.currency || '',
    impact: ['high', 'medium', 'low'].includes(e.impact) ? e.impact : 'medium',
    event: e.event || '',
    period: '',
    unit: e.unit || '',
    previous: e.previous, consensus: e.consensus, forecast: e.forecast, actual: e.actual,
    previousLabel:  _fmtAdmin(e.previous, e.unit),
    consensusLabel: _fmtAdmin(e.consensus, e.unit),
    forecastLabel:  _fmtAdmin(e.forecast, e.unit),
    actualLabel:    _fmtAdmin(e.actual, e.unit),
    __admin: true,
  };
}
// Merge admin events into the generated set, anchor around "now" (today/future
// first, past newest-first), and cap to `max` — same ordering getCalendarEvents uses.
function _mergeEvents(generated, adminEvents, now, max) {
  const admin = (adminEvents || []).map(_normAdminEvent).filter(Boolean);
  if (!admin.length) return generated;
  const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  return [...generated, ...admin]
    .sort((a, b) => {
      const aPast = a.date.getTime() < startMs, bPast = b.date.getTime() < startMs;
      if (aPast !== bPast) return aPast ? 1 : -1;
      return aPast ? b.date - a.date : a.date - b.date;
    })
    .slice(0, max);
}

function useTickingCalendar(opts) {
  // Recompute once per minute so "next event" updates as time passes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const cfg = useEconConfig();
  const calNonce = useCalendarLive();
  return useMemo(() => {
    const now = new Date();
    const generated = getCalendarEvents({ ...opts, now });
    return _mergeEvents(generated, cfg.events, now, opts?.max || 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, cfg, calNonce]);
}

/** Compact card variant — drops into the right sidebar where News used to be. */
export function EconomicCalendarCard({ max = 4 }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const cfg = useEconConfig();
  const calNonce = useCalendarLive();
  const events = useMemo(() => {
    const now = new Date();
    const generated = getUpcomingEvents(now, max * 3);
    return _mergeEvents(generated, cfg.events, now, max * 5)
      .filter((e) => e.date.getTime() >= now.getTime())
      .slice(0, max);
  }, [tick, cfg, max, calNonce]);

  if (!cfg.enabled) return null; // admin turned the calendar off
  return (
    <div className="bg-white border border-border-dark rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-text-primary">Economic Calendar</h3>

      <div className="mt-3 -mx-2">
        {events.length === 0 && (
          <div className="px-2 py-3 text-xs text-text-muted">No upcoming events.</div>
        )}
        {events.map((e) => {
          const tone = IMPACT[e.impact] || IMPACT.medium;
          return (
            <div key={e.id} className="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-bg-hover transition-colors">
              <div className="w-11 shrink-0 text-center bg-bg-card border border-border-subtle rounded-lg py-1">
                <div className="text-[9px] uppercase tracking-wider text-text-muted leading-none">
                  {e.date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}
                </div>
                <div className="text-base font-bold text-text-primary leading-tight mt-0.5">
                  {e.date.getUTCDate()}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-text-primary truncate">{e.event}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-muted">
                  <CountryFlag country={e.country} width={16} />
                  <span className="font-semibold text-text-secondary">{e.country}</span>
                  <span>· {formatTimeShort(e.date)} UTC</span>
                </div>
              </div>
              <span
                className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider shrink-0"
                style={{ background: `${tone.color}15`, color: tone.color }}
              >
                {tone.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Wide table variant — broker-style: dates as section headers with all
 * events for that day in a table beneath (Time, Country, Event, Actual,
 * Previous, Consensus, Forecast, Alert).
 */
export function EconomicCalendarSection({ max = 40 }) {
  const cfg = useEconConfig();
  const events = useTickingCalendar({ lookbackDays: 3, lookaheadDays: 14, max });

  // Group by UTC date (YYYY-MM-DD).
  const grouped = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      const key = e.date.toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return [...map.entries()];
  }, [events]);

  if (!cfg.enabled) return null; // admin turned the calendar off
  return (
    <section>
      <div className="flex items-end justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-text-primary">Economic Calendar</h2>
          <p className="text-xs text-text-secondary mt-1">
            High-impact macro events from US, EU, UK, JP and CN — actuals against consensus.
          </p>
        </div>
      </div>

      <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
        {/* Column header */}
        <div className="hidden md:grid grid-cols-12 gap-2 px-5 py-3 text-[11px] uppercase tracking-wider text-text-secondary font-bold bg-bg-card border-b border-border-dark">
          <div className="col-span-1">Time</div>
          <div className="col-span-1">Country</div>
          <div className="col-span-4">Event</div>
          <div className="col-span-1 text-right">Actual</div>
          <div className="col-span-1 text-right">Previous</div>
          <div className="col-span-1 text-right">Consensus</div>
          <div className="col-span-1 text-right">Forecast</div>
          <div className="col-span-1 text-center">Impact</div>
          <div className="col-span-1 text-right">Alert</div>
        </div>

        {events.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-text-muted">
            No upcoming events in the next 14 days.
          </div>
        )}

        {grouped.map(([key, dayEvents]) => {
          const dayDate = new Date(key + 'T00:00:00Z');
          return (
            <div key={key}>
              {/* Day header */}
              <div className="px-5 py-2.5 bg-bg-card border-y border-border-subtle">
                <div className="text-sm font-bold text-text-primary">
                  {formatDateLong(dayDate)}
                </div>
              </div>

              {/* Day rows */}
              {dayEvents.map((e) => {
                const tone = IMPACT[e.impact] || IMPACT.medium;
                const acColor = actualColor(e.actual, e.consensus, e.event);
                return (
                  <div
                    key={e.id}
                    className="grid grid-cols-12 gap-2 items-center px-5 py-3 border-b border-border-subtle last:border-b-0 hover:bg-bg-hover transition-colors text-sm"
                  >
                    {/* Time */}
                    <div className="col-span-2 md:col-span-1 font-mono text-text-primary font-semibold">
                      {formatTimeShort(e.date)}
                    </div>
                    {/* Country flag + ISO country code (US / EU / CN …) */}
                    <div className="col-span-2 md:col-span-1 flex items-center gap-1.5">
                      <CountryFlag country={e.country} width={20} />
                      <span className="text-text-primary font-bold">{e.country}</span>
                    </div>
                    {/* Event + period */}
                    <div className="col-span-8 md:col-span-4 min-w-0">
                      <div className="text-text-primary font-medium truncate">
                        {e.event}
                        <span className="ml-1.5 text-[10px] uppercase font-bold tracking-wider text-text-muted">
                          {e.period}
                        </span>
                      </div>
                    </div>
                    {/* Actual */}
                    <div className="col-span-3 md:col-span-1 text-right font-mono font-semibold" style={{ color: acColor }}>
                      {e.actualLabel || ''}
                    </div>
                    {/* Previous */}
                    <div className="col-span-3 md:col-span-1 text-right font-mono text-text-secondary">
                      {e.previousLabel}
                    </div>
                    {/* Consensus */}
                    <div className="col-span-3 md:col-span-1 text-right font-mono text-text-secondary hidden md:block">
                      {e.consensusLabel}
                    </div>
                    {/* Forecast */}
                    <div className="col-span-3 md:col-span-1 text-right font-mono text-text-secondary hidden md:block">
                      {e.forecastLabel}
                    </div>
                    {/* Impact pill */}
                    <div className="hidden md:flex col-span-1 justify-center">
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                        style={{ background: `${tone.color}15`, color: tone.color }}
                      >
                        {tone.label}
                      </span>
                    </div>
                    {/* Bell alert (visual; could wire to /alerts later) */}
                    <div className="hidden md:flex col-span-1 justify-end">
                      <button
                        type="button"
                        className="text-text-muted hover:text-primary-600 transition-colors p-1"
                        title="Set alert"
                        aria-label="Set alert for this event"
                      >
                        <Bell />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </section>
  );
}
