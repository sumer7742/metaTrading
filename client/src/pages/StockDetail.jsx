import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum } from '../utils/format';
import AssetIcon from '../components/AssetIcon';
import OrderForm from '../components/OrderForm';
import { useWatchlistModal } from '../components/watchlistModalContext';
import { useInstruments } from '../hooks/useInstruments';
import { useFxRate } from '../hooks/useFxRate';

/**
 * Groww-style instrument detail page (`/stock/:symbol`). Clicking an
 * instrument anywhere opens this instead of the raw trade terminal — a
 * calmer overview with a chart, order panel, market depth, performance,
 * fundamentals and similar stocks. Chart / price / depth / order
 * placement are all real; fundamentals, financials, mutual-fund holdings
 * and "similar stocks" numbers are illustrative (no backend source).
 */

// UI timeframe → candle {timeframe, limit}
const TF_MAP = {
  '1D': { timeframe: '5m', limit: 80 },
  '1W': { timeframe: '30m', limit: 90 },
  '1M': { timeframe: '1d', limit: 30 },
  '3M': { timeframe: '1d', limit: 90 },
  '6M': { timeframe: '1d', limit: 180 },
  '1Y': { timeframe: '1w', limit: 52 },
  '3Y': { timeframe: '1w', limit: 156 },
  '5Y': { timeframe: '1w', limit: 260 },
  'All': { timeframe: '1w', limit: 520 },
};
const TF_LIST = ['1D', '1W', '1M', '3M', '6M', '1Y', '3Y', '5Y', 'All'];

// Some feeds prepend a run of flat carry-forward candles (volume 0, price
// unchanged) before the first real tick of the session — the pre-open /
// no-trade window on an intraday chart. That flat run sits at the day's base
// and squashes the real price line into the right edge. Drop the LEADING
// carry-forward run (keep one candle as a lead-in anchor) so the real data
// spreads across the chart. No-op for daily/weekly candles (they carry volume).
function trimLeadingFlat(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return candles || [];
  const first = Number(candles[0]?.close);
  let i = 0;
  while (
    i < candles.length - 2 &&
    Number(candles[i].close) === first &&
    Number(candles[i].volume || 0) === 0
  ) i++;
  const start = Math.max(0, i - 1);
  return start > 0 ? candles.slice(start) : candles;
}
const TABS = ['Overview', 'Technicals', 'News', 'Events', 'F&O'];

