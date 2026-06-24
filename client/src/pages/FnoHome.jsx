import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useInstruments } from '../hooks/useInstruments';
import AssetIcon from '../components/AssetIcon';
import { fmtNum } from '../utils/format';

/**
 * F&O home — broker-grade landing built ENTIRELY on real platform data:
 * index/stock futures + commodities (live LTP/Δ via WS), popular underlyings →
 * option chain, and a real ATM-IV insight from the validated chain. Tiles that
 * need data our feed doesn't carry (OI / Volume / PCR / Max Pain) are labelled
 * "needs OI feed" — never faked.
 */
const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
const POPULAR = ['RELIANCE', 'TCS', 'INFY', 'SBIN', 'HDFCBANK', 'ICICIBANK', 'LT', 'BAJFINANCE', 'AXISBANK', 'MARUTI', 'TITAN', 'SUNPHARMA'];

const pctClass = (c) => (Number(c) >= 0 ? 'text-bull' : 'text-bear');
const pct = (c) => (c == null || !Number.isFinite(Number(c)) ? '—' : `${Number(c) >= 0 ? '+' : ''}${Number(c).toFixed(2)}%`);

export default function FnoHome() {
  const { rows, loading } = useInstruments();
  const navigate = useNavigate();
  const [live, setLive] = useState({});           // symbol -> live last price
  const [insightU, setInsightU] = useState('NIFTY');
  const [insight, setInsight] = useState(null);

  // ── Derive F&O groups from the catalog (futures aren't excluded). ──
  const futures = useMemo(() => rows.filter((r) => r.segment === 'FUT'), [rows]);
  const eqBySym = useMemo(() => new Map(rows.map((r) => [r.symbol, r])), [rows]);

  // Nearest-expiry future per underlying (used as the index/stock proxy price).
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

  const indexCards = INDEX_UNDERLYINGS.map((u) => nearestFut.get(u)).filter(Boolean);
  const indexFutures = useMemo(
    () => futures.filter((f) => INDEX_UNDERLYINGS.includes((f.underlying || '').toUpperCase()))
      .sort((a, b) => new Date(a.expiryDate || 0) - new Date(b.expiryDate || 0)).slice(0, 8),
    [futures],
  );
  const stockFutures = useMemo(
    () => futures.filter((f) => !INDEX_UNDERLYINGS.includes((f.underlying || '').toUpperCase()))
      .sort((a, b) => Math.abs(Number(b.change24h) || 0) - Math.abs(Number(a.change24h) || 0)).slice(0, 12),
    [futures],
  );
  // MCX commodity FUTURES (nearest expiry per commodity) — real F&O, not spot CFDs.
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

  // F&O movers (futures, by % change) — real, OI/volume omitted.
  const movers = useMemo(() => {
    const withChg = futures.filter((f) => Number.isFinite(Number(f.change24h)));
    const sorted = [...withChg].sort((a, b) => Number(b.change24h) - Number(a.change24h));
    return { gainers: sorted.slice(0, 6), losers: sorted.slice(-6).reverse() };
  }, [futures]);

  // ── Live prices for everything visible. ──
  const liveSymbols = useMemo(() => {
    const s = new Set();
    [...indexCards, ...indexFutures, ...stockFutures, ...commodityFutures].forEach((r) => r && s.add(r.symbol));
    return [...s];
  }, [indexCards, indexFutures, stockFutures, commodityFutures]);

  useEffect(() => {
    if (!liveSymbols.length) return undefined;
    const unsubs = liveSymbols.map((sym) => wsClient.subscribe(`ticker:${sym}`, (msg) => {
      const p = Number(msg?.price ?? msg?.last ?? msg?.lastPrice);
      if (Number.isFinite(p)) setLive((m) => (m[sym] === p ? m : { ...m, [sym]: p }));
    }));
    return () => unsubs.forEach((u) => u && u());
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

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-4 py-4 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-bold text-text-primary">F&amp;O</h1>
        <Link to="/options" className="text-sm font-semibold text-primary-600 hover:text-primary-700">Full option chain →</Link>
      </div>

      {/* ── Indices ── */}
      <Section title="Indices">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {indexCards.map((r) => (
            <PriceCard key={r.symbol} row={r} price={priceOf(r)} label={(r.underlying || r.symbol)} sub="fwd" onClick={() => goChain(r.underlying || r.symbol)} />
          ))}
          {!indexCards.length && <Empty loading={loading} text="No index futures — run the F&O sync." />}
        </div>
      </Section>

      {/* ── Index futures ── */}
      {indexFutures.length > 0 && (
        <Section title="Index futures">
          <Scroller>
            {indexFutures.map((r) => (
              <FutCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />
            ))}
          </Scroller>
        </Section>
      )}

      {/* ── Stock futures ── */}
      {stockFutures.length > 0 && (
        <Section title="Stock futures">
          <Scroller>
            {stockFutures.map((r) => (
              <FutCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />
            ))}
          </Scroller>
        </Section>
      )}

      {/* ── Popular F&O underlyings → chain ── */}
      <Section title="Popular F&O stocks">
        <div className="flex flex-wrap gap-2">
          {POPULAR.map((u) => (
            <button key={u} onClick={() => goChain(u)}
              className="px-3 py-1.5 rounded-full border border-border-dark text-sm font-medium text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors">
              {(eqBySym.get(u)?.name) || u}
            </button>
          ))}
        </div>
      </Section>

      {/* ── Option-chain insight (real ATM IV) + OI-dependent tiles labelled ── */}
      <Section
        title="Option insight"
        action={(
          <select value={insightU} onChange={(e) => setInsightU(e.target.value)}
            className="text-sm rounded-lg border border-border-dark bg-white px-2 py-1">
            {INDEX_UNDERLYINGS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Tile label={`${insightU} forward`} value={insight?.spot ? `₹${fmtNum(insight.spot, 2)}` : '—'} />
          <Tile label="ATM strike" value={insight?.atm != null ? fmtNum(insight.atm, 0) : '—'} />
          <Tile label="ATM IV" value={atmIv != null ? `${atmIv.toFixed(1)}%` : 'N/A'} />
          <Tile label="PCR / Max Pain" value="—" note="needs OI feed" />
        </div>
        <Link to={`/options?underlying=${insightU}`} className="mt-3 inline-block text-sm font-semibold text-primary-600 hover:text-primary-700">
          Open {insightU} option chain →
        </Link>
      </Section>

      {/* ── F&O movers (by % change) ── */}
      {(movers.gainers.length > 0 || movers.losers.length > 0) && (
        <Section title="F&O movers (by % change)">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MoversTable title="Top gainers" rows={movers.gainers} priceOf={priceOf} onPick={goTrade} />
            <MoversTable title="Top losers" rows={movers.losers} priceOf={priceOf} onPick={goTrade} />
          </div>
          <div className="mt-1 text-[11px] text-text-muted">Volume &amp; OI columns need the OI feed (full-quote/websocket) — omitted, not faked.</div>
        </Section>
      )}

      {/* ── Commodity futures (MCX) ── */}
      {commodityFutures.length > 0 && (
        <Section title="Commodity futures (MCX)">
          <Scroller>
            {commodityFutures.map((r) => (
              <FutCard key={r.symbol} row={r} price={priceOf(r)} onClick={() => goTrade(r.symbol)} />
            ))}
          </Scroller>
        </Section>
      )}

      {/* ── Tools ── */}
      <Section title="Tools">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: 'Option chain', to: '/options' },
            { label: 'Expiry calendar', to: '/options' },
            { label: 'Option calculator', soon: true },
            { label: 'Margin calculator', soon: true },
            { label: 'Strategy builder', soon: true },
            { label: 'OI analyzer', soon: true },
          ].map((t) => (
            t.to
              ? <Link key={t.label} to={t.to} className="rounded-2xl border border-border-dark bg-white p-4 text-sm font-semibold text-text-primary hover:border-primary-500 hover:shadow-card transition-all">{t.label}</Link>
              : <div key={t.label} className="rounded-2xl border border-border-dark bg-white p-4 text-sm font-semibold text-text-muted">{t.label}<span className="block text-[10px] font-normal">coming soon</span></div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ── bits ── */
function Section({ title, action, children }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-text-secondary uppercase tracking-wide">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Scroller({ children }) {
  return <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">{children}</div>;
}

function PriceCard({ row, price, label, sub, onClick }) {
  return (
    <button onClick={onClick} className="text-left rounded-2xl border border-border-dark bg-white p-4 hover:border-primary-500 hover:shadow-card transition-all min-w-0">
      <div className="flex items-center gap-2 mb-2">
        <AssetIcon row={row} size={22} round />
        <span className="text-sm font-bold text-text-primary truncate">{label}{sub ? <span className="text-[10px] text-text-muted ml-1">{sub}</span> : ''}</span>
      </div>
      <div className="text-lg font-bold font-mono tabular-nums text-text-primary truncate">₹{fmtNum(price, 2)}</div>
      <div className={`text-xs font-semibold ${pctClass(row.change24h)}`}>{pct(row.change24h)}</div>
    </button>
  );
}

function FutCard({ row, price, onClick }) {
  const exp = row.expiryDate ? new Date(row.expiryDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
  return (
    <button onClick={onClick} className="shrink-0 w-40 text-left rounded-2xl border border-border-dark bg-white p-4 hover:border-primary-500 hover:shadow-card transition-all">
      <div className="flex items-center gap-2 mb-1.5">
        <AssetIcon row={row} size={20} round />
        <span className="text-[13px] font-bold text-text-primary truncate">{row.underlying || row.symbol}</span>
      </div>
      <div className="text-[10px] text-text-muted mb-1">{exp}{row.lotSize ? ` · lot ${row.lotSize}` : ''}</div>
      <div className="text-base font-bold font-mono tabular-nums truncate">₹{fmtNum(price, 2)}</div>
      <div className={`text-xs font-semibold ${pctClass(row.change24h)}`}>{pct(row.change24h)}</div>
    </button>
  );
}

function Tile({ label, value, note }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-4 min-w-0">
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{label}</div>
      <div className="text-lg font-bold font-mono tabular-nums mt-0.5 truncate">{value}</div>
      {note && <div className="text-[10px] text-text-muted mt-0.5">{note}</div>}
    </div>
  );
}

function MoversTable({ title, rows, priceOf, onPick }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white overflow-hidden">
      <div className="px-4 py-2.5 text-sm font-bold text-text-primary border-b border-border-subtle">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-b border-border-subtle last:border-0 hover:bg-bg-hover cursor-pointer" onClick={() => onPick(r.symbol)}>
              <td className="px-4 py-2 font-medium text-text-primary truncate">{r.underlying || r.symbol}</td>
              <td className="px-4 py-2 text-right font-mono tabular-nums">₹{fmtNum(priceOf(r), 2)}</td>
              <td className={`px-4 py-2 text-right font-semibold ${pctClass(r.change24h)}`}>{pct(r.change24h)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ loading, text }) {
  return <div className="col-span-full text-sm text-text-muted py-6 text-center">{loading ? 'Loading…' : text}</div>;
}
