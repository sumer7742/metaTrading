import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum, fmtMoneyDual, fmtDate } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

/**
 * Funds Management page — the user's money-flow hub.
 *
 * Scope (deliberately scoped narrower than the Wallet page so the two
 * complement each other instead of duplicating UI):
 *   • Top summary: real equity + demo equity, INR primary / USD secondary
 *   • Quick-action tiles that link to the relevant flow
 *   • Internal transfer form (live form here — Wallet page doesn't expose
 *     this yet, and it's the most "Funds-only" action)
 *   • Recent fund movements from the ledger (DEPOSIT / WITHDRAWAL /
 *     TRANSFER / ADJUSTMENT) — trade-driven entries are filtered out
 *     because they're tracked in the Trade history view.
 */
export default function Funds() {
  const navigate = useNavigate();
  const fxRate = useFxRate();

  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [loading, setLoading] = useState(true);

  // Transfer form state — split out so the form doesn't re-create on every
  // ledger / balance refresh.
  const [transferFromId, setTransferFromId] = useState('');
  const [transferToId, setTransferToId] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferring, setTransferring] = useState(false);

  const load = async () => {
    // Promise.allSettled so a single slow/failing endpoint doesn't blank the
    // whole page — each section degrades to "no data" independently.
    const [a, b, l] = await Promise.allSettled([
      api.get('/user/accounts'),
      api.get('/wallet/balances'),
      api.get('/wallet/ledger', { params: { limit: 30 } }),
    ]);
    if (a.status === 'fulfilled') setAccounts(a.value.data.data);
    if (b.status === 'fulfilled') setBalances(b.value.data.data);
    if (l.status === 'fulfilled') setLedger(l.value.data.data);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // Set default transfer endpoints once accounts arrive (first real → first demo).
  useEffect(() => {
    if (!accounts.length || transferFromId) return;
    const real = accounts.find((a) => a.accountType === 'REAL');
    const demo = accounts.find((a) => a.accountType === 'DEMO' || a.accountType === 'VIRTUAL');
    if (real && demo) {
      setTransferFromId(real._id);
      setTransferToId(demo._id);
    } else if (accounts.length >= 2) {
      setTransferFromId(accounts[0]._id);
      setTransferToId(accounts[1]._id);
    }
  }, [accounts, transferFromId]);

  // Aggregate balances by REAL vs DEMO. Each bucket also tracks per-currency
  // totals so the headline cards can show INR primary + USD secondary.
  const accountTypeById = useMemo(() => {
    const m = {};
    for (const a of accounts) m[a._id] = a.accountType;
    return m;
  }, [accounts]);

  const totals = useMemo(() => {
    const real = { byCurrency: {}, total: 0 };
    const demo = { byCurrency: {}, total: 0 };
    for (const b of balances) {
      const isReal = accountTypeById[b.accountId] === 'REAL';
      const bucket = isReal ? real : demo;
      const cur = b.currency || 'INR';
      bucket.byCurrency[cur] = (bucket.byCurrency[cur] || 0) + Number(b.balance || 0);
    }
    return { real, demo };
  }, [balances, accountTypeById]);

  // Pick the primary currency (INR if present, else first available). The
  // dual formatter handles INR ↔ USD; other currencies render as raw native.
  const primaryCurrency = useMemo(() => {
    if (totals.real.byCurrency.INR != null) return 'INR';
    return Object.keys(totals.real.byCurrency)[0] || 'INR';
  }, [totals]);

  const realBalance = totals.real.byCurrency[primaryCurrency] || 0;
  const demoBalance = totals.demo.byCurrency[primaryCurrency] || 0;

  // Recent activity: only fund-movement ledger types.
  const fundsLedger = useMemo(() => {
    const FUND_TYPES = new Set(['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'ADJUSTMENT']);
    return ledger.filter((l) => FUND_TYPES.has(l.type)).slice(0, 10);
  }, [ledger]);

  const accountLabel = (id) => {
    const a = accounts.find((x) => x._id === id);
    if (!a) return '-';
    return `${a.nickname || a.accountNumber} · ${a.accountType}`;
  };

  const submitTransfer = async (e) => {
    e.preventDefault();
    if (!transferFromId || !transferToId) return toast.error('Select both accounts');
    if (transferFromId === transferToId) return toast.error('From and To must differ');
    const amt = Number(transferAmount);
    if (!Number.isFinite(amt) || amt <= 0) return toast.error('Enter a valid amount');

    setTransferring(true);
    try {
      const fromAcc = accounts.find((a) => a._id === transferFromId);
      const toAcc = accounts.find((a) => a._id === transferToId);
      const currency = fromAcc?.baseCurrency || toAcc?.baseCurrency || 'INR';
      await api.post('/wallet/transfers', {
        fromAccountId: transferFromId,
        toAccountId: transferToId,
        currency,
        amount: amt,
        note: transferNote || undefined,
      });
      toast.success(`Transferred ${amt} ${currency}`);
      setTransferAmount('');
      setTransferNote('');
      // Refresh balances + ledger so the user sees the move land instantly.
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setTransferring(false);
    }
  };

  if (loading) {
    return <div className="text-text-secondary p-4">Loading funds…</div>;
  }

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold text-white">Funds Management</h1>
        <p className="text-sm text-text-secondary mt-2">
          Deposit, withdraw, and move money between your accounts.
        </p>
      </div>

      {/* Summary cards — INR primary + USD secondary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <SummaryCard
          tone="primary"
          label="Total Real Balance"
          value={fmtMoneyDual(realBalance, primaryCurrency, fxRate)}
          accentClass="border-l-primary-500"
        />
        <SummaryCard
          tone="muted"
          label="Total Demo Balance"
          value={fmtMoneyDual(demoBalance, primaryCurrency, fxRate)}
          accentClass="border-l-border-dark"
          chip="DEMO"
        />
      </div>

      {/* Quick actions — link to the Wallet page for deposit/withdraw flows so
          we don't duplicate the modal logic that already lives there. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ActionTile
          icon={<DepositIcon />}
          tone="bull"
          title="Deposit"
          description="Add funds via UPI, bank transfer, or crypto."
          onClick={() => navigate('/wallet?action=deposit')}
        />
        <ActionTile
          icon={<WithdrawIcon />}
          tone="warn"
          title="Withdraw"
          description="Send your money to bank, UPI, or whitelisted crypto address."
          onClick={() => navigate('/wallet?action=withdraw')}
        />
        <ActionTile
          icon={<TransferIcon />}
          tone="info"
          title="Internal Transfer"
          description="Move funds between your real and demo accounts instantly."
          onClick={() => {
            const el = document.getElementById('funds-transfer');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
      </div>

      {/* Internal transfer form */}
      <div id="funds-transfer" className="card p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Internal Transfer</h2>
        <p className="text-xs text-text-secondary mt-1">
          Move funds between two of your trading accounts. No fees · settles instantly.
        </p>

        {accounts.length < 2 ? (
          <div className="mt-4 text-sm text-text-secondary">
            You need at least two trading accounts to transfer.{' '}
            <Link to="/accounts" className="text-primary-500 hover:underline">
              Open another account
            </Link>
            .
          </div>
        ) : (
          <form onSubmit={submitTransfer} className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="label">From</label>
              <select
                value={transferFromId}
                onChange={(e) => setTransferFromId(e.target.value)}
                className="input"
              >
                {accounts.map((a) => (
                  <option key={a._id} value={a._id}>
                    {a.nickname || a.accountNumber} · {a.accountType} · {a.baseCurrency}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">To</label>
              <select
                value={transferToId}
                onChange={(e) => setTransferToId(e.target.value)}
                className="input"
              >
                {accounts
                  .filter((a) => a._id !== transferFromId)
                  .map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.nickname || a.accountNumber} · {a.accountType} · {a.baseCurrency}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label">Amount</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                placeholder="0.00"
                className="input"
                required
              />
            </div>
            <div>
              <label className="label">Note (optional)</label>
              <input
                type="text"
                maxLength={140}
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                placeholder="e.g. Top up demo for backtesting"
                className="input"
              />
            </div>
            <div className="sm:col-span-2 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-xs text-text-muted">
                {transferFromId && transferToId && (
                  <>
                    Transfer from{' '}
                    <span className="text-text-secondary">{accountLabel(transferFromId)}</span>{' '}
                    to{' '}
                    <span className="text-text-secondary">{accountLabel(transferToId)}</span>
                  </>
                )}
              </div>
              <button
                type="submit"
                disabled={transferring || !transferAmount}
                className="btn-primary"
              >
                {transferring ? 'Transferring…' : 'Transfer'}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Recent activity */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-white font-semibold">Recent Fund Movements</h3>
          <Link to="/wallet" className="text-xs text-primary-500 hover:underline">
            View full ledger →
          </Link>
        </div>
        {!fundsLedger.length ? (
          <div className="p-8 text-center text-sm text-text-secondary">
            No deposits, withdrawals or transfers yet.
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {fundsLedger.map((entry) => {
              const amt = Number(entry.amount);
              const isCredit = amt > 0 || (typeof entry.amount === 'string' && entry.amount.startsWith('+'));
              const isDebit = amt < 0 || (typeof entry.amount === 'string' && entry.amount.startsWith('-'));
              const dual = fmtMoneyDual(Math.abs(amt), entry.currency || primaryCurrency, fxRate);
              return (
                <div
                  key={entry._id}
                  className="px-5 py-3 flex items-center justify-between gap-4 hover:bg-bg-hover transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <TypeBadge type={entry.type} />
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">
                        {entry.note || labelForType(entry.type)}
                      </div>
                      <div className="text-[11px] text-text-muted">
                        {fmtDate(entry.createdAt)} · {entry.currency || 'INR'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div
                      className={`font-mono text-sm ${
                        isCredit ? 'text-bull' : isDebit ? 'text-bear' : 'text-white'
                      }`}
                    >
                      {isCredit ? '+' : isDebit ? '-' : ''}
                      {dual.primary}
                    </div>
                    {dual.secondary && (
                      <div className="text-[10px] text-text-muted font-mono">{dual.secondary}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accentClass = '', chip, tone = 'primary' }) {
  return (
    <div className={`card p-5 border-l-4 ${accentClass}`}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-text-secondary">{label}</div>
        {chip && (
          <span className="text-[9px] uppercase font-bold bg-bg-hover text-text-muted px-2 py-0.5 rounded">
            {chip}
          </span>
        )}
      </div>
      <div className={`text-2xl font-bold mt-2 font-mono ${tone === 'primary' ? 'text-white' : 'text-text-secondary'}`}>
        {value.primary}
      </div>
      {value.secondary && (
        <div className="text-[11px] mt-0.5 font-mono text-text-muted">{value.secondary}</div>
      )}
    </div>
  );
}

function ActionTile({ icon, title, description, onClick, tone }) {
  // Tone hints the accent color on hover so each tile is visually distinct
  // even though they share layout.
  const hoverBorder =
    tone === 'bull' ? 'hover:border-bull/60' :
    tone === 'warn' ? 'hover:border-warn/60' :
    'hover:border-info/60';
  const iconColor =
    tone === 'bull' ? 'text-bull bg-bull/10 border-bull/30' :
    tone === 'warn' ? 'text-warn bg-warn/10 border-warn/30' :
    'text-info bg-info/10 border-info/30';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`card text-left p-5 transition-colors ${hoverBorder}`}
    >
      <div className={`w-12 h-12 rounded-lg flex items-center justify-center border ${iconColor}`}>
        {icon}
      </div>
      <div className="text-white font-semibold mt-4">{title}</div>
      <div className="text-xs text-text-secondary mt-1">{description}</div>
    </button>
  );
}

function TypeBadge({ type }) {
  const map = {
    DEPOSIT: { label: 'Deposit', cls: 'bg-bull/15 text-bull border-bull/30' },
    WITHDRAWAL: { label: 'Withdraw', cls: 'bg-bear/15 text-bear border-bear/30' },
    TRANSFER: { label: 'Transfer', cls: 'bg-info/15 text-info border-info/30' },
    ADJUSTMENT: { label: 'Adjustment', cls: 'bg-warn/15 text-warn border-warn/30' },
  };
  const t = map[type] || { label: type, cls: 'bg-bg-hover text-text-secondary border-border-dark' };
  return (
    <span className={`text-[10px] uppercase font-bold px-2 py-1 rounded border ${t.cls} shrink-0`}>
      {t.label}
    </span>
  );
}

function labelForType(type) {
  const map = { DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal', TRANSFER: 'Internal transfer', ADJUSTMENT: 'Adjustment' };
  return map[type] || type;
}

// ─── Icons ───
const Svg = ({ children, ...p }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
);

const DepositIcon = () => (
  <Svg>
    <path d="M12 5v14" />
    <polyline points="19 12 12 19 5 12" />
  </Svg>
);

const WithdrawIcon = () => (
  <Svg>
    <path d="M12 19V5" />
    <polyline points="5 12 12 5 19 12" />
  </Svg>
);

const TransferIcon = () => (
  <Svg>
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </Svg>
);
