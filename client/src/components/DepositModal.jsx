import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Shared multi-step "Add funds" deposit modal, used by both the Main
 * Wallet and the Bonus Wallet. Parameterized by the target wallet's
 * endpoints + display name so the exact same UX (Method → Amount → Proof
 * → Review, with UPI / Bank / Crypto / Skrill / Neteller / Trading
 * account) backs every wallet.
 *
 * Props:
 *   currency        display currency (default 'USD')
 *   walletName      'Main Wallet' | 'Bonus Wallet' (default 'Main Wallet')
 *   instantEndpoint POST endpoint for the instant trading-account transfer
 *   manualEndpoint  POST endpoint for manual (admin-verified) deposits
 *   onClose, onSuccess
 */
const DEPOSIT_METHODS = [
  { id: 'UPI',      label: 'UPI',             sub: 'Instant · Free',        min: 100, kind: 'manual',  emoji: '📱' },
  { id: 'BANK',     label: 'Bank Transfer',   sub: 'NEFT / IMPS · 1-3 hrs', min: 100, kind: 'manual',  emoji: '🏦' },
  { id: 'CRYPTO',   label: 'Crypto (USDT)',   sub: 'TRC20 · ~5 min',        min: 10,  kind: 'manual',  emoji: '🪙' },
  { id: 'SKRILL',   label: 'Skrill',          sub: 'Instant',               min: 10,  kind: 'manual',  emoji: '💳' },
  { id: 'NETELLER', label: 'Neteller',        sub: 'Instant',               min: 10,  kind: 'manual',  emoji: '💳' },
  { id: 'TRADING',  label: 'Trading account', sub: 'Instant transfer',      min: 1,   kind: 'instant', emoji: '↔️' },
];

