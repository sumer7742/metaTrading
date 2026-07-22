/**
 * Shared date-range helper — the SINGLE source of truth for turning a user's
 * "From date / To date" selection into an INCLUSIVE MongoDB range filter.
 *
 * The bug this fixes:
 *   `{ $lte: new Date('2026-07-22') }` is midnight (00:00:00), so selecting the
 *   SAME date for From and To returned nothing — data only appeared when To was
 *   pushed to the next day. The end bound was excluding the whole selected day.
 *
 * The fix — a half-open interval on LOCAL calendar days:
 *   createdAt >= startOfDay(from)   AND   createdAt < startOfNextDay(to)
 * which includes the ENTIRE `to` day (00:00:00.000 → 23:59:59.999) and makes
 * From == To return every record from that day.
 *
 * Timezone: date-only strings ('YYYY-MM-DD') are interpreted as server-LOCAL
 * calendar days — consistent with the platform's existing `.setHours(...)`
 * behaviour and correct when the server runs in the business timezone. Full
 * Date/ISO inputs are snapped to their local day. (For true per-user timezones
 * the client would need to send a UTC offset; server-local is the standard and
 * matches how the rest of the app already computes day boundaries.)
 *
 * Returns `null` when NEITHER bound is provided, so callers can apply it
 * conditionally without changing "All Time" behaviour or breaking pagination.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Local midnight (00:00:00.000) of the calendar day represented by `value`.
 * Accepts 'YYYY-MM-DD', an ISO string, a Date, or a ms timestamp. Returns a
 * Date, or null for empty/invalid input.
 */
function localDayStart(value) {
  if (value == null || value === '') return null;
  // Pure calendar-day string → build LOCAL midnight directly. (Using
  // `new Date('2026-07-22')` would parse as UTC midnight and drift by the tz
  // offset, which is exactly what caused the off-by-a-day filtering.)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    const [y, mo, d] = value.trim().split('-').map(Number);
    return new Date(y, mo - 1, d, 0, 0, 0, 0);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Local start of the day AFTER `value` — the exclusive upper bound. */
function nextDayStart(value) {
  const start = localDayStart(value);
  return start ? new Date(start.getTime() + DAY_MS) : null;
}

/**
 * Local END of the day (23:59:59.999) for `value` — the INCLUSIVE upper bound,
 * for the handful of call sites that resolve a { start, end } pair used later
 * with `$lte: end` (rather than the half-open `$lt` form). Prefer
 * dateRangeFilter/applyDateRange for new code.
 */
function endOfDay(value) {
  const start = localDayStart(value);
  return start ? new Date(start.getTime() + DAY_MS - 1) : null;
}

/**
 * Build an inclusive Mongo range operator object for a date field:
 *   { $gte: startOfDay(from), $lt: startOfNextDay(to) }
 * Either bound may be omitted. Returns null when both are absent so the caller
 * can skip applying any date filter (→ "All Time").
 *
 * @param {string|Date|number} from  inclusive lower bound (start of that day)
 * @param {string|Date|number} to    inclusive upper bound (END of that day)
 * @returns {{ $gte?: Date, $lt?: Date } | null}
 */
function dateRangeFilter(from, to) {
  const gte = localDayStart(from);
  const lt = nextDayStart(to);
  const op = {};
  if (gte) op.$gte = gte;
  if (lt) op.$lt = lt;
  return Object.keys(op).length ? op : null;
}

/**
 * Assign an inclusive date range onto `target[field]` when either bound is set,
 * and return `target`. No-op (leaves the field untouched) when neither is set.
 *
 *   applyDateRange(match, 'closedAt', req.query.from, req.query.to);
 */
function applyDateRange(target, field, from, to) {
  const op = dateRangeFilter(from, to);
  if (op) target[field] = op;
  return target;
}

/**
 * Precise DATE+TIME range, for endpoints whose client sends full ISO datetimes
 * (e.g. an audit log with a date+time picker). Honors the exact instants with
 * an INCLUSIVE upper bound (`$lte`). A bare 'YYYY-MM-DD' bound still snaps to
 * the whole local day (start-of-day → end-of-day) so From==To works there too.
 * Returns `{ $gte?, $lte? }` or null.
 */
function dateTimeRangeFilter(from, to) {
  const op = {};
  if (from != null && from !== '') {
    const f = (typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from.trim())) ? localDayStart(from) : new Date(from);
    if (f && !Number.isNaN(f.getTime())) op.$gte = f;
  }
  if (to != null && to !== '') {
    const t = (typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to.trim())) ? endOfDay(to) : new Date(to);
    if (t && !Number.isNaN(t.getTime())) op.$lte = t;
  }
  return Object.keys(op).length ? op : null;
}

/** applyDateRange sibling using precise date+time bounds (see dateTimeRangeFilter). */
function applyDateTimeRange(target, field, from, to) {
  const op = dateTimeRangeFilter(from, to);
  if (op) target[field] = op;
  return target;
}

/**
 * Resolve a named preset into a { from, to } pair of Date objects (day-aligned,
 * `to` = end of that day via the exclusive upper bound is applied by
 * dateRangeFilter). Presets: today, yesterday, 7d/last7, 30d, 90d, week/thismonth,
 * month, quarter/3m, 6m, year/1y, all. Unknown / 'all' → { from: null, to: null }.
 * `now` is injectable for testing.
 */
function presetRange(preset, now = new Date()) {
  const p = String(preset || '').toLowerCase();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const daysAgo = (n) => new Date(todayStart.getTime() - n * DAY_MS);
  const to = todayStart; // callers pass this to dateRangeFilter which extends it to end-of-today
  switch (p) {
    case 'today':                 return { from: todayStart, to };
    case 'yesterday':             return { from: daysAgo(1), to: daysAgo(1) };
    case '7d': case 'last7': case 'last7days':   return { from: daysAgo(6), to };
    case '30d': case 'last30': case 'last30days': return { from: daysAgo(29), to };
    case '90d': case 'last90': case 'last90days': return { from: daysAgo(89), to };
    case '3m': case 'quarter':    { const f = new Date(todayStart); f.setMonth(f.getMonth() - 3); return { from: f, to }; }
    case '6m':                    { const f = new Date(todayStart); f.setMonth(f.getMonth() - 6); return { from: f, to }; }
    case 'week': case 'thisweek': { const f = new Date(todayStart); f.setDate(f.getDate() - ((f.getDay() + 6) % 7)); return { from: f, to }; }
    case 'month': case 'thismonth': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to };
    case 'year': case '1y': case 'thisyear': return { from: new Date(now.getFullYear(), 0, 1), to };
    case 'all': case '': default: return { from: null, to: null };
  }
}

module.exports = { DAY_MS, localDayStart, nextDayStart, endOfDay, dateRangeFilter, applyDateRange, dateTimeRangeFilter, applyDateTimeRange, presetRange };
