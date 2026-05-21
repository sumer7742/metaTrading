import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import AssetIcon from '../components/AssetIcon';

const downloadCsv = async (path, filename) => {
  try {
    const res = await api.get(path, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast.error(errorMessage(e));
  }
};

export default function Reports() {
  const [trades, setTrades] = useState([]);
  // Aggregated stats over ALL closed positions for this user (across pages),
  // computed on the backend so we don't have to fetch + iterate the full set.
  const [stats, setStats] = useState({ totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [oh, hist] = await Promise.all([
          api.get('/trading/orders/history'),
          // limit=1 because we only need the `summary` block, not the rows.
          // The recent-activity table below uses /orders/history instead.
          api.get('/trading/positions/history', { params: { limit: 1 } }),
        ]);
        setTrades(oh.data.data);
        setStats(hist.data.data?.summary || { totalTrades: 0, totalLot: 0, netPnl: 0, wins: 0, losses: 0 });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totalPnl = Number(stats.netPnl || 0);
  const winners = Number(stats.wins || 0);
  const losers = Number(stats.losses || 0);
  const totalDecided = winners + losers; // ignore break-even (pnl===0) trades in win-rate denominator
  const winRate = totalDecided ? ((winners / totalDecided) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Analytics"
        title="Reports"
        subtitle="Trading activity, P&L, and historical performance across all your accounts."
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-5 hover:border-border-accent/40 transition-colors">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">Realized P&L</div>
          <div className={`text-2xl font-bold mt-2 font-mono ${totalPnl >= 0 ? 'text-bull' : 'text-bear'}`}>
            {totalPnl >= 0 ? '+' : ''}{Number(totalPnl).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="card p-5 hover:border-border-accent/40 transition-colors">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">Win Rate</div>
          <div className="text-2xl font-bold mt-2 font-mono text-text-primary">{winRate}%</div>
        </div>
        <div className="card p-5 hover:border-border-accent/40 transition-colors">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">Winners</div>
          <div className="text-2xl font-bold mt-2 font-mono text-bull">{winners}</div>
        </div>
        <div className="card p-5 hover:border-border-accent/40 transition-colors">
          <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">Losers</div>
          <div className="text-2xl font-bold mt-2 font-mono text-bear">{losers}</div>
        </div>
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link to="/orders" className="card p-5 hover:border-border-accent/50 hover:-translate-y-0.5 transition-all group">
          <div className="text-text-primary font-semibold group-hover:text-primary-500 transition-colors">Order History →</div>
          <div className="text-xs text-text-muted mt-1">All filled, cancelled, rejected orders</div>
        </Link>
        <Link to="/wallet" className="card p-5 hover:border-border-accent/50 hover:-translate-y-0.5 transition-all group">
          <div className="text-text-primary font-semibold group-hover:text-primary-500 transition-colors">Wallet Ledger →</div>
          <div className="text-xs text-text-muted mt-1">Deposits, withdrawals, fees, P&L</div>
        </Link>
        <Link to="/alerts" className="card p-5 hover:border-border-accent/50 hover:-translate-y-0.5 transition-all group">
          <div className="text-text-primary font-semibold group-hover:text-primary-500 transition-colors">Price Alerts →</div>
          <div className="text-xs text-text-muted mt-1">Create custom price notifications</div>
        </Link>
      </div>

      {/* CSV exports */}
      <div className="card p-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-white font-semibold">Export your data</h3>
            <p className="text-xs text-gray-400 mt-1">Download CSV files for tax or record-keeping.</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => downloadCsv('/reports/export/orders.csv', 'orders.csv')} className="btn-secondary text-sm">Orders CSV</button>
            <button onClick={() => downloadCsv('/reports/export/positions.csv', 'positions.csv')} className="btn-secondary text-sm">Positions CSV</button>
            <button onClick={() => downloadCsv('/reports/export/ledger.csv', 'ledger.csv')} className="btn-secondary text-sm">Ledger CSV</button>
          </div>
        </div>
      </div>

      {/* Recent trades */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border-dark">
          <h2 className="text-white font-semibold">Recent Order Activity</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-500 bg-bg-card">
                <th className="text-left py-2 px-4">Date</th>
                <th className="text-left py-2 px-4">Symbol</th>
                <th className="text-left py-2 px-4">Side</th>
                <th className="text-left py-2 px-4">Type</th>
                <th className="text-right py-2 px-4">Qty</th>
                <th className="text-right py-2 px-4">Price</th>
                <th className="text-left py-2 px-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={7} className="text-center py-6 text-gray-500">Loading…</td></tr>
              )}
              {!loading && trades.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-10">
                    <div className="mx-auto w-12 h-12 rounded-full bg-bg-hover flex items-center justify-center mb-2 text-text-muted">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3v18h18" />
                        <path d="M7 14l4-4 4 4 5-7" />
                      </svg>
                    </div>
                    <div className="text-sm text-text-secondary mb-1">No trades yet</div>
                    <Link to="/trade" className="text-xs text-primary-500 hover:underline font-semibold">Start trading →</Link>
                  </td>
                </tr>
              )}
              {trades.slice(0, 50).map((t) => (
                <tr key={t._id} className="table-row">
                  <td className="py-2 px-4 text-gray-300">{new Date(t.createdAt).toLocaleString()}</td>
                  <td className="py-2 px-4 text-white font-medium">
                    <div className="flex items-center gap-2">
                      <AssetIcon symbol={t.symbol} size={20} round />
                      <span>{t.symbol}</span>
                    </div>
                  </td>
                  <td className={`py-2 px-4 font-semibold ${t.side === 'BUY' ? 'text-bull' : 'text-bear'}`}>{t.side}</td>
                  <td className="py-2 px-4 text-gray-300">{t.type}</td>
                  <td className="py-2 px-4 text-right font-mono text-white">{t.filledQuantity || t.quantity}</td>
                  <td className="py-2 px-4 text-right font-mono text-white">{t.avgFillPrice || t.price || '—'}</td>
                  <td className="py-2 px-4">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                      t.status === 'FILLED' ? 'bg-bull/15 text-bull' :
                      t.status === 'CANCELLED' ? 'bg-gray-700 text-gray-400' :
                      t.status === 'REJECTED' ? 'bg-bear/15 text-bear' :
                      'bg-warn/15 text-warn'
                    }`}>{t.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
