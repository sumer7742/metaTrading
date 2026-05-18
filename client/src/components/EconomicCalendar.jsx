import { useEffect, useMemo, useState } from 'react';
import {
  getCalendarEvents,
  getUpcomingEvents,
  formatDateShort,
  formatTimeShort,
  formatDateLong,
} from '../utils/economicCalendar';
import CountryFlag from './CountryFlag';

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

function useTickingCalendar(opts) {
  // Recompute once per minute so "next event" updates as time passes.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => getCalendarEvents(opts), [tick]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Compact card variant — drops into the right sidebar where News used to be. */
export function EconomicCalendarCard({ max = 4 }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const events = useMemo(() => getUpcomingEvents(new Date(), max), [tick, max]);

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
