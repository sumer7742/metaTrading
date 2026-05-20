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
 * Dispatch by instrument category. Returns { isOpen, label, detail?, tz }.
 */
export function getMarketSession(category) {
  const cat = String(category || '').toUpperCase();
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
