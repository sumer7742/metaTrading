import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useInstruments } from '../hooks/useInstruments';
import AssetIcon from '../components/AssetIcon';
import { fmtNum } from '../utils/format';

/**
 * F&O home — Groww-style landing built ENTIRELY on real platform data:
 *  • Top traded (Equity / Commodities tabs) with live prices + real candlestick
 *    sparklines (from /instruments/:symbol/candles).
 *  • F&O Stocks — gainers / losers with real 1-day change and Volume.
 *  • Commodities (Live), and index / stock / commodity futures rows.
 *  • Popular underlyings → real option chain, real ATM-IV insight.
 * Anything that needs a data feed we don't carry (OI / PCR / Max-Pain /
 * multi-window movers) is intentionally omitted — never faked.
 */
const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

const isIndian = (r) => {
  const ex = String(r.exchange || '').toUpperCase();
  return ['NSE', 'BSE', 'NFO', 'BFO', 'MCX'].includes(ex) || String(r.quoteCurrency || '').toUpperCase() === 'INR';
};
const catOf = (r) => String(r.category || '').toUpperCase();
const isIndexRow = (r) => catOf(r).includes('INDEX') || catOf(r).includes('INDICES');

// Absolute + % 1-day change. change24h is a %, so we back out the previous
// close from the current price to show the rupee move like Groww does.
const changeParts = (row, price) => {
  const chg = Number(row?.change24h);
  const p = Number(price);
  const hasPct = Number.isFinite(chg);
  const up = hasPct ? chg >= 0 : true;
  let abs = null;
  if (hasPct && Number.isFinite(p) && (1 + chg / 100) !== 0) abs = p - p / (1 + chg / 100);
  return { hasPct, up, chg, abs };
};

const fmtVol = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n).toLocaleString('en-IN') : '—';
};

// ── Sparkline candle cache (module-level so tab switches don't refetch). ──
const _sparkCache = new Map(); // symbol -> [{o,h,l,c}]
const _sparkInflight = new Map();
function fetchSpark(symbol) {
  if (_sparkCache.has(symbol)) return Promise.resolve(_sparkCache.get(symbol));
  if (_sparkInflight.has(symbol)) return _sparkInflight.get(symbol);
  const p = api.get(`/instruments/${encodeURIComponent(symbol)}/candles`, { params: { timeframe: '1d', limit: 24 } })
    .then((res) => {
      const raw = Array.isArray(res.data?.data) ? res.data.data : [];
      const pts = raw
        .map((c) => ({ o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close) }))
        .filter((c) => Number.isFinite(c.o) && Number.isFinite(c.c) && Number.isFinite(c.h) && Number.isFinite(c.l));
      _sparkCache.set(symbol, pts);
      _sparkInflight.delete(symbol);
      return pts;
    })
    .catch(() => { _sparkCache.set(symbol, []); _sparkInflight.delete(symbol); return []; });
  _sparkInflight.set(symbol, p);
  return p;
}