export default function DepositModal({
  currency = 'USD',
  walletName = 'Main Wallet',
  instantEndpoint = '/subscription-wallet/deposit',
  manualEndpoint = '/subscription-wallet/manual-deposit',
  onClose,
  onSuccess,
}) {
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState(null);
  const [amount, setAmount] = useState('');
  const [txReference, setTxReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderUpiId, setSenderUpiId] = useState('');
  const [senderBankAccount, setSenderBankAccount] = useState('');
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotMimeType, setScreenshotMimeType] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [accounts, setAccounts] = useState([]);
  const [walletsByAcc, setWalletsByAcc] = useState({});
  const [sourceAccountId, setSourceAccountId] = useState('');

  const sym = currency === 'USD' ? '$' : `${currency} `;
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  useEffect(() => {
    if (method?.id !== 'TRADING') return;
    (async () => {
      try {
        const [accRes, walRes] = await Promise.all([
          api.get('/user/accounts'),
          api.get('/wallet/balances'),
        ]);
        const reals = (accRes.data.data || []).filter(
          (a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL' && a.isActive !== false
        );
        setAccounts(reals);
        const map = {};
        for (const w of (walRes.data.data || [])) map[String(w.accountId)] = w;
        setWalletsByAcc(map);
        const oldest = [...reals].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        if (oldest) setSourceAccountId(oldest._id);
      } catch { /* non-fatal */ }
    })();
  }, [method?.id]);

  const onScreenshot = (file) => {
    if (!file) { setScreenshot(null); setScreenshotMimeType(null); return; }
    if (file.size > 1.5 * 1024 * 1024) { toast.error('Screenshot must be < 1.5 MB'); return; }
    const reader = new FileReader();
    reader.onload = () => { setScreenshot(reader.result); setScreenshotMimeType(file.type); };
    reader.readAsDataURL(file);
  };

  const n = Number(amount);

  const submitInstant = async () => {
    if (!sourceAccountId) return toast.error('Pick a trading account');
    setSubmitting(true);
    try {
      await api.post(instantEndpoint, { amount: n, sourceAccountId });
      toast.success(`${sym}${n.toFixed(2)} moved to ${walletName}`);
      onSuccess();
    } catch (e) {
      const code = e.response?.data?.error?.code;
      const details = e.response?.data?.error?.details;
      if (code === 'INSUFFICIENT_TRADING_BALANCE' && details) {
        toast.error(`Not enough in ${details.accountNumber} — available ${details.currency} ${details.available}.`, { duration: 5000 });
      } else if (code === 'NO_REAL_ACCOUNT') {
        toast.error('Open a real trading account first.');
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitManual = async () => {
    setSubmitting(true);
    try {
      await api.post(manualEndpoint, {
        amount: n,
        currency,
        method: method.id,
        txReference: txReference.trim(),
        senderName: senderName.trim() || undefined,
        senderUpiId: senderUpiId.trim() || undefined,
        senderBankAccount: senderBankAccount.trim() || undefined,
        screenshot,
        screenshotMimeType,
      });
      toast.success('Deposit submitted — pending admin verification');
      onSuccess();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    if (!Number.isFinite(n) || n <= 0) return toast.error('Enter a positive amount');
    if (method?.id === 'TRADING') return submitInstant();
    if (!txReference.trim()) return toast.error('Transaction reference is required');
    if (!screenshot) return toast.error('Upload a payment screenshot');
    submitManual();
  };

  const canNext = () => {
    if (step === 0) return !!method;
    if (step === 1) return Number.isFinite(n) && n > 0 && (!method?.min || n >= method.min);
    if (step === 2) return method?.id === 'TRADING' ? !!sourceAccountId : !!txReference.trim() && !!screenshot;
    return true;
  };
  const next = () => setStep((s) => Math.min(3, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const STEPS = ['Method', 'Amount', 'Proof', 'Review'];

  return (
    <div className="fixed inset-0 z-[1000] bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl border border-border-dark max-w-md w-full max-h-[92vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3.5 border-b border-border-subtle">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-text-primary">Add funds to {walletName}</h3>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <div key={s} className="flex-1 flex items-center gap-1.5">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${i < step ? 'bg-bull text-white' : i === step ? 'bg-primary-500 text-white' : 'bg-bg-hover text-text-muted'}`}>
                  {i < step ? '✓' : i + 1}
                </span>
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${i === step ? 'text-text-primary' : 'text-text-muted'}`}>{s}</span>
                {i < STEPS.length - 1 && <span className="flex-1 h-px bg-border-subtle" />}
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {step === 0 && (
            <div className="space-y-2">
              <p className="text-[11px] text-text-muted">Pick how you want to fund this wallet.</p>
              {DEPOSIT_METHODS.map((m) => {
                const active = method?.id === m.id;
                return (
                  <button key={m.id} type="button" onClick={() => setMethod(m)} className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border-2 transition-all text-left ${active ? 'border-primary-500 bg-primary-500/5' : 'border-border-dark hover:border-primary-500/40'}`}>
                    <span className="text-xl shrink-0">{m.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-text-primary">{m.label}</div>
                      <div className="text-[11px] text-text-muted">{m.sub}</div>
                    </div>
                    {m.kind === 'instant' && <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull">Instant</span>}
                    {active && <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-primary-500"><polyline points="20 6 9 17 4 12" /></svg>}
                  </button>
                );
              })}
            </div>
          )}

          {step === 1 && method && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Amount</div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">{sym.trim() || '$'}</span>
                <input type="number" step="0.01" min={method.min} autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(method.min)} className="w-full pl-7 pr-3 py-2.5 rounded-xl border border-border-dark text-lg font-mono tabular-nums font-bold focus:outline-none focus:border-primary-500" />
              </div>
              <div className="grid grid-cols-4 gap-2 mt-2">
                {[method.min, method.min * 5, method.min * 10, method.min * 50].map((q, i) => (
                  <button key={i} onClick={() => setAmount(String(q))} className="px-2 py-1.5 rounded-lg border border-border-dark text-xs font-semibold text-text-secondary hover:border-primary-500 hover:text-primary-600 transition-colors">{sym.trim() || '$'}{q}</button>
                ))}
              </div>
              <p className="text-[11px] text-text-muted mt-2">Minimum {sym.trim() || '$'}{method.min}</p>
            </div>
          )}

          {step === 2 && method && method.id === 'TRADING' && (
            <>
              <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">From trading account</div>
              {accounts.length === 0 ? (
                <div className="text-sm text-text-muted rounded-xl border border-dashed border-border-dark px-3 py-3">
                  No real trading account yet. <Link to="/accounts/new" className="text-primary-600 font-semibold hover:underline">Open one →</Link>
                </div>
              ) : (
                <select value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500">
                  {accounts.map((a) => {
                    const w = walletsByAcc[a._id];
                    return <option key={a._id} value={a._id}>{a.nickname || a.accountNumber} · {a.baseCurrency} {fmt(Number(w?.balance || 0))}</option>;
                  })}
                </select>
              )}
            </>
          )}

          {step === 2 && method && method.id !== 'TRADING' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-primary-500/30 bg-primary-500/5 px-3 py-2.5 text-[12px] text-text-secondary leading-snug">
                Send <span className="font-bold text-text-primary">{sym}{n.toFixed(2)}</span> via {method.label}, then upload proof. An admin will verify and credit your {walletName}.
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Transaction reference *</div>
                <input value={txReference} onChange={(e) => setTxReference(e.target.value)} placeholder={method.id === 'UPI' ? 'UPI reference number' : method.id === 'BANK' ? 'NEFT / IMPS / UTR number' : method.id === 'CRYPTO' ? 'Transaction hash' : 'Transaction ID'} className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500" />
              </div>
              {method.id === 'UPI' && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Sender UPI ID</div>
                  <input value={senderUpiId} onChange={(e) => setSenderUpiId(e.target.value)} placeholder="username@upi" className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500" />
                </div>
              )}
              {method.id === 'BANK' && (
                <div>
                  <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Sender bank a/c (last 4)</div>
                  <input value={senderBankAccount} onChange={(e) => setSenderBankAccount(e.target.value)} placeholder="1234" maxLength={4} className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500" />
                </div>
              )}
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Sender name (optional)</div>
                <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Name on the source account" className="w-full px-3 py-2.5 rounded-xl border border-border-dark text-sm focus:outline-none focus:border-primary-500" />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Payment screenshot *</div>
                <label className={`flex items-center justify-center gap-2 px-3 py-3 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${screenshot ? 'border-bull/40 bg-bull/5' : 'border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5'}`}>
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onScreenshot(e.target.files?.[0])} />
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={screenshot ? 'text-bull' : 'text-text-muted'}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  <span className={`text-sm font-semibold ${screenshot ? 'text-bull' : 'text-text-secondary'}`}>{screenshot ? 'Screenshot attached · click to replace' : 'Click to upload (max 1.5 MB)'}</span>
                </label>
              </div>
            </div>
          )}

          {step === 3 && method && (
            <div className="space-y-2.5 text-sm">
              <Row label="Method" value={`${method.emoji} ${method.label}`} />
              <Row label="Amount" value={`${sym}${fmt(n)}`} tone="primary" />
              {method.id === 'TRADING' ? (
                <Row label="From" value={(accounts.find((a) => a._id === sourceAccountId)?.nickname) || '—'} />
              ) : (
                <>
                  <Row label="Reference" value={txReference} mono />
                  <Row label="Proof" value={screenshot ? 'Attached' : 'Missing'} tone={screenshot ? 'bull' : 'bear'} />
                </>
              )}
              <p className="text-[11px] text-text-muted leading-snug pt-2 border-t border-border-subtle">
                {method.id === 'TRADING'
                  ? `Funds transfer instantly. Your trading wallet is debited and ${walletName} credited in one step.`
                  : 'Submission goes to admin for verification. You\'ll get a notification when the deposit is credited.'}
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border-subtle flex justify-between gap-2">
          <button onClick={step === 0 ? onClose : back} disabled={submitting} className="btn-ghost text-sm">{step === 0 ? 'Cancel' : '← Back'}</button>
          {step < 3 ? (
            <button onClick={next} disabled={!canNext()} className="btn-primary text-sm disabled:opacity-50">Continue →</button>
          ) : (
            <button onClick={submit} disabled={submitting} className="btn-primary text-sm disabled:opacity-50">{submitting ? 'Submitting…' : method?.kind === 'instant' ? `Transfer ${sym}${fmt(n)}` : 'Submit deposit'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, tone, mono }) {
  const toneCls = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : tone === 'primary' ? 'text-text-primary' : 'text-text-secondary';
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-muted text-[12px]">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} font-bold ${toneCls} truncate max-w-[60%]`}>{value}</span>
    </div>
  );
}
