/**
 * Lightweight market-session detection used by sidebar panels to decide
 * whether to show "Market Closed" vs live data.
 *
 * The schedules are approximate (don't account for holidays or DST nuances) —
 * for a production-grade implementation you'd consult an external calendar
 * provider. The current implementation is good enough for the panel UX.
 *
 * Returns: { isOpen, label, nextOpenLabel? }
 */

const TZ_UTC = 'UTC';

const getUtc = () => {
  const d = new Date();
  return {
    day: d.getUTCDay(),       // 0=Sun ... 6=Sat
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
};

// ── CRYPTO — always open
const cryptoSession = () => ({ isOpen: true, label: 'Open 24/7', tz: TZ_UTC });

// ── FOREX — Sunday 22:00 UTC → Friday 22:00 UTC (NY close)
const forexSession = () => {
  const { day, hour } = getUtc();
  // Saturday entire day → closed
  if (day === 6) return { isOpen: false, label: 'Market Closed', detail: 'Forex re-opens Sunday 22:00 UTC', tz: TZ_UTC };
  // Sunday before 22:00 → closed
  if (day === 0 && hour < 22) return { isOpen: false, label: 'Market Closed', detail: 'Opens at 22:00 UTC', tz: TZ_UTC };
  // Friday after 22:00 → closed
  if (day === 5 && hour >= 22) return { isOpen: false, label: 'Market Closed', detail: 'Re-opens Sunday 22:00 UTC', tz: TZ_UTC };
  return { isOpen: true, label: 'Forex session open', tz: TZ_UTC };
};

// ── STOCKS / US equities — Mon-Fri 13:30-20:00 UTC (= 09:30-16:00 ET)
//   (ignores DST shifts, holidays — close enough for UI)
const stockSession = () => {
  const { day, hour, minute } = getUtc();
  if (day === 0 || day === 6) return { isOpen: false, label: 'Market Closed', detail: 'Stocks closed on weekends', tz: TZ_UTC };
  const mins = hour * 60 + minute;
  const open = 13 * 60 + 30;   // 13:30 UTC
  const close = 20 * 60;       // 20:00 UTC
  if (mins < open) return { isOpen: false, label: 'Pre-market', detail: 'Regular session opens 13:30 UTC', tz: TZ_UTC };
  if (mins >= close) return { isOpen: false, label: 'After-hours', detail: 'Regular session closes 20:00 UTC', tz: TZ_UTC };
  return { isOpen: true, label: 'NYSE / NASDAQ open', tz: TZ_UTC };
};

// ── COMMODITIES — most CFD commodity desks follow Sun 22-Fri 22 UTC like forex
const commoditySession = () => {
  const fx = forexSession();
  return fx.isOpen
    ? { isOpen: true, label: 'Commodity session open', tz: TZ_UTC }
    : fx;
};

// ── NSE / BSE (Indian equity) — Mon-Fri 09:15-15:30 IST.
//   IST derived via Intl so it's correct regardless of the browser timezone.
//   (Holidays are enforced server-side; this is UI-only.)
const _istParts = () => {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const x of fmt.formatToParts(new Date())) p[x.type] = x.value;
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let h = Number(p.hour); if (h === 24) h = 0;
  return { day: WD[p.weekday], mins: h * 60 + Number(p.minute) };
};
const nseSession = () => {
  const { day, mins } = _istParts();
  if (day === 0 || day === 6) return { isOpen: false, label: 'Market Closed', detail: 'NSE closed on weekends', tz: 'IST' };
  const open = 9 * 60 + 15, close = 15 * 60 + 30;
  if (mins < open) return { isOpen: false, label: 'Pre-open', detail: 'NSE opens 09:15 IST', tz: 'IST' };
  if (mins >= close) return { isOpen: false, label: 'Market Closed', detail: 'NSE closes 15:30 IST', tz: 'IST' };
  return { isOpen: true, label: 'NSE open', tz: 'IST' };
};

// ── INDICES — index CFDs typically Mon-Fri with short overnight break
const indexSession = () => {
  const { day, hour } = getUtc();
  if (day === 0 && hour < 22) return { isOpen: false, label: 'Market Closed', detail: 'Opens Sunday 22:00 UTC', tz: TZ_UTC };
  if (day === 6) return { isOpen: false, label: 'Market Closed', detail: 'Indices closed Saturday', tz: TZ_UTC };
  // Friday after 22 = closed
  if (day === 5 && hour >= 22) return { isOpen: false, label: 'Market Closed', detail: 'Re-opens Sunday 22:00 UTC', tz: TZ_UTC };
  return { isOpen: true, label: 'Index session open', tz: TZ_UTC };
};

/**
 * Dispatch by instrument. Accepts either a category string (legacy callers) or
 * an instrument object { exchange, category }. Exchange-bound instruments
 * (NSE/BSE) use Indian session hours; everything else dispatches by category.
 * Returns { isOpen, label, detail?, tz }.
 */
export function getMarketSession(arg) {
  const exchange = (arg && typeof arg === 'object') ? String(arg.exchange || '').toUpperCase() : '';
  if (['NSE', 'BSE', 'NFO', 'BFO'].includes(exchange)) return nseSession(); // F&O follows equity hours
  const cat = String((arg && typeof arg === 'object') ? arg.category : arg || '').toUpperCase();
  switch (cat) {
    case 'CRYPTO':    return cryptoSession();
    case 'FOREX':     return forexSession();
    case 'STOCK':
    case 'STOCKS':    return stockSession();
    case 'COMMODITY': return commoditySession();
    case 'INDEX':
    case 'INDICES':   return indexSession();
    default:          return { isOpen: true, label: 'Market open', tz: TZ_UTC };
  }
}
