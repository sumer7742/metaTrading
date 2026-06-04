import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Shared withdrawal modal for the standalone wallets (Main / Bonus). Pick an
 * amount + destination (UPI / Bank / Crypto); the balance is held and a
 * PENDING withdrawal goes to the admin queue (approve = payout, reject =
 * auto-refund). KYC-gated server-side.
 *
 * Props:
 *   endpoint  POST target, e.g. '/subscription-wallet/withdraw' | '/bonus-wallet/withdraw'
 *   title     header label, e.g. 'Withdraw from Main Wallet'
 *   currency  wallet currency (e.g. 'USD')
 *   balance   numeric available balance
 *   onClose / onSuccess
 */
export default function WithdrawModal({ endpoint, title = 'Withdraw', currency = 'USD', balance = 0, onClose, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('UPI');
  const [upiId, setUpiId] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankIFSC, setBankIFSC] = useState('');
  const [bankAccountHolderName, setBankAccountHolderName] = useState('');
  const [bankName, setBankName] = useState('');
  const [cryptoAddress, setCryptoAddress] = useState('');
  const [cryptoNetwork, setCryptoNetwork] = useState('TRC20');
  const [submitting, setSubmitting] = useState(false);

  const sym = currency === 'USD' ? '$' : `${currency} `;
  const bal = Number(balance || 0);
  const n = Number(amount);
  const amountValid = Number.isFinite(n) && n > 0 && n <= bal;

  const submit = async () => {
    if (!amountValid) { toast.error(n > bal ? 'Amount exceeds your balance' : 'Enter a valid amount'); return; }
    const payload = { amount: n, method };
    if (method === 'UPI') {
      if (!upiId.trim()) return toast.error('Enter your UPI ID');
      payload.upiId = upiId.trim();
    } else if (method === 'BANK') {
      if (!bankAccountNumber.trim() || !bankIFSC.trim() || !bankAccountHolderName.trim()) {
        return toast.error('Fill account number, IFSC and holder name');
      }
      Object.assign(payload, {
        bankAccountNumber: bankAccountNumber.trim(), bankIFSC: bankIFSC.trim(),
        bankAccountHolderName: bankAccountHolderName.trim(), bankName: bankName.trim(),
      });
    } else {
      if (!cryptoAddress.trim() || !cryptoNetwork.trim()) return toast.error('Enter crypto address and network');
      Object.assign(payload, { cryptoAddress: cryptoAddress.trim(), cryptoNetwork: cryptoNetwork.trim() });
    }
    setSubmitting(true);
    try {
      await api.post(endpoint, payload);
      toast.success('Withdrawal requested — pending admin approval');
      onSuccess && onSuccess();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      if (code === 'KYC_REQUIRED') toast.error('Complete KYC verification first (Profile → KYC).');
      else toast.error(errorMessage(e));
    } finally { setSubmitting(false); }
  };

  const fld = 'w-full px-3 py-2 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl border border-border-dark shadow-2xl max-h-[92vh] flex flex-col">
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between shrink-0">
          <h3 className="text-base font-bold text-text-primary">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Amount ({currency})</label>
            <div className="relative mt-1">
              <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`${fld} font-mono pr-14`} />
              <button type="button" onClick={() => setAmount(String(bal))} className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-bold text-primary-600 hover:text-primary-700">MAX</button>
            </div>
            <div className="mt-1 text-[11px] text-text-muted">Available: <span className="font-semibold text-text-secondary">{sym}{bal.toFixed(2)}</span></div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Method</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {['UPI', 'BANK', 'CRYPTO'].map((m) => (
                <button key={m} type="button" onClick={() => setMethod(m)}
                  className={`py-2 rounded-xl text-sm font-bold border transition-colors ${method === m ? 'border-primary-500 bg-primary-500/10 text-primary-600' : 'border-border-dark text-text-secondary hover:bg-bg-hover'}`}>
                  {m === 'BANK' ? 'Bank' : m === 'CRYPTO' ? 'Crypto' : 'UPI'}
                </button>
              ))}
            </div>
          </div>

          {method === 'UPI' && (
            <input value={upiId} onChange={(e) => setUpiId(e.target.value)} placeholder="UPI ID (e.g. name@bank)" className={fld} />
          )}
          {method === 'BANK' && (
            <div className="space-y-2">
              <input value={bankAccountHolderName} onChange={(e) => setBankAccountHolderName(e.target.value)} placeholder="Account holder name" className={fld} />
              <input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} placeholder="Account number" className={fld} />
              <input value={bankIFSC} onChange={(e) => setBankIFSC(e.target.value.toUpperCase())} placeholder="IFSC code" className={fld} />
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name (optional)" className={fld} />
            </div>
          )}
          {method === 'CRYPTO' && (
            <div className="space-y-2">
              <input value={cryptoAddress} onChange={(e) => setCryptoAddress(e.target.value)} placeholder="Wallet address" className={`${fld} font-mono`} />
              <select value={cryptoNetwork} onChange={(e) => setCryptoNetwork(e.target.value)} className={fld}>
                {['TRC20', 'ERC20', 'BEP20'].map((nw) => <option key={nw} value={nw}>{nw}</option>)}
              </select>
            </div>
          )}

          <div className="text-[11px] text-text-muted leading-snug rounded-lg bg-bg-hover/50 border border-border-subtle p-2.5">
            Withdrawals are reviewed by our team. The amount is held immediately, paid out on approval, and automatically refunded if rejected.
          </div>
        </div>

        <div className="p-4 border-t border-border-subtle flex items-center gap-2 shrink-0">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
          <button onClick={submit} disabled={submitting || !amountValid} className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors">
            {submitting ? 'Submitting…' : 'Request Withdrawal'}
          </button>
        </div>
      </div>
    </div>
  );
}
