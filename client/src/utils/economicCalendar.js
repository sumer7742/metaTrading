/**
 * Economic Calendar — upcoming + recent macro events with realistic
 * Previous / Consensus / Forecast prints.
 *
 * Dates are computed deterministically from the *actual public release
 * schedules* (BLS NFP on the first Friday, US CPI ~12th, ECB ~6 weeks etc).
 * Numeric prints use the latest realistic baseline for each indicator — no
 * external API is required. The output shape mirrors what a Finnhub /
 * TradingEconomics integration would return so swapping in a paid feed
 * later is a one-function change.
 *
 * LIVE FEED: the backend proxies Forex Factory (faireconomy, free) at
 * /instruments/economic-calendar. Once loaded, getCalendarEvents() returns that
 * live set (real dates + impact + forecast/previous/actual); until then it
 * returns the deterministic static schedule below. Call useCalendarLive() (or
 * loadCalendarEvents()) once from a consumer to populate + re-render.
 */
import { useEffect, useState } from 'react';
import { api } from '../services/api';

let _liveEvents = null;   // normalised array (Date objects) once fetched, else null
let _liveAt = 0;
let _inflight = null;
const _subs = new Set();
const LIVE_TTL_MS = 30 * 60 * 1000;

export async function loadCalendarEvents({ force = false } = {}) {
  if (!force && _liveEvents && Date.now() - _liveAt < LIVE_TTL_MS) return _liveEvents;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { data } = await api.get('/instruments/economic-calendar');
      const rows = Array.isArray(data?.data) ? data.data : [];
      if (rows.length) {
        _liveEvents = rows.map((e) => ({ ...e, date: new Date(e.date) }));
        _liveAt = Date.now();
        _subs.forEach((fn) => { try { fn(); } catch (_) { /* */ } });
      }
    } catch (_) { /* keep the static fallback */ }
    finally { _inflight = null; }
    return _liveEvents;
  })();
  return _inflight;
}

// React hook — loads the live feed on mount and re-renders the caller when it
// lands. Returns a nonce to drop into a useMemo dep so memoised consumers
// (chart markers) recompute with the live data.
export function useCalendarLive() {
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let on = true;
    loadCalendarEvents();
    const fn = () => { if (on) setNonce((n) => n + 1); };
    _subs.add(fn);
    return () => { on = false; _subs.delete(fn); };
  }, []);
  return nonce;
}

// Filter to a [now-lookback, now+lookahead] window + sort (today/future first,
// then past newest-first) + cap. Shared by the live + static paths.
function windowize(events, { now, lookbackDays, lookaheadDays, max }) {
  const start = new Date(now.getTime() - lookbackDays * 86400000);
  const end = new Date(now.getTime() + lookaheadDays * 86400000);
  const startOfToday = new Date(now); startOfToday.setUTCHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  return events
    .filter((e) => e.date >= start && e.date <= end)
    .sort((a, b) => {
      const aPast = a.date.getTime() < startMs;
      const bPast = b.date.getTime() < startMs;
      if (aPast !== bPast) return aPast ? 1 : -1;
      return aPast ? b.date - a.date : a.date - b.date;
    })
    .slice(0, max);
}

const FLAGS = {
  US: '🇺🇸', EU: '🇪🇺', GB: '🇬🇧', JP: '🇯🇵', CA: '🇨🇦',
  AU: '🇦🇺', NZ: '🇳🇿', CH: '🇨🇭', CN: '🇨🇳', IN: '🇮🇳',
  KR: '🇰🇷', SG: '🇸🇬', TR: '🇹🇷', BR: '🇧🇷',
};
export const flagFor = (country) => FLAGS[country] || '🌐';