export default function FnoHome() {
  const { rows, loading } = useInstruments();
  const navigate = useNavigate();
  const [live, setLive] = useState({});           // symbol -> live last price
  const [topTab, setTopTab] = useState('equity'); // 'equity' | 'commodity'
  const [fnoTab, setFnoTab] = useState('gainers'); // 'gainers' | 'losers'
  const [insightU, setInsightU] = useState('NIFTY');
  const [insight, setInsight] = useState(null);

  // ── Derive F&O groups from the catalog (futures aren't excluded). ──
  const futures = useMemo(() => rows.filter((r) => r.segment === 'FUT'), [rows]);
  const eqBySym = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);

  const nearestFut = useMemo(() => {
    const m = new Map();
    for (const f of futures) {
      const u = (f.underlying || '').toUpperCase();
      if (!u) continue;
      const cur = m.get(u);
      if (!cur || new Date(f.expiryDate || 0) < new Date(cur.expiryDate || 0)) m.set(u, f);
    }
    return m;
  }, [futures]);

  const indexCards = useMemo(() => INDEX_UNDERLYINGS.map((u) => nearestFut.get(u)).filter(Boolean), [nearestFut]);
  const indexFutures = useMemo(
    () => futures.filter((f) => INDEX_UNDERLYINGS.includes((f.underlying || '').toUpperCase()))
      .sort((a, b) => new Date(a.expiryDate || 0) - new Date(b.expiryDate || 0)).slice(0, 10),
    [futures],
  );
  // All non-index, non-MCX stock futures (used both for the display row and to
  // derive the F&O-stock underlyings for the movers table).
  const stockFuturesAll = useMemo(
    () => futures.filter((f) => !INDEX_UNDERLYINGS.includes((f.underlying || '').toUpperCase()) && (f.exchange || '').toUpperCase() !== 'MCX'),
    [futures],
  );
  const stockFutures = useMemo(
    () => [...stockFuturesAll].sort((a, b) => Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0)).slice(0, 12),
    [stockFuturesAll],
  );
  // MCX commodity FUTURES (nearest expiry per commodity) — real F&O, not spot.
  const commodityFutures = useMemo(() => {
    const m = new Map();
    for (const f of futures) {
      if ((f.exchange || '').toUpperCase() !== 'MCX') continue;
      const u = (f.underlying || f.symbol).toUpperCase();
      const cur = m.get(u);
      if (!cur || new Date(f.expiryDate || 0) < new Date(cur.expiryDate || 0)) m.set(u, f);
    }
    return [...m.values()];
  }, [futures]);

  // Spot rows by category (for the Groww-style "Top traded" + Commodities Live).
  const indexSpots = useMemo(() => rows.filter((r) => isIndexRow(r) && isIndian(r)), [rows]);
  const equities = useMemo(() => rows.filter((r) => catOf(r) === 'STOCK' && isIndian(r)), [rows]);
  const commoditySpots = useMemo(() => rows.filter((r) => catOf(r) === 'COMMODITY'), [rows]);

  const byVolDesc = (a, b) => (Number(b.volume24h) || 0) - (Number(a.volume24h) || 0);

  // Top traded — Equity: indices first, then most-traded equities. Falls back to
  // futures-derived proxies if spot rows aren't seeded.
  const topEquity = useMemo(() => {
    const idx = (indexSpots.length ? indexSpots : indexCards).slice(0, 3);
    const eq = [...equities].sort(byVolDesc).slice(0, Math.max(0, 6 - idx.length));
    const out = [...idx, ...eq];
    return out.length ? out : stockFutures.slice(0, 6);
  }, [indexSpots, indexCards, equities, stockFutures]);

  const topCommodity = useMemo(() => {
    const list = commoditySpots.length ? [...commoditySpots].sort(byVolDesc) : commodityFutures;
    return list.slice(0, 6);
  }, [commoditySpots, commodityFutures]);

  const commoditiesLive = useMemo(
    () => (commoditySpots.length ? [...commoditySpots].sort(byVolDesc) : commodityFutures).slice(0, 4),
    [commoditySpots, commodityFutures],
  );

  // F&O stocks (movers) — real underlyings that have stock futures, mapped to
  // their spot row (for price/volume/change) where available.
  const fnoStocks = useMemo(() => {
    const und = [...new Set(stockFuturesAll.map((f) => (f.underlying || '').toUpperCase()).filter(Boolean))];
    let list = und.map((u) => eqBySym.get(u) || nearestFut.get(u)).filter(Boolean);
    if (!list.length) list = equities.length ? equities : stockFutures;
    return list.filter((r) => Number.isFinite(Number(r.change24h)));
  }, [stockFuturesAll, eqBySym, nearestFut, equities, stockFutures]);

  const fnoMovers = useMemo(() => {
    const sorted = [...fnoStocks].sort((a, b) => Number(b.change24h) - Number(a.change24h));
    return { gainers: sorted.slice(0, 8), losers: [...sorted].reverse().slice(0, 8) };
  }, [fnoStocks]);

  // ── Live prices for everything visible. ──
  const liveSymbols = useMemo(() => {
    const s = new Set();
    [...topEquity, ...topCommodity, ...commoditiesLive, ...indexFutures, ...stockFutures, ...commodityFutures,
      ...fnoMovers.gainers, ...fnoMovers.losers].forEach((r) => r && r.symbol && s.add(r.symbol));
    return [...s];
  }, [topEquity, topCommodity, commoditiesLive, indexFutures, stockFutures, commodityFutures, fnoMovers]);

  useEffect(() => {
    if (!liveSymbols.length) return undefined;
    const unsubs = liveSymbols.map((sym) => wsClient.subscribe(`ticker:${sym}`, (msg) => {
      const p = Number(msg?.price ?? msg?.last ?? msg?.lastPrice);
      if (Number.isFinite(p)) setLive((m) => (m[sym] === p ? m : { ...m, [sym]: p }));
    }));
    return () => unsubs.forEach((u) => u && u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSymbols.join(',')]);

  const priceOf = (r) => (live[r.symbol] != null ? live[r.symbol] : r.lastPrice);

  // ── Real ATM-IV insight from the validated option chain. ──
  useEffect(() => {
    let cancelled = false;
    api.get(`/instruments/option-chain?underlying=${encodeURIComponent(insightU)}`)
      .then((res) => { if (!cancelled) setInsight(res.data?.data || res.data || null); })
      .catch(() => { if (!cancelled) setInsight(null); });
    return () => { cancelled = true; };
  }, [insightU]);

  const atmIv = useMemo(() => {
    if (!insight?.rows || insight.atm == null) return null;
    const row = insight.rows.find((r) => String(r.strike) === String(insight.atm));
    const ivs = [row?.ce?.iv, row?.pe?.iv].filter((v) => v != null);
    return ivs.length ? (ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100 : null;
  }, [insight]);

  const goTrade = (sym) => navigate(`/trade?symbol=${encodeURIComponent(sym)}`);
  const goChain = (u) => navigate(`/options?underlying=${encodeURIComponent(u)}`);
  const openRow = (r) => (isIndexRow(r) ? goChain(r.underlying || r.symbol) : goTrade(r.symbol));

  const topCards = topTab === 'equity' ? topEquity : topCommodity;
  const moverRows = fnoTab === 'gainers' ? fnoMovers.gainers : fnoMovers.losers;

  return (
    <div className="max-w-[1180px] mx-auto px-3 sm:px-4 py-5 space-y-9">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-text-primary leading-tight">Futures &amp; Options</h1>
          <p className="text-xs sm:text-sm text-text-muted mt-0.5">Live index &amp; stock futures, MCX commodities and real option-chain insight.</p>
        </div>
        <Link to="/options" className="shrink-0 inline-flex items-center gap-1 text-sm font-semibold text-bull hover:underline">
          Option chain
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </Link>
      </div>

      {/* ── Top traded (Equity / Commodities) ── */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-3">Top traded</h2>
        <div className="flex items-center justify-between gap-3 mb-4">
          <Tabs
            tabs={[{ key: 'equity', label: 'Equity' }, { key: 'commodity', label: 'Commodities' }]}
            active={topTab}
            onChange={setTopTab}
          />
          <Link to="/markets?view=most-traded" className="text-sm font-semibold text-bull hover:underline">See more</Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {topCards.map((r) => (
            <TopCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => openRow(r)} />
          ))}
          {!topCards.length && <Empty loading={loading} text="No instruments — run the F&O / market sync." />}
        </div>
      </section>

      {/* ── F&O Stocks (gainers / losers) ── */}
      {(fnoMovers.gainers.length > 0 || fnoMovers.losers.length > 0) && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3">F&amp;O Stocks</h2>
          <div className="flex items-center justify-between gap-3 mb-3">
            <Tabs
              tabs={[{ key: 'gainers', label: 'Gainers' }, { key: 'losers', label: 'Losers' }]}
              active={fnoTab}
              onChange={setFnoTab}
            />
            <Link to={`/markets?view=${fnoTab}`} className="text-sm font-semibold text-bull hover:underline">See more</Link>
          </div>
          <FnoTable rows={moverRows} priceOf={priceOf} onPick={openRow} />
        </section>
      )}

      {/* ── Commodities (Live) ── */}
      {commoditiesLive.length > 0 && (
        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2.5">
              <h2 className="text-lg font-bold text-text-primary">Commodities</h2>
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-bull">
                <span className="w-2 h-2 rounded-full bg-bull animate-pulse" /> Live
              </span>
            </div>
            <Link to="/markets" className="text-sm font-semibold text-bull hover:underline">See more</Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {commoditiesLive.map((r) => (
              <CommodityCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />
            ))}
          </div>
        </section>
      )}

      {/* ── Top traded index futures ── */}
      {indexFutures.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3">Top traded index futures</h2>
          <Scroller>
            {indexFutures.map((r) => <FutCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />)}
          </Scroller>
        </section>
      )}

      {/* ── Top traded stock futures ── */}
      {stockFutures.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3">Top traded stock futures</h2>
          <Scroller>
            {stockFutures.map((r) => <FutCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />)}
          </Scroller>
        </section>
      )}

      {/* ── Top traded commodity futures ── */}
      {commodityFutures.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-3">Top traded commodity futures</h2>
          <Scroller>
            {commodityFutures.map((r) => <FutCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />)}
          </Scroller>
        </section>
      )}

      {/* ── Option-chain insight (real ATM IV) ── */}
      <section>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-bold text-text-primary">Option insight</h2>
          <select
            value={insightU}
            onChange={(e) => setInsightU(e.target.value)}
            className="text-sm rounded-lg border border-border-dark bg-white px-2.5 py-1.5"
          >
            {['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Tile label={`${insightU} forward`} value={insight?.spot ? `₹${fmtNum(insight.spot, 2)}` : '—'} />
          <Tile label="ATM strike" value={insight?.atm != null ? fmtNum(insight.atm, 0) : '—'} />
          <Tile label="ATM IV" value={atmIv != null ? `${atmIv.toFixed(1)}%` : 'N/A'} />
        </div>
        <Link to={`/options?underlying=${insightU}`} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-bull hover:underline">
          Open {insightU} option chain
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </Link>
      </section>
    </div>
  );
}

