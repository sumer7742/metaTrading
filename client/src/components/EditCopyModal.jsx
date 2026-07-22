import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import CopySettingsFields, { settingsPayload } from './CopySettingsFields';

/**
 * EditCopyModal — edit an existing copy relation IN PLACE (no new session):
 * lot size, multipliers, copy SL/TP/pending, max open trades, and the
 * destination trading account. Changing the account with open copied positions
 * shows a confirmation asking whether to close them or keep them open.
 * Saves via PUT /copy-trading/copy/:id.
 */

const sym = (c) => (c === 'USD' ? '$' : c === 'INR' ? '₹' : `${c} `);

export default function EditCopyModal({ rel, onClose, onSaved }) {
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [accountId, setAccountId] = useState(String(rel.followerAccountId || ''));
  const [settings, setSettings] = useState({
    lotMode: rel.lotMode || 'MEDIUM',
    customLot: rel.customLot != null ? String(rel.customLot) : '0.10',
    maxLot: rel.maxLot != null ? String(rel.maxLot) : '',
    copySL: rel.copySL !== false,
    copyTP: rel.copyTP !== false,
    copyPending: !!rel.copyPending,
  });
  const set = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const [saving, setSaving] = useState(false);
  const [confirmAccount, setConfirmAccount] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [ar, br] = await Promise.all([
          api.get('/user/accounts'),
          api.get('/wallet/balances').catch(() => ({ data: { data: [] } })),
        ]);
        setAccounts((ar.data.data || []).filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false));
        setBalances(br.data.data || []);
      } catch { /* non-fatal */ }
    })();
  }, []);

  const balanceOf = (a) => {
    const w = balances.find((b) => String(b.accountId) === String(a._id) && b.currency === a.baseCurrency);
    return w ? Number(w.free ?? w.balance ?? 0) : null;
  };
  const accountChanged = String(accountId) !== String(rel.followerAccountId || '');
  const hasOpen = (rel.openMirrors || []).length > 0;

  const doSave = async (closePositions) => {
    setSaving(true);
    try {
      await api.put(`/copy-trading/copy/${rel._id}`, {
        followerAccountId: accountId,
        closePositions: !!closePositions,
        ...settingsPayload(settings),
      });
      toast.success('Copy updated');
      onSaved?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const onSaveClick = () => {
    if (settings.lotMode === 'CUSTOM' && !(Number(settings.customLot) > 0)) return toast.error('Enter a custom lot size greater than 0');
    if (accountChanged && hasOpen) { setConfirmAccount(true); return; } // ask about open positions
    doSave(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full max-h-[92vh] overflow-y-auto no-scrollbar" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between sticky top-0 bg-bg-card z-10">
          <h3 className="font-extrabold text-text-primary truncate">Edit copy · {rel.master?.displayName || 'Trader'}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {confirmAccount ? (
          /* ── Change-account confirmation ── */
          <div className="p-5 space-y-4">
            <div>
              <div className="font-extrabold text-text-primary">You are changing the trading account.</div>
              <p className="text-[13px] text-text-secondary mt-1">
                What should happen to the <span className="font-semibold">{(rel.openMirrors || []).length} open copied position(s)</span> in the current account? Future copied trades go to the new account either way.
              </p>
            </div>
            <div className="space-y-2">
              <button onClick={() => doSave(true)} disabled={saving}
                className="w-full text-left rounded-xl border-2 border-bear/40 bg-bear/5 p-3 hover:border-bear transition-colors disabled:opacity-50">
                <div className="font-bold text-text-primary">Close automatically</div>
                <div className="text-[12px] text-text-secondary">Market-close all open copied positions now, then switch account.</div>
              </button>
              <button onClick={() => doSave(false)} disabled={saving}
                className="w-full text-left rounded-xl border-2 border-border-dark p-3 hover:border-primary-500 transition-colors disabled:opacity-50">
                <div className="font-bold text-text-primary">I will close manually</div>
                <div className="text-[12px] text-text-secondary">Leave them open — you close them yourself from the Trade page.</div>
              </button>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setConfirmAccount(false)} disabled={saving} className="btn-ghost text-sm">Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-5 space-y-4">
              {/* Destination account */}
              <div>
                <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Trading account</label>
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15">
                  {accounts.map((a) => {
                    const bal = balanceOf(a);
                    return <option key={a._id} value={a._id}>{a.nickname || a.accountNumber} · {a.baseCurrency}{bal != null ? ` · ${sym(a.baseCurrency)}${bal.toFixed(2)}` : ''}</option>;
                  })}
                </select>
                {accountChanged && hasOpen && (
                  <p className="text-[11px] text-amber-700 mt-1.5">Changing account — you'll choose what happens to open positions on save.</p>
                )}
              </div>

              {/* Lot size + settings (shared component, advanced open by default in edit) */}
              <CopySettingsFields settings={settings} set={set} advancedDefault />
            </div>

            <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2 sticky bottom-0 bg-bg-card">
              <button onClick={onClose} disabled={saving} className="btn-ghost text-sm">Cancel</button>
              <button onClick={onSaveClick} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
