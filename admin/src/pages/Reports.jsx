import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { fmtNum, fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

export default function Reports() {
  const [trades, setTrades] = useState([]);
  const [filter, setFilter] = useState({ symbol: '', from: '', to: '' });

  const load = async () => {
    const params = { limit: 500 };
    if (filter.symbol) params.symbol = filter.symbol;
    if (filter.from) params.from = filter.from;
    if (filter.to) params.to = filter.to;
    const { data } = await api.get('/admin/reports/trades', { params });
    setTrades(data.data);
  };

  useEffect(() => { load(); }, []);

  const exportCSV = () => {
    const headers = ['Time', 'Symbol', 'Price', 'Quantity', 'Routing', 'BuyUserId', 'SellUserId'];
    const rows = trades.map((t) => [
      new Date(t.executedAt).toISOString(),
      t.symbol,
      t.price,
      t.quantity,
      t.routing,
      t.buyUserId,
      t.sellUserId,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trades-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalVolume = trades.reduce((sum, t) => sum + Number(t.price) * Number(t.quantity), 0);

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Insights"
        title="Trade Reports"
        subtitle="Filter trades by symbol or date range. Export CSV for compliance and audit trails."
      />

      <div className="card p-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label">Symbol</label>
          <input className="input w-32 font-mono uppercase" value={filter.symbol} onChange={(e) => setFilter({ ...filter, symbol: e.target.value })} placeholder="ANY" />
        </div>
        <div>
          <label className="label">From</label>
          <input type="date" className="input" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />
        </div>
        <button onClick={load} className="btn-primary">Apply</button>
        <button onClick={exportCSV} className="btn-ghost">Export CSV</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase">Trades</div>
          <div className="text-2xl font-semibold text-white mt-1">{trades.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase">Total Volume</div>
          <div className="text-2xl font-semibold text-white mt-1">{fmtNum(totalVolume, 2)}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase">Unique Symbols</div>
          <div className="text-2xl font-semibold text-white mt-1">{new Set(trades.map((t) => t.symbol)).size}</div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Time</th>
              <th className="text-left p-3">Symbol</th>
              <th className="text-right p-3">Price</th>
              <th className="text-right p-3">Quantity</th>
              <th className="text-right p-3">Volume</th>
              <th className="text-left p-3">Routing</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t._id} className="table-row">
                <td className="p-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(t.executedAt)}</td>
                <td className="p-3 font-medium">{t.symbol}</td>
                <td className="p-3 text-right font-mono">{fmtNum(t.price, 4)}</td>
                <td className="p-3 text-right font-mono">{fmtNum(t.quantity, 4)}</td>
                <td className="p-3 text-right font-mono">{fmtNum(Number(t.price) * Number(t.quantity), 2)}</td>
                <td className="p-3 text-xs">{t.routing}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!trades.length && <div className="text-center text-gray-500 py-6 text-sm">No trades match filter</div>}
      </div>
    </div>
  );
}
