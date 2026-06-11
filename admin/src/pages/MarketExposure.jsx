import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import TradingViewChart from '../components/TradingViewChart';

/**
 * Market Exposure Dashboard — READ ONLY analytics of live OPEN-position
 * exposure across the platform (SUPER_ADMIN) or an admin's own hierarchy
 * (ADMIN). No trading controls of any kind. Auto-refreshes every 4s.
 */
const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedMoney = (v) => `${Number(v) < 0 ? '-' : '+'}${money(Math.abs(Number(v) || 0))}`;
const pct = (v) => `${Number(v || 0).toFixed(1)}%`;
const fmtLots = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  const a = Math.abs(n);
  return n.toFixed(a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6);
};
const csvEscape = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const download = (content, filename, type) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

// Best-effort platform-symbol → TradingView-symbol mapping for the view-only chart.
const tvSymbolFor = (sym, meta) => {
  if (!sym) return 'BINANCE:BTCUSDT';
  const inst = meta.get(sym);
  const cat = (inst?.category || '').toUpperCase();
  const base = inst?.baseCurrency || sym.replace(/USDT?$/, '');
  if (cat === 'CRYPTO') return `BINANCE:${base}USDT`;
  if (cat === 'FOREX') return `FX:${sym}`;
  return sym;
};

