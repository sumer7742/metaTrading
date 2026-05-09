import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum, fmtMoney, fmtMoneyDual, fmtDate, currencySymbol } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';

export default function Wallet() {
  const [balances, setBalances] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [deposits, setDeposits] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [openPositions, setOpenPositions] = useState([]);
  // Map of symbol → live last price, used to mark-to-market open positions
  // and surface the unrealized P&L right inside the Wallet view (so users
  // see a profit/loss that's actually moving while a trade is open, not
  // just frozen wallet balance until they close).
  const [priceMap, setPriceMap] = useState({});
  const [tab, setTab] = useState('balances');
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [loading, setLoading] = useState(true);
  // Demo balances are visually de-emphasized by default — real money is the
  // user's actual financial position; demo is just practice. They can opt
  // to show demo balances via the toggle below the summary cards.
  const [showDemo, setShowDemo] = useState(false);
  const fxRate = useFxRate();

  const load = async () => {
    // Settled-with-fallback so a single slow/failing endpoint doesn't blank
    // the entire page. Each tab degrades to "no data" rather than the whole
    // wallet being unusable.
    const [b, a, d, w, l, p] = await Promise.allSettled([
      api.get('/wallet/balances'),
      api.get('/user/accounts'),
      api.get('/wallet/deposits'),
      api.get('/wallet/withdrawals'),
      api.get('/wallet/ledger', { params: { limit: 100 } }),
      api.get('/trading/positions'),
    ]);
    if (b.status === 'fulfilled') setBalances(b.value.data.data);
    if (a.status === 'fulfilled') setAccounts(a.value.data.data);
    if (d.status === 'fulfilled') setDeposits(d.value.data.data);
    if (w.status === 'fulfilled') setWithdrawals(w.value.data.data);
    if (l.status === 'fulfilled') setLedger(l.value.data.data);
    if (p.status === 'fulfilled') {
      const positions = p.value.data.data || [];
      setOpenPositions(positions);
      // Seed priceMap with the markPrice we already have so equity is
      // accurate on first paint, before any WS ticks arrive.
      const seed = {};
      for (const pos of positions) {
        if (pos.markPrice) seed[pos.symbol] = pos.markPrice;
      }
      setPriceMap((prev) => ({ ...seed, ...prev }));
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // Auto-refresh wallet on relevant server events. Without this the user
  // would close a profitable position and not see the credited PnL until
  // they navigated away and back.
  useEffect(() => {
    const w = wsClient.subscribe('wallet', () => load());
    const pos = wsClient.subscribe('positions', () => load());
    return () => {
      w && w();
      pos && pos();
    };
  }, []);

  // Subscribe to ticker for every symbol we hold a position in, so the
  // unrealized P&L shown in the Equity card moves in real time.
  useEffect(() => {
    if (!openPositions.length) return;
    const symbols = [...new Set(openPositions.map((p) => p.symbol))];
    const unsubs = symbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (data) => {
        setPriceMap((prev) => ({ ...prev, [sym]: data.lastPrice }));
      })
    );
    return () => unsubs.forEach((u) => u && u());
  }, [openPositions]);

  // Quick lookup: balance row → its account type. Used to scope summaries
  // and the table to REAL accounts only.
  const accountTypeById = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(String(a._id), a.accountType);
    return m;
  }, [accounts]);

  const isReal = (b) => accountTypeById.get(String(b.accountId)) === 'REAL';

  // Live unrealized PnL bucketed by account+currency. Lets the summary
  // card add "Equity = Balance + Unrealized" so the user sees the moving
  // P&L without leaving the wallet page or closing a position first.
  const unrealizedByAccountCurrency = useMemo(() => {
    const out = new Map(); // key: `${accountId}|${currency}` → number
    for (const p of openPositions) {
      const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const pnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
      // Position is denominated in the account's base currency (the
      // platform doesn't do FX yet) — so we attribute pnl there directly.
      const acc = accounts.find((a) => String(a._id) === String(p.accountId));
      const cur = acc?.baseCurrency || 'INR';
      const key = `${p.accountId}|${cur}`;
      out.set(key, (out.get(key) || 0) + pnl);
    }
    return out;
  }, [openPositions, priceMap, accounts]);

  // Per-currency totals — REAL money only. Summary cards must reflect the
  // user's actual financial position, not inflated demo numbers.
  const realTotalsByCurrency = useMemo(() => {
    const out = {};
    for (const b of balances) {
      if (!isReal(b)) continue;
      const c = b.currency || 'INR';
      if (!out[c]) out[c] = { balance: 0, locked: 0, free: 0, unrealized: 0 };
      out[c].balance += Number(b.balance || 0);
      out[c].locked += Number(b.locked || 0);
      out[c].free += Number(b.free || 0);
      const key = `${b.accountId}|${c}`;
      out[c].unrealized += unrealizedByAccountCurrency.get(key) || 0;
    }
    return out;
  }, [balances, accountTypeById, unrealizedByAccountCurrency]);

  // Same shape, demo accounts only — surfaced when user opts to see them.
  const demoTotalsByCurrency = useMemo(() => {
    const out = {};
    for (const b of balances) {
      if (isReal(b)) continue;
      const c = b.currency || 'INR';
      if (!out[c]) out[c] = { balance: 0, locked: 0, free: 0 };
      out[c].balance += Number(b.balance || 0);
      out[c].locked += Number(b.locked || 0);
      out[c].free += Number(b.free || 0);
    }
    return out;
  }, [balances, accountTypeById]);

  const realBalances = useMemo(() => balances.filter(isReal), [balances, accountTypeById]);
  const demoBalances = useMemo(() => balances.filter((b) => !isReal(b)), [balances, accountTypeById]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Wallet</h1>
        <div className="flex space-x-2">
          <button onClick={() => setShowDeposit(true)} className="btn-bull">Deposit</button>
          <button onClick={() => setShowWithdraw(true)} className="btn-ghost">Withdraw</button>
        </div>
      </div>

      <div className="card">
        <div className="flex border-b border-border-dark">
          {[
            { k: 'balances', label: 'Balances' },
            { k: 'deposits', label: `Deposits (${deposits.length})` },
            { k: 'withdrawals', label: `Withdrawals (${withdrawals.length})` },
            { k: 'ledger', label: 'Ledger' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-4 py-3 text-sm ${
                tab === t.k ? 'text-white border-b-2 border-primary-500' : 'text-gray-500'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="p-4 overflow-x-auto">
          {loading ? (
            <div className="text-gray-500 text-sm py-8 text-center">Loading wallet…</div>
          ) : tab === 'balances' && (
            <>
              {/* REAL money summary — primary focus. Demo gets a small chip
                  toggle below; not on by default because the user's actual
                  financial position is the real-account view. */}
              {Object.keys(realTotalsByCurrency).length > 0 ? (
                <div className="flex flex-wrap gap-3 mb-4">
                  {Object.entries(realTotalsByCurrency).map(([cur, t]) => {
                    const equity = t.balance + t.unrealized;
                    const hasOpenPnl = Math.abs(t.unrealized) > 0.005;
                    // INR-primary + USD-secondary money formatting. Source
                    // currency is whatever the wallet is denominated in.
                    const eq = fmtMoneyDual(equity, cur, fxRate);
                    const ur = fmtMoneyDual(t.unrealized, cur, fxRate, true);
                    const bal = fmtMoneyDual(t.balance, cur, fxRate);
                    const free = fmtMoneyDual(t.free, cur, fxRate);
                    const locked = fmtMoneyDual(t.locked, cur, fxRate);
                    return (
                      <div
                        key={cur}
                        className="flex-1 min-w-[220px] border-2 border-primary-500/30 rounded-lg p-4 bg-gradient-to-br from-primary-500/5 to-transparent"
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-wider text-primary-500 font-bold">
                            Real Equity · {cur}
                          </div>
                          <span className="text-[9px] uppercase font-bold bg-bull/15 text-bull px-2 py-0.5 rounded">
                            LIVE
                          </span>
                        </div>
                        {/* Equity = balance + unrealized PnL. INR primary,
                            USD secondary so the user always sees both views. */}
                        <div className="text-2xl font-bold text-white font-mono mt-2">{eq.primary}</div>
                        {eq.secondary && (
                          <div className="text-[11px] font-mono text-gray-500">{eq.secondary}</div>
                        )}
                        {hasOpenPnl && (
                          <div className={`text-[11px] mt-1 font-mono ${t.unrealized >= 0 ? 'text-bull' : 'text-bear'}`}>
                            {ur.primary} unrealized
                            {ur.secondary && <span className="text-gray-500 ml-1">({ur.secondary})</span>}
                          </div>
                        )}
                        <div className="text-[11px] text-gray-400 mt-2 flex items-center gap-3 flex-wrap">
                          <span>
                            Balance <span className="text-white font-mono font-semibold">{bal.primary}</span>
                            {bal.secondary && <span className="text-gray-500 ml-1">({bal.secondary})</span>}
                          </span>
                          <span className="text-gray-600">|</span>
                          <span>
                            Free <span className="text-bull font-mono">{free.primary}</span>
                          </span>
                          <span className="text-gray-600">|</span>
                          <span>
                            Locked <span className="font-mono">{locked.primary}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="border-2 border-dashed border-border-dark rounded-lg p-6 mb-4 text-center">
                  <div className="text-sm text-white font-semibold">No real balance yet</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Make a deposit to start trading with real funds.
                  </div>
                  <button onClick={() => setShowDeposit(true)} className="btn-primary mt-3 text-sm">
                    Deposit Now
                  </button>
                </div>
              )}

              {/* Real account rows — primary table */}
              {realBalances.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500 uppercase">
                    <tr>
                      <th className="text-left p-2">Account</th>
                      <th className="text-left p-2">Currency</th>
                      <th className="text-right p-2">Balance</th>
                      <th className="text-right p-2">Locked</th>
                      <th className="text-right p-2">Free</th>
                    </tr>
                  </thead>
                  <tbody>
                    {realBalances.map((b) => {
                      const acc = accounts.find((a) => a._id === b.accountId);
                      const cur = b.currency || 'INR';
                      return (
                        <tr key={b._id} className="table-row">
                          <td className="p-2">
                            <span className="font-medium text-white">
                              {acc?.nickname || acc?.accountNumber || '-'}
                            </span>{' '}
                            <span className="text-[10px] uppercase font-bold bg-bull/15 text-bull px-1.5 py-0.5 rounded ml-1">
                              REAL
                            </span>
                          </td>
                          <td className="p-2">{cur}</td>
                          <td className="p-2 text-right font-mono">{fmtMoney(b.balance, cur)}</td>
                          <td className="p-2 text-right font-mono text-gray-500">{fmtMoney(b.locked, cur)}</td>
                          <td className="p-2 text-right font-mono text-bull">{fmtMoney(b.free, cur)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {/* Demo accounts — collapsed by default with a count badge */}
              {demoBalances.length > 0 && (
                <div className="mt-6 pt-4 border-t border-border-dark">
                  <button
                    onClick={() => setShowDemo((s) => !s)}
                    className="flex items-center gap-2 text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    <span>{showDemo ? '▼' : '▶'}</span>
                    <span className="uppercase tracking-wider">Practice / Demo Balances</span>
                    <span className="bg-bg-hover text-gray-500 text-[10px] px-2 py-0.5 rounded">
                      {demoBalances.length}
                    </span>
                  </button>

                  {showDemo && (
                    <div className="mt-3 opacity-70">
                      <div className="text-[11px] text-gray-500 italic mb-2">
                        Practice money — not redeemable. Used for risk-free strategy testing.
                      </div>
                      <table className="w-full text-sm">
                        <thead className="text-xs text-gray-500 uppercase">
                          <tr>
                            <th className="text-left p-2">Account</th>
                            <th className="text-left p-2">Currency</th>
                            <th className="text-right p-2">Balance</th>
                            <th className="text-right p-2">Locked</th>
                            <th className="text-right p-2">Free</th>
                          </tr>
                        </thead>
                        <tbody>
                          {demoBalances.map((b) => {
                            const acc = accounts.find((a) => a._id === b.accountId);
                            const cur = b.currency || 'INR';
                            return (
                              <tr key={b._id} className="table-row">
                                <td className="p-2">
                                  <span className="text-gray-300">
                                    {acc?.nickname || acc?.accountNumber || '-'}
                                  </span>{' '}
                                  <span className="text-[10px] uppercase font-bold bg-info/15 text-info px-1.5 py-0.5 rounded ml-1">
                                    DEMO
                                  </span>
                                </td>
                                <td className="p-2 text-gray-400">{cur}</td>
                                <td className="p-2 text-right font-mono text-gray-400">{fmtMoney(b.balance, cur)}</td>
                                <td className="p-2 text-right font-mono text-gray-500">{fmtMoney(b.locked, cur)}</td>
                                <td className="p-2 text-right font-mono text-gray-400">{fmtMoney(b.free, cur)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {!loading && tab === 'deposits' && <DepositsTable items={deposits} />}
          {!loading && tab === 'withdrawals' && <WithdrawalsTable items={withdrawals} />}
          {!loading && tab === 'ledger' && <LedgerTable items={ledger} />}
        </div>
      </div>

      {showDeposit && (
        <DepositModal accounts={accounts} onClose={() => setShowDeposit(false)} onDone={() => { setShowDeposit(false); load(); }} />
      )}
      {showWithdraw && (
        <WithdrawModal balances={balances} accounts={accounts} onClose={() => setShowWithdraw(false)} onDone={() => { setShowWithdraw(false); load(); }} />
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const colors = {
    PENDING: 'bg-yellow-900 text-yellow-300',
    APPROVED: 'bg-blue-900 text-blue-300',
    CONFIRMED: 'bg-emerald-900 text-emerald-300',
    COMPLETED: 'bg-emerald-900 text-emerald-300',
    REJECTED: 'bg-red-900 text-red-300',
    CANCELLED: 'bg-gray-700 text-gray-400',
    PROCESSING: 'bg-blue-900 text-blue-300',
  };
  return <span className={`text-xs px-2 py-0.5 rounded ${colors[status] || ''}`}>{status}</span>;
}

function DepositsTable({ items }) {
  if (!items.length) return <div className="text-gray-500 text-sm py-4 text-center">No deposits</div>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Date</th>
          <th className="text-left p-2">Method</th>
          <th className="text-left p-2">Currency</th>
          <th className="text-right p-2">Amount</th>
          <th className="text-left p-2">Reference</th>
          <th className="text-left p-2">Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d._id} className="table-row">
            <td className="p-2">{fmtDate(d.createdAt)}</td>
            <td className="p-2">{d.method || '-'}</td>
            <td className="p-2">{d.currency}</td>
            <td className="p-2 text-right font-mono">{fmtNum(d.amount, 2)}</td>
            <td className="p-2 text-xs text-gray-400">{d.txReference || '-'}</td>
            <td className="p-2"><StatusBadge status={d.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WithdrawalsTable({ items }) {
  if (!items.length) return <div className="text-gray-500 text-sm py-4 text-center">No withdrawals</div>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Date</th>
          <th className="text-left p-2">Method</th>
          <th className="text-left p-2">Currency</th>
          <th className="text-right p-2">Amount</th>
          <th className="text-left p-2">Destination</th>
          <th className="text-left p-2">Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d._id} className="table-row">
            <td className="p-2">{fmtDate(d.createdAt)}</td>
            <td className="p-2">{d.method || '-'}</td>
            <td className="p-2">{d.currency}</td>
            <td className="p-2 text-right font-mono">{fmtNum(d.amount, 2)}</td>
            <td className="p-2 text-xs text-gray-400 truncate max-w-xs">{d.destination || '-'}</td>
            <td className="p-2"><StatusBadge status={d.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LedgerTable({ items }) {
  if (!items.length) return <div className="text-gray-500 text-sm py-4 text-center">No ledger entries</div>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-gray-500 uppercase">
        <tr>
          <th className="text-left p-2">Date</th>
          <th className="text-left p-2">Type</th>
          <th className="text-left p-2">Currency</th>
          <th className="text-right p-2">Amount</th>
          <th className="text-right p-2">Balance After</th>
          <th className="text-left p-2">Note</th>
        </tr>
      </thead>
      <tbody>
        {items.map((l) => (
          <tr key={l._id} className="table-row">
            <td className="p-2">{fmtDate(l.createdAt)}</td>
            <td className="p-2">{l.type}</td>
            <td className="p-2">{l.currency}</td>
            <td className={`p-2 text-right font-mono ${Number(l.amount) >= 0 ? 'text-bull' : 'text-bear'}`}>
              {fmtNum(l.amount, 2)}
            </td>
            <td className="p-2 text-right font-mono">{fmtNum(l.balanceAfter, 2)}</td>
            <td className="p-2 text-xs text-gray-400">{l.note || '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Modal({ children, onClose }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="card p-6 w-full max-w-md">
        {children}
        <button onClick={onClose} className="btn-ghost w-full mt-3">Cancel</button>
      </div>
    </div>
  );
}

function DepositModal({ accounts, onClose, onDone }) {
  // Prefer a REAL account by default — it's the user's actual money flow.
  // Falls back to the first account if no real one exists yet.
  const realAccount = accounts.find((a) => a.accountType === 'REAL');
  const [accountId, setAccountId] = useState(realAccount?._id || accounts[0]?._id || '');
  const [currency, setCurrency] = useState('INR');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('UPI');
  const [txReference, setTxReference] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderUpiId, setSenderUpiId] = useState('');
  const [senderBankAccount, setSenderBankAccount] = useState('');
  const [screenshot, setScreenshot] = useState(null);          // data URL
  const [screenshotMimeType, setScreenshotMimeType] = useState(null);
  const [screenshotPreview, setScreenshotPreview] = useState(null);
  const [loading, setLoading] = useState(false);

  const selectedAccount = accounts.find((a) => a._id === accountId);
  const isReal = selectedAccount?.accountType === 'REAL';
  const isDemo = selectedAccount?.accountType === 'DEMO';

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate type
    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file (PNG/JPG)');
      return;
    }

    // Validate size — max 500KB
    if (file.size > 500 * 1024) {
      toast.error('File too large. Maximum size: 500KB');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      setScreenshot(ev.target.result);
      setScreenshotMimeType(file.type);
      setScreenshotPreview(ev.target.result);
    };
    reader.readAsDataURL(file);
  };

  const removeScreenshot = () => {
    setScreenshot(null);
    setScreenshotMimeType(null);
    setScreenshotPreview(null);
  };

  const submit = async (e) => {
    e.preventDefault();

    if (isReal && !screenshot) {
      toast.error('Payment screenshot required for real account');
      return;
    }
    if (isReal && !txReference.trim()) {
      toast.error('Transaction reference required (UPI ref / bank ref)');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        accountId,
        currency,
        amount,
        method,
        txReference,
        senderName,
        senderUpiId,
        senderBankAccount,
      };
      if (isReal) {
        payload.screenshot = screenshot;
        payload.screenshotMimeType = screenshotMimeType;
      }
      await api.post('/wallet/deposits', payload);
      if (isDemo) {
        toast.success(`${fmtMoney(amount, currency)} added to demo account!`);
      } else {
        toast.success('Deposit submitted — pending admin verification');
      }
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-semibold text-white mb-3">
        {isDemo ? '🎮 Demo Top-up' : '💰 Deposit Funds'}
      </h2>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Account</label>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a._id} value={a._id}>
                {a.nickname || a.accountNumber} ({a.accountType})
              </option>
            ))}
          </select>
        </div>

        {/* Demo info banner */}
        {isDemo && (
          <div className="bg-blue-900/20 border border-blue-700/30 text-blue-200 text-xs p-3 rounded">
            ✨ Demo accounts are credited instantly — no payment needed. Use this to practice trading risk-free.
          </div>
        )}

        {/* Real money — bank details to pay to */}
        {isReal && (
          <div className="bg-bg-dark border border-primary-500/30 p-3 rounded space-y-2 text-xs">
            <div className="text-primary-500 font-semibold mb-1">📌 Pay to these details first:</div>
            <div className="grid grid-cols-[100px_1fr] gap-1">
              <span className="text-gray-500">UPI ID:</span>
              <span className="font-mono text-white">tradepro@upi</span>
              <span className="text-gray-500">Bank A/c:</span>
              <span className="font-mono text-white">XXXXXXXX1234</span>
              <span className="text-gray-500">IFSC:</span>
              <span className="font-mono text-white">HDFC0001234</span>
              <span className="text-gray-500">Name:</span>
              <span className="font-mono text-white">TradePro Pvt Ltd</span>
            </div>
            <div className="text-gray-400 mt-2 text-[11px]">
              After payment, fill the form below + upload screenshot of confirmation.
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Amount ({currencySymbol(currency)})</label>
            <input
              type="number"
              step="any"
              min={isDemo ? '1' : '100'}
              className="input font-mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={isDemo ? 'e.g. 50000' : `min ${currencySymbol(currency)}100`}
              required
            />
          </div>
          <div>
            <label className="label">Currency</label>
            <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option>INR</option>
              <option>USD</option>
              <option>USDT</option>
              <option>BTC</option>
            </select>
          </div>
        </div>

        {isReal && (
          <>
            <div>
              <label className="label">Payment Method</label>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="UPI">UPI</option>
                <option value="BANK">Bank Transfer (NEFT/IMPS)</option>
                <option value="CRYPTO">Crypto (USDT)</option>
                <option value="CARD">Card</option>
              </select>
            </div>

            <div>
              <label className="label">Transaction Reference / UPI Ref *</label>
              <input
                className="input font-mono"
                value={txReference}
                onChange={(e) => setTxReference(e.target.value)}
                placeholder="e.g. 4123456789012"
                required
              />
            </div>

            <div>
              <label className="label">Your Name (as on bank/UPI) *</label>
              <input
                className="input"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                placeholder="Full name"
                required
              />
            </div>

            {method === 'UPI' && (
              <div>
                <label className="label">Your UPI ID</label>
                <input
                  className="input font-mono"
                  value={senderUpiId}
                  onChange={(e) => setSenderUpiId(e.target.value)}
                  placeholder="e.g. yourname@upi"
                />
              </div>
            )}

            {method === 'BANK' && (
              <div>
                <label className="label">Bank A/c Last 4 Digits</label>
                <input
                  className="input font-mono"
                  maxLength={4}
                  value={senderBankAccount}
                  onChange={(e) => setSenderBankAccount(e.target.value)}
                  placeholder="1234"
                />
              </div>
            )}

            {/* SCREENSHOT UPLOAD — REQUIRED FOR REAL */}
            <div>
              <label className="label">
                Payment Screenshot * <span className="text-bear">(Required)</span>
              </label>
              {!screenshotPreview ? (
                <div className="border-2 border-dashed border-border-dark rounded-lg p-6 text-center hover:border-primary-500 transition-colors">
                  <input
                    id="screenshot-upload"
                    type="file"
                    accept="image/png,image/jpeg,image/jpg"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  <label htmlFor="screenshot-upload" className="cursor-pointer">
                    <div className="text-primary-500 text-3xl mb-2">📸</div>
                    <div className="text-sm text-white font-medium">Click to upload payment screenshot</div>
                    <div className="text-xs text-gray-500 mt-1">PNG/JPG · Max 500KB</div>
                  </label>
                </div>
              ) : (
                <div className="relative">
                  <img
                    src={screenshotPreview}
                    alt="Payment screenshot"
                    className="w-full max-h-48 object-contain rounded border border-border-dark bg-bg-dark"
                  />
                  <button
                    type="button"
                    onClick={removeScreenshot}
                    className="absolute top-1 right-1 bg-bear text-white rounded w-6 h-6 text-xs"
                  >
                    ✕
                  </button>
                  <div className="text-xs text-bull mt-1">✓ Screenshot uploaded</div>
                </div>
              )}
            </div>
          </>
        )}

        <button type="submit" disabled={loading} className="btn-primary w-full">
          {loading
            ? 'Submitting...'
            : isDemo
              ? '🎮 Add to Demo Account'
              : '💸 Submit Deposit Request'}
        </button>

        {isReal && (
          <div className="text-xs text-gray-500 text-center">
            Admin will verify your screenshot within 1-24 hours.
          </div>
        )}
      </form>
    </Modal>
  );
}

function WithdrawModal({ balances, accounts, onClose, onDone }) {
  const realAccounts = accounts.filter((a) => a.accountType === 'REAL');
  const [accountId, setAccountId] = useState(realAccounts[0]?._id || accounts[0]?._id || '');
  const [currency, setCurrency] = useState('INR');
  const [amount, setAmount] = useState('');
  // INR defaults to UPI; non-INR currencies must use CRYPTO since UPI/BANK
  // are domestic INR rails. Method is auto-flipped when currency changes.
  const [method, setMethod] = useState('UPI');
  const sym = currencySymbol(currency);

  // UPI fields
  const [upiId, setUpiId] = useState('');
  // Bank fields
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankIFSC, setBankIFSC] = useState('');
  const [bankAccountHolderName, setBankAccountHolderName] = useState('');
  const [bankName, setBankName] = useState('');
  // Crypto fields
  const [cryptoAddress, setCryptoAddress] = useState('');
  const [cryptoNetwork, setCryptoNetwork] = useState('USDT-TRC20');

  const [loading, setLoading] = useState(false);

  const selectedAccount = accounts.find((a) => a._id === accountId);
  const isDemo = selectedAccount?.accountType === 'DEMO';

  // Trust the API's pre-computed `free` field instead of recomputing from
  // balance - locked. Backend may reserve more than just `locked` (e.g.
  // pending withdrawals) — keeping this in sync with the table avoids
  // diverging numbers across the UI.
  const availableBalance = (() => {
    const wallet = balances?.find((b) => b.accountId === accountId && b.currency === currency);
    if (!wallet) return 0;
    return Math.max(0, Number(wallet.free || 0));
  })();

  // When currency changes, ensure method is compatible: UPI/BANK only for
  // INR, everything else has to be CRYPTO. Reset on every currency switch.
  useEffect(() => {
    if (currency !== 'INR' && (method === 'UPI' || method === 'BANK')) {
      setMethod('CRYPTO');
    }
  }, [currency, method]);

  const submit = async (e) => {
    e.preventDefault();

    if (isDemo) {
      toast.error('Withdrawals not allowed from demo accounts');
      return;
    }

    if (!amount || Number(amount) <= 0) {
      toast.error('Enter a valid amount');
      return;
    }

    if (Number(amount) > availableBalance) {
      toast.error(`Insufficient balance. Available: ${sym}${availableBalance.toLocaleString('en-IN')}`);
      return;
    }

    // Validate per method
    if (method === 'UPI' && (!upiId || !upiId.includes('@'))) {
      toast.error('Enter valid UPI ID (e.g. yourname@upi)');
      return;
    }
    if (method === 'BANK') {
      if (!bankAccountNumber || bankAccountNumber.length < 5) return toast.error('Bank account number required');
      if (!bankIFSC || bankIFSC.length !== 11) return toast.error('Valid 11-character IFSC required');
      if (!bankAccountHolderName) return toast.error('Account holder name required');
    }
    if (method === 'CRYPTO' && (!cryptoAddress || cryptoAddress.length < 20)) {
      toast.error('Valid crypto wallet address required');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        accountId,
        currency,
        amount,
        method,
      };
      if (method === 'UPI') payload.upiId = upiId.trim();
      if (method === 'BANK') {
        payload.bankAccountNumber = bankAccountNumber.trim();
        payload.bankIFSC = bankIFSC.trim().toUpperCase();
        payload.bankAccountHolderName = bankAccountHolderName.trim();
        payload.bankName = bankName.trim();
      }
      if (method === 'CRYPTO') {
        payload.cryptoAddress = cryptoAddress.trim();
        payload.cryptoNetwork = cryptoNetwork;
      }

      await api.post('/wallet/withdrawals', payload);
      toast.success('Withdrawal request submitted — admin will process within 24 hours');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-semibold text-white mb-3">💸 Withdraw Funds</h2>

      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Account</label>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a._id} value={a._id}>
                {a.nickname || a.accountNumber} ({a.accountType})
              </option>
            ))}
          </select>
        </div>

        {isDemo && (
          <div className="bg-bear/15 border border-bear/30 text-bear text-xs p-3 rounded">
            ⚠️ Withdrawals not allowed from demo accounts. Use a real account.
          </div>
        )}

        {!isDemo && (
          <>
            <div className="bg-bg-dark border border-border-dark p-3 rounded text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Available Balance:</span>
                <span className="font-mono text-bull font-semibold">
                  {fmtMoney(availableBalance, currency)}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Amount ({sym})</label>
                <input
                  type="number"
                  step="any"
                  min={currency === 'INR' ? '100' : '1'}
                  className="input font-mono"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={currency === 'INR' ? `min ${sym}100` : `min ${sym}1`}
                  required
                />
              </div>
              <div>
                <label className="label">Currency</label>
                <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option>INR</option>
                  <option>USD</option>
                  <option>USDT</option>
                </select>
              </div>
            </div>

            <div>
              <label className="label">Withdrawal Method</label>
              <div className="grid grid-cols-3 gap-2">
                {['UPI', 'BANK', 'CRYPTO'].map((m) => {
                  // UPI / BANK are INR-only rails. Show them disabled for
                  // non-INR currencies so the constraint is visible upfront.
                  const inrOnly = m === 'UPI' || m === 'BANK';
                  const disabled = inrOnly && currency !== 'INR';
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={disabled}
                      title={disabled ? `${m} only available for INR` : undefined}
                      onClick={() => !disabled && setMethod(m)}
                      className={`py-2 rounded text-xs font-semibold transition-all ${
                        method === m
                          ? 'bg-primary-500 text-bg-dark'
                          : disabled
                            ? 'bg-bg-dark text-gray-600 border border-border-dark opacity-40 cursor-not-allowed'
                            : 'bg-bg-dark text-gray-400 border border-border-dark hover:border-primary-500'
                      }`}
                    >
                      {m === 'UPI' ? 'UPI' : m === 'BANK' ? 'Bank' : 'Crypto'}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* UPI form */}
            {method === 'UPI' && (
              <div>
                <label className="label">Your UPI ID *</label>
                <input
                  className="input font-mono"
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  placeholder="e.g. yourname@upi or 9876543210@paytm"
                  required
                />
                <div className="text-xs text-gray-500 mt-1">Money will be sent to this UPI ID</div>
              </div>
            )}

            {/* Bank form */}
            {method === 'BANK' && (
              <>
                <div>
                  <label className="label">Account Holder Name *</label>
                  <input
                    className="input"
                    value={bankAccountHolderName}
                    onChange={(e) => setBankAccountHolderName(e.target.value)}
                    placeholder="Full name as on bank account"
                    required
                  />
                </div>
                <div>
                  <label className="label">Bank Account Number *</label>
                  <input
                    className="input font-mono"
                    value={bankAccountNumber}
                    onChange={(e) => setBankAccountNumber(e.target.value.replace(/\s/g, ''))}
                    placeholder="e.g. 50100123456789"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">IFSC Code *</label>
                    <input
                      className="input font-mono uppercase"
                      maxLength={11}
                      value={bankIFSC}
                      onChange={(e) => setBankIFSC(e.target.value.toUpperCase())}
                      placeholder="HDFC0001234"
                      required
                    />
                  </div>
                  <div>
                    <label className="label">Bank Name</label>
                    <input
                      className="input"
                      value={bankName}
                      onChange={(e) => setBankName(e.target.value)}
                      placeholder="e.g. HDFC Bank"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Crypto form */}
            {method === 'CRYPTO' && (
              <>
                <div>
                  <label className="label">Network *</label>
                  <select
                    className="input"
                    value={cryptoNetwork}
                    onChange={(e) => setCryptoNetwork(e.target.value)}
                  >
                    <option>USDT-TRC20</option>
                    <option>USDT-ERC20</option>
                    <option>USDT-BEP20</option>
                    <option>BTC</option>
                    <option>ETH</option>
                  </select>
                </div>
                <div>
                  <label className="label">Wallet Address *</label>
                  <input
                    className="input font-mono text-xs"
                    value={cryptoAddress}
                    onChange={(e) => setCryptoAddress(e.target.value.trim())}
                    placeholder="0x... or T..."
                    required
                  />
                </div>
                <div className="bg-yellow-900/20 border border-yellow-700/30 text-yellow-200 text-xs p-2 rounded">
                  ⚠️ Crypto address must be whitelisted (Profile → Whitelist) with 24h cooldown. This is a security check to prevent unauthorized withdrawals.
                </div>
              </>
            )}

            <div className="bg-blue-900/20 border border-blue-700/30 text-blue-200 text-xs p-3 rounded">
              ℹ️ Withdrawals are processed manually by admin within <strong>1-24 hours</strong>. Funds are locked from your balance immediately upon submission.
            </div>

            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading
                ? 'Submitting...'
                : `Request Withdrawal of ${fmtMoney(amount || '0', currency)}`}
            </button>
          </>
        )}
      </form>
    </Modal>
  );
}
