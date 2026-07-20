import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtNum, fmtMoney, fmtMoneyDual, fmtMoneyBoth, fmtDate, currencySymbol } from '../utils/format';
import { useFxRate } from '../hooks/useFxRate';
import PageHero from '../components/PageHero';
import TransactionHistory from '../components/TransactionHistory';
import AccountOverview from '../components/AccountOverview';
import { useAuthStore } from '../store/auth';

export default function Wallet() {
  const { user } = useAuthStore();
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
  // Withdraw now lives inline on the 'withdraw' view — no modal state needed.
  const [loading, setLoading] = useState(true);
  // Demo balances are visually de-emphasized by default — real money is the
  // user's actual financial position; demo is just practice. They can opt
  // to show demo balances via the toggle below the summary cards.
  const [showDemo, setShowDemo] = useState(false);
  const fxRate = useFxRate();
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Sticky-sidebar anchor ────────────────────────────────────────────
  // The global header (nav bar + instrument strip) is `sticky top-0`, and
  // its height varies by breakpoint (the strip is hidden below `sm`). The
  // left nav is `sticky` too — but for it to sit perfectly still on scroll
  // (no upward drift, no tucking under the header) its `top` must equal its
  // natural resting position: header height + the page's 24px top padding
  // (`py-6`). We measure the header at runtime instead of hardcoding a
  // fragile pixel value, and re-measure on resize.
  const [stickyTop, setStickyTop] = useState(136);
  useLayoutEffect(() => {
    const measure = () => {
      const header = document.querySelector('header');
      const h = header ? Math.round(header.getBoundingClientRect().height) : 112;
      setStickyTop(h + 24); // + main content's py-6 top padding
    };
    measure();
    window.addEventListener('resize', measure);
    // The instrument strip streams in async (live prices) and can change
    // height once loaded — re-measure a beat later to catch that.
    const t = setTimeout(measure, 600);
    return () => { window.removeEventListener('resize', measure); clearTimeout(t); };
  }, []);

  // Ref captures a pending deep-link target (e.g. "withdraw") so a later
  // effect that wires up `setView` can consume it once the view-state
  // exists. Declared BEFORE the effect that writes to it — fragile
  // initialization order was the bug previously.
  const pendingDeepLinkRef = useRef(null);

  // Deep-link from /funds, header CTAs, etc. Both Deposit and Withdraw
  // now live inline on the Wallet page — the deep-link handler just
  // switches to the relevant sidebar view and strips the URL flag so a
  // refresh doesn't re-trigger it.
  useEffect(() => {
    const action = searchParams.get('action');
    const VIEW_FOR = { deposit: 'grow', withdraw: 'withdraw', transfer: 'transfer' };
    if (VIEW_FOR[action]) {
      pendingDeepLinkRef.current = VIEW_FOR[action];
      const next = new URLSearchParams(searchParams);
      next.delete('action');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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

  // ── Aggregate top-line metrics (USD-normalised) for the hero cards ─
  // Real money only — demo balances are surfaced separately below the
  // primary cards so the headline figures reflect the user's actual
  // financial position.
  const totals = useMemo(() => {
    let balance = 0, locked = 0, free = 0, unrealized = 0;
    const cur = 'USD';
    const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
    for (const [c, t] of Object.entries(realTotalsByCurrency)) {
      // Normalise to USD so the top cards can show one consolidated number.
      const k = c === 'USD' ? 1 : c === 'INR' ? 1 / rate : 1;
      balance    += (Number(t.balance)    || 0) * k;
      locked     += (Number(t.locked)     || 0) * k;
      free       += (Number(t.free)       || 0) * k;
      unrealized += (Number(t.unrealized) || 0) * k;
    }
    const equity = balance + unrealized;
    const marginLevel = locked > 0 ? (equity / locked) * 100 : null;
    return { balance, locked, free, unrealized, equity, marginLevel, cur };
  }, [realTotalsByCurrency, fxRate]);

  // Recent transactions — merge deposits + withdrawals into one
  // chronological list for the main table. Each row carries a
  // `_kind` so we can paint icons / colours without re-checking.
  const recentTx = useMemo(() => {
    const d = (deposits || []).map((x) => ({ ...x, _kind: 'deposit' }));
    const w = (withdrawals || []).map((x) => ({ ...x, _kind: 'withdraw' }));
    return [...d, ...w]
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0))
      .slice(0, 12);
  }, [deposits, withdrawals]);

  // India-first money helpers. `totals.*` values are USD-normalised, so
  // we convert into INR for the primary line and keep USD as the
  // secondary line ("≈ $X.XX USD"). `usd(v)` returns the INR primary
  // string so we don't have to touch every Stat/MetricCard call site;
  // `usdSub(v)` returns the smaller USD subtitle string.
  const inrRate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const usd = (v) => `₹${fmtNum((Number(v) || 0) * inrRate, 2)}`;
  const usdSub = (v) => `≈ $${fmtNum(Number(v) || 0, 2)} USD`;
  const usdSubSigned = (v) => {
    const n = Number(v) || 0;
    const sign = n > 0 ? '+' : n < 0 ? '-' : '';
    return `≈ ${sign}$${fmtNum(Math.abs(n), 2)} USD`;
  };

  // ── Wizard state for the screenshot-matched deposit flow ───────────
  // `view` controls the left-nav active item; `method` is the
  // currently-picked payment rail; `amount` is the dollars the user
  // wants to deposit. Continue-to-Payment hands these to the existing
  // DepositModal so the actual payment integration stays intact.
  // Default landing tab is Account Overview — gives the user a snapshot
  // of all their balances / positions / activity before they pick an
  // action (deposit, withdraw, transfer, etc).
  const [view, setView] = useState('overview');
  // When the active view changes (e.g. "View All" → Transaction History), jump
  // to the top. The Recent Transactions strip sits at the page bottom, so
  // without this the view switches above the fold and it looks like the button
  // did nothing. Skip the initial mount so we don't fight the browser's own
  // scroll restoration.
  const didViewMount = useRef(false);
  useEffect(() => {
    if (!didViewMount.current) { didViewMount.current = true; return; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [view]);
  // Pick up any deep-link the earlier effect parked in the ref.
  useEffect(() => {
    if (pendingDeepLinkRef.current) {
      setView(pendingDeepLinkRef.current);
      pendingDeepLinkRef.current = null;
    }
  });
  const [method, setMethod] = useState('bank');
  const [amount, setAmount] = useState(100);
  const [customAmount, setCustomAmount] = useState('');

  const PAYMENT_METHODS = [
    { id: 'bank',    name: 'Bank Transfer',     sub: '1-3 Business Days', min: 50, icon: <PMBank /> },
    { id: 'card',    name: 'Credit / Debit Card', sub: 'Instant',          min: 20, icon: <PMCard /> },
    { id: 'skrill',  name: 'Skrill',            sub: 'Instant',          min: 10, icon: <PMSkrill /> },
    { id: 'neteller',name: 'Neteller',          sub: 'Instant',          min: 10, icon: <PMNeteller /> },
    { id: 'usdt',    name: 'USDT',              sub: 'TRC20 · Instant',  min: 10, icon: <PMUsdt /> },
    { id: 'more',    name: 'More Methods',      sub: 'Various options',  min: 10, icon: <PMMore /> },
  ];
  const AMOUNT_PILLS = [100, 250, 500, 1000, 2000];
  const selectedMethod = PAYMENT_METHODS.find((m) => m.id === method) || PAYMENT_METHODS[0];
  const effectiveAmount = customAmount !== '' ? Number(customAmount) || 0 : amount;
  const stepIdx = method ? 1 : 0;

  const NAV_ITEMS = [
    { id: 'details',  label: 'Account Details',   icon: <NIDetails /> },
    { id: 'overview', label: 'Account Overview', icon: <NIOverview /> },
    { id: 'grow',     label: 'Deposit Funds',     icon: <NIDeposit />, active: true },
    { id: 'withdraw', label: 'Withdraw Funds',    icon: <NIWithdraw /> },
    { id: 'transfer', label: 'Internal Transfer', icon: <NITransfer /> },
    // Subscription Wallet lives on its own page — items with `to`
    // navigate via Link instead of switching the local view.
    { id: 'subscription', label: 'Main Wallet', icon: <NISubscription />, to: '/subscription-wallet' },
    { id: 'bonus', label: 'Bonus Wallet', icon: <NIBonus />, to: '/bonus-wallet' },
    { id: 'history',  label: 'Transaction History', icon: <NIHistory /> },
  ];

  return (
    <div className="max-w-[1600px] grid grid-cols-12 gap-3 lg:-ml-4 xl:-ml-6 overflow-x-clip">
      {/* ── LEFT NAV — sticky so it stays visible as the main content
          (wizard, transactions, etc.) scrolls underneath. Layout's
          global header is sticky top-0 with h-16 nav (64 px) + the
          InstrumentStrip (~60 px) → total sticky zone ≈ 124 px. We
          pin the sidebar at top:8rem (128 px) so it clears that
          header zone instead of sliding underneath it.
          `self-start` is the magic that makes `sticky` actually work
          inside a grid column — without it the cell stretches and
          sticky becomes a no-op. */}
      <aside className="col-span-12 lg:col-span-2 xl:col-span-2 flex flex-col gap-4 min-w-0 lg:sticky lg:self-start" style={{ top: stickyTop }}>
        <nav className="bg-white border border-border-dark rounded-2xl p-2 flex flex-row lg:flex-col gap-1 lg:gap-0.5 overflow-x-auto lg:overflow-visible no-scrollbar">
          {NAV_ITEMS.map((n) => {
            const isActive = view === n.id;
            const className = `flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-colors shrink-0 ${
              isActive ? 'bg-primary-500/10 text-primary-600' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }`;
            const content = (
              <>
                <span className={`shrink-0 ${isActive ? 'text-primary-600' : 'text-text-muted'}`}>
                  {n.icon}
                </span>
                <span className={`text-[13px] truncate ${isActive ? 'font-bold' : 'font-medium'}`}>{n.label}</span>
                {n.badge && (
                  <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-primary-600 bg-primary-500/15 px-1.5 py-0.5 rounded">
                    {n.badge}
                  </span>
                )}
              </>
            );
            if (n.to) {
              return (
                <Link key={n.id} to={n.to} className={className}>
                  {content}
                </Link>
              );
            }
            return (
              <button key={n.id} type="button" onClick={() => setView(n.id)} className={className}>
                {content}
              </button>
            );
          })}
        </nav>

        {/* Support card — secondary chrome, hidden on mobile to keep wallet content above the fold */}
        <div className="hidden lg:block bg-white border border-border-dark rounded-2xl p-4">
          <div className="text-sm font-bold text-text-primary">Need Help?</div>
          <div className="text-[11px] text-text-muted mt-0.5">Our support team is available 24/7</div>
          <a
            href="/helpdesk"
            className="mt-3 inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-xl border border-border-dark text-text-primary text-xs font-semibold hover:shadow-card transition-all"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><path d="M21 14v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z" /><path d="M3 14v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z" /></svg>
            Contact Support
          </a>
        </div>

        {/* Secure footer card — hidden on mobile */}
        <div className="hidden lg:block rounded-2xl p-4 border" style={{ background: '#3B82F608', borderColor: '#3B82F633' }}>
          <div className="flex items-start gap-2.5">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: '#3B82F618', color: '#3B82F6' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
            </span>
            <div className="min-w-0">
              <div className="text-sm font-bold text-text-primary">100% Secure</div>
              <div className="text-[11px] text-text-muted mt-0.5">Your funds are safe with us</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── CENTER — wizard / view content ──────────────────────────── */}
      <main className="col-span-12 lg:col-span-10 xl:col-span-10 space-y-5 min-w-0">
        {view === 'grow' ? (
          <InlineDepositFlow
            accounts={accounts}
            balances={balances}
            fxRate={fxRate}
            onDone={() => { load(); setView('overview'); }}
            onCancel={() => setView('overview')}
          />
        ) : view === 'overview' ? (
          <AccountOverview accounts={accounts} balances={balances} deposits={deposits} withdrawals={withdrawals} positions={openPositions} priceMap={priceMap} totals={totals} usd={usd} usdSub={usdSub} fxRate={fxRate} setView={setView} />
        ) : view === 'withdraw' ? (
          <WithdrawView accounts={accounts} balances={balances} withdrawals={withdrawals} fxRate={fxRate} onDone={() => { load(); setView('overview'); }} onCancel={() => setView('overview')} />
        ) : view === 'transfer' ? (
          <TransferView accounts={accounts} balances={balances} onDone={load} />
        ) : view === 'history' ? (
          <TransactionHistory deposits={deposits} withdrawals={withdrawals} ledger={ledger} accounts={accounts} loading={loading} />
        ) : view === 'details' ? (
          <AccountDetailsView user={user} accounts={accounts} balances={balances} fxRate={fxRate} onRefresh={load} setView={setView} />
        ) : (
          <AccountOverview accounts={accounts} balances={balances} deposits={deposits} withdrawals={withdrawals} positions={openPositions} priceMap={priceMap} totals={totals} usd={usd} usdSub={usdSub} fxRate={fxRate} setView={setView} />
        )}

        {/* Overview now reuses the full Portfolio dashboard, which already
            carries its own Recent Closed Trades + activity — so the wallet's
            own Recent Transactions strip is hidden there to avoid a
            duplicate. It still shows on every other view. */}
        {view !== 'overview' && (
        <>
        {/* Recent Transactions — always visible at the bottom (matches screenshot footer) */}
        <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
            <div className="text-sm font-bold text-text-primary">Recent Transactions</div>
            {/* On the Transaction History page the full list is already shown, so
                "View All" would just point back here — hide it there. */}
            {view !== 'history' && (
              <button type="button" onClick={() => setView('history')} className="text-xs font-semibold text-primary-600 hover:text-primary-700 px-3 py-1.5 rounded-lg border border-border-dark hover:border-primary-500/40 transition-colors">
                View All
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            {recentTx.length === 0 ? (
              <div className="py-10 text-center text-sm text-text-muted">No transactions yet</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
                  <tr>
                    <th className="text-left px-5 py-2.5">Date</th>
                    <th className="text-left px-5 py-2.5">Type</th>
                    <th className="text-right px-5 py-2.5">Amount</th>
                    <th className="text-left px-5 py-2.5">Status</th>
                    <th className="text-left px-5 py-2.5">Payment Method</th>
                    <th className="text-left px-5 py-2.5">Transaction ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {recentTx.map((t) => {
                    const isDeposit = t._kind === 'deposit';
                    const sign = isDeposit ? '+' : '-';
                    const amt = Number(t.amount || 0);
                    return (
                      <tr key={t._id || t.id} className="hover:bg-bg-hover transition-colors">
                        <td className="px-5 py-3 text-text-secondary text-xs whitespace-nowrap">{fmtDate(t.createdAt)}</td>
                        <td className="px-5 py-3">
                          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${isDeposit ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'}`}>
                            {isDeposit ? 'Deposit' : 'Withdraw'}
                          </span>
                        </td>
                        <td className={`px-5 py-3 text-right font-mono tabular-nums font-bold ${isDeposit ? 'text-bull' : 'text-bear'}`}>
                          {sign}{currencySymbol(t.currency || 'INR')}{fmtNum(amt, 2)} <span className="text-text-muted font-mono text-[10px]">{t.currency || 'INR'}</span>
                        </td>
                        <td className="px-5 py-3"><StatusBadge status={t.status} /></td>
                        <td className="px-5 py-3 text-text-secondary text-xs capitalize">{t.method || t.gateway || t.paymentMethod || '—'}</td>
                        <td className="px-5 py-3 text-text-muted font-mono text-[11px]">{(t._id || t.txId || '—').toString().slice(-12)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Small inline support strip — kept as a single discreet row
            instead of the previous full card on the right sidebar. */}
        <div className="flex items-center justify-end gap-4 text-xs text-text-muted">
          <span>Need help?</span>
          <a href="/helpdesk" className="inline-flex items-center gap-1.5 font-semibold text-primary-600 hover:text-primary-700">
            <ChatGlyph /> Live chat
          </a>
          <span className="text-border-dark">·</span>
          <a href="mailto:support@tradepro.com" className="inline-flex items-center gap-1.5 font-semibold text-primary-600 hover:text-primary-700">
            <MailGlyph /> support@tradepro.com
          </a>
        </div>
        </>
        )}
      </main>

      {/* Deposit + Withdraw modals removed — both flows render inline
          via <InlineDepositFlow /> on the 'grow' view and the multi-step
          <WithdrawView /> on the 'withdraw' view. */}
    </div>
  );
}

// ─── Sub-views for non-deposit nav items ──────────────────────────────

function PlaceholderView({ title, subtitle, cta, onClick, toHref }) {
  return (
    <div className="bg-white border border-border-dark rounded-2xl p-10 text-center">
      <h2 className="text-2xl font-bold text-text-primary">{title}</h2>
      <p className="text-sm text-text-secondary mt-2 max-w-md mx-auto">{subtitle}</p>
      {cta && (
        toHref ? (
          <a href={toHref} className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold shadow-card hover:shadow-elevated transition-all" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
            <span className="keep-white" style={{ color: '#FFFFFF' }}>{cta} →</span>
          </a>
        ) : (
          <button onClick={onClick} className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold shadow-card hover:shadow-elevated transition-all" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
            <span className="keep-white" style={{ color: '#FFFFFF' }}>{cta} →</span>
          </button>
        )
      )}
    </div>
  );
}

function FullHistoryView({ deposits, withdrawals, ledger, loading, tab, setTab }) {
  return (
    <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
        <div className="text-sm font-bold text-text-primary">Transaction History</div>
        <div className="flex items-center gap-1 p-0.5 bg-bg-hover rounded-lg">
          {[
            { k: 'deposits', label: `Deposits (${deposits.length})` },
            { k: 'withdrawals', label: `Withdrawals (${withdrawals.length})` },
            { k: 'ledger', label: 'Ledger' },
          ].map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                tab === t.k ? 'bg-white text-text-primary shadow-card' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto p-5">
        {loading ? (
          <div className="text-text-muted text-sm py-12 text-center">Loading…</div>
        ) : tab === 'withdrawals' ? <WithdrawalsTable items={withdrawals} />
          : tab === 'ledger' ? <LedgerTable items={ledger} />
          : <DepositsTable items={deposits} />}
      </div>
    </div>
  );
}

// ─── Payment-method brand glyphs ──────────────────────────────────────

const PMBank = () => (
  <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#1D4ED818', color: '#1D4ED8' }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V10" /><path d="M9 21V10" /><path d="M15 21V10" /><path d="M19 21V10" /><path d="M2 10l10-7 10 7" /></svg>
  </span>
);
const PMCard = () => (
  <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#0EA5E918', color: '#0EA5E9' }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
  </span>
);
const PMSkrill = () => (
  <span className="w-10 h-10 rounded-xl flex items-center justify-center text-[10px] font-bold tracking-tight shrink-0" style={{ background: '#86198F18', color: '#86198F' }}>
    Skrill
  </span>
);
const PMNeteller = () => (
  <span className="w-10 h-10 rounded-xl flex items-center justify-center text-[9px] font-bold tracking-tight shrink-0" style={{ background: '#16A34A18', color: '#16A34A' }}>
    NETELLER
  </span>
);
const PMUsdt = () => (
  <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#26A17B18', color: '#26A17B' }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /><text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="#FFFFFF" fontFamily="Inter">T</text></svg>
  </span>
);
const PMMore = () => (
  <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: '#47556918', color: '#475569' }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
  </span>
);

// ─── Nav glyphs ───────────────────────────────────────────────────────
const NS = (props) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props} />;
const NIOverview = () => <NS><circle cx="12" cy="12" r="9" /><path d="M9 12h6" /><path d="M12 9v6" /></NS>;
const NIDeposit  = () => <NS><circle cx="12" cy="12" r="9" /><path d="M8 12l4-4 4 4" /><path d="M12 16V8" /></NS>;
const NIWithdraw = () => <NS><circle cx="12" cy="12" r="9" /><path d="M8 12l4 4 4-4" /><path d="M12 8v8" /></NS>;
const NITransfer = () => <NS><path d="M7 17l-4-4 4-4" /><path d="M3 13h13" /><path d="M17 7l4 4-4 4" /><path d="M21 11H8" /></NS>;
const NIHistory  = () => <NS><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></NS>;
const NIMethods  = () => <NS><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /></NS>;
const NIDetails  = () => <NS><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" /></NS>;
const NIBonus    = () => <NS><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M3 12h18" /><path d="M12 8v13" /><path d="M12 8s-3-5-5-3 1 3 5 3z" /><path d="M12 8s3-5 5-3-1 3-5 3z" /></NS>;
const NISubscription = () => <NS><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 16h4" /><circle cx="17" cy="16" r="1.2" /></NS>;

// ─── UI primitives for the premium wallet layout ──────────────────────

function Stat({ label, value, secondary, hint, color, emphasis }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div
        className={`mt-1 font-bold font-mono tabular-nums truncate ${emphasis ? 'text-xl sm:text-3xl' : 'text-lg sm:text-2xl'}`}
        style={{ color: color || undefined }}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
      {secondary && <div className="text-[11px] font-mono text-text-muted mt-0.5 truncate">{secondary}</div>}
      {hint && <div className="text-[11px] text-text-muted mt-1 truncate">{hint}</div>}
    </div>
  );
}

function MetricCard({ tint, icon: Icon, label, value, secondary, sub, valueColor }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-4 hover:shadow-card transition-shadow min-w-0">
      <div className="flex items-start justify-between">
        <span
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: `${tint}18`, color: tint }}
        >
          <Icon />
        </span>
      </div>
      <div className="text-[11px] uppercase tracking-wider text-text-muted font-semibold mt-3 truncate">{label}</div>
      <div className="text-lg sm:text-xl font-bold font-mono tabular-nums mt-0.5 truncate" style={{ color: valueColor || undefined }} title={typeof value === 'string' ? value : undefined}>
        {value}
      </div>
      {secondary && <div className="text-[11px] font-mono text-text-muted mt-0.5 truncate">{secondary}</div>}
      {sub && <div className="text-[11px] text-text-muted mt-1 truncate">{sub}</div>}
    </div>
  );
}

function ActionButton({ tint, icon: Icon, label, onClick, to }) {
  const inner = (
    <>
      <span className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${tint}18`, color: tint }}>
        <Icon />
      </span>
      <span className="text-[12px] font-semibold text-text-primary text-center leading-tight">{label}</span>
    </>
  );
  const cls = "flex flex-col items-center gap-2 p-3 rounded-xl border border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5 transition-colors text-left";
  if (to) {
    return <a href={to} className={cls}>{inner}</a>;
  }
  return <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

function SidebarCard({ title, icon: Icon, tint, children }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${tint}18`, color: tint }}>
          <Icon />
        </span>
        <span className="text-sm font-bold text-text-primary">{title}</span>
      </div>
      {children}
    </div>
  );
}

// Inline SVG glyphs — keep them tiny and consistent.
const S = (props) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props} />;
const WalletGlyph   = () => <S><path d="M3 7h18v12H3z" /><path d="M3 11h18" /><circle cx="17" cy="15" r="1.5" /></S>;
const ChartGlyph    = () => <S><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></S>;
const CheckGlyph    = () => <S><circle cx="12" cy="12" r="10" /><path d="M9 12l2 2 4-4" /></S>;
const LockGlyph     = () => <S><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></S>;
const GiftGlyph     = () => <S><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M3 12h18" /><path d="M12 8v13" /><path d="M12 8s-3-5-5-3 1 3 5 3z" /><path d="M12 8s3-5 5-3-1 3-5 3z" /></S>;
const TrendGlyph    = () => <S><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></S>;
const DepositGlyph  = () => <S><circle cx="12" cy="12" r="10" /><path d="M8 12l4 4 4-4" /><path d="M12 8v8" /></S>;
const WithdrawGlyph = () => <S><circle cx="12" cy="12" r="10" /><path d="M8 12l4-4 4 4" /><path d="M12 16V8" /></S>;
const SwapGlyph     = () => <S><path d="M16 3l4 4-4 4" /><path d="M4 7h16" /><path d="M8 21l-4-4 4-4" /><path d="M20 17H4" /></S>;
const ConvertGlyph  = () => <S><circle cx="12" cy="12" r="10" /><path d="M8 10h8" /><path d="M8 14h8" /><path d="M10 8l-2 2 2 2" /><path d="M14 12l2 2-2 2" /></S>;
const HistoryGlyph  = () => <S><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></S>;
const ShieldGlyph   = () => <S><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></S>;
const ClockGlyph    = () => <S><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></S>;
const GlobeGlyph    = () => <S><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20" /><path d="M12 2a15 15 0 0 0 0 20" /></S>;
const ChatGlyph     = () => <S><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></S>;
const MailGlyph     = () => <S><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 6l-10 7L2 6" /></S>;
const CheckDot = ({ color }) => (
  <span className="inline-flex w-4 h-4 rounded-full items-center justify-center shrink-0" style={{ background: `${color}22`, color }}>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
  </span>
);

function StatusBadge({ status }) {
  const colors = {
    PENDING: 'bg-blue-100 text-blue-700',
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
    <div className="overflow-x-auto">
    <table className="w-full text-sm min-w-[640px]">
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
    </div>
  );
}

function WithdrawalsTable({ items }) {
  if (!items.length) return <div className="text-gray-500 text-sm py-4 text-center">No withdrawals</div>;
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-sm min-w-[640px]">
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
    </div>
  );
}

// Friendlier labels for the ledger Type column. Peer-to-peer transfer
// rows render as "Transfer Sent" / "Transfer Received" with the
// counterparty name surfaced inline so the user doesn't have to read
// the cryptic system enum.
function ledgerTypeLabel(l) {
  if (l.type === 'INTERNAL_TRANSFER_OUT') return 'Transfer Sent';
  if (l.type === 'INTERNAL_TRANSFER_IN')  return 'Transfer Received';
  return l.type;
}

function LedgerTable({ items }) {
  if (!items.length) return <div className="text-gray-500 text-sm py-4 text-center">No ledger entries</div>;
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-sm min-w-[640px]">
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
        {items.map((l) => {
          const isXfer = l.type === 'INTERNAL_TRANSFER_OUT' || l.type === 'INTERNAL_TRANSFER_IN';
          const cp = l.counterparty;
          const cpLabel = isXfer && cp
            ? (l.type === 'INTERNAL_TRANSFER_OUT' ? `to ${cp.name}` : `from ${cp.name}`)
            : null;
          return (
            <tr key={l._id} className="table-row">
              <td className="p-2">{fmtDate(l.createdAt)}</td>
              <td className="p-2">
                <span className="font-semibold">{ledgerTypeLabel(l)}</span>
                {cpLabel && <span className="ml-1 text-text-muted">· {cpLabel}</span>}
              </td>
              <td className="p-2">{l.currency}</td>
              <td className={`p-2 text-right font-mono ${Number(l.amount) >= 0 ? 'text-bull' : 'text-bear'}`}>
                {fmtNum(l.amount, 2)}
              </td>
              <td className="p-2 text-right font-mono">{fmtNum(l.balanceAfter, 2)}</td>
              <td className="p-2 text-xs text-gray-400">{l.note || '-'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function Modal({ children, onClose }) {
  // max-h-[90vh] keeps the modal inside the viewport even when the form is
  // long (Withdraw/Bank flow has 7+ fields). flex-col splits the card into
  // a scrollable body + a sticky footer (Cancel button stays visible).
  // Click on backdrop closes; click inside doesn't bubble.
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-1 min-h-0 overflow-y-auto p-5 sm:p-6">
          {children}
        </div>
        <div className="border-t border-border-dark p-3 shrink-0 bg-bg-card rounded-b-lg">
          <button onClick={onClose} className="btn-ghost w-full">Cancel</button>
        </div>
      </div>
    </div>
  );
}

function InlineDepositFlow({ accounts, balances = [], fxRate, onDone, onCancel }) {
  const onClose = onCancel || (() => {});
  // Prefer a REAL account by default — it's the user's actual money flow.
  // Falls back to the first account if no real one exists yet.
  const realAccount = accounts.find((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
  const [accountId, setAccountId] = useState(realAccount?._id || accounts[0]?._id || '');
  // The user enters amounts in INR (Indian payment rails); on submit
  // we convert into USD via the live `fxRate` so the backend wallet —
  // which is the canonical USD base — stays as the single source of
  // truth. UI display elsewhere also reads in INR (see Wallet.jsx).
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
  const [payDetails, setPayDetails] = useState(null); // admin-configured "where to send money"
  // Plan catalogue (code → plan) so we can enforce each tier's minimum
  // deposit (USD) in the UI, mirroring the backend gate. Keyed by account
  // type code (FREE / STANDARD / PRO / +IC variants …).
  const [planByCode, setPlanByCode] = useState({});

  useEffect(() => {
    api.get('/wallet/deposit-details')
      .then((r) => setPayDetails(r.data?.data || null))
      .catch(() => setPayDetails(null));
    api.get('/account-plans')
      .then((r) => {
        const map = {};
        for (const p of (r.data?.data || [])) map[String(p.code).toUpperCase()] = p;
        setPlanByCode(map);
      })
      .catch(() => setPlanByCode({}));
  }, []);

  const selectedAccount = accounts.find((a) => a._id === accountId);
  const isReal = selectedAccount && selectedAccount.accountType !== 'DEMO' && selectedAccount.accountType !== 'VIRTUAL';
  const isDemo = selectedAccount?.accountType === 'DEMO';

  // ── Per-tier minimum-deposit check (USD base, like the backend) ──────
  const _fxRate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const planMinUsd = (() => {
    const p = selectedAccount ? planByCode[String(selectedAccount.accountType).toUpperCase()] : null;
    return p ? Number(p.minDeposit || 0) : 0;
  })();
  // Convert the typed amount to USD. INR uses the live rate; USD/USDT are
  // 1:1; anything else (e.g. BTC) returns null → defer to the backend gate.
  const amountUsd = (() => {
    const amt = Number(amount) || 0;
    if (currency === 'INR') return amt / _fxRate;
    if (currency === 'USD' || currency === 'USDT') return amt;
    return null;
  })();
  const belowMinDeposit = isReal && planMinUsd > 0 && amountUsd != null && amountUsd < planMinUsd;

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

  // Razorpay Checkout SDK — loaded lazily on first use. Returns a promise
  // that resolves when window.Razorpay is available, or rejects on script
  // load failure (offline / blocked).
  const loadRazorpayScript = () =>
    new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve(window.Razorpay);
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => resolve(window.Razorpay);
      s.onerror = () => reject(new Error('Failed to load Razorpay Checkout'));
      document.body.appendChild(s);
    });

  const submitRazorpay = async () => {
    if (!amount || Number(amount) <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setLoading(true);
    try {
      // 1. Create order on backend.
      const { data } = await api.post('/wallet/razorpay/order', {
        accountId, currency, amount,
      });
      const order = data.data;
      // 2. Open Razorpay Checkout.
      const Razorpay = await loadRazorpayScript();
      const rzp = new Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: Math.round(Number(order.amount) * 100),
        currency: order.currency,
        name: 'Trading Platform',
        description: `Deposit to ${selectedAccount?.nickname || selectedAccount?.accountNumber}`,
        handler: async (resp) => {
          // 3. Verify on backend → credit wallet.
          try {
            await api.post('/wallet/razorpay/verify', {
              orderId: resp.razorpay_order_id,
              paymentId: resp.razorpay_payment_id,
              signature: resp.razorpay_signature,
            });
            toast.success(`${fmtMoney(amount, currency)} credited`);
            onDone();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        },
        modal: {
          ondismiss: () => setLoading(false),
        },
      });
      rzp.open();
    } catch (err) {
      toast.error(errorMessage(err));
      setLoading(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();

    // Per-tier minimum deposit — mirrors the backend gate so the user gets
    // immediate feedback instead of a round-trip rejection.
    if (belowMinDeposit) {
      toast.error(`Minimum deposit for ${selectedAccount?.nickname || selectedAccount?.accountType} is $${fmtNum(planMinUsd, 2)}.`);
      return;
    }

    // Razorpay path skips the screenshot flow entirely.
    if (method === 'RAZORPAY') {
      return submitRazorpay();
    }

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
      // Send the deposit as the user actually entered it (INR if the
      // user used Indian rails, USD if the user typed dollars). This
      // matches the UPI / bank receipt the user attached, so admin
      // verification is one-to-one with what landed in the company
      // account. The wallet display elsewhere aggregates INR + USD
      // wallets into INR via fxRate, so the user still sees a single
      // INR figure on the dashboard.
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

  // ── Multi-step state + helpers (UI only; submit handlers unchanged) ──
  const [step, setStep] = useState(0);
  const [drag, setDrag] = useState(false);
  const PRESETS = currency === 'INR' ? [100, 500, 1000, 5000, 10000] : [10, 50, 100, 500, 1000];

  // INR-denominated deposits. Mins are INR (₹100 minimum for Indian
  // rails, ₹500 for crypto). The backend receives the converted USD
  // value at submit time.
  const METHODS = [
    { id: 'UPI',      label: 'UPI',           sub: 'Instant · Free',         min: 100,  kind: 'manual',  icon: <MUPI /> },
    { id: 'BANK',     label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-3 hrs',  min: 100,  kind: 'manual',  icon: <MBank /> },
    { id: 'CRYPTO',   label: 'Crypto (USDT)', sub: 'TRC20 · ~5 min',         min: 500,  kind: 'manual',  icon: <MCrypto /> },
    { id: 'SKRILL',   label: 'Skrill',        sub: 'Instant · Free',         min: 100,  kind: 'manual',  icon: <MSkrill /> },
    { id: 'NETELLER', label: 'Neteller',      sub: 'Instant · Free',         min: 100,  kind: 'manual',  icon: <MNeteller /> },
    { id: 'RAZORPAY', label: 'Razorpay',      sub: 'UPI / Card · Instant',   min: 100,  kind: 'instant', icon: <MRazor /> },
  ];
  const STEPS = [
    { id: 'account', label: 'Account',         sub: 'Choose account' },
    { id: 'method',  label: 'Payment Method',  sub: 'Select method' },
    { id: 'amount',  label: 'Amount',          sub: 'Enter amount' },
    { id: 'proof',   label: 'Upload Proof',    sub: 'Add payment proof' },
    { id: 'confirm', label: 'Confirmation',    sub: 'Review & confirm' },
  ];
  const isRazor = method === 'RAZORPAY';
  // Razorpay path doesn't need the proof step — skip it for those.
  const skipProof = isDemo || isRazor;
  const totalSteps = skipProof ? 4 : 5;
  const effectiveSteps = skipProof ? STEPS.filter((s) => s.id !== 'proof') : STEPS;

  const copy = (txt, label) => {
    try { navigator.clipboard.writeText(txt); toast.success(`${label || 'Copied'}`); }
    catch (_) { toast.error('Copy failed'); }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      const fakeEvt = { target: { files: [file] } };
      handleFileChange(fakeEvt);
    }
  };

  const canNext = (() => {
    if (step === 0) return !!accountId;
    if (step === 1) return !!method;
    if (step === 2) return amount && Number(amount) >= (METHODS.find((m) => m.id === method)?.min || 1) && !belowMinDeposit;
    if (step === 3) {
      if (skipProof) return true;
      return !!screenshot && !!txReference.trim() && !!senderName.trim();
    }
    return true;
  })();

  const goNext = () => setStep((s) => Math.min(s + 1, effectiveSteps.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const finalSubmit = (e) => {
    if (e?.preventDefault) e.preventDefault();
    submit({ preventDefault: () => {} });
  };

  const selectedMethodMeta = METHODS.find((m) => m.id === method) || METHODS[0];
  const stepId = effectiveSteps[step]?.id;

  return (
    <div className="bg-white rounded-2xl border border-border-dark shadow-card overflow-hidden flex flex-col">

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border-subtle">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-text-primary">Add Funds</h2>
            <p className="text-xs text-text-secondary mt-0.5">Securely add balance to your trading account</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" title="How it works?" className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5 text-text-primary text-xs font-semibold transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
              How it works?
            </button>
            <a href="/helpdesk" title="Support" className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            </a>
            <button type="button" onClick={onClose} className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* ── Stepper ──────────────────────────────────────────────── */}
        <div className="px-6 py-5 border-b border-border-subtle">
          <div className="flex items-start gap-1.5 sm:gap-3">
            {effectiveSteps.map((s, i) => {
              const isActive = i === step;
              const isDone = i < step;
              return (
                <div key={s.id} className="flex items-start gap-2.5 flex-1 min-w-0">
                  <span
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 transition-all ${
                      isActive ? 'shadow-card' : ''
                    }`}
                    style={
                      isActive ? { background: '#3B82F6', color: '#FFFFFF' }
                      : isDone   ? { background: '#3B82F622', color: '#3B82F6' }
                      :            { background: '#E5E7EB', color: '#9CA3AF' }
                    }
                  >
                    {isDone ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    ) : <span className={isActive ? 'keep-white' : ''} style={isActive ? { color: '#FFFFFF' } : undefined}>{i + 1}</span>}
                  </span>
                  <div className="hidden md:flex flex-col min-w-0 leading-tight pt-0.5">
                    <span className={`text-[13px] font-bold truncate ${isActive ? 'text-text-primary' : isDone ? 'text-text-primary' : 'text-text-muted'}`}>{s.label}</span>
                    <span className="text-[11px] text-text-muted truncate">{s.sub}</span>
                  </div>
                  {i < effectiveSteps.length - 1 && (
                    <span className="flex-1 mx-1 sm:mx-2 mt-4 h-px border-t border-dashed border-border-dark" />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Body (scrollable) ─────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">

          {/* Step 1 — Account selector */}
          {stepId === 'account' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-text-primary">Select an account</h3>
                <p className="text-xs text-text-muted mt-0.5">Choose which trading account to credit.</p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {accounts.map((a) => {
                  const sel = a._id === accountId;
                  const isR = a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL';
                  const accCcy = a.baseCurrency || 'USD';
                  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
                  // Funds may sit in the native wallet OR the canonical USD
                  // wallet (every deposit credits USD). Sum ALL of this
                  // account's wallets, converted into its display currency, so
                  // the card reflects credited funds whichever wallet they hit.
                  const bal = (Array.isArray(balances) ? balances : [])
                    .filter((b) => b.accountId === a._id)
                    .reduce((sum, b) => {
                      const v = Number(b.balance) || 0;
                      if (b.currency === accCcy) return sum + v;
                      if (b.currency === 'USD' && accCcy === 'INR') return sum + v * rate;
                      if (b.currency === 'INR' && accCcy === 'USD') return sum + v / rate;
                      return sum + v; // unknown currency — best-effort 1:1
                    }, 0);
                  return (
                    <button
                      key={a._id}
                      type="button"
                      onClick={() => setAccountId(a._id)}
                      className={`relative w-full p-5 rounded-2xl border-2 text-left transition-all hover:shadow-card ${sel ? 'shadow-card' : 'hover:-translate-y-0.5'}`}
                      style={sel
                        ? { borderColor: '#3B82F6', background: '#3B82F608' }
                        : { borderColor: '#E5E7EB', background: '#FFFFFF' }
                      }
                    >
                      {/* Top — avatar + check */}
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className="w-11 h-11 rounded-xl flex items-center justify-center text-sm font-extrabold shrink-0"
                          style={{ background: '#1D4ED810', color: '#1D4ED8' }}
                        >
                          {(a.nickname || a.accountNumber || 'A').slice(0, 2).toUpperCase()}
                        </span>
                        <span
                          className="shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all"
                          style={sel
                            ? { borderColor: '#3B82F6', background: '#3B82F6' }
                            : { borderColor: '#E5E7EB', background: '#FFFFFF' }
                          }
                        >
                          {sel && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" className="keep-white"><path d="M5 13l4 4L19 7" /></svg>
                          )}
                        </span>
                      </div>

                      {/* Name + badge */}
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-base font-bold text-text-primary truncate">{a.nickname || a.accountNumber}</span>
                        <span
                          className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded"
                          style={isR
                            ? { background: '#3B82F618', color: '#3B82F6' }
                            : { background: '#1D4ED815', color: '#1D4ED8' }
                          }
                        >
                          {isR ? 'Live · Real' : 'Demo'}
                        </span>
                      </div>
                      <div className="text-[11px] text-text-muted font-mono mt-0.5">{a.accountNumber}</div>

                      {/* Balance footer */}
                      <div className="mt-4 flex items-end justify-between gap-2">
                        <div>
                          <div className="text-xl font-bold font-mono tabular-nums text-text-primary">
                            {currencySymbol(accCcy)}{fmtNum(bal, 2)}
                          </div>
                          <div className="text-[11px] text-text-muted mt-0.5">Balance</div>
                        </div>
                        <span className="text-[10px] font-bold font-mono px-2 py-1 rounded-md bg-bg-hover text-text-secondary self-end">{accCcy}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 2 — Payment method cards */}
          {stepId === 'method' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">Choose payment method</h3>
                <p className="text-xs text-text-muted mt-0.5">Pick how you'd like to fund your account.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {METHODS.map((m) => {
                  const sel = method === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMethod(m.id)}
                      className={`relative text-left p-4 rounded-xl border-2 transition-all hover:shadow-card ${sel ? 'border-primary-500 bg-primary-500/[0.05]' : 'border-border-dark hover:border-primary-500/40'}`}
                    >
                      <div className="flex items-center gap-3">
                        {m.icon}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-text-primary">{m.label}</span>
                            {m.kind === 'instant' && <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-600">Instant</span>}
                          </div>
                          <div className="text-[11px] text-text-muted mt-0.5">{m.sub}</div>
                          <div className="text-[11px] text-text-secondary mt-1">Min · {currencySymbol(currency)}{m.min}</div>
                        </div>
                      </div>
                      <span className={`absolute top-3 right-3 w-4 h-4 rounded-full border-2 ${sel ? 'border-primary-500 bg-primary-500' : 'border-border-dark'} flex items-center justify-center`}>
                        {sel && <span className="keep-white w-1.5 h-1.5 rounded-full bg-white" />}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Payment details card (manual methods) */}
              {isReal && !isRazor && (
                <div className="rounded-xl border border-border-dark bg-bg-hover p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: '#3B82F618', color: '#3B82F6' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></svg>
                      </span>
                      <span className="text-sm font-bold text-text-primary">Pay to these details</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull">Verified</span>
                    </div>
                    {payDetails?.[method]?.qr && (
                      <span className="text-[10px] font-semibold text-text-muted inline-flex items-center gap-1">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3z" /><path d="M14 20h7M20 14v7" /></svg>
                        Scan below
                      </span>
                    )}
                  </div>
                  {(() => {
                    // Admin-configured payment details for the selected method
                    // (no more hardcoded values).
                    const dd = payDetails?.[method] || {};
                    const rows = method === 'UPI'
                      ? [{ l: 'UPI ID', v: dd.upiId, c: true }, { l: 'Beneficiary', v: dd.payeeName, c: false }]
                      : method === 'BANK'
                        ? [{ l: 'Beneficiary', v: dd.accountName, c: false }, { l: 'Bank A/C', v: dd.accountNumber, c: true }, { l: 'IFSC', v: dd.ifsc, c: true }, { l: 'Bank', v: dd.bankName, c: false }]
                        : method === 'CRYPTO'
                          ? [{ l: 'Address', v: dd.address, c: true }, { l: 'Network', v: dd.network, c: false }]
                          : [{ l: 'Email', v: dd.email, c: true }];
                    const visible = rows.filter((r) => String(r.v || '').trim());
                    if (!visible.length) {
                      return (
                        <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-800 leading-snug">
                          Payment details for {method} aren&apos;t set up yet. Please contact support before sending money.
                        </div>
                      );
                    }
                    return (
                      <div className="space-y-2 text-xs">
                        {visible.map((r) => (
                          <div key={r.l} className="flex items-center justify-between gap-3">
                            <span className="text-text-muted">{r.l}</span>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="font-mono font-semibold text-text-primary truncate">{r.v}</span>
                              {r.c && (
                                <button type="button" onClick={() => copy(r.v, `${r.l} copied`)} className="p-1 rounded text-text-muted hover:text-primary-600 hover:bg-white transition-colors shrink-0">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                        {dd.note && <div className="text-[11px] text-text-secondary pt-2 border-t border-border-subtle/60 leading-snug">{dd.note}</div>}
                        {dd.qr && (
                          <div className="pt-2 mt-1 border-t border-border-subtle/60 flex flex-col items-center gap-1">
                            <img src={dd.qr} alt="Payment QR" className="w-32 h-32 rounded-lg border border-border-dark bg-white object-contain p-1" />
                            <span className="text-[10px] text-text-muted">Scan to pay</span>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Step 3 — Amount */}
          {stepId === 'amount' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">Enter amount</h3>
                <p className="text-xs text-text-muted mt-0.5">Pick a preset or enter your own.</p>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {PRESETS.map((p) => {
                  const sel = String(amount) === String(p);
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAmount(String(p))}
                      className={`px-3 py-2.5 rounded-xl border-2 text-sm font-bold transition-colors ${sel ? 'border-primary-500 bg-primary-500/[0.05] text-primary-600' : 'border-border-dark text-text-primary hover:border-primary-500/40'}`}
                    >
                      {currencySymbol(currency)}{p.toLocaleString()}
                    </button>
                  );
                })}
                <button type="button" onClick={() => setAmount('')} className={`px-3 py-2.5 rounded-xl border-2 text-sm font-bold transition-colors ${!PRESETS.some(p => String(p) === String(amount)) && amount ? 'border-primary-500 bg-primary-500/[0.05] text-primary-600' : 'border-border-dark text-text-primary hover:border-primary-500/40'}`}>
                  Custom
                </button>
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Custom amount</label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted font-semibold">{currencySymbol(currency)}</span>
                  <input type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className="w-full pl-8 pr-3 py-3 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-lg font-bold text-text-primary" />
                  <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="absolute right-2 top-1/2 -translate-y-1/2 bg-bg-hover text-xs font-bold text-text-primary rounded-lg px-2 py-1.5 border border-border-dark focus:outline-none">
                    {['INR', 'USD', 'USDT', 'BTC'].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              {/* Live summary — primary in the selected currency,
                  secondary line converts to the *other* major currency
                  (USD ↔ INR) so the user sees both at a glance. */}
              {(() => {
                const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
                const amt = Number(amount) || 0;
                const isInr = currency === 'INR';
                const altCcy = isInr ? 'USD' : 'INR';
                const altAmt = isInr ? amt / rate : amt * rate;
                const fmtAlt = (v) => `${currencySymbol(altCcy)}${fmtNum(v, 2)}`;
                return (
                  <>
                    <div className="grid grid-cols-3 gap-3 bg-bg-hover rounded-xl p-4">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">You Pay</div>
                        <div className="text-base font-bold font-mono tabular-nums text-text-primary mt-0.5">{currencySymbol(currency)}{fmtNum(amt, 2)}</div>
                        <div className="text-[10px] font-mono tabular-nums text-text-muted mt-0.5">≈ {fmtAlt(altAmt)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">Fees</div>
                        <div className="text-base font-bold font-mono tabular-nums text-bull mt-0.5">{currencySymbol(currency)}0.00</div>
                        <div className="text-[10px] font-mono tabular-nums text-text-muted mt-0.5">≈ {fmtAlt(0)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">You Receive</div>
                        <div className="text-base font-bold font-mono tabular-nums text-text-primary mt-0.5">{currencySymbol(currency)}{fmtNum(amt, 2)}</div>
                        <div className="text-[10px] font-mono tabular-nums text-text-muted mt-0.5">≈ {fmtAlt(altAmt)}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-lg bg-primary-500/5 border border-primary-500/20 px-3 py-2 text-[11px]">
                      <span className="flex items-center gap-1.5 text-text-secondary">
                        <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
                        Live FX rate
                      </span>
                      <span className="font-mono font-bold text-text-primary">1 USD = ₹{fmtNum(rate, 2)}</span>
                    </div>
                  </>
                );
              })()}

              {belowMinDeposit && (
                <div className="rounded-xl bg-bear/10 border border-bear/30 p-3 text-xs text-text-primary">
                  ⚠ Minimum deposit for the <span className="font-bold">{selectedAccount?.nickname || selectedAccount?.accountType}</span> plan is{' '}
                  <span className="font-bold">${fmtNum(planMinUsd, 2)}</span>
                  {currency === 'INR' && <> (≈ ₹{fmtNum(planMinUsd * _fxRate, 0)})</>}.
                  {' '}You entered ≈ ${fmtNum(amountUsd || 0, 2)} — please increase the amount.
                </div>
              )}

              {isDemo && (
                <div className="rounded-xl bg-info/10 border border-info/30 p-3 text-xs text-text-primary">
                  ✨ Demo accounts are credited instantly. No payment is collected.
                </div>
              )}
            </div>
          )}

          {/* Step 4 — Upload proof + sender details */}
          {stepId === 'proof' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">Upload payment proof</h3>
                <p className="text-xs text-text-muted mt-0.5">Drop a screenshot of the confirmation, plus your transaction reference.</p>
              </div>

              <div
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}
                className={`rounded-2xl border-2 border-dashed p-6 text-center transition-all ${drag ? 'border-primary-500 bg-primary-500/[0.05]' : 'border-border-dark hover:border-primary-500/40'}`}
              >
                {!screenshotPreview ? (
                  <>
                    <input id="screenshot-upload" type="file" accept="image/png,image/jpeg,image/jpg" onChange={handleFileChange} className="hidden" />
                    <label htmlFor="screenshot-upload" className="cursor-pointer block">
                      <span className="inline-flex w-14 h-14 rounded-full items-center justify-center mb-3" style={{ background: '#1D4ED818', color: '#1D4ED8' }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
                      </span>
                      <div className="text-sm font-bold text-text-primary">Drop file here or click to upload</div>
                      <div className="text-[11px] text-text-muted mt-1">PNG / JPG · Max 500 KB</div>
                    </label>
                  </>
                ) : (
                  <div className="relative">
                    <img src={screenshotPreview} alt="Payment screenshot" className="w-full max-h-56 object-contain rounded-xl border border-border-dark bg-white" />
                    <button type="button" onClick={removeScreenshot} className="absolute top-2 right-2 w-7 h-7 rounded-full bg-bear text-white text-xs font-bold flex items-center justify-center shadow-card">
                      <span className="keep-white" style={{ color: '#FFFFFF' }}>✕</span>
                    </button>
                    <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold text-primary-600">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                      Screenshot ready
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Transaction reference *</label>
                  <input value={txReference} onChange={(e) => setTxReference(e.target.value)} placeholder="e.g. 4123456789012" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono text-text-primary" />
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Your name *</label>
                  <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="As on bank / UPI" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm text-text-primary" />
                </div>
                {method === 'UPI' && (
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Your UPI ID</label>
                    <input value={senderUpiId} onChange={(e) => setSenderUpiId(e.target.value)} placeholder="yourname@upi" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono text-text-primary" />
                  </div>
                )}
                {method === 'BANK' && (
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Bank A/C last 4 digits</label>
                    <input value={senderBankAccount} onChange={(e) => setSenderBankAccount(e.target.value)} maxLength={4} placeholder="1234" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono text-text-primary" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 5 — Confirmation */}
          {stepId === 'confirm' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">Review &amp; confirm</h3>
                <p className="text-xs text-text-muted mt-0.5">Double-check the details before submitting.</p>
              </div>
              <div className="rounded-2xl border border-border-dark p-5 space-y-3 bg-bg-hover/40">
                {[
                  { l: 'Account',  v: `${selectedAccount?.nickname || selectedAccount?.accountNumber} · ${selectedAccount?.accountType}` },
                  { l: 'Method',   v: selectedMethodMeta.label },
                  { l: 'Amount',   v: `${currencySymbol(currency)}${fmtNum(Number(amount) || 0, 2)}` },
                  { l: 'Fees',     v: `${currencySymbol(currency)}0.00` },
                  { l: 'Receive',  v: `${currencySymbol(currency)}${fmtNum(Number(amount) || 0, 2)}` },
                  ...(isReal && !isRazor ? [
                    { l: 'Reference', v: txReference || '—' },
                    { l: 'Sender',    v: senderName || '—' },
                  ] : []),
                ].map((r) => (
                  <div key={r.l} className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">{r.l}</span>
                    <span className="font-semibold text-text-primary text-right truncate ml-3">{r.v}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-xl bg-bull/10 border border-bull/30 p-3 flex items-start gap-2.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                <div className="text-[11px] text-text-secondary">
                  Your payment is protected with bank-grade encryption. {isReal && !isRazor ? 'Admin will verify your screenshot within 1–24 hours.' : isRazor ? 'Instant credit — powered by Razorpay.' : 'Demo funds credit instantly.'}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Sticky bottom action bar — Cancel/Back left, security
            strip centre, primary action right. */}
        <div className="border-t border-border-subtle bg-bg-hover/40 px-6 py-4 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={step === 0 ? onClose : goBack}
            className="px-5 py-2.5 rounded-xl border border-border-dark bg-white text-text-primary font-semibold text-sm hover:shadow-card transition-all"
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          <span className="hidden md:flex items-center gap-2 text-[12px] text-text-secondary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            Your funds are protected with bank-level security
          </span>
          {step < effectiveSteps.length - 1 ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canNext}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{ background: '#3B82F6', color: '#FFFFFF' }}
            >
              <span className="keep-white" style={{ color: '#FFFFFF' }}>Continue →</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={finalSubmit}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{ background: '#3B82F6', color: '#FFFFFF' }}
            >
              <span className="keep-white" style={{ color: '#FFFFFF' }}>
                {loading ? 'Submitting…' : isDemo ? 'Add to Demo Account' : isRazor ? `Pay ${currencySymbol(currency)}${fmtNum(Number(amount) || 0, 2)} via Razorpay` : 'Confirm Deposit'}
              </span>
            </button>
          )}
        </div>
      </div>
  );
}

// ─── Method-card glyphs ───────────────────────────────────────────────
const MIcon = (bg, fg, child) => (
  <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: bg, color: fg }}>{child}</span>
);
const MUPI = () => MIcon('#7C3AED18', '#7C3AED',
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4l10 8-10 8V4z" /></svg>
);
const MBank = () => MIcon('#1D4ED818', '#1D4ED8',
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18" /><path d="M5 21V10" /><path d="M9 21V10" /><path d="M15 21V10" /><path d="M19 21V10" /><path d="M2 10l10-7 10 7" /></svg>
);
const MCrypto = () => MIcon('#26A17B18', '#26A17B',
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" /><text x="12" y="16" textAnchor="middle" fontSize="10" fontWeight="700" fill="#FFFFFF" fontFamily="Inter">₮</text></svg>
);
const MSkrill = () => (
  <span className="w-11 h-11 rounded-xl flex items-center justify-center text-[10px] font-bold tracking-tight shrink-0" style={{ background: '#86198F18', color: '#86198F' }}>Skrill</span>
);
const MNeteller = () => (
  <span className="w-11 h-11 rounded-xl flex items-center justify-center text-[9px] font-bold tracking-tight shrink-0" style={{ background: '#16A34A18', color: '#16A34A' }}>NETELLER</span>
);
const MRazor = () => MIcon('#3B82F618', '#3B82F6',
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 21l4-9 6 1.5 5-12 3 2-7 17z" /></svg>
);

function WithdrawModal({ balances, accounts, onClose, onDone }) {
  const realAccounts = accounts.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
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
            <div className="bg-bg-card border border-border-dark p-3 rounded text-xs">
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
                            ? 'bg-bg-card text-gray-600 border border-border-dark opacity-40 cursor-not-allowed'
                            : 'bg-bg-card text-gray-400 border border-border-dark hover:border-primary-500'
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
                <div className="bg-blue-50 border border-blue-200 text-blue-700 text-xs p-2 rounded">
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

// ═══════════════════════════════════════════════════════════════════════
// Wallet sidebar sub-views — every nav item gets a fully-built workflow.
// ═══════════════════════════════════════════════════════════════════════

function AccountOverviewView({ totals, usd, usdSub, usdSubSigned, realBalances, accounts, recentTx, positions, setView }) {
  const winRate = useMemo(() => {
    if (!positions || !positions.length) return null;
    const winners = positions.filter((p) => Number(p.unrealizedPnl || 0) >= 0).length;
    return Math.round((winners / positions.length) * 100);
  }, [positions]);
  const openCount = positions?.length || 0;

  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Account Overview</h1>
          <p className="text-sm text-text-secondary mt-1">Complete wallet summary across every real trading account.</p>
        </div>
        <button
          type="button"
          onClick={() => setView('grow')}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm shadow-card hover:shadow-elevated transition-all"
          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}
        >
          <span className="keep-white" style={{ color: '#FFFFFF' }}>+ Deposit</span>
        </button>
      </div>

      {/* Equity hero strip */}
      <div className="bg-white border border-border-dark rounded-2xl p-5 sm:p-6 overflow-hidden relative">
        <div className="absolute inset-0 pointer-events-none opacity-50" style={{ background: 'radial-gradient(circle at 100% 0%, rgba(29, 78, 216, 0.08), transparent 55%)' }} />
        <div className="relative grid grid-cols-2 md:grid-cols-4 gap-5">
          <Stat label="Equity"      value={usd(totals.equity)} secondary={usdSub(totals.equity)} hint="Balance + Unrealised" emphasis />
          <Stat label="Free Margin" value={usd(totals.free)}   secondary={usdSub(totals.free)}   hint="Available to trade" />
          <Stat
            label="Margin Level"
            value={totals.marginLevel != null ? `${fmtNum(totals.marginLevel, 2)}%` : '—'}
            hint="Equity / Used Margin"
            color={totals.marginLevel != null && totals.marginLevel < 100 ? '#DC2626' : undefined}
          />
          <Stat
            label="Today's P&L"
            value={`${totals.unrealized >= 0 ? '+' : ''}${usd(totals.unrealized)}`}
            secondary={usdSubSigned(totals.unrealized)}
            hint="Unrealised across positions"
            color={totals.unrealized >= 0 ? '#16A34A' : '#DC2626'}
          />
        </div>
      </div>

      {/* 6-card metric grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <MetricCard tint="#1D4ED8" icon={WalletGlyph} label="Total Balance"   value={usd(totals.balance)} secondary={usdSub(totals.balance)} sub="All real accounts" />
        <MetricCard tint="#0EA5E9" icon={ChartGlyph}  label="Trading Balance" value={usd(totals.equity)}  secondary={usdSub(totals.equity)}  sub="Includes open P&L" />
        <MetricCard tint="#16A34A" icon={CheckGlyph}  label="Available Funds" value={usd(totals.free)}    secondary={usdSub(totals.free)}    sub="Ready to deploy" />
        <MetricCard tint="#F59E0B" icon={LockGlyph}   label="Locked Margin"   value={usd(totals.locked)}  secondary={usdSub(totals.locked)}  sub="Used by open trades" />
        <MetricCard tint="#8B5CF6" icon={GiftGlyph}   label="Bonus Balance"   value={usd(0)}              secondary={usdSub(0)}              sub="Promotions & rewards" />
        <MetricCard tint={totals.unrealized >= 0 ? '#16A34A' : '#DC2626'} icon={TrendGlyph} label="Recent P&L"
          value={`${totals.unrealized >= 0 ? '+' : ''}${usd(totals.unrealized)}`}
          secondary={usdSubSigned(totals.unrealized)}
          sub="Live across positions"
          valueColor={totals.unrealized >= 0 ? '#16A34A' : '#DC2626'}
        />
      </div>

      {/* Trading performance + per-account balances */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-border-dark rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold text-text-primary">Trading Performance</span>
            <button onClick={() => setView('history')} className="text-xs font-semibold text-primary-600 hover:text-primary-700">View ledger →</button>
          </div>
          <div className="grid grid-cols-3 gap-3 sm:gap-4">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">Open Positions</div>
              <div className="text-xl sm:text-2xl font-bold text-text-primary mt-1">{openCount}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">Win Rate</div>
              <div className="text-xl sm:text-2xl font-bold mt-1" style={{ color: winRate != null && winRate >= 50 ? '#16A34A' : '#DC2626' }}>
                {winRate != null ? `${winRate}%` : '—'}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">Margin Used</div>
              <div className="text-base sm:text-2xl font-bold text-text-primary mt-1 font-mono tabular-nums truncate" title={usd(totals.locked)}>{usd(totals.locked)}</div>
              <div className="text-[11px] font-mono text-text-muted mt-0.5 truncate">{usdSub(totals.locked)}</div>
            </div>
          </div>
        </div>

        <div className="bg-white border border-border-dark rounded-2xl p-5">
          <div className="text-sm font-bold text-text-primary mb-3">Accounts</div>
          {realBalances.length === 0 ? (
            <div className="text-xs text-text-muted">No real accounts funded yet.</div>
          ) : (
            <ul className="space-y-2.5">
              {realBalances.slice(0, 5).map((b) => {
                const acc = accounts.find((a) => a._id === b.accountId);
                const cur = b.currency || 'USD';
                return (
                  <li key={b._id} className="flex items-center justify-between text-sm">
                    <span className="text-text-primary font-semibold truncate">{acc?.nickname || acc?.accountNumber || '—'}</span>
                    <span className="font-mono tabular-nums font-bold text-text-primary">{fmtMoney(b.balance, cur)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Recent activity feed */}
      <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <span className="text-sm font-bold text-text-primary">Recent Activity</span>
          <button onClick={() => setView('history')} className="text-xs font-semibold text-primary-600 hover:text-primary-700">View all →</button>
        </div>
        {recentTx.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-muted">No activity yet.</div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {recentTx.slice(0, 5).map((t) => {
              const isDeposit = t._kind === 'deposit';
              const amt = Number(t.amount || 0);
              return (
                <li key={t._id || t.id} className="flex items-center gap-3 px-5 py-3 hover:bg-bg-hover transition-colors">
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDeposit ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'}`}>
                    {isDeposit ? <DepositGlyph /> : <WithdrawGlyph />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-text-primary">{isDeposit ? 'Deposit' : 'Withdraw'}</div>
                    <div className="text-[11px] text-text-muted">{fmtDate(t.createdAt)}</div>
                  </div>
                  <div className={`font-mono tabular-nums font-bold text-sm ${isDeposit ? 'text-bull' : 'text-bear'}`}>
                    {isDeposit ? '+' : '-'}{currencySymbol(t.currency || 'INR')}{fmtNum(amt, 2)}
                  </div>
                  <StatusBadge status={t.status} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function WithdrawView({ accounts, balances, withdrawals, fxRate, onDone, onCancel }) {
  const realAccounts = accounts.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
  const [step, setStep] = useState(0);
  const [accountId, setAccountId] = useState(realAccounts[0]?._id || accounts[0]?._id || '');
  // INR-first input: the user enters an INR amount; on submit the
  // amount is converted into USD via the live `fxRate` and the
  // request is sent to the backend in USD (which is the canonical
  // base currency for the trading wallet).
  const [currency, setCurrency] = useState('INR');
  const [method, setMethod] = useState('UPI');
  const [amount, setAmount] = useState('');
  // Currency-converter widget state — exposes the non-INR wallets the
  // user is holding so they can flip those funds into INR (or any
  // other supported currency) before withdrawing through Indian rails.
  const [converterOpen, setConverterOpen] = useState(false);
  const [convertFromCcy, setConvertFromCcy] = useState('USD');
  const [convertAmount, setConvertAmount] = useState('');
  const [converting, setConverting] = useState(false);

  // UPI / Bank / Crypto destination fields — kept in shape with the
  // existing /wallet/withdrawals payload contract.
  const [upiId, setUpiId] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankIFSC, setBankIFSC] = useState('');
  const [bankAccountHolderName, setBankAccountHolderName] = useState('');
  const [bankName, setBankName] = useState('');
  const [cryptoAddress, setCryptoAddress] = useState('');
  const [cryptoNetwork, setCryptoNetwork] = useState('USDT-TRC20');

  const [loading, setLoading] = useState(false);

  const selectedAccount = accounts.find((a) => a._id === accountId);
  const isDemo = selectedAccount?.accountType === 'DEMO';
  const sym = currencySymbol(currency);

  // UPI / Bank are domestic INR rails — disable when the user is
  // withdrawing in a non-INR currency.
  useEffect(() => {
    if (currency !== 'INR' && (method === 'UPI' || method === 'BANK')) setMethod('CRYPTO');
  }, [currency, method]);

  // Available balance — the platform stores wallets in USD as the base
  // currency. When the user enters in INR we display the available
  // figure by converting every USD wallet on the selected account
  // into INR via the live `fxRate`. The submit handler converts the
  // user's INR input back into USD before hitting the backend.
  const availableBalance = (() => {
    if (!accountId) return 0;
    const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
    const wallets = (balances || []).filter((b) => b.accountId === accountId);
    let total = 0;
    for (const w of wallets) {
      const free = Math.max(0, Number(w.free || 0));
      if (!free) continue;
      if (w.currency === currency) total += free;
      else if (w.currency === 'USD' && currency === 'INR') total += free * rate;
      else if (w.currency === 'INR' && currency === 'USD') total += free / rate;
      else total += free;
    }
    return total;
  })();
  // Other-currency hint — surfaced beside the hero so the user knows
  // they have funds elsewhere even if the current currency reads 0.
  const otherCurrencyHint = (() => {
    if (!accountId) return null;
    const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
    const wallets = (balances || []).filter((b) => b.accountId === accountId && b.currency !== currency && Number(b.free || 0) > 0);
    if (!wallets.length) return null;
    const total = wallets.reduce((s, w) => {
      const free = Number(w.free || 0);
      if (w.currency === 'USD' && currency === 'INR') return s + free * rate;
      if (w.currency === 'INR' && currency === 'USD') return s + free / rate;
      return s + free;
    }, 0);
    return { wallets, totalInTargetCcy: total };
  })();
  const isOverBudget = Number(amount) > availableBalance;

  const METHODS = [
    // Withdrawals are user-entered in INR; the backend receives the
    // converted USD figure (USD is the canonical wallet currency).
    { id: 'UPI',    label: 'UPI',           sub: 'Instant · Free',          min: 500,  icon: <MUPI />,    inrOnly: false },
    { id: 'BANK',   label: 'Bank Transfer', sub: 'NEFT / IMPS · 1-24 hrs',  min: 500,  icon: <MBank />,   inrOnly: false },
    { id: 'CRYPTO', label: 'Crypto Wallet', sub: 'USDT / BTC / ETH · ~5min', min: 1000, icon: <MCrypto />, inrOnly: false },
  ];
  const STEPS = [
    { id: 'account',     label: 'Account',       sub: 'Choose account' },
    { id: 'method',      label: 'Method',        sub: 'Select method' },
    { id: 'amount',      label: 'Amount',        sub: 'Enter amount' },
    { id: 'destination', label: 'Destination',   sub: 'Where to send' },
    { id: 'confirm',     label: 'Confirmation',  sub: 'Review & confirm' },
  ];
  // Demo / virtual accounts withdraw instantly (practice money) — no real
  // payout, so the method + destination steps are skipped entirely.
  const effectiveSteps = isDemo ? STEPS.filter((s) => s.id !== 'method' && s.id !== 'destination') : STEPS;
  const stepId = effectiveSteps[step]?.id;

  const selectedMethodMeta = METHODS.find((m) => m.id === method) || METHODS[0];
  const canNext = (() => {
    if (stepId === 'account') return !!accountId;
    if (stepId === 'method')  return !!method;
    if (stepId === 'amount')  return amount && Number(amount) >= (isDemo ? 1 : (selectedMethodMeta.min || 1)) && !isOverBudget;
    if (stepId === 'destination') {
      if (method === 'UPI')    return upiId && upiId.includes('@');
      if (method === 'BANK')   return bankAccountNumber.length >= 5 && bankIFSC.length === 11 && !!bankAccountHolderName.trim();
      if (method === 'CRYPTO') return cryptoAddress.length >= 20;
    }
    return true;
  })();

  const goNext = () => setStep((s) => Math.min(s + 1, effectiveSteps.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  const submit = async () => {
    if (!amount || Number(amount) <= 0) { toast.error('Enter a valid amount'); return; }
    if (Number(amount) > availableBalance) {
      toast.error(`Insufficient balance. Available: ${sym}${availableBalance.toLocaleString('en-IN')}`);
      return;
    }
    setLoading(true);
    try {
      // Send the withdrawal as the user typed it (INR for Indian
      // rails, USD for crypto). Matches the destination format the
      // admin actually pays out, and matches what the user expects
      // to see on their UPI / bank statement. The wallet's source
      // wallet (if it's a different currency) is selected by the
      // user via the "Also held in" chip on the Amount step.
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
      toast.success(isDemo
        ? 'Demo withdrawal completed instantly'
        : 'Withdrawal request submitted — admin will process within 24 hours');
      onDone && onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="bg-white rounded-2xl border border-border-dark shadow-card overflow-hidden flex flex-col">

        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-4 border-b border-border-subtle">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-text-primary">Withdraw Funds</h2>
            <p className="text-xs text-text-secondary mt-0.5">Request a withdrawal to your registered bank or wallet</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" title="How it works?" className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5 text-text-primary text-xs font-semibold transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
              How it works?
            </button>
            <a href="/helpdesk" title="Support" className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
            </a>
            <button type="button" onClick={onCancel || (() => {})} className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
            </button>
          </div>
        </div>

        {/* ── Stepper ──────────────────────────────────────────────── */}
        <div className="px-6 py-5 border-b border-border-subtle">
          <div className="flex items-start gap-1.5 sm:gap-3">
            {effectiveSteps.map((s, i) => {
              const isActive = i === step;
              const isDone = i < step;
              return (
                <div key={s.id} className="flex items-start gap-2.5 flex-1 min-w-0">
                  <span
                    className={`w-9 h-9 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0 transition-all ${
                      isActive ? 'shadow-card' : ''
                    }`}
                    style={
                      isActive ? { background: '#3B82F6', color: '#FFFFFF' }
                      : isDone   ? { background: '#3B82F622', color: '#3B82F6' }
                      :            { background: '#E5E7EB', color: '#9CA3AF' }
                    }
                  >
                    {isDone ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    ) : <span className={isActive ? 'keep-white' : ''} style={isActive ? { color: '#FFFFFF' } : undefined}>{i + 1}</span>}
                  </span>
                  <div className="hidden md:flex flex-col min-w-0 leading-tight pt-0.5">
                    <span className={`text-[13px] font-bold truncate ${isActive ? 'text-text-primary' : isDone ? 'text-text-primary' : 'text-text-muted'}`}>{s.label}</span>
                    <span className="text-[11px] text-text-muted truncate">{s.sub}</span>
                  </div>
                  {i < effectiveSteps.length - 1 && (
                    <span className="flex-1 mx-1 sm:mx-2 mt-4 h-px border-t border-dashed border-border-dark" />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Body (scrollable) ─────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">

          {/* Step 1 — Account */}
          {stepId === 'account' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-text-primary">Withdraw from</h3>
                <p className="text-xs text-text-muted mt-0.5">Pick an account to withdraw funds from.</p>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {accounts.map((a) => {
                  const sel = a._id === accountId;
                  const isR = a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL';
                  const inrWallet = balances.find((b) => b.accountId === a._id && b.currency === 'INR');
                  const usdWallet = balances.find((b) => b.accountId === a._id && b.currency === 'USD');
                  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
                  const accFree = (Number(inrWallet?.free) || 0) + (Number(usdWallet?.free) || 0) * rate;
                  return (
                    <button
                      key={a._id}
                      type="button"
                      onClick={() => setAccountId(a._id)}
                      className={`relative w-full p-5 rounded-2xl border-2 text-left transition-all hover:shadow-card ${sel ? 'shadow-card' : 'hover:-translate-y-0.5'}`}
                      style={sel
                        ? { borderColor: '#3B82F6', background: '#3B82F608' }
                        : { borderColor: '#E5E7EB', background: '#FFFFFF' }
                      }
                    >
                      {/* Top — avatar + check */}
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className="w-11 h-11 rounded-xl flex items-center justify-center text-sm font-extrabold shrink-0"
                          style={{ background: '#1D4ED810', color: '#1D4ED8' }}
                        >
                          {(a.nickname || a.accountNumber || 'A').slice(0, 2).toUpperCase()}
                        </span>
                        <span
                          className="shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all"
                          style={sel
                            ? { borderColor: '#3B82F6', background: '#3B82F6' }
                            : { borderColor: '#E5E7EB', background: '#FFFFFF' }
                          }
                        >
                          {sel && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" className="keep-white"><path d="M5 13l4 4L19 7" /></svg>
                          )}
                        </span>
                      </div>

                      {/* Name + badge */}
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-base font-bold text-text-primary truncate">{a.nickname || a.accountNumber}</span>
                        <span
                          className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded"
                          style={isR
                            ? { background: '#3B82F618', color: '#3B82F6' }
                            : { background: '#1D4ED815', color: '#1D4ED8' }
                          }
                        >
                          {isR ? 'Live · Real' : 'Demo'}
                        </span>
                      </div>
                      <div className="text-[11px] text-text-muted font-mono mt-0.5">{a.accountNumber}</div>

                      {/* Balance footer — Available to withdraw */}
                      <div className="mt-4 flex items-end justify-between gap-2">
                        <div>
                          <div className="text-xl font-bold font-mono tabular-nums text-text-primary">
                            {currencySymbol('INR')}{fmtNum(accFree, 2)}
                          </div>
                          <div className="text-[11px] text-text-muted mt-0.5">Available</div>
                        </div>
                        <span className="text-[10px] font-bold font-mono px-2 py-1 rounded-md bg-bg-hover text-text-secondary self-end">INR</span>
                      </div>
                    </button>
                  );
                })}
              </div>
              {isDemo && (
                <div className="rounded-xl bg-info/10 border border-info/30 p-3 text-xs text-text-primary">
                  ✨ Demo withdrawals are processed instantly — no payment details or admin review needed.
                </div>
              )}
            </div>
          )}

          {/* Step 2 — Method */}
          {stepId === 'method' && (
            <div className="space-y-3">
              <div>
                <h3 className="text-base font-bold text-text-primary">Choose withdrawal method</h3>
                <p className="text-xs text-text-muted mt-0.5">Where should we send the funds?</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {METHODS.map((m) => {
                  const sel = method === m.id;
                  const disabled = m.inrOnly && currency !== 'INR';
                  return (
                    <button
                      key={m.id}
                      type="button"
                      disabled={disabled}
                      title={disabled ? `${m.label} is only available for INR` : undefined}
                      onClick={() => setMethod(m.id)}
                      className={`relative text-left p-4 rounded-xl border-2 transition-all hover:shadow-card disabled:opacity-40 disabled:cursor-not-allowed ${sel ? 'border-primary-500 bg-primary-500/[0.05]' : 'border-border-dark hover:border-primary-500/40'}`}
                    >
                      <div className="flex items-center gap-3">
                        {m.icon}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-bold text-text-primary">{m.label}</div>
                          <div className="text-[11px] text-text-muted mt-0.5">{m.sub}</div>
                          <div className="text-[11px] text-text-secondary mt-1">Min · {sym}{m.min}</div>
                        </div>
                      </div>
                      <span className={`absolute top-3 right-3 w-4 h-4 rounded-full border-2 ${sel ? 'border-primary-500 bg-primary-500' : 'border-border-dark'} flex items-center justify-center`}>
                        {sel && <span className="keep-white w-1.5 h-1.5 rounded-full bg-white" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3 — Amount */}
          {stepId === 'amount' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">How much would you like to withdraw?</h3>
                <p className="text-xs text-text-muted mt-0.5">Pick a preset or enter your own.</p>
              </div>

              {/* Available balance hero */}
              <div className="rounded-xl bg-bull/5 border border-bull/30 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Available to Withdraw</div>
                    <div className="text-2xl font-bold text-bull font-mono tabular-nums mt-1">{fmtMoney(availableBalance, currency)}</div>
                  </div>
                  <button type="button" onClick={() => setAmount(String(availableBalance))} disabled={availableBalance <= 0} className="text-xs font-bold text-bull bg-bull/15 px-3 py-1.5 rounded-lg hover:bg-bull/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                    Use MAX
                  </button>
                </div>
                {otherCurrencyHint && otherCurrencyHint.wallets.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-bull/20 text-[11px] text-text-secondary flex items-center gap-2 flex-wrap">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></svg>
                    <span>Also held in:</span>
                    {otherCurrencyHint.wallets.map((w) => (
                      <button
                        key={w.currency}
                        type="button"
                        onClick={() => setCurrency(w.currency)}
                        className="px-2 py-0.5 rounded-md bg-white border border-border-dark text-text-primary font-mono font-semibold hover:border-primary-500 transition-colors"
                      >
                        {fmtMoney(Number(w.free || 0), w.currency)}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const first = otherCurrencyHint.wallets[0];
                        setConvertFromCcy(first.currency);
                        setConvertAmount(String(Number(first.free || 0)));
                        setConverterOpen((v) => !v);
                      }}
                      className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-bold text-primary-600 bg-primary-500/10 border border-primary-500/30 hover:bg-primary-500/15 transition-colors"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3l4 4-4 4" /><path d="M4 7h16" /><path d="M8 21l-4-4 4-4" /><path d="M20 17H4" /></svg>
                      Convert to {currency}
                    </button>
                  </div>
                )}
                {converterOpen && otherCurrencyHint && (() => {
                  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
                  const srcFree = (balances || []).find((b) => b.accountId === accountId && b.currency === convertFromCcy)?.free || 0;
                  const amt = Math.max(0, Number(convertAmount) || 0);
                  const isOver = amt > Number(srcFree);
                  // FX math: convert any source currency into the
                  // currently-selected target (INR by default). We use
                  // the same fxRate the rest of the wallet uses so the
                  // figures are coherent across the page.
                  let converted = 0;
                  if (convertFromCcy === 'USD' && currency === 'INR') converted = amt * rate;
                  else if (convertFromCcy === 'INR' && currency === 'USD') converted = amt / rate;
                  else if (convertFromCcy === currency) converted = amt;
                  else converted = amt; // fallback — same magnitude
                  const submitConvert = async () => {
                    if (!amt || isOver) return;
                    setConverting(true);
                    try {
                      // Best-effort backend call. If the platform
                      // exposes a conversion endpoint, this lands
                      // funds in the target wallet instantly.
                      // Otherwise the error bubbles back through
                      // errorMessage() so the user sees a clear toast.
                      await api.post('/wallet/convert', {
                        accountId,
                        fromCurrency: convertFromCcy,
                        toCurrency: currency,
                        amount: amt,
                      });
                      toast.success(`Converted ${currencySymbol(convertFromCcy)}${fmtNum(amt, 2)} to ${currencySymbol(currency)}${fmtNum(converted, 2)}`);
                      setConverterOpen(false);
                      setConvertAmount('');
                      onDone && onDone();
                    } catch (err) {
                      toast.error(errorMessage(err) || 'Currency conversion is not available — please contact support.');
                    } finally {
                      setConverting(false);
                    }
                  };
                  return (
                    <div className="mt-3 rounded-xl bg-white border border-primary-500/30 p-3 space-y-2.5">
                      <div className="text-xs font-bold text-text-primary">Convert to {currency}</div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-bold text-text-muted">From</label>
                          <select value={convertFromCcy} onChange={(e) => setConvertFromCcy(e.target.value)} className="w-full mt-1 px-2.5 py-2 rounded-lg border border-border-dark bg-white text-xs font-semibold text-text-primary focus:border-primary-500 focus:outline-none">
                            {otherCurrencyHint.wallets.map((w) => (
                              <option key={w.currency} value={w.currency}>{w.currency} (Free: {currencySymbol(w.currency)}{fmtNum(Number(w.free || 0), 2)})</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Amount</label>
                          <div className="relative mt-1">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted font-semibold text-xs">{currencySymbol(convertFromCcy)}</span>
                            <input type="number" step="any" value={convertAmount} onChange={(e) => setConvertAmount(e.target.value)} placeholder="0.00" className={`w-full pl-6 pr-2 py-2 rounded-lg border bg-white text-xs font-bold text-text-primary focus:outline-none ${isOver ? 'border-bear' : 'border-border-dark focus:border-primary-500'}`} />
                          </div>
                          {isOver && <div className="mt-1 text-[10px] text-bear font-semibold">Exceeds available balance</div>}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-lg bg-bg-hover px-3 py-2 text-[11px]">
                        <div>
                          <span className="text-text-muted">You give</span>
                          <span className="ml-1.5 font-mono font-bold text-text-primary">{currencySymbol(convertFromCcy)}{fmtNum(amt, 2)}</span>
                        </div>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
                        <div>
                          <span className="text-text-muted">You get</span>
                          <span className="ml-1.5 font-mono font-bold text-bull">{currencySymbol(currency)}{fmtNum(converted, 2)}</span>
                        </div>
                      </div>
                      <div className="text-[10px] text-text-muted font-mono">Rate · 1 USD = ₹{fmtNum(rate, 2)} (live)</div>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setConverterOpen(false)} className="flex-1 py-1.5 rounded-lg text-xs font-semibold border border-border-dark text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
                        <button
                          type="button"
                          onClick={submitConvert}
                          disabled={!amt || isOver || converting}
                          className="flex-1 py-1.5 rounded-lg text-xs font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}
                        >
                          <span className="keep-white" style={{ color: '#FFFFFF' }}>{converting ? 'Converting…' : 'Confirm Conversion'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Percent presets */}
              <div className="grid grid-cols-4 gap-2">
                {[25, 50, 75, 100].map((pct) => {
                  const v = ((availableBalance * pct) / 100);
                  const sel = amount && Math.abs(Number(amount) - v) < 0.01;
                  return (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => setAmount(v.toFixed(2))}
                      className={`px-3 py-2.5 rounded-xl border-2 text-sm font-bold transition-colors ${sel ? 'border-primary-500 bg-primary-500/[0.05] text-primary-600' : 'border-border-dark text-text-primary hover:border-primary-500/40'}`}
                    >
                      {pct === 100 ? 'MAX' : `${pct}%`}
                    </button>
                  );
                })}
              </div>

              <div>
                <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Custom amount</label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted font-semibold">{sym}</span>
                  <input
                    type="number"
                    step="any"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className={`w-full pl-8 pr-3 py-3 rounded-xl border-2 bg-white text-lg font-bold text-text-primary focus:outline-none ${isOverBudget ? 'border-bear' : 'border-border-dark focus:border-primary-500'}`}
                  />
                  <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="absolute right-2 top-1/2 -translate-y-1/2 bg-bg-hover text-xs font-bold text-text-primary rounded-lg px-2 py-1.5 border border-border-dark focus:outline-none">
                    {['INR', 'USD', 'USDT'].map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
                {isOverBudget && (
                  <div className="mt-1.5 text-[11px] text-bear font-semibold">Exceeds your available balance</div>
                )}
              </div>

              {/* Live summary — dual-currency. Primary line in the
                  selected currency, sub-line in the converted INR↔USD
                  equivalent so the user sees both at a glance. */}
              {(() => {
                const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
                const amt = Number(amount) || 0;
                const isInr = currency === 'INR';
                const altCcy = isInr ? 'USD' : 'INR';
                const altAmt = isInr ? amt / rate : amt * rate;
                const fmtAlt = (v) => `${currencySymbol(altCcy)}${fmtNum(v, 2)}`;
                return (
                  <>
                    <div className="grid grid-cols-3 gap-3 bg-bg-hover rounded-xl p-4">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">You Withdraw</div>
                        <div className="text-base font-bold font-mono tabular-nums text-text-primary mt-0.5">{sym}{fmtNum(amt, 2)}</div>
                        <div className="text-[10px] font-mono tabular-nums text-text-muted mt-0.5">≈ {fmtAlt(altAmt)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">Fees</div>
                        <div className="text-base font-bold font-mono tabular-nums text-bull mt-0.5">{sym}0.00</div>
                        <div className="text-[10px] font-mono tabular-nums text-text-muted mt-0.5">≈ {fmtAlt(0)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">You Receive</div>
                        <div className="text-base font-bold font-mono tabular-nums text-text-primary mt-0.5">{sym}{fmtNum(amt, 2)}</div>
                        <div className="text-[10px] font-mono tabular-nums text-text-muted mt-0.5">≈ {fmtAlt(altAmt)}</div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-lg bg-primary-500/5 border border-primary-500/20 px-3 py-2 text-[11px]">
                      <span className="flex items-center gap-1.5 text-text-secondary">
                        <span className="w-1.5 h-1.5 rounded-full bg-bull animate-pulse" />
                        Live FX rate
                      </span>
                      <span className="font-mono font-bold text-text-primary">1 USD = ₹{fmtNum(rate, 2)}</span>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {/* Step 4 — Destination details */}
          {stepId === 'destination' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">Destination details</h3>
                <p className="text-xs text-text-muted mt-0.5">Where should the funds land?</p>
              </div>

              {method === 'UPI' && (
                <div>
                  <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Your UPI ID *</label>
                  <input value={upiId} onChange={(e) => setUpiId(e.target.value)} placeholder="e.g. yourname@upi or 9876543210@paytm" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono text-text-primary" />
                  <div className="text-[11px] text-text-muted mt-1">Money will be sent to this UPI ID</div>
                </div>
              )}

              {method === 'BANK' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Account holder name *</label>
                    <input value={bankAccountHolderName} onChange={(e) => setBankAccountHolderName(e.target.value)} placeholder="Full name as on bank account" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm text-text-primary" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Account number *</label>
                    <input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value.replace(/\s/g, ''))} placeholder="e.g. 50100123456789" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono text-text-primary" />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">IFSC *</label>
                    <input value={bankIFSC} onChange={(e) => setBankIFSC(e.target.value.toUpperCase())} maxLength={11} placeholder="HDFC0001234" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono uppercase text-text-primary" />
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Bank name</label>
                    <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. HDFC Bank" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm text-text-primary" />
                  </div>
                </div>
              )}

              {method === 'CRYPTO' && (
                <>
                  <div>
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Network *</label>
                    <select value={cryptoNetwork} onChange={(e) => setCryptoNetwork(e.target.value)} className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-semibold text-text-primary">
                      {['USDT-TRC20', 'USDT-ERC20', 'USDT-BEP20', 'BTC', 'ETH'].map((n) => <option key={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Wallet address *</label>
                    <input value={cryptoAddress} onChange={(e) => setCryptoAddress(e.target.value.trim())} placeholder="0x... or T..." className="w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 border-border-dark focus:border-primary-500 focus:outline-none bg-white text-sm font-mono text-xs text-text-primary" />
                  </div>
                  <div className="rounded-xl bg-info/10 border border-info/30 p-3 text-[11px] text-text-secondary">
                    <span className="font-bold text-text-primary">Heads up.</span> Crypto addresses may need to be whitelisted from your Profile (24 h cooldown) before they're accepted.
                  </div>
                </>
              )}

              <div className="rounded-xl bg-bull/10 border border-bull/30 p-3 flex items-start gap-2.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                <div className="text-[11px] text-text-secondary">
                  <span className="font-bold text-text-primary">Security check.</span> Withdrawals are processed manually within 1-24 hours. Funds are locked from your balance immediately upon submission.
                </div>
              </div>
            </div>
          )}

          {/* Step 5 — Confirmation */}
          {stepId === 'confirm' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-bold text-text-primary">Review &amp; confirm</h3>
                <p className="text-xs text-text-muted mt-0.5">Double-check the details before submitting.</p>
              </div>
              <div className="rounded-2xl border border-border-dark p-5 space-y-3 bg-bg-hover/40">
                {[
                  { l: 'Account',  v: `${selectedAccount?.nickname || selectedAccount?.accountNumber} · ${selectedAccount?.accountType}` },
                  { l: 'Method',   v: selectedMethodMeta.label },
                  { l: 'Amount',   v: `${sym}${fmtNum(Number(amount) || 0, 2)}` },
                  { l: 'Fees',     v: `${sym}0.00` },
                  { l: 'Receive',  v: `${sym}${fmtNum(Number(amount) || 0, 2)}` },
                  ...(method === 'UPI'    ? [{ l: 'UPI ID',  v: upiId || '—' }] : []),
                  ...(method === 'BANK'   ? [
                    { l: 'Beneficiary',    v: bankAccountHolderName || '—' },
                    { l: 'Account number', v: bankAccountNumber ? `••• ${bankAccountNumber.slice(-4)}` : '—' },
                    { l: 'IFSC',           v: bankIFSC || '—' },
                  ] : []),
                  ...(method === 'CRYPTO' ? [
                    { l: 'Network',  v: cryptoNetwork },
                    { l: 'Address',  v: cryptoAddress ? `${cryptoAddress.slice(0, 8)}…${cryptoAddress.slice(-6)}` : '—' },
                  ] : []),
                ].map((r) => (
                  <div key={r.l} className="flex items-center justify-between text-sm">
                    <span className="text-text-muted">{r.l}</span>
                    <span className="font-semibold text-text-primary text-right truncate ml-3">{r.v}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-xl bg-bull/10 border border-bull/30 p-3 flex items-start gap-2.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                <div className="text-[11px] text-text-secondary">
                  Funds will be locked immediately on submit. Admin verifies and releases within 1–24 hours.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Sticky bottom action bar — Cancel/Back left, security
            strip centre, primary action right. */}
        <div className="border-t border-border-subtle bg-bg-hover/40 px-6 py-4 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={step === 0 ? (onCancel || (() => {})) : goBack}
            className="px-5 py-2.5 rounded-xl border border-border-dark bg-white text-text-primary font-semibold text-sm hover:shadow-card transition-all"
          >
            {step === 0 ? 'Cancel' : '← Back'}
          </button>
          <span className="hidden md:flex items-center gap-2 text-[12px] text-text-secondary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
            {isDemo ? 'Demo withdrawals are processed instantly' : 'Withdrawals are processed manually within 1–24 hours'}
          </span>
          {step < effectiveSteps.length - 1 ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canNext}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{ background: '#3B82F6', color: '#FFFFFF' }}
            >
              <span className="keep-white" style={{ color: '#FFFFFF' }}>Continue →</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={loading || !canNext}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{ background: '#3B82F6', color: '#FFFFFF' }}
            >
              <span className="keep-white" style={{ color: '#FFFFFF' }}>
                {loading ? 'Submitting…' : isDemo ? `Withdraw ${sym}${fmtNum(Number(amount) || 0, 2)} instantly` : `Request Withdrawal of ${sym}${fmtNum(Number(amount) || 0, 2)}`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Recent withdrawals — sits below the flow card */}
      <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-border-subtle">
          <span className="text-sm font-bold text-text-primary">Recent Withdrawals</span>
        </div>
        <div className="overflow-x-auto p-5">
          <WithdrawalsTable items={withdrawals} />
        </div>
      </div>
    </>
  );
}

function TransferView({ accounts, balances, onDone }) {
  // ── Mode toggle: between own accounts (legacy) OR to another user.
  // Both share the same endpoint family — `/wallet/transfers` for the
  // existing flow, `/wallet/transfer-user` for the new peer-to-peer
  // flow. We render two different panels but keep them under the same
  // "Transfer" left-nav item so the user sees a single transfer hub.
  const [mode, setMode] = useState('self'); // 'self' | 'user'

  // Subscription ("Main") + Bonus wallets use the literal sentinels
  // 'subscription' / 'bonus' on the backend (user-level, not per-account).
  // We surface them as fake entries in the From/To dropdowns so the
  // existing transfer flow handles them. (Bonus has no withdraw path, but
  // funds CAN move out via this internal transfer.)
  const SUB_OPT = { _id: 'subscription', nickname: 'Main Wallet', accountType: 'SUB' };
  const BONUS_OPT = { _id: 'bonus', nickname: 'Bonus Wallet', accountType: 'BONUS' };

  // DEMO / VIRTUAL accounts use practice money — they have no real
  // balance to move and aren't allowed on either side of an internal
  // transfer. Filtered here so they never appear in the picker.
  const liveAccounts = useMemo(
    () => accounts.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL'),
    [accounts]
  );

  const [from, setFrom] = useState(liveAccounts[0]?._id || '');
  const [to, setTo] = useState(liveAccounts[1]?._id || liveAccounts[0]?._id || '');
  const [currency, setCurrency] = useState('USD');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Main + Bonus wallet snapshots — fetched once for the free-balance
  // display when the user picks one as the source.
  const [subWallet, setSubWallet] = useState(null);
  const [bonusWallet, setBonusWallet] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/subscription-wallet');
        setSubWallet(r.data.data || null);
      } catch { /* non-fatal */ }
      try {
        const b = await api.get('/bonus-wallet');
        setBonusWallet(b.data.data || null);
      } catch { /* non-fatal */ }
    })();
  }, []);

  // Merge live trading accounts + Main + Bonus wallets for the dropdowns.
  // (Demo accounts are already filtered out of `liveAccounts` above.)
  const transferOptions = useMemo(() => [...liveAccounts, SUB_OPT, BONUS_OPT], [liveAccounts]);

  const isSubFrom = from === 'subscription';
  const isSubTo   = to   === 'subscription';
  const isBonusFrom = from === 'bonus';
  const isBonusTo   = to   === 'bonus';
  const isSpecial = (id) => id === 'subscription' || id === 'bonus';
  const fromAcc = transferOptions.find((a) => a._id === from);
  const toAcc   = transferOptions.find((a) => a._id === to);

  // Source balance: Main/Bonus wallets use their own balance; trading
  // wallets read from the per-account balances array.
  const free = isSubFrom
    ? Number(subWallet?.balance || 0)
    : isBonusFrom
    ? Number(bonusWallet?.balance || 0)
    : Number((balances.find((b) => b.accountId === from && b.currency === currency))?.free || 0);
  const overBudget = Number(amount) > free;
  const subOnlyUsd = (isSpecial(from) || isSpecial(to)) && currency !== 'USD';

  const submit = async () => {
    if (!from || !to || from === to || !amount) {
      toast.error('Pick two different accounts and a positive amount');
      return;
    }
    if (subOnlyUsd) {
      toast.error('Main / Bonus Wallet transfers must be in USD');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/wallet/transfers', { fromAccountId: from, toAccountId: to, currency, amount });
      toast.success('Transfer completed');
      setAmount('');
      setConfirm(false);
      onDone && onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Transfer Funds</h1>
        <p className="text-sm text-text-secondary mt-1">
          {mode === 'self'
            ? 'Move funds instantly between your trading and funding accounts.'
            : 'Send funds directly to another registered user using the internal wallet ledger.'}
        </p>
      </div>

      {/* Mode toggle */}
      <div className="inline-flex p-1 bg-bg-hover rounded-xl border border-border-dark">
        {[
          { id: 'self', label: 'Between my accounts' },
          { id: 'user', label: 'Send to another user' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setMode(t.id)}
            className={`px-4 py-2 text-sm font-bold rounded-lg transition-all ${
              mode === t.id
                ? 'bg-white text-text-primary shadow-card'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === 'user' && (
        <TransferToUserPanel accounts={liveAccounts} balances={balances} subWallet={subWallet} onDone={onDone} />
      )}

      {mode === 'self' && (
      <div className="bg-white border border-border-dark rounded-2xl p-5 space-y-4">
        {/* Quick action — one tap pre-selects the existing Subscription
            Wallet as the destination (still uses the same /wallet/transfers
            flow). Purely a discoverability shortcut; no logic changes. */}
        {!isSubTo && (
          <button
            type="button"
            onClick={() => {
              if (from === 'subscription') setFrom(liveAccounts[0]?._id || '');
              setTo('subscription');
              setCurrency('USD');
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-primary-500/40 bg-primary-500/5 text-primary-600 text-sm font-bold hover:bg-primary-500/10 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="M5 12l7-7 7 7" /></svg>
            Transfer to Main Wallet
          </button>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">From</label>
            <select
              value={from}
              onChange={(e) => {
                const v = e.target.value;
                setFrom(v);
                if (v === 'subscription' || v === 'bonus') setCurrency('USD');
              }}
              className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none"
            >
              {transferOptions.map((a) => (
                <option key={a._id} value={a._id}>
                  {a._id === 'subscription'
                    ? 'Main Wallet · USD'
                    : a._id === 'bonus'
                    ? 'Bonus Wallet · USD'
                    : `${a.nickname || a.accountNumber} · ${a.accountType}`}
                </option>
              ))}
            </select>
            {fromAcc && (
              <div className="mt-1.5 text-[11px] text-text-muted">
                {(isSubFrom || isBonusFrom) ? 'Balance' : 'Free'}: <span className="font-mono font-semibold text-bull">{fmtMoney(free, (isSubFrom || isBonusFrom) ? 'USD' : currency)}</span>
              </div>
            )}
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">To</label>
            <select
              value={to}
              onChange={(e) => {
                const v = e.target.value;
                setTo(v);
                if (v === 'subscription' || v === 'bonus') setCurrency('USD');
              }}
              className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none"
            >
              {transferOptions.map((a) => (
                <option key={a._id} value={a._id}>
                  {a._id === 'subscription'
                    ? 'Main Wallet · USD'
                    : a._id === 'bonus'
                    ? 'Bonus Wallet · USD'
                    : `${a.nickname || a.accountNumber} · ${a.accountType}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Currency</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none">
              {['USD', 'EUR', 'GBP', 'INR'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Amount</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" className={`w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 bg-white text-lg font-bold text-text-primary focus:outline-none ${overBudget ? 'border-bear' : 'border-border-dark focus:border-primary-500'}`} />
            {overBudget && <div className="mt-1.5 text-[11px] text-bear font-semibold">Exceeds source account balance</div>}
          </div>
        </div>

        {from === to && from && (
          <div className="text-[11px] text-bear font-semibold">Source and destination must be different accounts.</div>
        )}
        {subOnlyUsd && (
          <div className="text-[11px] text-warn font-semibold">Main / Bonus Wallet only supports USD. Currency switched automatically.</div>
        )}

        <button
          type="button"
          onClick={() => setConfirm(true)}
          disabled={!from || !to || from === to || !amount || Number(amount) <= 0 || overBudget || subOnlyUsd}
          className="w-full py-3.5 rounded-xl font-bold text-base shadow-card hover:shadow-elevated transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}
        >
          <span className="keep-white" style={{ color: '#FFFFFF' }}>Review Transfer →</span>
        </button>
      </div>
      )}

      {confirm && mode === 'self' && (
        <Modal onClose={() => setConfirm(false)}>
          <div className="text-lg font-bold text-text-primary">Confirm Transfer</div>
          <p className="text-sm text-text-secondary mt-2">
            Move <span className="font-mono font-bold text-text-primary">{fmtMoney(amount || '0', currency)}</span> from{' '}
            <span className="font-semibold text-text-primary">{fromAcc?.nickname || fromAcc?.accountNumber}</span>{' '}
            to <span className="font-semibold text-text-primary">{toAcc?.nickname || toAcc?.accountNumber}</span>?
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => setConfirm(false)} className="flex-1 py-2.5 rounded-xl border border-border-dark text-text-primary font-semibold text-sm hover:bg-bg-hover transition-colors">Cancel</button>
            <button onClick={submit} disabled={submitting} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
              <span className="keep-white" style={{ color: '#FFFFFF' }}>{submitting ? 'Transferring…' : 'Confirm Transfer'}</span>
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Peer-to-peer transfer panel.
 *
 * Recipient search is debounced (250 ms) and hits
 * `/wallet/recipients/search?q=&by=uid` — matching the recipient's
 * permanent User ID ONLY (e.g. USR100245), shown with an avatar initials
 * chip. Once a recipient is selected the form gates Review on
 * a positive amount within the admin-tuned min/max, and a fee preview
 * is shown if `feePercent > 0`.
 */
function TransferToUserPanel({ accounts, balances, subWallet, onDone }) {
  // Source options = trading accounts + the user-level Main Wallet
  // (sentinel 'subscription', USD-only).
  const fromOptions = [...accounts, { _id: 'subscription', nickname: 'Main Wallet', accountType: 'MAIN' }];
  const [fromAccountId, setFromAccountId] = useState(accounts[0]?._id || 'subscription');
  const [currency, setCurrency] = useState(accounts[0]?.baseCurrency || 'USD');
  const isMainFrom = fromAccountId === 'subscription';
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState(null);
  const [cfg, setCfg] = useState({ enabled: true, min: '0', max: '0', feePercent: '0' });
  const [submitting, setSubmitting] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Pull admin settings once on mount so we can show min/max hints and
  // pre-compute the fee preview. If the call fails we leave the
  // permissive defaults — backend enforces the cap regardless.
  useEffect(() => {
    api.get('/wallet/transfer-user/settings')
      .then((r) => setCfg(r.data.data || cfg))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced recipient search. The picker doesn't fire on every
  // keystroke — we wait until the user stops typing for 250 ms so the
  // backend isn't hammered for incremental garbage like "a", "ab", "abc".
  useEffect(() => {
    const q = query.trim();
    if (recipient) return;       // already picked
    if (q.length < 2) { setResults([]); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.get('/wallet/recipients/search', { params: { q, limit: 8, by: 'uid' } })
        .then((r) => { if (!cancelled) setResults(r.data.data || []); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, recipient]);

  const acct = fromOptions.find((a) => a._id === fromAccountId);
  const free = isMainFrom
    ? Number(subWallet?.balance || 0)
    : Number(balances.find((b) => b.accountId === fromAccountId && b.currency === currency)?.free || 0);
  const amt = Number(amount) || 0;
  const feePct = Number(cfg.feePercent) || 0;
  const feeAmt = feePct > 0 ? amt * (feePct / 100) : 0;
  const total = amt + feeAmt;
  const overBudget = total > free;
  const min = Number(cfg.min || 0);
  const max = Number(cfg.max || 0);
  const belowMin = min > 0 && amt > 0 && amt < min;
  const aboveMax = max > 0 && amt > max;

  const canReview = !!recipient && amt > 0 && !overBudget && !belowMin && !aboveMax && cfg.enabled !== false;

  const submit = async () => {
    if (!canReview || !fromAccountId) return;
    setSubmitting(true);
    try {
      await api.post('/wallet/transfer-user', {
        fromAccountId,
        currency,
        amount: String(amt),
        note: note?.trim() || undefined,
        recipientUserId: recipient._id,
      });
      toast.success(`Sent ${amt} ${currency} to ${recipient.name}`);
      setAmount('');
      setNote('');
      setRecipient(null);
      setQuery('');
      setConfirm(false);
      onDone && onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (cfg.enabled === false) {
    return (
      <div className="bg-white border border-border-dark rounded-2xl p-5">
        <div className="text-sm font-bold text-text-primary">Peer transfers are currently disabled</div>
        <p className="text-xs text-text-secondary mt-1">
          User-to-user transfers have been turned off by the platform administrator. Try again later.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-white border border-border-dark rounded-2xl p-5 space-y-4">
        {/* From account + currency */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">From account</label>
            <select
              value={fromAccountId}
              onChange={(e) => {
                const v = e.target.value;
                setFromAccountId(v);
                if (v === 'subscription') setCurrency('USD');
              }}
              className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none"
            >
              {fromOptions.map((a) => (
                <option key={a._id} value={a._id}>
                  {a._id === 'subscription'
                    ? 'Main Wallet · USD'
                    : `${(a.nickname || a.accountNumber)} · ${a.accountType}`}
                </option>
              ))}
            </select>
            {acct && (
              <div className="mt-1.5 text-[11px] text-text-muted">
                {isMainFrom ? 'Balance' : 'Free'}: <span className="font-mono font-semibold text-bull">{fmtMoney(free, isMainFrom ? 'USD' : currency)}</span>
              </div>
            )}
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Currency</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={isMainFrom} className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none disabled:opacity-60">
              {(isMainFrom ? ['USD'] : ['USD', 'EUR', 'GBP', 'INR']).map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Recipient picker */}
        <div>
          <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Recipient</label>
          {recipient ? (
            <div className="mt-1.5 flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 border-primary-500 bg-primary-500/5">
              <RecipientAvatar user={recipient} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-text-primary truncate">{recipient.name}</div>
                <div className="text-[11px] text-text-muted truncate font-mono">
                  {recipient.userUid || recipient.email}
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setRecipient(null); setQuery(''); setResults([]); }}
                className="text-xs font-semibold text-text-secondary hover:text-bear px-2 py-1 rounded-lg hover:bg-bear/10 transition-colors"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="mt-1.5 relative">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Enter recipient's User ID (e.g. USR100245)"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="characters"
                spellCheck={false}
                name="recipient-user-id"
                data-lpignore="true"
                data-1p-ignore=""
                className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none"
              />
              {/* Results dropdown */}
              {(searching || results.length > 0) && (
                <div className="absolute z-20 mt-1 left-0 right-0 max-h-72 overflow-y-auto bg-white border border-border-dark rounded-xl shadow-elevated">
                  {searching && results.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-text-muted">Searching…</div>
                  ) : (
                    results.map((u) => (
                      <button
                        key={u._id}
                        type="button"
                        onClick={() => { setRecipient(u); setResults([]); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-bg-hover transition-colors text-left"
                      >
                        <RecipientAvatar user={u} />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-bold text-text-primary truncate">{u.name}</div>
                          <div className="text-[11px] text-text-muted truncate font-mono">
                            {u.userUid || u.email}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                  {!searching && results.length === 0 && query.trim().length >= 2 && (
                    <div className="px-3 py-3 text-xs text-text-muted">No users found.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Amount + note */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Amount</label>
            <input
              type="number" inputMode="decimal" min="0" step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={`w-full mt-1.5 px-3 py-2.5 rounded-xl border-2 bg-white text-lg font-bold text-text-primary focus:outline-none ${overBudget || belowMin || aboveMax ? 'border-bear' : 'border-border-dark focus:border-primary-500'}`}
            />
            <div className="mt-1.5 text-[11px] text-text-muted">
              {min > 0 && <>Min <span className="font-mono">{fmtMoney(min, currency)}</span></>}
              {min > 0 && max > 0 && ' · '}
              {max > 0 && <>Max <span className="font-mono">{fmtMoney(max, currency)}</span></>}
              {(min > 0 || max > 0) && feePct > 0 && ' · '}
              {feePct > 0 && <>Fee <span className="font-mono">{feePct}%</span></>}
            </div>
            {overBudget && <div className="mt-1.5 text-[11px] text-bear font-semibold">Exceeds free balance ({fmtMoney(free, currency)})</div>}
            {belowMin && <div className="mt-1.5 text-[11px] text-bear font-semibold">Below minimum transfer amount</div>}
            {aboveMax && <div className="mt-1.5 text-[11px] text-bear font-semibold">Above maximum transfer amount</div>}
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={120}
              placeholder="Visible to recipient"
              className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Fee preview */}
        {feeAmt > 0 && amt > 0 && (
          <div className="text-[11px] text-text-secondary bg-bg-hover rounded-lg px-3 py-2 flex items-center justify-between">
            <span>You send</span>
            <span className="font-mono font-semibold text-text-primary">{fmtMoney(amt, currency)}</span>
            <span>Fee {feePct}%</span>
            <span className="font-mono text-warn">{fmtMoney(feeAmt, currency)}</span>
            <span>Total debit</span>
            <span className="font-mono font-bold text-text-primary">{fmtMoney(total, currency)}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => setConfirm(true)}
          disabled={!canReview}
          className="w-full py-3.5 rounded-xl font-bold text-base shadow-card hover:shadow-elevated transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}
        >
          <span className="keep-white" style={{ color: '#FFFFFF' }}>Review Transfer →</span>
        </button>
      </div>

      {confirm && (
        <Modal onClose={() => setConfirm(false)}>
          <div className="text-lg font-bold text-text-primary">Confirm Transfer</div>
          <div className="mt-3 px-3 py-2.5 rounded-xl bg-bg-hover flex items-center gap-3">
            <RecipientAvatar user={recipient} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-text-primary truncate">{recipient?.name}</div>
              <div className="text-[11px] text-text-muted truncate font-mono">
                {recipient?.userUid || recipient?.email}
              </div>
            </div>
          </div>
          <div className="mt-3 text-sm space-y-1">
            <div className="flex items-center justify-between text-text-secondary"><span>Amount</span><span className="font-mono font-bold text-text-primary">{fmtMoney(amt, currency)}</span></div>
            {feeAmt > 0 && (
              <div className="flex items-center justify-between text-text-secondary"><span>Fee ({feePct}%)</span><span className="font-mono text-warn">{fmtMoney(feeAmt, currency)}</span></div>
            )}
            <div className="flex items-center justify-between font-bold pt-1 border-t border-border-subtle"><span className="text-text-primary">You pay</span><span className="font-mono text-text-primary">{fmtMoney(total, currency)}</span></div>
          </div>
          {note && <div className="mt-3 text-xs text-text-muted">Note: "{note}"</div>}
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => setConfirm(false)} className="flex-1 py-2.5 rounded-xl border border-border-dark text-text-primary font-semibold text-sm hover:bg-bg-hover transition-colors">Cancel</button>
            <button onClick={submit} disabled={submitting} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
              <span className="keep-white" style={{ color: '#FFFFFF' }}>{submitting ? 'Sending…' : 'Confirm & Send'}</span>
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function RecipientAvatar({ user }) {
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />;
  }
  const initials = String(user?.name || user?.email || '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
  return (
    <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0"
         style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
      <span className="keep-white" style={{ color: '#FFFFFF' }}>{initials}</span>
    </div>
  );
}

function MethodsView({ onAdd }) {
  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Payment Methods</h1>
          <p className="text-sm text-text-secondary mt-1">Saved cards, bank accounts, and crypto wallets for faster checkout.</p>
        </div>
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated transition-all" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
          <span className="keep-white" style={{ color: '#FFFFFF' }}>+ Add Method</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          { type: 'Bank Account', name: 'HDFC Bank ••• 1234', sub: 'INR · Default', tint: '#1D4ED8', icon: <NIMethods />, isDefault: true },
          { type: 'Crypto Wallet', name: 'USDT (TRC20)', sub: 'TX••sH7p', tint: '#3B82F6', icon: <PMUsdt /> },
        ].map((m, i) => (
          <div key={i} className="bg-white border border-border-dark rounded-2xl p-4 flex items-center gap-3 hover:shadow-card transition-shadow">
            <span className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${m.tint}18`, color: m.tint }}>{m.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-text-primary truncate">{m.name}</span>
                {m.isDefault && <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-bull/15 text-bull">Default</span>}
              </div>
              <div className="text-[11px] text-text-muted">{m.type} · {m.sub}</div>
            </div>
            <button className="text-xs font-semibold text-text-secondary hover:text-bear transition-colors px-3 py-1.5 rounded-lg hover:bg-bear/5">Remove</button>
          </div>
        ))}
      </div>

      <div className="bg-bg-hover border border-dashed border-border-dark rounded-2xl p-6 text-center">
        <div className="text-sm font-semibold text-text-primary">Want faster deposits?</div>
        <div className="text-xs text-text-muted mt-1">Add a card, bank account, or crypto address to skip re-entry on every transaction.</div>
        <button onClick={onAdd} className="mt-3 text-xs font-bold text-primary-600 hover:text-primary-700">+ Add a method</button>
      </div>
    </>
  );
}

function AccountDetailsView({ user, accounts, balances, fxRate, onRefresh, setView }) {
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const kyc = user?.kycStatus || 'NOT_STARTED';
  const kycMeta = kyc === 'APPROVED'
    ? { tint: '#16A34A', label: 'Verified' }
    : kyc === 'PENDING' ? { tint: '#3B82F6', label: 'Under Review' }
    : { tint: '#DC2626', label: 'Not verified' };

  // Account creation moved to dedicated pages (/accounts/new → tier
  // picker → /accounts/new/:tierCode configure). The legacy
  // CreateAccountInlineModal below is left in the file unused as
  // dead code that can be removed in a follow-up cleanup.
  const balanceFor = (accId, currency) => {
    const w = balances?.find((x) => x.accountId === accId && x.currency === currency);
    return w ? Number(w.balance) || 0 : 0;
  };

  return (
    <>
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Account Details</h1>
          <p className="text-sm text-text-secondary mt-1">Profile, trading accounts, KYC status, and security settings.</p>
        </div>
        <Link
          to="/accounts/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm shadow-card hover:shadow-elevated transition-all"
          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}
        >
          <span className="keep-white" style={{ color: '#FFFFFF' }}>+ New Account</span>
        </Link>
      </div>

      {/* Profile hero */}
      <div className="bg-white border border-border-dark rounded-2xl p-5">
        <div className="flex items-center gap-4">
          <span className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-bold text-white" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)' }}>
            <span className="keep-white" style={{ color: '#FFFFFF' }}>
              {(fullName || 'T').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold text-text-primary">{fullName}</div>
            <div className="text-sm text-text-secondary truncate">{user?.email || '—'}</div>
            <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase font-bold tracking-wider" style={{ background: `${kycMeta.tint}18`, color: kycMeta.tint }}>
              KYC · {kycMeta.label}
            </div>
          </div>
          <a href="/profile" className="text-xs font-semibold text-primary-600 hover:text-primary-700">Edit profile →</a>
        </div>
      </div>

      {/* Trading Accounts — full grid (replaces the old /accounts page) */}
      <div className="bg-white border border-border-dark rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-bold text-text-primary">Trading Accounts <span className="text-text-muted font-semibold">({accounts.length})</span></div>
          <button onClick={() => setView('transfer')} className="text-xs font-semibold text-primary-600 hover:text-primary-700">Transfer funds →</button>
        </div>
        {accounts.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-sm font-semibold text-text-primary">No accounts yet</div>
            <div className="text-xs text-text-muted mt-1">Create your first trading account to start.</div>
            <Link to="/accounts/new" className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold shadow-card hover:shadow-elevated transition-all" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
              <span className="keep-white" style={{ color: '#FFFFFF' }}>+ Create Account</span>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {accounts.map((a) => {
              const isR = a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL';
              const tint = isR ? '#1D4ED8' : '#3B82F6';
              const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
              const isSuspended = !!a.planSuspendedAt;
              const native = balanceFor(a._id, a.baseCurrency);
              let inr = 0, usd = 0;
              if (a.baseCurrency === 'INR') { inr = native; usd = native / rate; }
              else if (a.baseCurrency === 'USD') { usd = native; inr = native * rate; }
              else { inr = native; usd = native / rate; }
              return (
                <div key={a._id} className={`rounded-2xl border-2 p-4 hover:shadow-card hover:-translate-y-0.5 transition-all bg-white relative ${isSuspended ? 'border-amber-400 bg-amber-50/40' : 'border-border-dark'}`}>
                  {isSuspended && (
                    <div className="absolute -top-2 right-3 bg-amber-500 text-white text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full shadow">
                      Suspended
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-2">
                    <span className="w-11 h-11 rounded-xl flex items-center justify-center text-sm font-extrabold shrink-0 shadow-sm" style={{ background: `linear-gradient(135deg, ${tint}22 0%, ${tint}11 100%)`, color: tint }}>
                      {(a.nickname || a.accountNumber || 'A').slice(0, 2).toUpperCase()}
                    </span>
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded ${isR ? 'bg-bull/15 text-bull' : 'bg-info/15 text-info'}`}>
                      {isR ? 'Live · Real' : a.accountType}
                    </span>
                  </div>
                  <div className="mt-3 text-sm font-bold text-text-primary truncate">{a.nickname || a.accountNumber}</div>
                  <div className="text-[11px] text-text-muted font-mono truncate">{a.accountNumber}</div>
                  {isSuspended && (
                    <div className="mt-2 text-[11px] text-amber-700 leading-snug">
                      Over plan limit. Trading paused; you can still withdraw funds and view the last 3 months of history.
                      {' '}
                      <Link to="/plans" className="font-bold underline">Upgrade plan</Link>
                    </div>
                  )}

                  {/* Dual-currency balance — primary in native, INR & USD shown side-by-side. */}
                  <div className="mt-3 grid grid-cols-2 gap-2 bg-bg-hover rounded-xl p-2.5">
                    <div>
                      <div className="text-[9px] text-text-muted uppercase tracking-wider font-semibold">INR</div>
                      <div className="text-sm font-mono font-bold text-text-primary tabular-nums mt-0.5">₹{fmtNum(inr, 2)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-text-muted uppercase tracking-wider font-semibold">USD</div>
                      <div className="text-sm font-mono font-bold text-text-primary tabular-nums mt-0.5">${fmtNum(usd, 2)}</div>
                    </div>
                  </div>

                  <div className="mt-2.5 text-[11px]">
                    <div className="text-text-muted uppercase tracking-wider font-semibold">Leverage</div>
                    <div className="text-sm font-mono font-bold text-text-primary">1:{a.leverage}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Subscription Wallet entry-point card — separate wallet system,
          lives at /subscription-wallet. Trading balance is never touched
          by plan charges. */}
      <Link
        to="/subscription-wallet"
        className="block bg-white border-2 border-border-dark rounded-2xl p-5 hover:border-primary-500 hover:shadow-card transition-all"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-xl flex items-center justify-center text-primary-600"
                  style={{ background: 'linear-gradient(135deg, #3B82F622, #3B82F611)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 16h4" /></svg>
            </span>
            <div>
              <div className="text-base font-bold text-text-primary">Main Wallet</div>
              <div className="text-[12px] text-text-muted mt-0.5">Separate balance for plan purchases & renewals — trading funds are never touched.</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-primary-600 font-semibold text-sm">
            Open
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
          </div>
        </div>
      </Link>

      {/* Bonus Wallet entry-point card — referral/partner earnings land
          here automatically. No direct withdrawal; transfer out only. */}
      <Link
        to="/bonus-wallet"
        className="block bg-white border-2 border-border-dark rounded-2xl p-5 hover:border-bull hover:shadow-card transition-all"
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="w-11 h-11 rounded-xl flex items-center justify-center text-bull"
                  style={{ background: 'linear-gradient(135deg, #16A34A22, #16A34A11)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M3 12h18" /><path d="M12 8v13" /><path d="M12 8s-3-5-5-3 1 3 5 3z" /><path d="M12 8s3-5 5-3-1 3-5 3z" /></svg>
            </span>
            <div>
              <div className="text-base font-bold text-text-primary">Bonus Wallet</div>
              <div className="text-[12px] text-text-muted mt-0.5">All referral &amp; partner earnings, credited automatically. Transfer out to spend — no direct withdrawal.</div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-bull font-semibold text-sm">
            Open
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
          </div>
        </div>
      </Link>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-border-dark rounded-2xl p-5">
          <div className="text-sm font-bold text-text-primary mb-3">Security</div>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between">
              <span className="text-text-primary">Two-Factor Authentication</span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded uppercase" style={{ background: user?.twoFactorEnabled ? '#16A34A18' : '#DC262618', color: user?.twoFactorEnabled ? '#16A34A' : '#DC2626' }}>
                {user?.twoFactorEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-text-primary">Password</span>
              <a href="/profile" className="text-xs font-semibold text-primary-600 hover:text-primary-700">Change →</a>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-text-primary">Login alerts</span>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded uppercase bg-bull/15 text-bull">Active</span>
            </li>
          </ul>
        </div>

        <div className="bg-white border border-border-dark rounded-2xl p-5">
          <div className="text-sm font-bold text-text-primary mb-3">Profile</div>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between">
              <span className="text-text-primary">Name</span>
              <span className="font-semibold text-text-primary truncate">{fullName}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-text-primary">Email</span>
              <span className="font-semibold text-text-primary text-right truncate ml-3">{user?.email || '—'}</span>
            </li>
            <li className="flex items-center justify-between">
              <span className="text-text-primary">Phone</span>
              <span className="font-semibold text-text-primary">{user?.phone || '—'}</span>
            </li>
          </ul>
        </div>
      </div>

    </>
  );
}

// Inline replacement for the old Accounts page's CreateAccountModal.
function CreateAccountInlineModal({ onClose, onCreated }) {
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
      // `initialBalance` is only valid for DEMO accounts — strip it
      // from the payload otherwise to avoid the server's 400.
      const { initialBalance, ...rest } = form;
      const payload = form.accountType === 'DEMO' ? { ...rest, initialBalance } : rest;
      await api.post('/user/accounts', payload);
      toast.success('Account created');
      onCreated();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-elevated w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-text-primary">Create Trading Account</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Account Type</label>
            <select className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none" value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })}>
              <option value="DEMO">Demo</option>
              <option value="VIRTUAL">Virtual</option>
              <option value="REAL">Real</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Nickname</label>
            <input className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm text-text-primary focus:border-primary-500 focus:outline-none" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} placeholder="e.g. Scalping Account" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Base Currency</label>
              <select className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none" value={form.baseCurrency} onChange={(e) => setForm({ ...form, baseCurrency: e.target.value })}>
                <option>INR</option><option>USD</option><option>EUR</option><option>GBP</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Leverage</label>
              <select className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none" value={form.leverage} onChange={(e) => setForm({ ...form, leverage: Number(e.target.value) })}>
                {[1, 5, 10, 20, 50, 100, 200, 500].map((l) => <option key={l} value={l}>1:{l}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Trading Mode</label>
            <select className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-primary focus:border-primary-500 focus:outline-none" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="INTERNAL">Internal Only</option>
              <option value="EXTERNAL">External Feed</option>
              <option value="HYBRID">Hybrid</option>
            </select>
          </div>
          {form.accountType === 'DEMO' && (
            <div>
              <label className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Starting Balance</label>
              <input type="number" className="w-full mt-1.5 px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-mono text-text-primary focus:border-primary-500 focus:outline-none" value={form.initialBalance} onChange={(e) => setForm({ ...form, initialBalance: Number(e.target.value) })} />
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border-dark text-text-primary font-semibold text-sm hover:bg-bg-hover transition-colors">Cancel</button>
            <button onClick={submit} disabled={submitting} className="flex-1 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50" style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)', color: '#FFFFFF' }}>
              <span className="keep-white" style={{ color: '#FFFFFF' }}>{submitting ? 'Creating…' : 'Create'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BonusesView() {
  const promos = [
    { id: 1, title: '100% Welcome Bonus', sub: 'Up to $1,000 on your first deposit', cta: 'Claim now', tint: '#1D4ED8', tag: 'Featured', expires: 'Ends in 7 days' },
    { id: 2, title: 'Refer & Earn $50', sub: 'For every funded friend you invite', cta: 'Invite', tint: '#3B82F6', tag: 'Ongoing' },
    { id: 3, title: '10% Cashback on Spreads', sub: 'Auto-credited monthly', cta: 'See terms', tint: '#8B5CF6', tag: 'Active' },
    { id: 4, title: 'XAUUSD Weekend Boost', sub: 'Zero commission on gold trades', cta: 'Trade gold', tint: '#F59E0B', tag: 'Limited' },
  ];
  return (
    <>
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Bonuses & Offers</h1>
        <p className="text-sm text-text-secondary mt-1">Trading bonuses, cashback rewards, and seasonal promotions.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {promos.map((p) => (
          <div key={p.id} className="relative bg-white border border-border-dark rounded-2xl p-5 hover:shadow-card transition-shadow overflow-hidden">
            <div className="absolute inset-0 pointer-events-none opacity-40" style={{ background: `radial-gradient(circle at 100% 0%, ${p.tint}22, transparent 60%)` }} />
            <div className="relative">
              <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `${p.tint}18`, color: p.tint }}>{p.tag}</span>
              <div className="text-lg font-bold text-text-primary mt-2">{p.title}</div>
              <div className="text-xs text-text-secondary mt-1">{p.sub}</div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <button type="button" onClick={() => toast.success(`${p.title} – feature coming soon`)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-transform hover:scale-[1.02] active:scale-[0.98]" style={{ background: p.tint, color: '#FFFFFF' }}>
                  <span className="keep-white" style={{ color: '#FFFFFF' }}>{p.cta} →</span>
                </button>
                {p.expires && <span className="text-[10px] font-semibold text-text-muted">{p.expires}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-border-dark rounded-2xl p-5">
        <div className="text-sm font-bold text-text-primary mb-2">Referral Rewards</div>
        <p className="text-xs text-text-secondary">Share your unique link and earn rebates on every trade your referrals make.</p>
        <div className="mt-3 flex items-center gap-2">
          <input value="https://tradepro.com/r/YOUR-CODE" readOnly className="flex-1 px-3 py-2 rounded-xl border border-border-dark bg-bg-hover text-xs font-mono text-text-secondary" />
          <button onClick={() => { navigator.clipboard?.writeText('https://tradepro.com/r/YOUR-CODE'); toast.success('Link copied'); }} className="px-3 py-2 rounded-xl border border-border-dark hover:border-primary-500/50 text-xs font-bold text-text-primary transition-colors">Copy</button>
        </div>
      </div>
    </>
  );
}