export default function MarketExposure() {
  const [summary, setSummary] = useState(null);
  const [instruments, setInstruments] = useState([]);
  const [allInstruments, setAllInstruments] = useState([]);
  const [loading, setLoading] = useState(true);

  // filters — no date range: exposure is always LIVE (all open positions).
  const [symbolFilter, setSymbolFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all'); // all | buy | sell
  const [search, setSearch] = useState('');

  // table sort + bottom tab
  const [sort, setSort] = useState({ key: 'total', dir: 'desc' });
  const [tab, setTab] = useState('buy'); // buy | sell | net

  // keep latest filter for the silent auto-refresh interval
  const filtersRef = useRef({ symbolFilter });
  filtersRef.current = { symbolFilter };

  const fetchExposure = async (silent) => {
    if (!silent) setLoading(true);
    const { symbolFilter: sf } = filtersRef.current;
    const params = { symbol: sf !== 'all' ? sf : undefined };
    try {
      const [s, inst] = await Promise.all([
        api.get('/admin/exposure/summary', { params }),
        api.get('/admin/exposure/instruments', { params }),
      ]);
      setSummary(s.data.data);
      setInstruments(inst.data.data || []);
    } catch (e) {
      if (!silent) toast.error(errorMessage(e));
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Initial + on-filter-change load, plus a silent auto-refresh every 4s.
  useEffect(() => {
    fetchExposure(false);
    const id = setInterval(() => fetchExposure(true), 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolFilter]);

  // Instrument metadata (for the symbol dropdown + TradingView mapping).
  useEffect(() => {
    api.get('/instruments').then(({ data }) => setAllInstruments(data.data || [])).catch(() => {});
  }, []);
  const instMeta = useMemo(() => new Map(allInstruments.map((i) => [i.symbol, i])), [allInstruments]);

  // Client-side status + search filter.
  const filtered = useMemo(() => instruments.filter((r) => {
    if (statusFilter === 'buy' && r.net <= 0) return false;
    if (statusFilter === 'sell' && r.net >= 0) return false;
    if (search && !r.symbol.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  }), [instruments, statusFilter, search]);

  const sortedRows = useMemo(() => {
    const rows = [...filtered];
    const val = (r) => sort.key === 'total' ? (r.buyAmount + r.sellAmount) : r[sort.key];
    rows.sort((a, b) => sort.dir === 'asc' ? val(a) - val(b) : val(b) - val(a));
    return rows;
  }, [filtered, sort]);

  const buyRows = useMemo(() => filtered.filter((r) => r.buyPositions > 0).sort((a, b) => b.buyAmount - a.buyAmount), [filtered]);
  const sellRows = useMemo(() => filtered.filter((r) => r.sellPositions > 0).sort((a, b) => b.sellAmount - a.sellAmount), [filtered]);

  const setSortKey = (key) => setSort((s) => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  const sortArrow = (key) => sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : '';

  const chartSym = symbolFilter !== 'all'
    ? symbolFilter
    : (instruments[0]?.symbol || allInstruments[0]?.symbol || 'BTCUSD');
  const tvSymbol = tvSymbolFor(chartSym, instMeta);

  const k = summary || { totalUsers: 0, totalBuyAmount: 0, totalSellAmount: 0, difference: 0, buyPercentage: 0, sellPercentage: 0 };
  const netPositive = k.difference >= 0;

  // ── Exports ──
  const exportRows = () => ([
    ['Symbol', 'Buy Lots', 'Buy Amount (USD)', 'Sell Lots', 'Sell Amount (USD)', 'Net Difference (USD)', 'Buy %', 'Sell %', 'Status'],
    ...sortedRows.map((r) => [r.symbol, r.buyLots, r.buyAmount, r.sellLots, r.sellAmount, r.net, r.buyPct, r.sellPct, r.status]),
  ]);
  const exportCSV = () => {
    const rows = [['Market Exposure Report'], ['Total Buy', k.totalBuyAmount], ['Total Sell', k.totalSellAmount], ['Net', k.difference], [], ...exportRows()];
    download(rows.map((r) => r.map(csvEscape).join(',')).join('\n'), 'market_exposure.csv', 'text/csv;charset=utf-8;');
    toast.success('CSV exported');
  };
  const exportExcel = () => {
    const body = exportRows().map((r, i) => `<tr>${r.map((c) => `<${i === 0 ? 'th' : 'td'}>${c}</${i === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('');
    const html = `<html><head><meta charset="utf-8"></head><body><h3>Market Exposure Report</h3>
      <p>Total Buy: ${k.totalBuyAmount} · Total Sell: ${k.totalSellAmount} · Net: ${k.difference}</p>
      <table border="1">${body}</table></body></html>`;
    download(html, 'market_exposure.xls', 'application/vnd.ms-excel');
    toast.success('Excel exported');
  };

  const showSkeleton = loading && !summary;

  return (
    <div className="space-y-5 max-w-[1600px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHero
          eyebrow="Risk · Read Only · B-Book"
          title="Market Exposure Dashboard"
          subtitle="Live B-BOOK open-position exposure (the broker's own risk; A-book is forwarded to the LP and excluded). Buy vs Sell imbalance, per-instrument breakdown. Auto-refreshes every 4s. No trading actions."
        />
        <div className="flex items-center gap-2">
          <button onClick={exportCSV} disabled={!summary} className="btn-ghost text-xs disabled:opacity-40">⭳ CSV</button>
          <button onClick={exportExcel} disabled={!summary} className="btn-ghost text-xs disabled:opacity-40">⭳ Excel</button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Symbol</label>
          <select className="input w-40" value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)}>
            <option value="all">All Symbols</option>
            {allInstruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input w-40" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="buy">Buy Dominant</option>
            <option value="sell">Sell Dominant</option>
          </select>
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="label">Search</label>
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Symbol…" />
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted pb-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Live
        </div>
      </div>

      {/* ── Top summary cards ── */}
      {showSkeleton ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-bg-hover animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 sticky top-0 z-10">
          <KpiCard label="Total Users" value={k.totalUsers.toLocaleString()} tone="slate" />
          <KpiCard label="Open Buy Exposure" value={money(k.totalBuyAmount)} tone="emerald" />
          <KpiCard label="Open Sell Exposure" value={money(k.totalSellAmount)} tone="rose" />
          <KpiCard label="Net Exposure" value={signedMoney(k.difference)} tone={netPositive ? 'emerald' : 'rose'} />
          <KpiCard label="Buy %" value={pct(k.buyPercentage)} tone="emerald" />
          <KpiCard label="Sell %" value={pct(k.sellPercentage)} tone="rose" />
        </div>
      )}

      {/* ── Exposure overview + progress bar ── */}
      <div className="card p-5">
        <h3 className="text-sm font-bold text-white mb-4">Exposure Overview</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
          <Big label="Total Buy Amount" value={money(k.totalBuyAmount)} cls="text-emerald-400" />
          <Big label="Total Sell Amount" value={money(k.totalSellAmount)} cls="text-rose-400" />
          <Big label="Net Difference" value={signedMoney(k.difference)} cls={netPositive ? 'text-emerald-400' : 'text-rose-400'} />
          <Big label="Buy %" value={pct(k.buyPercentage)} cls="text-emerald-400" />
          <Big label="Sell %" value={pct(k.sellPercentage)} cls="text-rose-400" />
        </div>
        <div className="flex items-center justify-between text-xs font-bold mb-1.5">
          <span className="text-emerald-400">BUY {pct(k.buyPercentage)}</span>
          <span className="text-rose-400">SELL {pct(k.sellPercentage)}</span>
        </div>
        <div className="flex h-3.5 rounded-full overflow-hidden bg-bg-hover">
          <div className="bg-emerald-500 transition-all duration-500" style={{ width: `${k.buyPercentage}%` }} />
          <div className="bg-rose-500 transition-all duration-500" style={{ width: `${k.sellPercentage}%` }} />
        </div>
      </div>

      {/* ── Center chart (view only) ── */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white">Chart · {chartSym} <span className="text-[10px] uppercase tracking-wider text-text-muted ml-1">view only</span></h3>
        </div>
        <TradingViewChart tvSymbol={tvSymbol} height={460} />
      </div>

      {/* ── Instrument exposure table ── */}
      <div className="card overflow-x-auto">
        <div className="px-4 pt-4 pb-2 text-sm font-bold text-white">Instrument Exposure</div>
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Symbol</th>
              <th className="text-right p-3">Buy Lots</th>
              <th className="text-right p-3 cursor-pointer select-none hover:text-white" onClick={() => setSortKey('buyAmount')}>Buy Amount{sortArrow('buyAmount')}</th>
              <th className="text-right p-3">Sell Lots</th>
              <th className="text-right p-3 cursor-pointer select-none hover:text-white" onClick={() => setSortKey('sellAmount')}>Sell Amount{sortArrow('sellAmount')}</th>
              <th className="text-right p-3 cursor-pointer select-none hover:text-white" onClick={() => setSortKey('net')}>Net Difference{sortArrow('net')}</th>
              <th className="text-right p-3">Buy %</th>
              <th className="text-right p-3">Sell %</th>
            </tr>
          </thead>
          <tbody>
            {showSkeleton ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-border-subtle"><td colSpan={8} className="p-3"><div className="h-5 rounded bg-bg-hover animate-pulse" /></td></tr>
              ))
            ) : sortedRows.length === 0 ? (
              <tr><td colSpan={8} className="p-10 text-center text-text-muted">No open exposure for the current filters.</td></tr>
            ) : sortedRows.map((r) => (
              <tr key={r.symbol} className="table-row">
                <td className="p-3 font-semibold text-white">{r.symbol}</td>
                <td className="p-3 text-right font-mono text-emerald-400/90">{fmtLots(r.buyLots)}</td>
                <td className="p-3 text-right font-mono text-emerald-400">{money(r.buyAmount)}</td>
                <td className="p-3 text-right font-mono text-rose-400/90">{fmtLots(r.sellLots)}</td>
                <td className="p-3 text-right font-mono text-rose-400">{money(r.sellAmount)}</td>
                <td className={`p-3 text-right font-mono font-semibold ${r.net > 0 ? 'text-emerald-400' : r.net < 0 ? 'text-rose-400' : 'text-gray-400'}`}>{signedMoney(r.net)}</td>
                <td className="p-3 text-right font-mono text-emerald-400/80">{pct(r.buyPct)}</td>
                <td className="p-3 text-right font-mono text-rose-400/80">{pct(r.sellPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Bottom exposure tabs ── */}
      <div className="card">
        <div className="flex items-center gap-1 border-b border-border-dark px-2">
          {[
            { k: 'buy', label: 'Buy Exposure', count: buyRows.length },
            { k: 'sell', label: 'Sell Exposure', count: sellRows.length },
            { k: 'net', label: 'Net Exposure', count: filtered.length },
          ].map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)}
              className={`relative px-4 py-3 text-sm font-semibold flex items-center gap-2 transition-colors ${tab === t.k ? 'text-white' : 'text-text-secondary hover:text-white'}`}>
              {t.label}
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${tab === t.k ? 'bg-primary-500 text-bg-dark' : 'bg-bg-hover text-text-secondary'}`}>{t.count}</span>
              {tab === t.k && <span className="absolute bottom-0 left-2 right-2 h-[3px] bg-primary-500 rounded-t-full" />}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto p-2">
          {tab === 'buy' && (
            <TabTable
              cols={['Symbol', 'Buy Positions', 'Buy Lots', 'Buy Amount']}
              rows={buyRows.map((r) => [r.symbol, r.buyPositions, fmtLots(r.buyLots), money(r.buyAmount)])}
              empty="No buy exposure."
            />
          )}
          {tab === 'sell' && (
            <TabTable
              cols={['Symbol', 'Sell Positions', 'Sell Lots', 'Sell Amount']}
              rows={sellRows.map((r) => [r.symbol, r.sellPositions, fmtLots(r.sellLots), money(r.sellAmount)])}
              empty="No sell exposure."
            />
          )}
          {tab === 'net' && (
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="text-xs text-gray-500 uppercase">
                <tr>
                  <th className="text-left p-3">Symbol</th>
                  <th className="text-right p-3">Buy Amount</th>
                  <th className="text-right p-3">Sell Amount</th>
                  <th className="text-right p-3">Difference</th>
                  <th className="text-center p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-text-muted">No exposure.</td></tr>
                ) : filtered.map((r) => (
                  <tr key={r.symbol} className="table-row">
                    <td className="p-3 font-semibold text-white">{r.symbol}</td>
                    <td className="p-3 text-right font-mono text-emerald-400">{money(r.buyAmount)}</td>
                    <td className="p-3 text-right font-mono text-rose-400">{money(r.sellAmount)}</td>
                    <td className={`p-3 text-right font-mono font-semibold ${r.net > 0 ? 'text-emerald-400' : r.net < 0 ? 'text-rose-400' : 'text-gray-400'}`}>{signedMoney(r.net)}</td>
                    <td className="p-3 text-center">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${
                        r.status === 'NET BUY' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : r.status === 'NET SELL' ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                            : 'bg-bg-hover text-gray-400 border-border-dark'}`}>
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

const TONES = {
  slate: 'text-white',
  emerald: 'text-emerald-400',
  rose: 'text-rose-400',
};
function KpiCard({ label, value, tone }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{label}</div>
      <div className={`text-xl font-extrabold mt-1 ${TONES[tone] || 'text-white'}`}>{value}</div>
    </div>
  );
}
function Big({ label, value, cls }) {
  return (
    <div className="rounded-xl border border-border-dark bg-bg-dark/40 p-3">
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{label}</div>
      <div className={`text-lg font-extrabold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
function TabTable({ cols, rows, empty }) {
  return (
    <table className="w-full text-sm whitespace-nowrap">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>{cols.map((c, i) => <th key={c} className={`p-3 ${i === 0 ? 'text-left' : 'text-right'}`}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={cols.length} className="p-8 text-center text-text-muted">{empty}</td></tr>
        ) : rows.map((r, ri) => (
          <tr key={ri} className="table-row">
            {r.map((c, ci) => (
              <td key={ci} className={`p-3 ${ci === 0 ? 'text-left font-semibold text-white' : 'text-right font-mono text-gray-200'}`}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
