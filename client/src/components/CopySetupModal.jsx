import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * CopySetupModal — small premium dialog the user sees after clicking
 * "Copy" on a master row in the leaderboard. Captures:
 *   • Investment amount (USD)
 *   • Risk level (LOW / MEDIUM / HIGH)
 *   • SL/TP sync toggle
 * Submit POSTs /copy-trading/copy and resolves with the new relation
 * so the parent page can refresh its "My copies" tab.
 */
export default function CopySetupModal({ trader, onClose, onStarted }) {
  const [investment, setInvestment] = useState('100');
  const [riskLevel, setRiskLevel] = useState('MEDIUM');
  const [syncSlTp, setSyncSlTp] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  // Load the user's real trading accounts so they can pick which one
  // the mirrored trades land in.
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/user/accounts');
        const reals = (r.data.data || []).filter(
          (a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false
        );
        setAccounts(reals);
        if (reals.length) setAccountId(reals[0]._id);
      } catch { /* non-fatal */ }
    })();
  }, []);

  const submit = async () => {
    const amt = Number(investment);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter an investment amount > $0');
      return;
    }
    setSaving(true);
    try {
      const r = await api.post('/copy-trading/copy', {
        masterId: trader.userId,
        investment: amt,
        riskLevel,
        syncSlTp,
        followerAccountId: accountId || undefined,
      });
      toast.success(`Now copying ${trader.displayName}`);
      onStarted?.(r.data.data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const RISK = [
    { id: 'LOW',    label: 'Low',    note: '0.5× master size',  tone: 'bg-emerald-50 text-emerald-700 border-emerald-300' },
    { id: 'MEDIUM', label: 'Medium', note: '1× master size',    tone: 'bg-amber-50 text-amber-700 border-amber-300' },
    { id: 'HIGH',   label: 'High',   note: '1.5× master size',  tone: 'bg-rose-50 text-rose-700 border-rose-300' },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center gap-3">
          <span className="w-10 h-10 rounded-full bg-primary-500/15 text-primary-600 flex items-center justify-center text-base font-extrabold">
            {(trader.displayName || 'T').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-extrabold text-text-primary">Copy {trader.displayName}</h3>
            <p className="text-[11px] text-text-muted truncate">
              ROI {Number(trader.roiPct || 0).toFixed(1)}% · {Number(trader.winRate || 0).toFixed(0)}% win · {trader.followers || 0} followers
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Investment amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">$</span>
              <input
                type="number"
                step="1"
                min="1"
                value={investment}
                onChange={(e) => setInvestment(e.target.value)}
                className="w-full pl-7 pr-3 py-2.5 rounded-xl border border-border-dark bg-white text-base font-mono font-bold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
              />
            </div>
            <div className="flex gap-1.5 mt-2">
              {[50, 100, 500, 1000].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setInvestment(String(q))}
                  className="text-[11px] font-bold px-2.5 py-1 rounded-md border border-border-dark text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors"
                >
                  ${q}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted mt-2 leading-snug">
              Mirrored trades are sized as <span className="font-semibold text-text-secondary">amount × master share</span>. Higher amount = bigger copy lots.
            </p>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Risk level</label>
            <div className="grid grid-cols-3 gap-2">
              {RISK.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRiskLevel(r.id)}
                  className={`rounded-xl border-2 p-2.5 text-left transition-all ${
                    riskLevel === r.id
                      ? `${r.tone} border-current shadow-sm`
                      : 'border-border-dark bg-white text-text-secondary hover:border-primary-500'
                  }`}
                >
                  <div className="text-sm font-extrabold">{r.label}</div>
                  <div className="text-[10px] mt-0.5 opacity-80">{r.note}</div>
                </button>
              ))}
            </div>
          </div>

          {accounts.length > 1 && (
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Funding account</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm focus:outline-none focus:border-primary-500"
              >
                {accounts.map((a) => (
                  <option key={a._id} value={a._id}>{a.nickname || a.accountNumber} · {a.baseCurrency}</option>
                ))}
              </select>
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={syncSlTp}
              onChange={(e) => setSyncSlTp(e.target.checked)}
              className="accent-primary-500"
            />
            <span className="text-text-primary">Sync SL/TP changes from the master</span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Starting…' : 'Start copying'}
          </button>
        </div>
      </div>
    </div>
  );
}
