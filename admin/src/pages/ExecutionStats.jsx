import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum, fmtMoney, fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';
import DateFilter, { useDateFilter } from '../components/DateFilter';

const RESULT_TONE = {
  INTERNAL_MATCHING: { bar: 'bg-violet-500', text: 'text-violet-400', label: 'Internal Matching' },
  B_BOOK:            { bar: 'bg-emerald-500', text: 'text-emerald-400', label: 'B-Book' },
  A_BOOK:            { bar: 'bg-blue-500',    text: 'text-blue-400',    label: 'A-Book' },
  REJECTED:          { bar: 'bg-red-500',     text: 'text-red-400',     label: 'Rejected' },
};

export default function ExecutionStats() {
  const [range, setRange] = useDateFilter('execstats.range', '7d');
  const [stats, setStats] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        api.get('/admin/execution/stats', { params: { fromDate: range.fromDate, toDate: range.toDate, period: range.period } }),
        api.get('/admin/execution/decisions', { params: { limit: 50 } }),
      ]);
      setStats(s.data.data);
      setDecisions(d.data.data.items || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [range]);

  const dist = stats?.distribution || {};

  return (
    <div className="space-y-5 max-w-[1500px]">
      <PageHero
        eyebrow="Insights"
        title="Execution Analytics"
        subtitle="How orders are routed across Internal Matching, B-Book, A-Book and Hybrid."
      />

      {/* Period selector — global reusable DateFilter */}
      <div className="flex items-center gap-2">
        <DateFilter value={range} onChange={setRange} />
        <button onClick={load} className="text-xs px-3 py-1.5 rounded-lg border border-border-dark text-text-secondary hover:text-white ml-auto">↻ Refresh</button>
      </div>

      {/* Volume cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard label="Internal Matching Volume" value={fmtMoney(stats?.volume.internalMatching)} sub={`${fmtNum(stats?.trades.internalMatching || 0, 0)} trades`} tone="violet" loading={loading} />
        <StatCard label="B-Book Volume" value={fmtMoney(stats?.volume.bBook)} sub={`${fmtNum(stats?.trades.bBook || 0, 0)} trades`} tone="emerald" loading={loading} />
        <StatCard label="A-Book Volume" value={fmtMoney(stats?.volume.aBook)} sub={`${fmtNum(stats?.trades.aBook || 0, 0)} trades`} tone="blue" loading={loading} />
        <StatCard label="Hybrid Routed Orders" value={fmtNum(stats?.hybridRoutedOrders || 0, 0)} sub={`${fmtNum(stats?.rejectedOrders || 0, 0)} rejected`} tone="amber" loading={loading} />
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <StatCard label="User ↔ User Matched" value={fmtNum(stats?.trades.userToUserMatched || 0, 0)} sub="peer trades" tone="violet" loading={loading} />
        <StatCard label="Broker Exposure" value={fmtMoney(stats?.exposure.broker)} sub="B-book routed notional" tone="emerald" loading={loading} />
        <StatCard label="LP Exposure" value={fmtMoney(stats?.exposure.lp)} sub="A-book routed notional" tone="blue" loading={loading} />
        <StatCard label="Total Routing Decisions" value={fmtNum(stats?.totalDecisions || 0, 0)} sub={range.period || 'custom'} tone="gray" loading={loading} />
      </div>

      {/* Routing distribution */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-white mb-3">Routing Distribution</h3>
        {stats && stats.totalDecisions > 0 ? (
          <>
            <div className="flex h-3 rounded-full overflow-hidden bg-bg-dark mb-3">
              {['INTERNAL_MATCHING', 'B_BOOK', 'A_BOOK', 'REJECTED'].map((k) => {
                const pct = dist[k]?.pct || 0;
                return pct > 0 ? <div key={k} className={RESULT_TONE[k].bar} style={{ width: `${pct}%` }} title={`${RESULT_TONE[k].label} ${pct}%`} /> : null;
              })}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {['INTERNAL_MATCHING', 'B_BOOK', 'A_BOOK', 'REJECTED'].map((k) => (
                <div key={k} className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-sm ${RESULT_TONE[k].bar}`} />
                  <div>
                    <div className="text-[11px] text-text-muted">{RESULT_TONE[k].label}</div>
                    <div className={`text-sm font-bold font-mono ${RESULT_TONE[k].text}`}>
                      {dist[k]?.pct || 0}% <span className="text-text-muted font-normal">({dist[k]?.count || 0})</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="text-text-muted text-sm py-6 text-center">No routing decisions in this period.</div>
        )}
      </div>

      {/* Routing decision audit log */}
      <div className="card overflow-x-auto">
        <div className="px-4 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Recent Routing Decisions</h3>
          <span className="text-[11px] text-text-muted">Latest {decisions.length}</span>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Time</th>
              <th className="text-left p-3">User</th>
              <th className="text-left p-3">Symbol</th>
              <th className="text-left p-3">Mode</th>
              <th className="text-left p-3">Result</th>
              <th className="text-right p-3">Notional</th>
              <th className="text-left p-3">Reason</th>
            </tr>
          </thead>
          <tbody>
            {decisions.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-gray-500">No decisions recorded yet.</td></tr>
            ) : decisions.map((d) => {
              const u = d.userId;
              const name = u ? (u.email || u.userUid || '—') : '—';
              const tone = RESULT_TONE[d.routingResult] || { text: 'text-gray-400', label: d.routingResult || '—' };
              return (
                <tr key={d._id} className="border-b border-border-dark/60">
                  <td className="p-3 text-xs text-gray-400 whitespace-nowrap">{fmtDate(d.createdAt)}</td>
                  <td className="p-3 text-xs text-gray-300 truncate max-w-[180px]" title={name}>{name}</td>
                  <td className="p-3 text-xs font-mono text-gray-300">{d.symbol || '—'}</td>
                  <td className="p-3 text-xs text-gray-300">{(d.executionMode || '').replace(/_/g, ' ')}</td>
                  <td className="p-3 text-xs"><span className={`font-bold ${tone.text}`}>{tone.label}</span></td>
                  <td className="p-3 text-xs text-right font-mono text-gray-300">{fmtMoney(d.notional)}</td>
                  <td className="p-3 text-[11px] text-text-muted truncate max-w-[280px]" title={d.reason}>{d.reason}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, tone = 'gray', loading }) {
  const ring = {
    violet: 'border-violet-500/30', emerald: 'border-emerald-500/30',
    blue: 'border-blue-500/30', amber: 'border-amber-500/30', gray: 'border-border-dark',
  }[tone] || 'border-border-dark';
  return (
    <div className={`card p-4 border ${ring}`}>
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-bold">{label}</div>
      {loading ? (
        <div className="h-6 mt-2 w-2/3 rounded bg-bg-hover animate-pulse" />
      ) : (
        <div className="mt-1 text-xl font-extrabold font-mono tabular-nums text-white">{value}</div>
      )}
      {sub && !loading && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}
