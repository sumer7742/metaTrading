import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

export default function Affiliate() {
  const [summary, setSummary] = useState(null);
  const [commissions, setCommissions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [s, c] = await Promise.all([
          api.get('/compliance/affiliate/summary'),
          api.get('/compliance/affiliate/commissions'),
        ]);
        setSummary(s.data.data);
        setCommissions(c.data.data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const copyLink = () => {
    if (!summary?.referralCode) return;
    const link = `${window.location.origin}/register?ref=${summary.referralCode}`;
    navigator.clipboard.writeText(link);
    toast.success('Referral link copied');
  };

  if (loading) return <div className="text-gray-400 p-4">Loading…</div>;
  if (!summary) return <div className="text-bear p-4">Could not load affiliate data.</div>;

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Earnings"
        title="Affiliate Program"
        subtitle="Earn lifetime commissions on your referrals' trading activity across three levels deep."
      />

      {/* Referral link card */}
      <div className="card p-6">
        <div className="text-xs uppercase text-gray-500 mb-2">Your referral code</div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="font-mono text-2xl text-teal-accent">{summary.referralCode || '—'}</div>
          <button onClick={copyLink} className="btn-secondary">Copy referral link</button>
        </div>
        <p className="text-xs text-gray-500 mt-3">
          Share this link. Anyone who signs up through it becomes your referee.
        </p>
      </div>

      {/* Earnings summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card p-5">
          <div className="text-xs uppercase text-gray-500">Total Earnings</div>
          <div className="text-2xl font-bold text-white mt-1">${Number(summary.total).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-gray-500">Pending</div>
          <div className="text-2xl font-bold text-warn mt-1">${Number(summary.pending).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-gray-500">Paid Out</div>
          <div className="text-2xl font-bold text-bull mt-1">${Number(summary.paid).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
        </div>
        <div className="card p-5">
          <div className="text-xs uppercase text-gray-500">Referees</div>
          <div className="text-2xl font-bold text-white mt-1">{summary.refereeCount}</div>
        </div>
      </div>

      {/* By level */}
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((lvl) => (
          <div key={lvl} className="card p-5">
            <div className="text-xs uppercase text-gray-500">Level {lvl} earnings</div>
            <div className="text-xl font-bold text-white mt-1">${(Number(summary.byLevel?.[lvl] || 0)).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
            <div className="text-xs text-gray-500 mt-1">
              {lvl === 1 ? '20% of fees from direct referrals' : lvl === 2 ? '5% from L2' : '1% from L3'}
            </div>
          </div>
        ))}
      </div>

      {/* Commissions table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border-dark">
          <h2 className="text-white font-semibold">Recent Commissions</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-500 bg-bg-dark">
                <th className="text-left py-2 px-4">Date</th>
                <th className="text-left py-2 px-4">Level</th>
                <th className="text-left py-2 px-4">Source</th>
                <th className="text-right py-2 px-4">Rate</th>
                <th className="text-right py-2 px-4">Amount</th>
                <th className="text-left py-2 px-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {commissions.length === 0 && (
                <tr><td colSpan={6} className="text-center py-6 text-gray-500">No commissions yet — refer someone to start earning</td></tr>
              )}
              {commissions.map((c) => (
                <tr key={c._id} className="table-row">
                  <td className="py-2 px-4 text-gray-300">{new Date(c.createdAt).toLocaleString()}</td>
                  <td className="py-2 px-4 text-white">L{c.level}</td>
                  <td className="py-2 px-4 text-gray-300">{c.sourceType}</td>
                  <td className="py-2 px-4 text-right font-mono">{(Number(c.rate || 0) * 100).toFixed(1)}%</td>
                  <td className="py-2 px-4 text-right font-mono text-bull">+${Number(c.amount).toFixed(4)}</td>
                  <td className="py-2 px-4">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      c.status === 'PAID' ? 'bg-bull/15 text-bull' :
                      c.status === 'REVERSED' ? 'bg-bear/15 text-bear' :
                      'bg-warn/15 text-warn'
                    }`}>{c.status}</span>
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