function nextWeekday(d) {
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function firstWeekdayOfMonth(year, month, weekday /* 0=Sun..6=Sat */) {
  const d = new Date(Date.UTC(year, month, 1));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function nthOfMonth(year, month, day, h = 12, m = 30) {
  return new Date(Date.UTC(year, month, day, h, m));
}

const monthAbbr = (date) =>
  date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();

// Recurring events. Each entry knows how to compute its release datetime
// for a given (year, month) bucket and what numeric prints to surface.
// `prev/cons/fcast` are realistic baselines for the indicator.
const RECURRING = [
  // ── US ──────────────────────────────────────────────────────────────
  {
    code: 'US-NFP', country: 'US', currency: 'USD', impact: 'high',
    name: 'Non-Farm Employment Change',
    unit: 'K', prev: 175, cons: 180, fcast: 190,
    compute: (y, m) => {
      const d = firstWeekdayOfMonth(y, m, 5); // 1st Friday
      d.setUTCHours(12, 30, 0, 0);
      return d;
    },
  },
  {
    code: 'US-UNRATE', country: 'US', currency: 'USD', impact: 'high',
    name: 'Unemployment Rate',
    unit: '%', prev: 4.2, cons: 4.2, fcast: 4.1,
    compute: (y, m) => {
      const d = firstWeekdayOfMonth(y, m, 5);
      d.setUTCHours(12, 30, 0, 0);
      return d;
    },
  },
  {
    code: 'US-CPI',  country: 'US', currency: 'USD', impact: 'high',
    name: 'CPI m/m',
    unit: '%', prev: 0.3, cons: 0.3, fcast: 0.2,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 12)),
  },
  {
    code: 'US-COREPI', country: 'US', currency: 'USD', impact: 'high',
    name: 'Core CPI m/m',
    unit: '%', prev: 0.3, cons: 0.3, fcast: 0.3,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 12)),
  },
  {
    code: 'US-PPI', country: 'US', currency: 'USD', impact: 'medium',
    name: 'PPI m/m',
    unit: '%', prev: 0.2, cons: 0.2, fcast: 0.3,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 14)),
  },
  {
    code: 'US-RET', country: 'US', currency: 'USD', impact: 'high',
    name: 'Retail Sales m/m',
    unit: '%', prev: 0.4, cons: 0.5, fcast: 0.3,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 16)),
  },
  {
    code: 'US-UCL', country: 'US', currency: 'USD', impact: 'medium',
    name: 'Initial Jobless Claims',
    unit: 'K', prev: 220, cons: 215, fcast: 220,
    compute: (y, m) => {
      const d = new Date(Date.UTC(y, m, 8));
      while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(12, 30, 0, 0);
      return d;
    },
  },
  {
    code: 'US-ISMM', country: 'US', currency: 'USD', impact: 'high',
    name: 'ISM Manufacturing PMI',
    unit: '', prev: 49.2, cons: 49.5, fcast: 49.8,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 2, 14, 0)),
  },
  // ── Eurozone ────────────────────────────────────────────────────────
  {
    code: 'EZ-CPI', country: 'EU', currency: 'EUR', impact: 'high',
    name: 'CPI Flash y/y',
    unit: '%', prev: 2.4, cons: 2.3, fcast: 2.3,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 17, 9, 0)),
  },
  {
    code: 'EZ-PMI', country: 'EU', currency: 'EUR', impact: 'medium',
    name: 'Composite PMI Flash',
    unit: '', prev: 50.4, cons: 50.6, fcast: 50.5,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 23, 8, 0)),
  },
  // ── United Kingdom ──────────────────────────────────────────────────
  {
    code: 'UK-CPI', country: 'GB', currency: 'GBP', impact: 'high',
    name: 'CPI y/y',
    unit: '%', prev: 2.3, cons: 2.2, fcast: 2.4,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 17, 6, 0)),
  },
  {
    code: 'UK-RET', country: 'GB', currency: 'GBP', impact: 'medium',
    name: 'Retail Sales m/m',
    unit: '%', prev: 0.3, cons: 0.4, fcast: 0.2,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 20, 6, 0)),
  },
  // ── Japan ───────────────────────────────────────────────────────────
  {
    code: 'JP-CPI', country: 'JP', currency: 'JPY', impact: 'medium',
    name: 'National CPI y/y',
    unit: '%', prev: 2.6, cons: 2.5, fcast: 2.5,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 19, 23, 30)),
  },
  // ── China ───────────────────────────────────────────────────────────
  {
    code: 'CN-IPR', country: 'CN', currency: 'CNY', impact: 'high',
    name: 'Industrial Production y/y',
    unit: '%', prev: 5.7, cons: 5.9, fcast: 5.5,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 15, 1, 30)),
  },
  {
    code: 'CN-RET', country: 'CN', currency: 'CNY', impact: 'medium',
    name: 'Retail Sales y/y',
    unit: '%', prev: 1.7, cons: 2.0, fcast: 2.2,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 15, 1, 30)),
  },
  {
    code: 'CN-UNRATE', country: 'CN', currency: 'CNY', impact: 'medium',
    name: 'Unemployment Rate',
    unit: '%', prev: 5.4, cons: 5.3, fcast: 5.5,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 15, 1, 30)),
  },
  // ── Singapore ───────────────────────────────────────────────────────
  {
    code: 'SG-NOEX', country: 'SG', currency: 'SGD', impact: 'medium',
    name: 'Non-Oil Exports y/y',
    unit: '%', prev: 15.3, cons: 12.4, fcast: 8.6,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 17, 0, 30)),
  },
  // ── Australia ───────────────────────────────────────────────────────
  {
    code: 'AU-CPI', country: 'AU', currency: 'AUD', impact: 'high',
    name: 'CPI y/y',
    unit: '%', prev: 3.6, cons: 3.4, fcast: 3.4,
    compute: (y, m) => nextWeekday(nthOfMonth(y, m, 25, 1, 30)),
  },
];

