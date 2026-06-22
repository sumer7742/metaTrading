/**
 * Curated liquid NSE cash-equity universe (~NIFTY 200 large/mid caps + active F&O
 * names). Used to keep the tradable stock list to liquid, real-price-able names
 * instead of all ~2700 listed scrips (most of which are illiquid penny stocks the
 * free Yahoo feed can't refresh fast enough).
 *
 * Symbols are NSE UNDERLYING_SYMBOL form (== Dhan scrip master, == Yahoo `<SYM>.NS`).
 * A generous superset is intentional: an extra symbol that doesn't exist in the DB
 * is simply ignored, but a liquid name omitted here would get deactivated — so when
 * in doubt, include it. Curation is reversible (isActive flag, never a delete).
 *
 * Used by: services/dhanInstrumentSync.js (sync only these in curated mode) and
 * scripts/curate-indian-equity.js (deactivate everything not listed here).
 */

const LIQUID_NSE = [
  // ── NIFTY 50 ──
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'SBIN', 'BHARTIARTL', 'ITC',
  'HINDUNILVR', 'LT', 'KOTAKBANK', 'AXISBANK', 'BAJFINANCE', 'ASIANPAINT', 'MARUTI',
  'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'WIPRO', 'ONGC', 'NTPC', 'POWERGRID',
  'M&M', 'TATAMOTORS', 'TATASTEEL', 'JSWSTEEL', 'HCLTECH', 'TECHM', 'ADANIENT',
  'ADANIPORTS', 'COALINDIA', 'BAJAJFINSV', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT',
  'DRREDDY', 'CIPLA', 'GRASIM', 'BRITANNIA', 'BPCL', 'HINDALCO', 'INDUSINDBK',
  'APOLLOHOSP', 'HDFCLIFE', 'SBILIFE', 'TATACONSUM', 'LTIM', 'SHRIRAMFIN', 'BEL', 'TRENT',

  // ── NIFTY Next 50 / large caps ──
  'DMART', 'ADANIGREEN', 'ADANIENSOL', 'ADANIPOWER', 'AMBUJACEM', 'DLF', 'BANKBARODA',
  'PNB', 'CANBK', 'IOC', 'GAIL', 'VEDL', 'SIEMENS', 'ABB', 'PIDILITIND', 'HAVELLS',
  'GODREJCP', 'DABUR', 'MARICO', 'COLPAL', 'BERGEPAINT', 'ICICIGI', 'ICICIPRULI',
  'HDFCAMC', 'SBICARD', 'CHOLAFIN', 'BAJAJHLDNG', 'LICI', 'ETERNAL', 'ZOMATO', 'NAUKRI',
  'IRCTC', 'INDIGO', 'JINDALSTEL', 'SAIL', 'TATAPOWER', 'NMDC', 'BOSCHLTD', 'MOTHERSON',
  'TVSMOTOR', 'MUTHOOTFIN', 'TORNTPHARM', 'ZYDUSLIFE', 'UNITDSPR', 'VBL', 'JUBLFOOD',
  'SRF', 'GODREJPROP', 'MAXHEALTH', 'LODHA', 'DIVISLAB',

  // ── Active F&O mid/large caps ──
  'HAL', 'BHARATFORG', 'ASHOKLEY', 'ESCORTS', 'BHEL', 'IDFCFIRSTB', 'FEDERALBNK',
  'AUBANK', 'INDHOTEL', 'OBEROIRLTY', 'PHOENIXLTD', 'POLYCAB', 'DIXON', 'KPITTECH',
  'PERSISTENT', 'COFORGE', 'MPHASIS', 'OFSS', 'LTTS', 'TATAELXSI', 'TATACOMM',
  'INDUSTOWER', 'PETRONET', 'HINDPETRO', 'IGL', 'GUJGASLTD', 'ATGL', 'PFC', 'RECLTD',
  'IRFC', 'LICHSGFIN', 'MFSL', 'MANAPPURAM', 'POONAWALLA', 'AUROPHARMA', 'LUPIN',
  'BIOCON', 'ALKEM', 'IPCALAB', 'GLENMARK', 'LAURUSLABS', 'SYNGENE', 'ABBOTINDIA',
  'MANKIND', 'MRF', 'BALKRISIND', 'APOLLOTYRE', 'EXIDEIND', 'CGPOWER', 'CUMMINSIND',
  'ABFRL', 'PAGEIND', 'PEL', 'AARTIIND', 'DEEPAKNTR', 'PIIND', 'UPL', 'GNFC',
  'COROMANDEL', 'ACC', 'DALBHARAT', 'SHREECEM', 'JKCEMENT', 'RAMCOCEM', 'APLAPOLLO',
  'ASTRAL', 'SUPREMEIND', 'CROMPTON', 'VOLTAS', 'HONAUT', 'SONACOMS', 'TIINDIA',
  'SUNDARMFIN', 'YESBANK', 'IDEA', 'GMRAIRPORT', 'SUZLON', 'RVNL', 'BDL', 'MAZDOCK',
  'COCHINSHIP', 'NHPC', 'SJVN', 'OIL', 'MGL', 'TATACHEM', 'SUNTV', 'PVRINOX', 'NYKAA',
  'POLICYBZR', 'PAYTM', 'DELHIVERY', 'KALYANKJIL', 'JIOFIN', 'HUDCO', 'IREDA', 'CDSL',
  'BSE', 'MCX', 'ANGELONE', 'KEI', 'HFCL', 'OLECTRA', 'TITAGARH', 'CONCOR', 'GODREJIND',
];

const LIQUID_NSE_SET = new Set(LIQUID_NSE);

module.exports = { LIQUID_NSE, LIQUID_NSE_SET };
