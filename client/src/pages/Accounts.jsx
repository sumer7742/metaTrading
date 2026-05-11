import { useEffect, useState } from 'react';
import { api, errorMessage } from '../services/api';
import toast from 'react-hot-toast';
import PageHero from '../components/PageHero';

export default function Accounts() {
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  const refresh = async () => {
    try {
      const [a, b] = await Promise.all([api.get('/user/accounts'), api.get('/wallet/balances')]);
      setAccounts(a.data.data);
      setBalances(b.data.data);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const balanceFor = (accId, currency) => {
    const w = balances.find((x) => x.accountId === accId && x.currency === currency);
    return w ? w.balance : '0';
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <PageHero
        eyebrow="Portfolio"
        title="Trading Accounts"
        subtitle="Manage your live, demo, and virtual accounts. Configure leverage, mode, and nickname per account."
        actions={
          <>
            <button onClick={() => setShowTransfer(true)} className="btn-secondary text-sm">Transfer Funds</button>
            <button onClick={() => setShowCreate(true)} className="btn-primary text-sm">+ New Account</button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {accounts.map((acc) => (
          <div key={acc._id} className="card p-5 hover:border-border-accent/50 hover:-translate-y-0.5 transition-all group">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-[0.15em] text-text-muted font-bold">{acc.accountType}</div>
                <div className="text-lg font-semibold text-text-primary mt-1">{acc.nickname || acc.accountNumber}</div>
                <div className="text-xs text-text-muted mt-0.5 font-mono">{acc.accountNumber}</div>
              </div>
              <span
                className={`text-[10px] px-2 py-1 rounded uppercase font-semibold ${
                  acc.accountType === 'REAL'
                    ? 'bg-bull/15 text-bull'
                    : 'bg-teal-accent/15 text-teal-accent'
                }`}
              >
                {acc.accountType === 'REAL' ? 'LIVE' : acc.accountType}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-gray-500">Balance</div>
                <div className="text-white font-mono mt-0.5">{Number(balanceFor(acc._id, acc.baseCurrency)).toFixed(2)}</div>
              </div>
              <div>
                <div className="text-gray-500">Leverage</div>
                <div className="text-white font-mono mt-0.5">1:{acc.leverage}</div>
              </div>
              <div>
                <div className="text-gray-500">Mode</div>
                <div className="text-white font-mono mt-0.5">{acc.mode}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showCreate && (
        <CreateAccountModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      {showTransfer && (
        <TransferModal accounts={accounts} onClose={() => setShowTransfer(false)} onDone={() => { setShowTransfer(false); refresh(); }} />
      )}
    </div>
  );
}

function CreateAccountModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    accountType: 'DEMO',
    baseCurrency: 'INR',
    leverage: 100,
    mode: 'HYBRID',
    nickname: '',
    initialBalance: 100000,
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.post('/user/accounts', form);
      toast.success('Account created');
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Create Trading Account" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="label">Account Type</label>
          <select
            className="input"
            value={form.accountType}
            onChange={(e) => setForm({ ...form, accountType: e.target.value })}
          >
            <option value="DEMO">Demo</option>
            <option value="VIRTUAL">Virtual</option>
            <option value="REAL">Real</option>
          </select>
        </div>
        <div>
          <label className="label">Nickname</label>
          <input className="input" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="e.g. Scalping Account" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Base Currency</label>
            <select className="input" value={form.baseCurrency} onChange={(e) => setForm({ ...form, baseCurrency: e.target.value })}>
              <option>INR</option>
              <option>USD</option>
              <option>EUR</option>
              <option>GBP</option>
            </select>
          </div>
          <div>
            <label className="label">Leverage</label>
            <select className="input" value={form.leverage} onChange={(e) => setForm({ ...form, leverage: Number(e.target.value) })}>
              {[1, 5, 10, 20, 50, 100, 200, 500].map((l) => (
                <option key={l} value={l}>1:{l}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">Trading Mode</label>
          <select className="input" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
            <option value="INTERNAL">Internal Only</option>
            <option value="EXTERNAL">External Feed</option>
            <option value="HYBRID">Hybrid</option>
          </select>
        </div>
        {form.accountType !== 'REAL' && (
          <div>
            <label className="label">Starting Balance</label>
            <input
              type="number"
              className="input"
              value={form.initialBalance}
              onChange={(e) => setForm({ ...form, initialBalance: Number(e.target.value) })}
            />
          </div>
        )}
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={submit} disabled={submitting} className="btn-primary flex-1">
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TransferModal({ accounts, onClose, onDone }) {
  const [from, setFrom] = useState(accounts[0]?._id || '');
  const [to, setTo] = useState(accounts[1]?._id || accounts[0]?._id || '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!from || !to || from === to || !amount) {
      toast.error('Pick two different accounts and a positive amount');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/wallet/transfers', { fromAccountId: from, toAccountId: to, currency, amount });
      toast.success('Transfer complete');
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Transfer Between Accounts" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="label">From</label>
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            {accounts.map((a) => <option key={a._id} value={a._id}>{a.nickname || a.accountNumber} ({a.accountType})</option>)}
          </select>
        </div>
        <div>
          <label className="label">To</label>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {accounts.map((a) => <option key={a._id} value={a._id}>{a.nickname || a.accountNumber} ({a.accountType})</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Currency</label>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>INR</option><option>USD</option><option>EUR</option><option>GBP</option>
            </select>
          </div>
          <div>
            <label className="label">Amount</label>
            <input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={submit} disabled={submitting} className="btn-primary flex-1">
            {submitting ? 'Transferring…' : 'Transfer'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-xl border border-border-dark p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
