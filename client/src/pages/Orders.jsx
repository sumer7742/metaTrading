import { useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';
import AssetIcon from '../components/AssetIcon';

/**
 * Trade History — closed positions for the selected trading account, with
 * filters, pagination, summary stats and CSV download. Design mirrors a
 * broker-style trade-history table (ORDER ID / SYMBOL / SIDE / OPEN-CLOSE
 * PRICE / COMMISSION / CHARGE / EXECUTED BY / REMARKS / OPENED-CLOSED AT / P/L).
 *
 * Data shape from /trading/positions/history:
 *   { items: Position[], summary: {...}, pagination: {...} }
 */
export default function Orders() {
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState({ totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
  const [pagination, setPagination] = useState({ page: 1, limit: 30, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);

  // Filter state
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [sideFilter, setSideFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  // Load accounts once. Pre-select the first account.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/user/accounts');
        setAccounts(data.data);
        if (data.data.length && !selectedAccountId) setSelectedAccountId(data.data[0]._id);
      } catch (_) { /* ignore */ }
    })();
  }, []);

  // Reload history whenever filters or account change.
  useEffect(() => {
    if (!selectedAccountId) return;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get('/trading/positions/history', {
          params: {
            accountId: selectedAccountId,
            symbol: symbolFilter || undefined,
            side: sideFilter || undefined,
            from: fromDate || undefined,
            to: toDate || undefined,
            page,
            limit: 30,
          },
        });
        setItems(data.data.items);
        setSummary(data.data.summary);
        setPagination(data.data.pagination);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedAccountId, symbolFilter, sideFilter, fromDate, toDate, page]);

  const account = useMemo(
    () => accounts.find((a) => a._id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  const downloadReport = () => {
    if (!items.length) return;
    const headers = [
      'Order ID', 'Symbol', 'Side', 'Size', 'Open Price', 'Close Price',
      'Commission', 'Charge', 'Executed By', 'Remarks', 'Opened At', 'Closed At', 'P/L',
    ];
    const rows = items.map((p) => [
      shortId(p._id),
      p.symbol,
      p.side,
      p.quantity,
      p.entryPrice,
      p.closePrice || '',
      p.commission || '0',
      p.swap || '0',
      'SELF',
      remarkText(p.closeReason),
      formatDateTime(p.openedAt || p.createdAt),
      formatDateTime(p.closedAt),
      p.realizedPnl,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade-history-${account?.accountNumber || selectedAccountId}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setSymbolFilter('');
    setSideFilter('');
    setFromDate('');
    setToDate('');
    setPage(1);
  };

  return (
    <div className="space-y-4 max-w-[1600px]">
      {/* Header bar — title + account chip + filters + download */}
      <div className="card p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="w-1 h-6 bg-primary-500 rounded-full" />
          <h1 className="text-xl font-bold text-text-primary tracking-wide">
            TRADE HISTORY <span className="text-text-muted font-normal">({pagination.total})</span>
          </h1>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Account chip */}
          <div className="border border-border-dark rounded px-3 py-1.5 text-xs flex items-center gap-3">
            <span className="text-primary-500 font-medium">Selected Account</span>
            <span className="text-gray-600">|</span>
            <span className="text-gray-400">ID:</span>
            <select
              value={selectedAccountId}
              onChange={(e) => { setSelectedAccountId(e.target.value); setPage(1); }}
              className="bg-transparent text-white font-mono text-xs focus:outline-none"
            >
              {accounts.map((a) => (
                <option key={a._id} value={a._id} className="bg-bg-dark">
                  {a.accountNumber}
                </option>
              ))}
            </select>
            <span className="text-gray-600">|</span>
            <span className="text-gray-400">TYPE:</span>
            <span className="px-2 py-0.5 bg-bg-hover rounded text-[10px] font-bold text-primary-500">
              {account?.accountType || '—'}
            </span>
          </div>

          {/* Filters toggle */}
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className="btn-ghost flex items-center gap-1 text-sm"
          >
            <span>▽</span> Filters
          </button>

          {/* Download */}
          <button
            onClick={downloadReport}
            disabled={!items.length}
            className="border border-border-dark rounded px-3 py-1.5 text-sm text-white hover:bg-bg-hover disabled:opacity-40"
          >
            ⬇ Download Report
          </button>
        </div>
      </div>

      {/* Filters panel */}
      {filtersOpen && (
        <div className="card p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="label">Symbol</label>
            <input
              type="text"
              value={symbolFilter}
              onChange={(e) => { setSymbolFilter(e.target.value.toUpperCase()); setPage(1); }}
              placeholder="e.g. XAUUSD"
              className="input text-xs"
            />
          </div>
          <div>
            <label className="label">Side</label>
            <select
              value={sideFilter}
              onChange={(e) => { setSideFilter(e.target.value); setPage(1); }}
              className="input text-xs"
            >
              <option value="">All</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>
          <div>
            <label className="label">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
              className="input text-xs"
            />
          </div>
          <div>
            <label className="label">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => { setToDate(e.target.value); setPage(1); }}
              className="input text-xs"
            />
          </div>
          <div className="flex items-end">
            <button onClick={clearFilters} className="btn-ghost w-full text-xs">Clear</button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-x-auto">
        {loading ? (
          <div className="text-gray-500 text-sm py-12 text-center">Loading trade history…</div>
        ) : !items.length ? (
          <div className="text-gray-500 text-sm py-12 text-center">No closed trades yet</div>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="text-xs text-gray-500 uppercase tracking-wider border-b border-border-dark">
              <tr>
                <th className="text-left px-4 py-3 font-normal">Order Id</th>
                <th className="text-left px-4 py-3 font-normal">Symbol</th>
                <th className="text-left px-4 py-3 font-normal">Side</th>
                <th className="text-right px-4 py-3 font-normal">Size</th>
                <th className="text-right px-4 py-3 font-normal">Open Price</th>
                <th className="text-right px-4 py-3 font-normal">Close Price</th>
                <th className="text-right px-4 py-3 font-normal">Commission</th>
                <th className="text-right px-4 py-3 font-normal">Charge</th>
                <th className="text-center px-4 py-3 font-normal">Executed By</th>
                <th className="text-left px-4 py-3 font-normal">Remarks</th>
                <th className="text-left px-4 py-3 font-normal">Opened At</th>
                <th className="text-left px-4 py-3 font-normal">Closed At</th>
                <th className="text-right px-4 py-3 font-normal">P/L</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const pnl = Number(p.realizedPnl || 0);
                return (
                  <tr key={p._id} className="border-b border-border-subtle hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-300">{shortId(p._id)}</td>
                    <td className="px-4 py-3 font-bold text-white">
                      <div className="flex items-center gap-2">
                        <AssetIcon symbol={p.symbol} size={20} round />
                        <span>{p.symbol}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3"><SidePill side={p.side} /></td>
                    <td className="px-4 py-3 text-right font-mono">{fmtLot(p.quantity)}</td>
                    <td className="px-4 py-3 text-right font-mono">{fmtNum(p.entryPrice, 5)}</td>
                    <td className="px-4 py-3 text-right font-mono">
                      {p.closePrice ? fmtNum(p.closePrice, 5) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400">
                      {fmtNum(p.commission || '0', 2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-gray-400">
                      {fmtNum(p.swap || '0', 2)}
                    </td>
                    <td className="px-4 py-3 text-center"><ExecutedByPill /></td>
                    <td className="px-4 py-3 text-gray-400 max-w-[200px] truncate" title={remarkText(p.closeReason)}>
                      {remarkText(p.closeReason)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                      {formatDateTime(p.openedAt || p.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                      {formatDateTime(p.closedAt)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono font-semibold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer + count */}
      <div className="flex items-center justify-between text-xs text-gray-400 px-2">
        <span>
          Showing {items.length} of {pagination.total} trades
        </span>
        {pagination.pages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="btn-ghost text-xs px-2 disabled:opacity-30"
            >
              ◀ Prev
            </button>
            <span>{page} / {pagination.pages}</span>
            <button
              onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
              disabled={page >= pagination.pages}
              className="btn-ghost text-xs px-2 disabled:opacity-30"
            >
              Next ▶
            </button>
          </div>
        )}
      </div>

      {/* Summary stat strip */}
      <div className="flex flex-wrap gap-3">
        <StatCard label="Total Trades" value={summary.totalTrades.toFixed(2)} />
        <StatCard label="Total Lot" value={Number(summary.totalLot).toFixed(2)} />
        <StatCard label="Loaded Wins" value={summary.wins.toFixed(2)} positive />
        <StatCard label="Loaded Losses" value={summary.losses.toFixed(2)} negative />
        <div className="flex-1" />
        <StatCard
          label="Net P/L"
          value={`${summary.netPnl >= 0 ? '+' : ''}${Number(summary.netPnl).toFixed(2)}`}
          positive={summary.netPnl > 0}
          negative={summary.netPnl < 0}
          highlight
        />
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Mongo ObjectId hex → short numeric display id (last 8 hex chars → number). */
function shortId(id) {
  if (!id) return '';
  const tail = String(id).slice(-8);
  const num = parseInt(tail, 16);
  return Number.isFinite(num) ? String(num) : String(id).slice(-8);
}

function fmtLot(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

function formatDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const pad = (n) => String(n).padStart(2, '0');
  const dd = pad(d.getDate());
  const mm = pad(d.getMonth() + 1);
  const yy = d.getFullYear();
  let h = d.getHours();
  const m = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${dd}/${mm}/${yy}, ${pad(h)}:${m}:${s} ${ampm}`;
}

function remarkText(reason) {
  switch (reason) {
    case 'TAKE_PROFIT':       return 'PROFIT TAKEN — Target hit';
    case 'STOP_LOSS':         return 'STOP LOSS HIT';
    case 'TRAILING_STOP':     return 'TRAILING STOP HIT';
    case 'MARGIN_STOPOUT':    return 'CLOSED — Margin stop-out';
    case 'NEGATIVE_BALANCE':  return 'NEG-BALANCE PROTECTION';
    case 'MANUAL':            return 'closed by user';
    default:                  return 'N/A';
  }
}

function SidePill({ side }) {
  const isBuy = side === 'BUY';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold border ${
        isBuy
          ? 'border-bull/40 text-bull bg-bull/10'
          : 'border-bear/40 text-bear bg-bear/10'
      }`}
    >
      {isBuy ? '↗' : '↙'} {side}
    </span>
  );
}

function ExecutedByPill() {
  // No copy-trading yet → every fill is the user themselves. The pill is kept
  // so the column matches the broker spec; swap to MASTER once copy is wired.
  return (
    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-info/20 text-info border border-info/40">
      SELF
    </span>
  );
}

function StatCard({ label, value, positive, negative, highlight }) {
  const border =
    highlight && negative ? 'border-bear' :
    highlight && positive ? 'border-bull' :
    'border-border-dark';
  const valueColor =
    positive ? 'text-bull' :
    negative ? 'text-bear' :
    'text-white';
  return (
    <div className={`px-4 py-3 rounded border bg-bg-card ${border} flex items-center gap-3 min-w-[140px]`}>
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`font-mono font-bold ${valueColor}`}>{value}</span>
    </div>
  );
}
