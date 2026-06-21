/**
 * marketHours.js — trading-session calendar for exchange-bound instruments.
 *
 * Crypto/forex on this platform trade 24/7, but NSE/BSE/MCX have fixed daily
 * sessions + holidays. This service answers "is <exchange> open at time T?"
 * so order placement can be gated and the UI can show OPEN / PRE-OPEN / CLOSED.
 *
 * Times are IST (Asia/Kolkata). Server timezone is irrelevant — IST components
 * are derived via Intl, so this is correct on a UTC EC2 box.
 *
 * Non-exchange instruments (no `exchange`, or one not in SESSIONS) are treated
 * as always-open (24/7), preserving today's crypto behaviour.
 */

// Session windows per exchange, as IST minutes-from-midnight.
//   NSE/BSE equity: pre-open 09:00–09:15, continuous 09:15–15:30
//   MCX commodities: 09:00–23:30 (evening session)
const SESSIONS = {
  NSE: { preOpen: 9 * 60, open: 9 * 60 + 15, close: 15 * 60 + 30 },
  BSE: { preOpen: 9 * 60, open: 9 * 60 + 15, close: 15 * 60 + 30 },
  NFO: { preOpen: 9 * 60, open: 9 * 60 + 15, close: 15 * 60 + 30 }, // NSE F&O — same hours
  BFO: { preOpen: 9 * 60, open: 9 * 60 + 15, close: 15 * 60 + 30 }, // BSE F&O
  MCX: { preOpen: 8 * 60 + 45, open: 9 * 60, close: 23 * 60 + 30 },
};

// Equity-segment trading holidays (full-day), as IST 'YYYY-MM-DD'.
// ⚠️ VERIFY + UPDATE yearly against the OFFICIAL NSE/BSE holiday circular.
// Fixed-date holidays are reliable; movable festival dates (Holi, Eid, Diwali,
// etc.) MUST be confirmed each year — the ones below are best-effort and
// flagged. Weekends are handled automatically (not listed here).
const HOLIDAYS = {
  2026: [
    '2026-01-26', // Republic Day            (fixed)
    '2026-03-04', // Holi                     (verify)
    '2026-03-21', // Eid-Ul-Fitr             (verify)
    '2026-04-03', // Good Friday             (verify)
    '2026-04-14', // Dr. Ambedkar Jayanti    (verify)
    '2026-05-01', // Maharashtra Day          (verify)
    '2026-08-15', // Independence Day         (fixed)
    '2026-10-02', // Gandhi Jayanti           (fixed)
    '2026-10-20', // Dussehra                 (verify)
    '2026-11-09', // Diwali / Laxmi Pujan     (verify — Muhurat session separate)
    '2026-12-25', // Christmas                (fixed)
  ],
};

const _istFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
});

const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Break a Date into IST { dateStr, minutes, weekday, year }.
function _istParts(at = new Date()) {
  const p = {};
  for (const part of _istFmt.formatToParts(at)) p[part.type] = part.value;
  let hour = Number(p.hour);
  if (hour === 24) hour = 0; // some envs render midnight as 24
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    minutes: hour * 60 + Number(p.minute),
    weekday: _WD[p.weekday],
    year: Number(p.year),
  };
}

const _hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Is the given IST date a full-day holiday for this exchange? */
function isHoliday(dateStr, year) {
  const list = HOLIDAYS[year] || [];
  return list.includes(dateStr);
}

/**
 * Session state for an exchange at a moment.
 * @returns {{ exchange, state, isOpen, opensAt, closesAt, reason }}
 *   state: 'OPEN' | 'PRE_OPEN' | 'CLOSED' | 'HOLIDAY' | 'WEEKEND' | 'ALWAYS_OPEN'
 */
