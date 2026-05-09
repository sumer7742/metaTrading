import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/admin/dashboard');
        setStats(data.data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="text-gray-400">Loading dashboard...</div>;
  if (!stats) return <div className="text-bear">Failed to load dashboard</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        <p className="text-sm text-gray-400 mt-1">Real-time platform overview</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Stat label="Total Users" value={stats.totalUsers} />
        <Stat label="Active 24h" value={stats.activeUsers24h} />
        <Stat label="Trades 24h" value={stats.trades24h} />
        <Stat label="Open Positions" value={stats.openPositions} />
        <Stat label="KYC Pending" value={stats.kycPending} accent={stats.kycPending > 0 ? 'warn' : 'default'} />
        <Stat label="Withdrawals Pending" value={stats.withdrawPending} accent={stats.withdrawPending > 0 ? 'warn' : 'default'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-5">
          <h2 className="font-semibold text-white mb-4">Trade Volume by Routing (Last 7 Days)</h2>
          {stats.volumeByRouting.length === 0 ? (
            <div className="text-gray-500 text-sm">No trades yet</div>
          ) : (
            <div className="space-y-2">
              {stats.volumeByRouting.map((v) => (
                <div key={v._id} className="flex items-center justify-between bg-bg-dark p-3 rounded">
                  <span className="text-sm text-gray-300">{v._id || 'UNKNOWN'}</span>
                  <span className="font-mono text-white">{v.count} trades</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card p-5">
          <h2 className="font-semibold text-white mb-4">Net Exposure (Open Positions)</h2>
          {stats.exposure.length === 0 ? (
            <div className="text-gray-500 text-sm">No open positions</div>
          ) : (
            <div className="space-y-1">
              {stats.exposure.map((e, i) => (
                <div key={i} className="flex items-center justify-between bg-bg-dark p-2 rounded text-sm">
                  <span className="text-gray-300">{e._id.symbol}</span>
                  <span className={e._id.side === 'BUY' ? 'text-bull' : 'text-bear'}>
                    {e._id.side} {fmtNum(e.total, 4)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  const cls = accent === 'warn' ? 'text-yellow-400' : 'text-white';
  return (
    <div className="card p-4">
      <div className="text-xs text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