/* ── bits ── */
function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex items-center gap-2">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`px-4 py-1.5 rounded-full text-sm font-semibold border transition-colors ${active === t.key
            ? 'bg-bg-hover border-border-dark text-text-primary'
            : 'border-transparent text-text-muted hover:text-text-primary'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Scroller({ children }) {
  return <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">{children}</div>;
}

function ChangeText({ row, price, className = '' }) {
  const { hasPct, up, chg, abs } = changeParts(row, price);
  if (!hasPct) return <span className={`text-text-muted ${className}`}>—</span>;
  return (
    <span className={`${up ? 'text-bull' : 'text-bear'} font-semibold tabular-nums ${className}`}>
      {abs != null ? `${fmtNum(abs, 2)} ` : ''}({up ? '+' : ''}{chg.toFixed(2)}%)
    </span>
  );
}

// Real candlestick sparkline from daily candles.
function Sparkline({ symbol }) {
  const [candles, setCandles] = useState(() => _sparkCache.get(symbol) || null);
  useEffect(() => {
    let cancelled = false;
    fetchSpark(symbol).then((pts) => { if (!cancelled) setCandles(pts); });
    return () => { cancelled = true; };
  }, [symbol]);

  if (!candles || candles.length < 2) return <div className="h-12" />;
  const W = 140, H = 48, n = candles.length;
  const lo = Math.min(...candles.map((c) => c.l));
  const hi = Math.max(...candles.map((c) => c.h));
  const span = hi - lo || 1;
  const y = (v) => H - ((v - lo) / span) * (H - 4) - 2;
  const cw = W / n;
  const bodyW = Math.max(1.6, cw * 0.55);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="block">
      {candles.map((c, i) => {
        const cx = i * cw + cw / 2;
        const green = c.c >= c.o;
        const col = green ? '#16A34A' : '#EF4444';
        const yO = y(c.o), yC = y(c.c);
        const top = Math.min(yO, yC);
        const h = Math.max(1, Math.abs(yC - yO));
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="0.8" />
            <rect x={cx - bodyW / 2} y={top} width={bodyW} height={h} fill={col} rx="0.4" />
          </g>
        );
      })}
    </svg>
  );
}