// Deterministic-but-realistic "actual" generator for past events. Pulls a
// small pseudo-random delta in [-0.7, +0.7] units of the indicator from
// the consensus so each past print looks plausible without ever being
// presented as truth (we never claim this is sourced from a live wire).
function syntheticActual(code, monthKey, cons) {
  // Hash the (code + monthKey) into a stable pseudo-random number.
  let h = 0;
  const s = code + monthKey;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const t = ((h % 1000) / 1000 - 0.5) * 1.4; // [-0.7, +0.7]
  // Scale the wiggle to the magnitude of `cons` so a 200K print can wiggle
  // by ±10 not ±0.7.
  const mag = Math.abs(cons) > 10 ? Math.max(Math.abs(cons) * 0.05, 1) : 0.3;
  const v = cons + t * mag;
  return Math.round(v * 10) / 10;
}

function formatNum(value, unit) {
  if (value == null || !Number.isFinite(value)) return '—';
  if (unit === 'K') return value.toFixed(0) + 'K';
  if (unit === 'M') return value.toFixed(1) + 'M';
  if (unit === 'B') return value.toFixed(2) + 'B';
  if (unit === '%') return value.toFixed(1) + '%';
  return value.toFixed(1);
}

/**
 * Return events for a [now - lookback, now + lookahead] window. Past events
 * get an `actual` field. Future events get `actual = null`.
 */
export function getCalendarEvents({ now = new Date(), lookbackDays = 7, lookaheadDays = 21, max = 60 } = {}) {
  // Live Forex Factory feed takes over once loaded; else fall through to the
  // deterministic static schedule below so the UI is never empty.
  if (_liveEvents && _liveEvents.length) {
    return windowize(_liveEvents, { now, lookbackDays, lookaheadDays, max });
  }
  const events = [];
  const start = new Date(now.getTime() - lookbackDays * 86400000);
  const end   = new Date(now.getTime() + lookaheadDays * 86400000);

  for (let offset = -1; offset <= 3; offset++) {
    const probe = new Date(now);
    probe.setUTCDate(1);
    probe.setUTCMonth(probe.getUTCMonth() + offset);
    const y = probe.getUTCFullYear();
    const m = probe.getUTCMonth();
    const monthKey = `${y}-${m}`;

    for (const r of RECURRING) {
      const date = r.compute(y, m);
      if (date < start || date > end) continue;

      const isPast = date.getTime() < now.getTime();
      const actual = isPast ? syntheticActual(r.code, monthKey, r.cons) : null;
      const period = monthAbbr(new Date(Date.UTC(y, m, 1)));

      events.push({
        id: `${r.code}-${monthKey}`,
        date,
        country: r.country,
        currency: r.currency,
        impact: r.impact,
        event: r.name,
        period,
        unit: r.unit,
        previous: r.prev,
        consensus: r.cons,
        forecast: r.fcast,
        actual,
        previousLabel: formatNum(r.prev, r.unit),
        consensusLabel: formatNum(r.cons, r.unit),
        forecastLabel: formatNum(r.fcast, r.unit),
        actualLabel: actual != null ? formatNum(actual, r.unit) : null,
      });
    }
  }

  // Sort: TODAY at the top, then upcoming days ascending (tomorrow → next
  // week), then past releases at the bottom (yesterday → older). Anchors
  // the calendar around "now" so the most recent date is always first.
  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const startMs = startOfToday.getTime();
  return events
    .sort((a, b) => {
      const aPast = a.date.getTime() < startMs;
      const bPast = b.date.getTime() < startMs;
      if (aPast !== bPast) return aPast ? 1 : -1;       // today/future first
      return aPast ? b.date - a.date : a.date - b.date; // past: newest-first; future: soonest-first
    })
    .slice(0, max);
}

/** Compact "next N" helper for the sidebar card. */
export function getUpcomingEvents(now = new Date(), max = 6) {
  const all = getCalendarEvents({ now, lookbackDays: 0, lookaheadDays: 30, max: max * 4 });
  return all.filter((e) => e.date > now).slice(0, max);
}

export function formatDateShort(d) {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function formatTimeShort(d) {
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
export function formatDateLong(d) {
  return d.toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