function getSession(exchange, at = new Date()) {
  const s = SESSIONS[exchange];
  if (!s) return { exchange: exchange || null, state: 'ALWAYS_OPEN', isOpen: true, opensAt: null, closesAt: null, reason: '24/7' };

  const { dateStr, minutes, weekday, year } = _istParts(at);
  const base = { exchange, opensAt: _hhmm(s.open), closesAt: _hhmm(s.close), tz: 'IST' };

  if (weekday === 0 || weekday === 6) return { ...base, state: 'WEEKEND', isOpen: false, reason: 'weekend' };
  if (isHoliday(dateStr, year))        return { ...base, state: 'HOLIDAY', isOpen: false, reason: 'exchange holiday' };
  if (minutes >= s.open && minutes < s.close) return { ...base, state: 'OPEN', isOpen: true, reason: 'continuous session' };
  if (s.preOpen != null && minutes >= s.preOpen && minutes < s.open)
    return { ...base, state: 'PRE_OPEN', isOpen: false, reason: 'pre-open session' };
  return { ...base, state: 'CLOSED', isOpen: false, reason: minutes < s.open ? 'before open' : 'after close' };
}

/** Quick boolean: is this exchange tradeable right now (continuous session)? */
function isExchangeOpen(exchange, at = new Date()) {
  return getSession(exchange, at).isOpen;
}

/**
 * Category-based session for non-exchange instruments (UTC). Mirrors the
 * client (utils/marketSession.js):
 *   CRYPTO → 24/7
 *   FOREX / COMMODITY / INDEX (CFD) → Sun 22:00 UTC → Fri 22:00 UTC
 *   anything else → open (no schedule known)
 */
function getCategorySession(category, at = new Date()) {
  const cat = String(category || '').toUpperCase();
  if (cat === 'CRYPTO') return { state: 'ALWAYS_OPEN', isOpen: true, opensAt: null, closesAt: null, reason: '24/7', tz: 'UTC' };
  if (cat === 'FOREX' || cat === 'COMMODITY' || cat === 'INDEX') {
    const day = at.getUTCDay();                       // 0=Sun .. 6=Sat
    const mins = at.getUTCHours() * 60 + at.getUTCMinutes();
    const open = 22 * 60;                             // 22:00 UTC
    const win = { opensAt: 'Sun 22:00', closesAt: 'Fri 22:00', tz: 'UTC' };
    let reason = null;
    if (day === 6) reason = 'weekend';
    else if (day === 0 && mins < open) reason = 'opens Sun 22:00 UTC';
    else if (day === 5 && mins >= open) reason = 're-opens Sun 22:00 UTC';
    return reason
      ? { ...win, state: 'CLOSED', isOpen: false, reason }
      : { ...win, state: 'OPEN', isOpen: true, reason: 'fx session' };
  }
  return { state: 'ALWAYS_OPEN', isOpen: true, opensAt: null, closesAt: null, reason: '24/7', tz: 'UTC' };
}

/**
 * Instrument-level gate.
 *   Exchange-bound (NSE/BSE/NFO/BFO/MCX) → exchange session (IST).
 *   Else dispatch by category → forex/commodity/index weekend-close, crypto 24/7.
 */
function isInstrumentTradeable(instrument, at = new Date()) {
  const exch = instrument && instrument.exchange;
  if (exch && SESSIONS[exch]) {
    const session = getSession(exch, at);
    return { tradeable: session.isOpen, session };
  }
  const session = getCategorySession(instrument && instrument.category, at);
  return { tradeable: session.isOpen, session };
}

module.exports = {
  SESSIONS,
  HOLIDAYS,
  getSession,
  getCategorySession,
  isExchangeOpen,
  isInstrumentTradeable,
  isHoliday,
  _istParts, // exported for tests
};

// Tiny self-check: `node src/services/marketHours.js`
if (require.main === module) {
  const now = new Date();
  console.log('IST now:', _istParts(now));
  for (const ex of ['NSE', 'BSE', 'MCX', 'CRYPTO']) console.log(ex, '→', getSession(ex, now));
}