function TopCard({ row, price, onClick }) {
  const name = row.name || row.underlying || row.symbol;
  const idx = isIndexRow(row);
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-2xl border border-border-dark bg-white p-4 hover:shadow-card hover:border-primary-500/50 transition-all min-w-0 flex flex-col"
    >
      <div className="text-sm font-semibold text-text-primary truncate mb-2">{name}</div>
      <div className="mb-3"><Sparkline symbol={row.symbol} /></div>
      <div className="mt-auto flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-lg font-bold tabular-nums text-text-primary truncate">{idx ? '' : '₹'}{fmtNum(price, 2)}</div>
          <ChangeText row={row} price={price} className="text-[13px]" />
        </div>
        <span className="shrink-0 w-8 h-8 rounded-full border border-border-dark flex items-center justify-center text-text-muted group-hover:border-primary-500 group-hover:text-primary-600 transition-colors">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
        </span>
      </div>
    </button>
  );
}

function CommodityCard({ row, price, onClick }) {
  const name = row.name || row.underlying || row.symbol;
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-2xl border border-border-dark bg-white p-4 hover:shadow-card hover:border-primary-500/50 transition-all min-w-0"
    >
      <div className="mb-3"><AssetIcon row={row} size={40} /></div>
      <div className="text-sm font-semibold text-text-primary truncate">{name}</div>
      <div className="text-lg font-bold tabular-nums mt-0.5 text-text-primary truncate">₹{fmtNum(price, 2)}</div>
      <ChangeText row={row} price={price} className="text-[13px]" />
    </button>
  );
}

