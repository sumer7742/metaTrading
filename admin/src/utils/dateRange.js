/**
 * Shared FRONTEND date-range helper — mirrors backend/src/utils/dateRange.js.
 *
 * Fixes the "From == To returns nothing" bug: the end date must include the
 * WHOLE selected day. We use a half-open interval on local calendar days:
 *   value >= startOfDay(from)   AND   value < startOfNextDay(to)
 *
 * Use `matchesDateRange` for client-side filtering, `presetRange` to turn a
 * preset key into {from,to}, and `toDateInput` to format a Date for
 * <input type="date"> / API params (always send 'YYYY-MM-DD').
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Local midnight of the calendar day for `value` ('YYYY-MM-DD' | Date | ISO). */
export function dayStart(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [y, m, d] = value.trim().split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0);
  }
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Local start of the day AFTER `value` — the exclusive upper bound. */
export function nextDayStart(value) {
  const s = dayStart(value);
  return s ? new Date(s.getTime() + DAY_MS) : null;
}

/** Inclusive predicate: is `value` within [startOfDay(from), startOfNextDay(to)) ? */
export function inCustomRange(value, from, to) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return false;
  const s = dayStart(from);
  if (s && t < s.getTime()) return false;
  const e = nextDayStart(to);
  if (e && t >= e.getTime()) return false;
  return true;
}

/** Resolve a preset key → { from: Date|null, to: Date|null } (day-aligned). */
export function presetRange(range, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const ago = (n) => new Date(today.getTime() - n * DAY_MS);
  switch (String(range || '').toLowerCase()) {
    case 'today': return { from: today, to: today };
    case 'yesterday': return { from: ago(1), to: ago(1) };
    case '7d': case 'last7': return { from: ago(6), to: today };
    case '30d': case 'last30': return { from: ago(29), to: today };
    case '90d': case 'last90': return { from: ago(89), to: today };
    case '3m': { const f = new Date(today); f.setMonth(f.getMonth() - 3); return { from: f, to: today }; }
    case '6m': { const f = new Date(today); f.setMonth(f.getMonth() - 6); return { from: f, to: today }; }
    case '1y': { const f = new Date(today); f.setFullYear(f.getFullYear() - 1); return { from: f, to: today }; }
    case 'week': case 'thisweek': { const f = new Date(today); f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return { from: f, to: today }; }
    case 'month': case 'thismonth': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: today };
    case 'year': case 'thisyear': return { from: new Date(now.getFullYear(), 0, 1), to: today };
    case 'all': case '': default: return { from: null, to: null };
  }
}

/**
 * Full predicate for a named range OR a custom {from,to}. Drop-in replacement
 * for ad-hoc `inDateRange` functions.
 *   matchesDateRange(row.createdAt, 'today')
 *   matchesDateRange(row.createdAt, 'custom', { from, to })
 */
export function matchesDateRange(value, range, custom) {
  const r = String(range || 'all').toLowerCase();
  if (r === 'all') {
    if (custom && (custom.from || custom.to)) return inCustomRange(value, custom.from, custom.to);
    return true;
  }
  if (r === 'custom') return inCustomRange(value, custom?.from, custom?.to);
  const { from, to } = presetRange(r);
  return inCustomRange(value, from, to);
}

/** Format a Date/'YYYY-MM-DD'/ISO → 'YYYY-MM-DD' (local) for date inputs + API params. */
export function toDateInput(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
