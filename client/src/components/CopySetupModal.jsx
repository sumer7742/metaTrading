import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import CopySettingsFields, { defaultSettings, settingsPayload } from './CopySettingsFields';

/**
 * CopySetupModal (v2 — account-based) — the dialog after clicking "Copy".
 * Picks a destination trading account (no investment / copy wallet), shows a
 * balance warning (advisory), and captures lot size + copy settings.
 */

const sym = (c) => (c === 'USD' ? '$' : c === 'INR' ? '₹' : `${c} `);

export default function CopySetupModal({ trader, onClose, onStarted }) {
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [settings, setSettings] = useState(defaultSettings);
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [feePct, setFeePct] = useState(
    trader?.performanceFeePercent != null ? Number(trader.performanceFeePercent) : null
  );

  useEffect(() => {
    (async () => {
      try {
        const [ar, br] = await Promise.all([
          api.get('/user/accounts'),
          api.get('/wallet/balances').catch(() => ({ data: { data: [] } })),
        ]);
        const reals = (ar.data.data || []).filter(
          (a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false
        );
        setAccounts(reals);
        setBalances(br.data.data || []);
        if (reals.length) setAccountId(reals[0]._id);
      } catch { /* non-fatal */ }
    })();
  }, []);

  useEffect(() => {
    if (feePct != null) return;
    (async () => {
      try {
        const r = await api.get(`/copy-trading/trader/${trader.userId}`);
        const p = r.data?.data?.earnings?.performanceFeePercent;
        if (p != null) setFeePct(Number(p));
      } catch { /* leave hidden */ }
    })();
  }, []);

  useEffect(() => {
    if (!accountId) { setPreview(null); return; }
    let dead = false;
    (async () => {
      try {
        const r = await api.get('/copy-trading/copy-preview', {
          params: { followerAccountId: accountId, masterAccountId: trader.accountId },
        });
        if (!dead) setPreview(r.data.data);
      } catch { if (!dead) setPreview(null); }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const balanceOf = (a) => {
    const w = balances.find((b) => String(b.accountId) === String(a._id) && b.currency === a.baseCurrency);
    return w ? Number(w.free ?? w.balance ?? 0) : null;
  };

  const submit = async () => {
    if (!accountId) return toast.error('Select a trading account');
    if (settings.lotMode === 'CUSTOM' && !(Number(settings.customLot) > 0)) return toast.error('Enter a custom lot size greater than 0');
    setSaving(true);
    try {
      const r = await api.post('/copy-trading/copy', {
        masterAccountId: trader.accountId,
        followerAccountId: accountId,
        ...settingsPayload(settings),
      });
      toast.success(`Now copying ${trader.displayName}`);
      onStarted?.(r.data.data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full max-h-[92vh] overflow-y-auto no-scrollbar" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-subtle flex items-center gap-3 sticky top-0 bg-bg-card z-10">
          <span className="w-10 h-10 rounded-full bg-primary-500/15 text-primary-600 flex items-center justify-center text-base font-extrabold">
            {(trader.displayName || 'T').slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-extrabold text-text-primary truncate">Copy {trader.displayName}</h3>
            <p className="text-[11px] text-text-muted truncate">
              ROI {Number(trader.roiPct || 0).toFixed(1)}% · {Number(trader.winRate || 0).toFixed(0)}% win · {trader.followers || 0} followers
            </p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Trading account (destination) */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Trading account</label>
            <p className="text-[11px] text-text-muted mb-2 leading-snug">Copied trades open in this account — its balance, margin, swaps and P&L.</p>
            {accounts.length === 0 ? (
              <div className="text-text-muted text-sm py-2">No live trading account found.</div>
            ) : (
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15">
                {accounts.map((a) => {
                  const bal = balanceOf(a);
                  return (
                    <option key={a._id} value={a._id}>
                      {a.nickname || a.accountNumber} · {a.baseCurrency}{bal != null ? ` · ${sym(a.baseCurrency)}${bal.toFixed(2)}` : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* Balance validation (advisory) */}
          {preview && (
            <div className={`rounded-xl border p-3 ${preview.lowBalance ? 'border-amber-300 bg-amber-50/70' : 'border-border-dark bg-bg-hover/40'}`}>
              <div className="grid grid-cols-2 gap-3 text-center">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Current balance</div>
                  <div className="text-lg font-extrabold text-text-primary font-mono tabular-nums">{sym(preview.currency)}{Number(preview.currentBalance).toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Recommended</div>
                  <div className="text-lg font-extrabold text-text-secondary font-mono tabular-nums">{sym(preview.currency)}{Number(preview.recommendedBalance).toFixed(2)}</div>
                </div>
              </div>
              {preview.lowBalance && (
                <p className="text-[11px] text-amber-700 mt-2 flex items-start gap-1.5">
                  <span aria-hidden>⚠</span>
                  <span><span className="font-semibold">Low balance.</span> Future copied trades may fail from insufficient margin — you can still copy.</span>
                </p>
              )}
            </div>
          )}

          {/* Lot size + copy settings (shared component) */}
          <CopySettingsFields settings={settings} set={set} />

          {/* Performance fee disclosure */}
          {feePct != null && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wider font-bold text-amber-700">{feePct > 0 ? 'Performance Fee' : 'Profit Settlement'}</span>
                {feePct > 0 && <span className="text-sm font-extrabold text-amber-700">{feePct}%</span>}
              </div>
              <p className="text-[11px] text-amber-800/80 mt-1 leading-snug">
                {feePct > 0
                  ? <>{trader.displayName} earns <span className="font-semibold">{feePct}%</span> of your <span className="font-semibold">profit</span> on winning copied trades. <span className="font-semibold">No fee</span> on losses. Profits pay to your Main Wallet.</>
                  : 'No performance fee on this trader.'}
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2 sticky bottom-0 bg-bg-card">
          <button onClick={onClose} disabled={saving} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={saving || !accountId} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Starting…' : 'Start copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