function FutCard({ row, price, onClick }) {
  const exp = row.expiryDate ? new Date(row.expiryDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
  const label = `${row.underlying || row.symbol}${exp ? ` ${exp} Fut` : ''}`;
  return (
    <button
      onClick={onClick}
      className="group shrink-0 w-48 text-left rounded-2xl border border-border-dark bg-white p-4 hover:shadow-card hover:border-primary-500/50 transition-all"
    >
      <div className="mb-4"><AssetIcon row={row} size={36} /></div>
      <div className="text-[13px] font-semibold text-text-primary truncate leading-snug">{label}</div>
      <div className="text-base font-bold tabular-nums mt-2 text-text-primary truncate">₹{fmtNum(price, 2)}</div>
      <ChangeText row={row} price={price} className="text-xs" />
    </button>
  );
}

function FnoTable({ rows, priceOf, onPick }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[520px]">
        <thead>
          <tr className="text-text-muted border-b border-border-subtle">
            <th className="text-left font-medium px-4 py-3">Stocks</th>
            <th className="text-right font-medium px-4 py-3">Price</th>
            <th className="text-right font-medium px-4 py-3">1D Change</th>
            <th className="text-right font-medium px-4 py-3">Volume</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.symbol}
              className="border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer transition-colors"
              onClick={() => onPick(r)}
            >
              <td className="px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <AssetIcon row={r} size={30} />
                  <span className="font-medium text-text-primary truncate">{r.name || r.underlying || r.symbol}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums text-text-primary">₹{fmtNum(priceOf(r), 2)}</td>
              <td className="px-4 py-3 text-right"><ChangeText row={r} price={priceOf(r)} /></td>
              <td className="px-4 py-3 text-right tabular-nums text-text-secondary">{fmtVol(r.volume24h)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({ label, value }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-4 min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{label}</div>
      <div className="text-lg font-bold tabular-nums mt-0.5 truncate text-text-primary">{value}</div>
    </div>
  );
}

function Empty({ loading, text }) {
  return <div className="col-span-full text-sm text-text-muted py-6 text-center">{loading ? 'Loading…' : text}</div>;
}