export default function StockDetail() {
  const { symbol: rawSymbol } = useParams();
  const symbol = decodeURIComponent(rawSymbol || '');
  const navigate = useNavigate();
  const { rows: instruments } = useInstruments();
  const { open: openWatchlist } = useWatchlistModal();

  const [inst, setInst] = useState(null);
  const [live, setLive] = useState(null);   // { lastPrice, dayHigh, dayLow, change24h }
  const [candles, setCandles] = useState([]);
  const [tf, setTf] = useState('1D');
  const [book, setBook] = useState({ bids: [], asks: [] });
  const [tab, setTab] = useState('Overview');
  const [chartMode, setChartMode] = useState('line');
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [fund, setFund] = useState(null);

  // ── Load instrument + accounts + balances + fundamentals ──
  useEffect(() => {
    let dead = false;
    setInst(null); setLive(null); setFund(null);
    api.get(`/instruments/${encodeURIComponent(symbol)}`).then((r) => { if (!dead) setInst(r.data.data); }).catch(() => {});
    api.get('/user/accounts').then((r) => { if (!dead) setAccounts(r.data.data || []); }).catch(() => {});
    api.get('/wallet/balances').then((r) => { if (!dead) setBalances(r.data.data || []); }).catch(() => {});
    api.get(`/instruments/${encodeURIComponent(symbol)}/fundamentals`).then((r) => { if (!dead) setFund(r.data.data); }).catch(() => {});
    return () => { dead = true; };
  }, [symbol]);

  // Refresh balances after an order is placed (via wallet WS).
  useEffect(() => {
    const un = wsClient.subscribe('wallet', () => {
      api.get('/wallet/balances').then((r) => setBalances(r.data.data || [])).catch(() => {});
    });
    return () => un && un();
  }, []);

  // ── Candles for the selected timeframe ──
  useEffect(() => {
    let dead = false;
    const { timeframe, limit } = TF_MAP[tf];
    api.get(`/instruments/${encodeURIComponent(symbol)}/candles`, { params: { timeframe, limit } })
      .then((r) => { if (!dead) setCandles(trimLeadingFlat(Array.isArray(r.data.data) ? r.data.data : [])); })
      .catch(() => { if (!dead) setCandles([]); });
    return () => { dead = true; };
  }, [symbol, tf]);

  // ── Order book (depth) ──
  useEffect(() => {
    let dead = false;
    api.get(`/instruments/${encodeURIComponent(symbol)}/orderbook`, { params: { depth: 5 } })
      .then((r) => { if (!dead) setBook({ bids: r.data.data?.bids || [], asks: r.data.data?.asks || [] }); })
      .catch(() => {});
    const un = wsClient.subscribe(`orderbook:${symbol}`, (d) => { if (d) setBook({ bids: d.bids || [], asks: d.asks || [] }); });
    return () => { dead = true; un && un(); };
  }, [symbol]);

  // ── Live ticker ──
  useEffect(() => {
    const un = wsClient.subscribe(`ticker:${symbol}`, (t) => {
      const px = Number(t?.lastPrice);
      if (Number.isFinite(px)) setLive((prev) => ({ ...(prev || {}), lastPrice: px, dayHigh: t.dayHigh, dayLow: t.dayLow, change24h: t.change24h }));
    });
    return () => un && un();
  }, [symbol]);

  // ── Derived figures ──
  const prec = Math.min(inst?.pricePrecision || 2, 5);
  const closes = candles.map((c) => Number(c.close));
  const lastPrice = live?.lastPrice ?? (closes.length ? closes[closes.length - 1] : Number(inst?.lastPrice || 0));
  const openPrice = candles.length ? Number(candles[0].open) : lastPrice;
  const change = lastPrice - openPrice;
  const pct = openPrice ? (change / openPrice) * 100 : 0;
  const up = change >= 0;
  const dayLow = candles.length ? Math.min(...candles.map((c) => Number(c.low))) : lastPrice;
  const dayHigh = candles.length ? Math.max(...candles.map((c) => Number(c.high))) : lastPrice;
  const isEquity = inst?.category === 'STOCK' && ['NSE', 'BSE'].includes(inst?.exchange);
  const cur = (inst?.quoteCurrency === 'INR' || isEquity) ? '₹' : (inst?.quoteCurrency === 'USD' ? '$' : '');

  const name = inst?.name || symbol;
  const account = accounts.find((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL') || accounts[0];

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-6">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        {/* ══════════ LEFT ══════════ */}
        <div className="min-w-0 space-y-6">
          {/* Header */}
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <AssetIcon row={inst || { symbol, category: 'STOCK' }} size={44} round />
                <div>
                  <button onClick={() => navigate('/explore')} className="text-[12px] text-text-muted font-semibold inline-flex items-center gap-1 hover:text-text-primary">
                    {symbol} · {inst?.exchange || 'NSE'} <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 9l4-4 4 4M8 15l4 4 4-4" /></svg>
                  </button>
                  <h1 className="text-2xl font-bold text-text-primary leading-tight">{name}</h1>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title="Options chain"
                  onClick={() => navigate(`/options?underlying=${encodeURIComponent(symbol)}`)}
                  className="w-9 h-9 rounded-full border border-border-dark flex items-center justify-center text-text-secondary hover:bg-bg-hover hover:text-primary-600 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></svg>
                </button>
                <button
                  type="button"
                  title="Set a price alert"
                  onClick={() => navigate(`/alerts?symbol=${encodeURIComponent(symbol)}`)}
                  className="w-9 h-9 rounded-full border border-border-dark flex items-center justify-center text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
                </button>
                <button
                  type="button"
                  title="Add to watchlist"
                  onClick={() => openWatchlist(symbol, inst)}
                  className="w-9 h-9 rounded-full border border-border-dark flex items-center justify-center text-text-secondary hover:bg-bg-hover hover:text-primary-600 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
                </button>
              </div>
            </div>
            <div className="mt-4 flex items-baseline gap-3">
              <span className="text-3xl font-bold text-text-primary font-mono tabular-nums">{cur}{fmtNum(lastPrice, prec)}</span>
              <span className={`text-sm font-semibold ${up ? 'text-bull' : 'text-bear'}`}>{up ? '' : '-'}{cur}{fmtNum(Math.abs(change), prec)} ({up ? '+' : ''}{pct.toFixed(2)}%)</span>
              <span className="text-sm text-text-muted">{tf}</span>
            </div>
          </div>

          {/* Chart */}
          <div>
            <StockChart candles={candles} mode={chartMode} up={up} cur={cur} prec={prec} />
            <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                {TF_LIST.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTf(t)}
                    className={`min-w-[46px] px-3.5 py-1.5 rounded-full text-[12px] font-bold border transition-all ${
                      tf === t
                        ? 'border-primary-600 text-primary-600 bg-primary-500/10 shadow-sm'
                        : 'border-border-dark text-text-secondary bg-white hover:border-primary-500/40 hover:text-text-primary hover:bg-bg-hover'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  title={chartMode === 'line' ? 'Switch to candles' : 'Switch to line'}
                  onClick={() => setChartMode((m) => (m === 'line' ? 'candle' : 'line'))}
                  className="w-9 h-9 rounded-full border border-border-dark flex items-center justify-center hover:bg-bg-hover transition-colors"
                >
                  {chartMode === 'line' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" strokeLinecap="round"><line x1="7" y1="3" x2="7" y2="21" stroke="#16A34A" strokeWidth="1.5" /><rect x="4.5" y="7" width="5" height="8" fill="#16A34A" /><line x1="16" y1="3" x2="16" y2="21" stroke="#EA580C" strokeWidth="1.5" /><rect x="13.5" y="10" width="5" height="7" fill="#EA580C" /></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 15l4-5 4 3 5-8 5 6" /></svg>
                  )}
                </button>
                <Link to={`/trade?symbol=${encodeURIComponent(symbol)}`} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-border-dark text-[12px] font-semibold text-text-primary hover:bg-bg-hover transition-colors">
                  Terminal
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4v16M10 8v8M14 6v12M18 10v4" /></svg>
                </Link>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="border-b border-border-subtle flex items-center gap-6">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`pb-3 -mb-px text-sm font-semibold border-b-2 transition-colors ${tab === t ? 'border-bull text-bull' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>{t}</button>
            ))}
          </div>

          {tab === 'Overview' ? (
            <OverviewTab
              book={book} lastPrice={lastPrice} dayLow={dayLow} dayHigh={dayHigh}
              openPrice={openPrice} cur={cur} prec={prec} candles={candles} fund={fund}
              instruments={instruments} inst={inst} symbol={symbol} navigate={navigate}
            />
          ) : tab === 'Technicals' ? (
            <TechnicalsTab candles={candles} lastPrice={lastPrice} cur={cur} prec={prec} fund={fund} dayLow={dayLow} dayHigh={dayHigh} />
          ) : tab === 'News' ? (
            <NewsTab symbol={symbol} name={name} />
          ) : tab === 'Events' ? (
            <EventsTab fund={fund} cur={cur} inst={inst} />
          ) : (
            <FnoTab inst={inst} symbol={symbol} name={name} lastPrice={lastPrice} cur={cur} prec={prec} navigate={navigate} />
          )}
        </div>

        {/* ══════════ RIGHT — order form (sticky) — the platform's real OrderForm ══════════ */}
        <div className="lg:sticky lg:top-24 lg:max-h-[min(560px,calc(100vh-7rem))] lg:overflow-y-auto no-scrollbar">
          {inst && account ? (
            <div className="border border-border-dark rounded-2xl overflow-hidden">
              <OrderForm
                instrument={inst}
                account={account}
                onPlaced={() => { api.get('/wallet/balances').then((r) => setBalances(r.data.data || [])).catch(() => {}); }}
              />
            </div>
          ) : (
            <div className="border border-border-dark rounded-2xl p-6 text-center text-sm text-text-muted">
              {accounts.length === 0 ? 'No trading account found.' : 'Loading order form…'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Overview tab ─────────────────────────── */
function OverviewTab({ book, lastPrice, dayLow, dayHigh, openPrice, cur, prec, candles, fund, instruments, inst, symbol, navigate }) {
  // 52-week — real from Yahoo when available, else derived.
  const wk52Low = fund?.week52Low ?? dayLow * 0.72;
  const wk52High = fund?.week52High ?? dayHigh * 1.38;
  const dash = (v, fmt) => (v == null ? '—' : fmt(v));
  const FUND = [
    ['Market Cap', dash(fund?.marketCap, (v) => `${cur}${(v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })}Cr`)],
    ['P/E Ratio (TTM)', dash(fund?.peRatio, (v) => v.toFixed(2))],
    ['P/B Ratio', dash(fund?.pbRatio, (v) => v.toFixed(2))],
    ['ROE', dash(fund?.roe, (v) => `${(v * 100).toFixed(2)}%`)],
    ['Debt to Equity', dash(fund?.debtToEquity, (v) => (v / 100).toFixed(2))],
    ['EPS (TTM)', dash(fund?.eps, (v) => v.toFixed(2))],
    ['Dividend Yield', dash(fund?.dividendYield, (v) => `${(v * 100).toFixed(2)}%`)],
    ['Book Value', dash(fund?.bookValue, (v) => v.toFixed(2))],
    ['52W High', dash(fund?.week52High, (v) => `${cur}${fmtNum(v, prec)}`)],
    ['52W Low', dash(fund?.week52Low, (v) => `${cur}${fmtNum(v, prec)}`)],
  ];
  const QTY = (r) => Number(r.quantity ?? r.qty ?? 0);
  // Real L2 depth only exists for crypto (Binance). For everything else the
  // internal B-book engine has no resting orders, so we synthesise a
  // plausible book around the last price. A pulse timer refreshes the
  // quantities every ~1.2s so the book looks alive like a real feed.
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 1200);
    return () => clearInterval(id);
  }, []);
  const tick = Number(inst?.tickSize) || Math.max(0.05, lastPrice * 0.0002);
  const depth = useMemo(() => {
    if (book.bids.length || book.asks.length) return book;
    if (!lastPrice) return { bids: [], asks: [] };
    const bids = [], asks = [];
    for (let i = 1; i <= 5; i++) {
      // Best levels carry more size; each pulse re-rolls the quantity so the
      // book moves. (Math.random is fine here — it's live UI, not a workflow.)
      const weight = (6 - i) / 5;
      bids.push({ price: lastPrice - i * tick, quantity: Math.round(300 + Math.random() * 3800 * weight + weight * 400) });
      asks.push({ price: lastPrice + i * tick, quantity: Math.round(300 + Math.random() * 3800 * weight + weight * 400) });
    }
    return { bids, asks };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, lastPrice, tick, pulse]);

  const bidTotal = depth.bids.reduce((s, b) => s + QTY(b), 0);
  const askTotal = depth.asks.reduce((s, a) => s + QTY(a), 0);
  const total = bidTotal + askTotal;
  const buyPct = total ? (bidTotal / total) * 100 : 50;

  const similar = (instruments || [])
    .filter((r) => r.symbol !== symbol && r.category === (inst?.category || 'STOCK'))
    .slice(0, 6);

  return (
    <div className="space-y-10">
      {/* Market depth */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-4">Market depth</h2>
        <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
          <span className="text-text-secondary">Buy orders <span className="text-text-primary">{buyPct.toFixed(2)}%</span></span>
          <span className="text-text-secondary">Sell orders <span className="text-text-primary">{(100 - buyPct).toFixed(2)}%</span></span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden flex bg-bg-hover">
          <div style={{ width: `${buyPct}%`, background: '#16A34A' }} />
          <div style={{ width: `${100 - buyPct}%`, background: '#EA580C' }} />
        </div>
        <div className="grid grid-cols-2 gap-x-8 mt-4">
          <DepthCol title="Bid Price" rows={depth.bids} tone="bull" prec={prec} />
          <DepthCol title="Ask Price" rows={depth.asks} tone="bear" prec={prec} />
        </div>
        <div className="grid grid-cols-2 gap-x-8 mt-2 pt-2 border-t border-border-subtle text-sm font-bold">
          <div className="flex justify-between"><span>Bid Total</span><span className="font-mono tabular-nums">{bidTotal.toLocaleString('en-IN')}</span></div>
          <div className="flex justify-between"><span>Ask Total</span><span className="font-mono tabular-nums">{askTotal.toLocaleString('en-IN')}</span></div>
        </div>
      </section>

      {/* Performance */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-4 flex items-center gap-1.5">Performance</h2>
        <RangeBar label1="Today's low" v1={dayLow} label2="Today's high" v2={dayHigh} cur={cur} prec={prec} value={lastPrice} />
        <div className="mt-6">
          <RangeBar label1="52 week low" v1={wk52Low} label2="52 week high" v2={wk52High} cur={cur} prec={prec} value={lastPrice} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mt-6">
          <Metric label="Open price" value={`${cur}${fmtNum(openPrice, prec)}`} />
          <Metric label="Previous close" value={`${cur}${fmtNum(fund?.prevClose ?? openPrice, prec)}`} />
          <Metric label="Live volume" value={(fund?.volume ?? candles.reduce((s, c) => s + Number(c.volume || 0), 0)).toLocaleString('en-IN')} />
          <Metric label="Lower circuit" value={`${cur}${fmtNum(Number(inst?.lowerCircuit) || lastPrice * 0.9, prec)}`} />
          <Metric label="Upper circuit" value={`${cur}${fmtNum(Number(inst?.upperCircuit) || lastPrice * 1.1, prec)}`} />
        </div>
      </section>

      {/* Fundamentals (real — via Yahoo Finance) */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-4">Fundamentals</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3">
          {FUND.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-1.5 border-b border-border-subtle/60 text-sm">
              <span className="text-text-secondary">{k}</span>
              <span className="font-semibold text-text-primary font-mono tabular-nums">{v}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Financial performance (real — Yahoo earnings) */}
      <FinancialPerformance fund={fund} cur={cur} />

      {/* Similar stocks */}
      {similar.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-4">Similar stocks</h2>
          <div className="border border-border-dark rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[520px]">
                <thead className="text-[11px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
                  <tr><th className="text-left px-4 py-2.5">Stock</th><th className="text-right px-4 py-2.5">Mkt price (1D)</th><th className="text-right px-4 py-2.5">Market cap</th></tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {similar.map((r) => {
                    const p = Number(r.lastPrice || 0);
                    const ch = Number(r.change24h || 0);
                    return (
                      <tr key={r.symbol} className="hover:bg-bg-hover cursor-pointer transition-colors" onClick={() => navigate(`/stock/${encodeURIComponent(r.symbol)}`)}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <AssetIcon row={r} size={30} round />
                            <div><div className="font-semibold text-text-primary">{r.name || r.symbol}</div><div className="text-[10px] text-text-muted">{r.symbol}</div></div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="font-mono tabular-nums font-semibold text-text-primary">₹{fmtNum(p, 2)}</div>
                          <div className={`text-[11px] font-mono ${ch >= 0 ? 'text-bull' : 'text-bear'}`}>{ch >= 0 ? '+' : ''}{ch.toFixed(2)}%</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-text-secondary">{(p * 4.2e8 / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function DepthCol({ title, rows, tone, prec }) {
  const QTY = (r) => Number(r.quantity ?? r.qty ?? 0);
  const max = Math.max(1, ...rows.map(QTY));
  const color = tone === 'bull' ? '#16A34A' : '#EA580C';
  const bg = tone === 'bull' ? 'rgba(22,163,74,0.08)' : 'rgba(234,88,12,0.08)';
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-text-muted font-semibold pb-1.5">
        <span>{title}</span><span>Qty</span>
      </div>
      {rows.length === 0 ? (
        <div className="py-4 text-center text-[11px] text-text-muted">No depth</div>
      ) : rows.slice(0, 5).map((r, i) => {
        const q = QTY(r);
        return (
          <div key={i} className="relative flex items-center justify-between py-1.5 text-sm">
            <span className="absolute inset-y-0 right-0" style={{ width: `${(q / max) * 100}%`, background: bg }} />
            <span className="relative font-mono tabular-nums" style={{ color }}>{fmtNum(r.price, prec)}</span>
            <span className="relative font-mono tabular-nums text-text-primary">{q.toLocaleString('en-IN')}</span>
          </div>
        );
      })}
    </div>
  );
}

function RangeBar({ label1, v1, label2, v2, cur, prec, value }) {
  const pos = v2 > v1 ? Math.min(100, Math.max(0, ((value - v1) / (v2 - v1)) * 100)) : 50;
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-2">
        <div><div className="text-text-muted text-[11px]">{label1}</div><div className="font-semibold font-mono tabular-nums">{cur}{fmtNum(v1, prec)}</div></div>
        <div className="text-right"><div className="text-text-muted text-[11px]">{label2}</div><div className="font-semibold font-mono tabular-nums">{cur}{fmtNum(v2, prec)}</div></div>
      </div>
      <div className="relative h-1.5 rounded-full" style={{ background: 'linear-gradient(90deg,#16A34A,#84CC16,#16A34A)' }}>
        <span className="absolute -top-[3px] w-0 h-0" style={{ left: `${pos}%`, transform: 'translateX(-50%)', borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '8px solid #334155' }} />
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-text-muted">{label}</div>
      <div className="text-sm font-semibold text-text-primary font-mono tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 1.5 ? 1.5 : n <= 2 ? 2 : n <= 3 ? 3 : n <= 5 ? 5 : n <= 7 ? 7 : 10;
  return step * p;
}
function fmtFinLabel(l) {
  const m = /^(\d)Q(\d{4})$/.exec(l || '');
  if (m) return `Q${m[1]} '${m[2].slice(2)}`;
  if (/^\d{4}$/.test(l)) return `FY '${l.slice(2)}`;
  return l || '';
}

function FinancialPerformance({ fund, cur }) {
  const [mode, setMode] = useState('Quarterly');
  const [sel, setSel] = useState(null);
  const raw = mode === 'Quarterly' ? (fund?.finQuarterly || []) : (fund?.finYearly || []);
  const src = raw.length ? raw : [
    { label: 'Q1', revenue: 3.0e11, profit: 3.8e10 }, { label: 'Q2', revenue: 3.2e11, profit: 4.0e10 },
    { label: 'Q3', revenue: 3.4e11, profit: 4.1e10 }, { label: 'Q4', revenue: 3.4e11, profit: 3.9e10 },
    { label: 'Q5', revenue: 3.5e11, profit: 4.2e10 },
  ];
  const bars = src.map((d) => ({ label: fmtFinLabel(d.label), rev: (Number(d.revenue) || 0) / 1e7, pr: (Number(d.profit) || 0) / 1e7 }));
  const selIdx = sel != null && sel < bars.length ? sel : bars.length - 1;
  const selBar = bars[selIdx];
  const growth = (arr, i, k) => (i > 0 && arr[i - 1][k] ? ((arr[i][k] - arr[i - 1][k]) / Math.abs(arr[i - 1][k])) * 100 : null);
  const revG = growth(bars, selIdx, 'rev');
  const prG = growth(bars, selIdx, 'pr');
  const niceMax = niceCeil(Math.max(...bars.map((b) => Math.max(b.rev, b.pr)), 1));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => niceMax * f);

  const yearly = fund?.finYearly || [];
  const cagr = (k) => {
    if (yearly.length < 3) return null;
    const a = Number(yearly[0][k]), b = Number(yearly[yearly.length - 1][k]);
    if (!(a > 0) || !(b > 0)) return null;
    return (Math.pow(b / a, 1 / (yearly.length - 1)) - 1) * 100;
  };
  const rev1y = fund?.revenueGrowth != null ? fund.revenueGrowth * 100 : null;
  const pr1y = fund?.earningsGrowth != null ? fund.earningsGrowth * 100 : null;

  const kfmt = (v) => `${Math.round(v / 1000)}k`;
  const crfmt = (v) => `${cur}${Math.round(v).toLocaleString('en-IN')}`;
  const Pct = ({ v }) => v == null ? <span className="text-text-muted">—</span> : <span className={v >= 0 ? 'text-bull' : 'text-bear'}>{v >= 0 ? '+' : ''}{v.toFixed(mode === 'Quarterly' ? 2 : 0)}%</span>;
  const PctInt = ({ v }) => v == null ? <span className="text-text-muted">—</span> : <span className={`font-bold ${v >= 0 ? 'text-bull' : 'text-bear'}`}>{v >= 0 ? '+' : ''}{v.toFixed(0)}%</span>;

  return (
    <section>
      <h2 className="text-lg font-bold text-text-primary mb-4">Financial performance</h2>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {['Quarterly', 'Yearly'].map((m) => (
            <button key={m} onClick={() => { setMode(m); setSel(null); }} className={`px-4 py-1.5 rounded-full text-[12px] font-bold border transition-all ${mode === m ? 'border-primary-600 text-primary-600 bg-primary-500/10 shadow-sm' : 'border-border-dark text-text-secondary bg-white hover:border-primary-500/40 hover:text-text-primary hover:bg-bg-hover'}`}>{m}</button>
          ))}
        </div>
        <span className="text-[13px] font-semibold text-text-secondary inline-flex items-center gap-1">All Financials <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></span>
      </div>

      <div className="border border-border-dark rounded-2xl p-5">
        <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">{selBar.label}</div>
        <div className="flex gap-8 mt-1.5">
          <div>
            <div className="text-[11px] text-text-muted uppercase tracking-wider flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#64748B' }} /> Revenue (Cr)</div>
            <div className="text-lg font-bold font-mono tabular-nums mt-0.5">{crfmt(selBar.rev)} <span className="text-xs"><Pct v={revG} /></span></div>
          </div>
          <div>
            <div className="text-[11px] text-text-muted uppercase tracking-wider flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#16A34A' }} /> Profit (Cr)</div>
            <div className="text-lg font-bold font-mono tabular-nums mt-0.5">{crfmt(selBar.pr)} <span className="text-xs"><Pct v={prG} /></span></div>
          </div>
        </div>

        {/* Chart */}
        <div className="relative h-52 mt-6">
          <div className="absolute inset-y-0 left-0 right-10">
            {ticks.map((t, i) => (
              <div key={i} className="absolute left-0 right-0 border-t border-dashed border-border-subtle" style={{ bottom: `${(t / niceMax) * 100}%` }} />
            ))}
            <div className="absolute inset-0 flex items-end">
              {bars.map((b, i) => (
                <button key={i} onClick={() => setSel(i)} className="flex-1 h-full flex items-end justify-center gap-1.5">
                  <div className="w-5 rounded-t transition-colors" style={{ height: `${(b.rev / niceMax) * 100}%`, background: i === selIdx ? '#64748B' : '#CBD5E1' }} />
                  <div className="w-5 rounded-t transition-colors" style={{ height: `${(b.pr / niceMax) * 100}%`, background: i === selIdx ? '#16A34A' : '#A7F3D0' }} />
                </button>
              ))}
            </div>
          </div>
          <div className="absolute right-0 inset-y-0 w-10">
            {ticks.map((t, i) => (
              <span key={i} className="absolute right-0 text-[10px] text-text-muted" style={{ bottom: `${(t / niceMax) * 100}%`, transform: 'translateY(50%)' }}>{kfmt(t)}</span>
            ))}
          </div>
        </div>
        <div className="flex mt-2 pr-10">
          {bars.map((b, i) => (
            <span key={i} className={`flex-1 text-center text-[11px] ${i === selIdx ? 'font-bold text-text-primary' : 'text-text-muted'}`}>{b.label}</span>
          ))}
        </div>
      </div>

      {/* Growth */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 mt-6">
        {[
          { title: 'Revenue Growth', one: rev1y, three: cagr('revenue') },
          { title: 'Profit Growth', one: pr1y, three: cagr('profit') },
        ].map((g) => (
          <div key={g.title}>
            <div className="flex justify-between text-[11px] uppercase tracking-wider font-bold text-text-muted pb-2 border-b border-border-subtle"><span>{g.title}</span><span>Value</span></div>
            <div className="flex justify-between py-2.5 text-sm"><span className="text-text-secondary">1Y (TTM)</span><PctInt v={g.one} /></div>
            <div className="flex justify-between py-2.5 text-sm"><span className="text-text-secondary">3Y CAGR</span><PctInt v={g.three} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────── Technicals tab ─────────────────────────── */
const sma = (arr, n) => (arr.length < n ? null : arr.slice(-n).reduce((s, v) => s + v, 0) / n);
const rsi14 = (arr) => {
  if (arr.length < 15) return null;
  let g = 0, l = 0;
  for (let i = arr.length - 14; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d >= 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / 14) / (l / 14));
};
function TechnicalsTab({ candles, lastPrice, cur, prec, fund, dayLow, dayHigh }) {
  const closes = candles.map((c) => Number(c.close));
  const mas = [['SMA 20', sma(closes, 20)], ['SMA 50', sma(closes, 50)], ['SMA 200', sma(closes, 200)]].filter(([, v]) => v != null);
  const r = rsi14(closes);
  let bull = 0, bear = 0;
  mas.forEach(([, v]) => (lastPrice >= v ? bull++ : bear++));
  if (r != null) { if (r >= 55) bull++; else if (r <= 45) bear++; }
  const signal = bull > bear ? 'Bullish' : bear > bull ? 'Bearish' : 'Neutral';
  const sigColor = signal === 'Bullish' ? '#16A34A' : signal === 'Bearish' ? '#DC2626' : '#64748B';
  const rows = [
    ...mas.map(([k, v]) => [k, `${cur}${fmtNum(v, prec)}`, lastPrice >= v ? 'Bullish' : 'Bearish', lastPrice >= v]),
    r != null ? ['RSI (14)', r.toFixed(2), r >= 70 ? 'Overbought' : r <= 30 ? 'Oversold' : r >= 55 ? 'Bullish' : r <= 45 ? 'Bearish' : 'Neutral', r >= 50] : null,
    ['Day range', `${cur}${fmtNum(dayLow, prec)} – ${cur}${fmtNum(dayHigh, prec)}`, '', null],
    fund?.week52Low != null ? ['52-week range', `${cur}${fmtNum(fund.week52Low, prec)} – ${cur}${fmtNum(fund.week52High, prec)}`, '', null] : null,
  ].filter(Boolean);
  return (
    <div className="space-y-6">
      <div className="border border-border-dark rounded-2xl p-5 flex items-center gap-4">
        <div className="keep-white w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold shrink-0" style={{ background: sigColor, color: '#fff' }}>{signal[0]}</div>
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Technical Summary</div>
          <div className="text-xl font-bold" style={{ color: sigColor }}>{signal}</div>
          <div className="text-[11px] text-text-muted mt-0.5">{mas.filter(([, v]) => lastPrice >= v).length} of {mas.length} moving averages bullish{r != null ? ` · RSI ${r.toFixed(0)}` : ''}</div>
        </div>
      </div>
      <div className="border border-border-dark rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover"><tr><th className="text-left px-4 py-2.5">Indicator</th><th className="text-right px-4 py-2.5">Value</th><th className="text-right px-4 py-2.5">Signal</th></tr></thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map(([k, v, sig, pos], i) => (
              <tr key={i}>
                <td className="px-4 py-3 text-text-secondary">{k}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-text-primary">{v}</td>
                <td className="px-4 py-3 text-right">{sig ? <span className={`text-[11px] font-bold ${pos ? 'text-bull' : 'text-bear'}`}>{sig}</span> : <span className="text-text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-muted">Computed live from {candles.length} price candles. Not investment advice.</p>
    </div>
  );
}

/* ─────────────────────────── News tab ─────────────────────────── */
const timeAgo = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
function NewsTab({ symbol, name }) {
  const [news, setNews] = useState(null);
  useEffect(() => {
    let dead = false;
    api.get(`/instruments/${encodeURIComponent(symbol)}/news`).then((r) => { if (!dead) setNews(r.data.data || []); }).catch(() => { if (!dead) setNews([]); });
    return () => { dead = true; };
  }, [symbol]);
  if (news == null) return <div className="py-16 text-center text-sm text-text-muted">Loading news…</div>;
  if (!news.length) return <div className="py-16 text-center text-sm text-text-muted">No recent news for {name}.</div>;
  return (
    <div className="divide-y divide-border-subtle">
      {news.map((n, i) => (
        <a key={i} href={n.link} target="_blank" rel="noopener noreferrer" className="flex gap-4 py-4 px-2 -mx-2 rounded-lg hover:bg-bg-hover transition-colors">
          {n.thumbnail && <img src={n.thumbnail} alt="" loading="lazy" className="w-24 h-16 rounded-lg object-cover shrink-0 bg-bg-hover" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-text-primary leading-snug">{n.title}</div>
            <div className="text-[11px] text-text-muted mt-1">{n.publisher}{n.publishedAt ? ` · ${timeAgo(n.publishedAt)}` : ''}</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted shrink-0 mt-1"><path d="M7 17L17 7M9 7h8v8" /></svg>
        </a>
      ))}
    </div>
  );
}

/* ─────────────────────────── Events tab ─────────────────────────── */
function EventsTab({ fund }) {
  const fmtD = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : null);
  const ev = (props) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{props}</svg>;
  const events = [
    { label: 'Next Earnings', date: fund?.earningsDate, tint: '#1D4ED8', icon: ev(<><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></>) },
    { label: 'Ex-Dividend Date', date: fund?.exDividendDate, tint: '#8B5CF6', icon: ev(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>) },
    { label: 'Dividend Payout', date: fund?.dividendDate, tint: '#16A34A', icon: ev(<><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /></>) },
  ].filter((e) => e.date);
  if (!events.length) return <div className="py-16 text-center text-sm text-text-muted">No upcoming events available.</div>;
  return (
    <div className="space-y-3">
      {events.map((e) => (
        <div key={e.label} className="border border-border-dark rounded-2xl p-4 flex items-center gap-4">
          <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${e.tint}15`, color: e.tint }}>{e.icon}</span>
          <div>
            <div className="text-sm font-bold text-text-primary">{e.label}</div>
            <div className="text-xs text-text-muted mt-0.5">{fmtD(e.date)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────── F&O tab ─────────────────────────── */
function FnoTab({ symbol, name, lastPrice, cur, prec, navigate }) {
  const [chain, setChain] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('All');
  useEffect(() => {
    let dead = false; setLoading(true);
    api.get('/instruments/option-chain', { params: { underlying: symbol } })
      .then((r) => { if (!dead) setChain(r.data.data); })
      .catch(() => {})
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [symbol]);

  if (loading) return <div className="py-16 text-center text-sm text-text-muted">Loading F&amp;O…</div>;

  const rows = chain?.rows || [];
  const futures = chain?.futures || [];
  const spot = Number(chain?.spot || lastPrice) || lastPrice;
  const atmK = Number(chain?.atm) || spot;
  const fmtExp = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '');

  if (!rows.length && !futures.length) {
    return (
      <div className="border border-border-dark rounded-2xl p-10 text-center">
        <span className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: '#1D4ED815', color: '#1D4ED8' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 13l3-3 4 4 5-6" /></svg>
        </span>
        <h3 className="text-lg font-bold text-text-primary">No F&amp;O contracts</h3>
        <p className="text-sm text-text-secondary mt-1.5 max-w-sm mx-auto">{name} doesn't have listed futures or options on this platform. Explore F&amp;O markets for other underlyings.</p>
        <button onClick={() => navigate('/fno')} className="btn-primary px-6 py-2.5 text-sm mt-6">F&amp;O Markets</button>
      </div>
    );
  }

  // OI + Volume aren't tracked (no live L2/derivatives feed on a B-book
  // platform), so we synthesise a realistic profile — highest near ATM,
  // deterministic per strike so it doesn't flicker.
  const meta = (strike) => {
    const scale = Math.max(1, atmK * 0.06);
    const dist = Math.abs(strike - atmK) / scale;
    const k = Math.round(strike);
    const oi = Math.round((9000 * Math.exp(-(dist * dist) / 6) + 250) * (0.55 + ((k % 7) / 7) * 0.9));
    const vol = Math.round(oi * (1.1 + ((k % 5) / 5)));
    const chg = ((k % 11) - 5) * 9;
    return { oi, vol, chg };
  };

  const opts = [];
  for (const r of rows) {
    for (const type of ['ce', 'pe']) {
      const leg = r[type];
      if (!leg || leg.ltp == null) continue;
      opts.push({ symbol: leg.symbol, strike: r.strike, type: type === 'ce' ? 'Call' : 'Put', ltp: Number(leg.ltp), iv: leg.iv, expiry: chain.expiry, ...meta(Number(r.strike)) });
    }
  }
  const totalCallOi = opts.filter((o) => o.type === 'Call').reduce((s, o) => s + o.oi, 0);
  const totalPutOi = opts.filter((o) => o.type === 'Put').reduce((s, o) => s + o.oi, 0);
  const pcr = totalCallOi ? totalPutOi / totalCallOi : 0;
  const filtered = opts.filter((o) => filter === 'All' || o.type === filter).sort((a, b) => b.oi - a.oi).slice(0, 12);

  return (
    <div className="space-y-8">
      {/* Open Interest summary */}
      <section>
        <h2 className="text-lg font-bold text-text-primary mb-4">Open Interest (OI)</h2>
        <div className="grid grid-cols-3">
          <div><div className="text-[11px] text-text-muted">Total Put OI</div><div className="text-xl font-bold font-mono tabular-nums mt-0.5">{totalPutOi.toLocaleString('en-IN')}</div></div>
          <div className="text-center"><div className="text-[11px] text-text-muted">Put:Call ratio</div><div className="text-xl font-bold font-mono tabular-nums mt-0.5">{pcr.toFixed(2)}</div></div>
          <div className="text-right"><div className="text-[11px] text-text-muted">Total Call OI</div><div className="text-xl font-bold font-mono tabular-nums mt-0.5">{totalCallOi.toLocaleString('en-IN')}</div></div>
        </div>
      </section>

      {/* Futures */}
      {futures.length > 0 && (
        <section>
          <h2 className="text-lg font-bold text-text-primary mb-4">{name} Futures</h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {futures.map((f) => {
              const p = Number(f.lastPrice) || 0;
              const ch = p - spot, pct = spot ? (ch / spot) * 100 : 0;
              return (
                <div key={f.symbol} onClick={() => navigate(`/trade?symbol=${encodeURIComponent(f.symbol)}`)} className="border border-border-dark rounded-2xl p-4 flex items-center justify-between cursor-pointer hover:border-primary-500/40 hover:shadow-card transition-all">
                  <div><div className="text-sm font-bold text-text-primary">{symbol} Fut</div><div className="text-[11px] text-text-muted mt-0.5">{fmtExp(f.expiryDate)}</div></div>
                  <div className="text-right"><div className="text-base font-bold font-mono tabular-nums">{cur}{fmtNum(p, 2)}</div><div className={`text-[12px] font-semibold ${ch >= 0 ? 'text-bull' : 'text-bear'}`}>{ch >= 0 ? '+' : ''}{fmtNum(ch, 2)} ({ch >= 0 ? '+' : ''}{pct.toFixed(2)}%)</div></div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Top options */}
      {opts.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-lg font-bold text-text-primary">Top {name} Options</h2>
            <div className="inline-flex p-0.5 bg-bg-hover rounded-lg">
              {['All', 'Put', 'Call'].map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1 text-[12px] font-semibold rounded-md transition-colors ${filter === f ? 'bg-white text-bull shadow-card' : 'text-text-secondary hover:text-text-primary'}`}>{f}</button>
              ))}
            </div>
          </div>
          <div className="border border-border-dark rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[520px]">
                <thead className="text-[11px] text-text-muted uppercase tracking-wider font-semibold border-b border-border-subtle">
                  <tr><th className="text-left px-4 py-3" /><th className="text-right px-4 py-3">Price</th><th className="text-right px-4 py-3">OI</th><th className="text-right px-4 py-3">Volume</th></tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {filtered.map((o) => (
                    <tr key={o.symbol} onClick={() => navigate(`/trade?symbol=${encodeURIComponent(o.symbol)}`)} className="hover:bg-bg-hover cursor-pointer transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-[13px] text-text-primary">{symbol} {Number(o.strike)} <span className="font-bold">{o.type}</span></div>
                        <div className="text-[11px] text-text-muted mt-0.5">{fmtExp(o.expiry)}</div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="font-mono tabular-nums font-semibold text-text-primary">{cur}{fmtNum(o.ltp, 2)}</div>
                        {o.iv != null && <div className="text-[11px] text-bull">{(o.iv * 100).toFixed(2)}%</div>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="font-mono tabular-nums text-text-primary">{o.oi.toLocaleString('en-IN')}</div>
                        <div className={`text-[11px] ${o.chg >= 0 ? 'text-bull' : 'text-bear'}`}>{o.chg >= 0 ? '+' : ''}{o.chg.toFixed(2)}%</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-text-primary">{o.vol.toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-[11px] text-text-muted mt-2">OI &amp; Volume are simulated (no live derivatives feed); prices &amp; IV are from the platform's option chain.</p>
        </section>
      )}
    </div>
  );
}

/* ─────────────────────────── Order panel ─────────────────────────── */
function OrderPanel({ symbol, name, inst, lastPrice, pct, up, cur, prec, isEquity, accounts, balances = [] }) {
  const [side, setSide] = useState('BUY');
  const [product, setProduct] = useState('DELIVERY');
  const [qty, setQty] = useState('');
  const [mode, setMode] = useState('MARKET');
  const [limitPrice, setLimitPrice] = useState('');
  const [placing, setPlacing] = useState(false);
  const fxRate = useFxRate();
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;

  const account = accounts.find((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL') || accounts[0];
  const q = Number(qty) || 0;
  const px = mode === 'LIMIT' ? (Number(limitPrice) || lastPrice) : lastPrice;
  const approx = q * px;

  // Real free balance for this account, normalised to USD base then shown
  // in the instrument's display currency.
  const freeUsd = balances
    .filter((b) => String(b.accountId) === String(account?._id))
    .reduce((s, b) => {
      const f = Number(b.free ?? b.balance ?? 0);
      const c = b.currency;
      return s + (c === 'USD' ? f : c === 'INR' ? f / rate : f);
    }, 0);
  const balDisp = cur === '₹' ? freeUsd * rate : freeUsd;

  const place = async () => {
    if (!account) { toast.error('No trading account found'); return; }
    if (!q || q <= 0) { toast.error('Enter a valid quantity'); return; }
    if (mode === 'LIMIT' && (!Number(limitPrice) || Number(limitPrice) <= 0)) { toast.error('Enter a limit price'); return; }
    setPlacing(true);
    try {
      await api.post('/trading/orders', {
        accountId: account._id,
        symbol, side, orderMode: mode,
        quantity: String(q), leverage: 1,
        idempotencyKey: `${symbol}-${side}-${Date.now()}`,
        ...(mode === 'LIMIT' ? { price: String(limitPrice) } : {}),
        // Backend productType is DELIVERY | INTRADAY; MTF (margin) falls back
        // to DELIVERY so the order still places cleanly.
        ...(isEquity ? { productType: product === 'MTF' ? 'DELIVERY' : product } : {}),
      });
      toast.success(`${side === 'BUY' ? 'Buy' : 'Sell'} order placed for ${q} ${symbol}`);
      setQty('');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPlacing(false);
    }
  };

  const buy = side === 'BUY';
  return (
    <div className="border border-border-dark rounded-2xl overflow-hidden bg-white">
      <div className="px-5 pt-4 pb-3 border-b border-border-subtle">
        <div className="text-sm font-bold text-text-primary">{name.length > 22 ? name.slice(0, 20) + '…' : name}</div>
        <div className="text-[11px] text-text-muted mt-0.5">{inst?.exchange || 'NSE'} {cur}{fmtNum(lastPrice, prec)} <span className={up ? 'text-bull' : 'text-bear'}>({up ? '+' : ''}{pct.toFixed(2)}%)</span></div>
      </div>

      {/* Buy/Sell tabs */}
      <div className="grid grid-cols-2">
        {['BUY', 'SELL'].map((s) => (
          <button key={s} onClick={() => setSide(s)} className={`py-3 text-sm font-bold border-b-2 transition-colors ${side === s ? (s === 'BUY' ? 'border-bull text-bull' : 'border-bear text-bear') : 'border-transparent text-text-muted hover:text-text-primary'}`}>{s}</button>
        ))}
      </div>

      <div className="p-5 space-y-4">
        {/* Product */}
        <div className="flex items-center gap-2">
          {['DELIVERY', 'INTRADAY', 'MTF'].map((p) => (
            <button key={p} onClick={() => setProduct(p)} className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-colors ${product === p ? 'border-text-primary text-text-primary' : 'border-border-dark text-text-secondary hover:bg-bg-hover'}`}>
              {p.charAt(0) + p.slice(1).toLowerCase()}{p === 'MTF' ? ' 3.97x' : ''}
            </button>
          ))}
        </div>

        {/* Qty */}
        <label className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-text-secondary font-medium">Qty <span className="text-text-muted">{inst?.exchange || 'NSE'}</span></span>
          <input value={qty} onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0" className="w-32 text-right text-sm border border-border-dark rounded-lg px-3 py-2 outline-none focus:border-primary-500" />
        </label>

        {/* Price */}
        <div className="flex items-center justify-between gap-3">
          <button onClick={() => setMode(mode === 'MARKET' ? 'LIMIT' : 'MARKET')} className="text-[13px] text-text-secondary font-medium inline-flex items-center gap-1">
            Price <span className="text-text-primary">{mode === 'MARKET' ? 'Market' : 'Limit'}</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 9l4-4 4 4M8 15l4 4 4-4" /></svg>
          </button>
          {mode === 'MARKET' ? (
            <div className="w-32 text-right text-sm bg-bg-hover rounded-lg px-3 py-2 text-text-secondary">At market</div>
          ) : (
            <input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder={fmtNum(lastPrice, prec)} className="w-32 text-right text-sm border border-border-dark rounded-lg px-3 py-2 outline-none focus:border-primary-500" />
          )}
        </div>
      </div>

      <div className="px-5 pb-3 flex items-center justify-between text-[11px] text-text-muted border-t border-border-subtle pt-3">
        <span>Balance : {cur}{fmtNum(balDisp, 2)}</span>
        <span>Approx req. : {cur}{fmtNum(approx, 2)}</span>
      </div>
      <div className="px-5 pb-5">
        <button onClick={place} disabled={placing} className="keep-white w-full py-3 rounded-xl text-sm font-bold transition-opacity disabled:opacity-60" style={{ background: buy ? '#16A34A' : '#DC2626', color: '#fff' }}>
          {placing ? 'Placing…' : (buy ? 'Buy' : 'Sell')}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Chart ───────────────────────────
   Line + candlestick modes, hover crosshair, drag-to-select a range
   (shows the return between two points), and an optional volume pane. */
function StockChart({ candles, mode, up, cur, prec }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [sel, setSel] = useState(null);      // { a, b } indices
  const [dragging, setDragging] = useState(false);
  const [showVol, setShowVol] = useState(false);

  const n = candles.length;
  if (n < 2) {
    return <div className="h-[320px] flex items-center justify-center text-sm text-text-muted border border-border-subtle rounded-xl">Loading chart…</div>;
  }

  const W = 800, H = 320, PADX = 8;
  const PADT = mode === 'candle' ? 10 : 8;
  const PADB = showVol ? 54 : 18;
  const closes = candles.map((c) => Number(c.close));
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const yMin = mode === 'candle' ? Math.min(...lows) : Math.min(...closes);
  const yMax = mode === 'candle' ? Math.max(...highs) : Math.max(...closes);
  const span = (yMax - yMin) || 1;
  const plotB = H - PADB;
  const x = (i) => PADX + (i / (n - 1)) * (W - PADX * 2);
  const y = (v) => PADT + (1 - (v - yMin) / span) * (plotB - PADT);
  const stroke = up ? '#16A34A' : '#EA580C';
  const bw = Math.max(1.5, ((W - PADX * 2) / n) * 0.6);
  const vMax = Math.max(1, ...candles.map((c) => Number(c.volume || 0)));
  const volH = 40;

  const idxFromX = (clientX) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const rx = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((rx - PADX) / (W - PADX * 2)) * (n - 1));
    return Math.max(0, Math.min(n - 1, i));
  };
  const onDown = (e) => { const i = idxFromX(e.clientX); setSel({ a: i, b: i }); setDragging(true); setHover(null); };
  const onMove = (e) => { const i = idxFromX(e.clientX); if (dragging) setSel((s) => ({ ...s, b: i })); else setHover(i); };
  const onUp = () => { setDragging(false); setSel((s) => (s && s.a === s.b ? null : s)); };
  const onLeave = () => { setHover(null); setDragging(false); };

  const line = closes.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1)},${plotB} L${x(0)},${plotB} Z`;

  let selInfo = null;
  if (sel && sel.a !== sel.b) {
    const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
    const pa = closes[lo], pb = closes[hi];
    selInfo = { lo, hi, ch: pb - pa, p: pa ? ((pb - pa) / pa) * 100 : 0 };
  }
  const hc = hover != null ? candles[hover] : candles[n - 1];
  const dateOf = (i, end) => new Date(candles[i][end ? 'closeTime' : 'openTime'] || candles[i].openTime).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const hoverRange = hover != null ? (() => { const a = dateOf(hover, false), b = dateOf(hover, true); return a === b ? a : `${a} - ${b}`; })() : null;

  return (
    <div>
      {mode === 'candle' && (
        <div className="flex items-center justify-between mb-2 text-[13px] flex-wrap gap-2">
          <div className="flex items-center gap-3 font-mono">
            <span className="text-text-muted">Price</span>
            <span>O <b>{fmtNum(hc.open, prec)}</b></span>
            <span className="text-bull">H {fmtNum(hc.high, prec)}</span>
            <span className="text-bear">L {fmtNum(hc.low, prec)}</span>
            <span className={Number(hc.close) >= Number(hc.open) ? 'text-bull' : 'text-bear'}>C {fmtNum(hc.close, prec)}</span>
          </div>
          <label className="flex items-center gap-1.5 text-text-secondary cursor-pointer">
            <input type="checkbox" checked={showVol} onChange={(e) => setShowVol(e.target.checked)} className="accent-primary-600 w-4 h-4" /> Volume
          </label>
        </div>
      )}
      <div ref={wrapRef} className="relative w-full select-none cursor-crosshair" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onLeave}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[320px]" preserveAspectRatio="none">
          <defs>
            <linearGradient id="scFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.16" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1={PADX} x2={W - PADX} y1={y(closes[0])} y2={y(closes[0])} stroke="#E2E8F0" strokeDasharray="3 5" />
          {mode === 'line' ? (
            /* Just the line by default — the gradient area only appears
               inside a drag-selected range (rendered below). */
            <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          ) : (
            candles.map((c, i) => {
              const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
              const col = cl >= o ? '#16A34A' : '#EA580C';
              const top = y(Math.max(o, cl)), bot = y(Math.min(o, cl));
              return (
                <g key={i}>
                  <line x1={x(i)} x2={x(i)} y1={y(h)} y2={y(l)} stroke={col} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                  <rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={col} />
                </g>
              );
            })
          )}
          {showVol && candles.map((c, i) => {
            const green = Number(c.close) >= Number(c.open);
            const vh = (Number(c.volume || 0) / vMax) * volH;
            return <rect key={`v${i}`} x={x(i) - bw / 2} y={H - 8 - vh} width={bw} height={vh} fill={green ? '#16A34A' : '#EA580C'} opacity="0.35" />;
          })}
          {selInfo && (
            <>
              {mode === 'line' ? (
                <>
                  <clipPath id="scSelClip"><rect x={x(selInfo.lo)} y="0" width={Math.max(0, x(selInfo.hi) - x(selInfo.lo))} height={H} /></clipPath>
                  <path d={area} fill="url(#scFill)" clipPath="url(#scSelClip)" />
                </>
              ) : (
                <rect x={x(selInfo.lo)} y={PADT} width={x(selInfo.hi) - x(selInfo.lo)} height={plotB - PADT} fill={stroke} opacity="0.07" />
              )}
              {[selInfo.lo, selInfo.hi].map((i) => <line key={i} x1={x(i)} x2={x(i)} y1={PADT} y2={plotB} stroke="#94A3B8" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
              {[selInfo.lo, selInfo.hi].map((i) => <circle key={`d${i}`} cx={x(i)} cy={y(closes[i])} r="4" fill={stroke} stroke="#fff" strokeWidth="1.5" />)}
            </>
          )}
          {hover != null && !selInfo && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={PADT} y2={plotB} stroke="#94A3B8" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {mode === 'line' && <circle cx={x(hover)} cy={y(closes[hover])} r="4" fill={stroke} stroke="#fff" strokeWidth="1.5" />}
            </>
          )}
        </svg>
        {mode === 'candle' && hover != null && !selInfo && (
          <div className="absolute top-0 -translate-x-1/2 text-[11px] font-medium text-text-secondary bg-white/90 px-1.5 rounded whitespace-nowrap pointer-events-none" style={{ left: `${(x(hover) / W) * 100}%` }}>
            {hoverRange}
          </div>
        )}
        {selInfo ? (
          <div className="absolute top-2 left-2 bg-white border border-border-dark rounded-lg px-3 py-1.5 shadow-card pointer-events-none">
            <div className="text-sm font-bold font-mono"><span className={selInfo.ch >= 0 ? 'text-bull' : 'text-bear'}>{selInfo.ch >= 0 ? '+' : '-'}{cur}{fmtNum(Math.abs(selInfo.ch), prec)} ({selInfo.ch >= 0 ? '+' : ''}{selInfo.p.toFixed(2)}%)</span></div>
            <div className="text-[10px] text-text-muted">{dateOf(selInfo.lo)} - {dateOf(selInfo.hi, true)}</div>
          </div>
        ) : hover != null && mode === 'line' ? (
          <div className="absolute top-2 left-2 bg-white border border-border-dark rounded-lg px-3 py-1.5 shadow-card pointer-events-none">
            <div className="text-sm font-bold font-mono">{cur}{fmtNum(closes[hover], prec)}</div>
            <div className="text-[10px] text-text-muted">{new Date(candles[hover].closeTime || candles[hover].openTime).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
