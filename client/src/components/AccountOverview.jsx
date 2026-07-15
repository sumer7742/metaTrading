import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { fmtNum } from '../utils/format';

/**
 * Account Overview — the rich wallet landing dashboard.
 *
 * Mirrors the reference design: a Total Wallet Balance summary bar,
 * Main Wallet + Referral/IB Wallet cards, an Overall Trading Summary
 * strip, a Your Trading Accounts table, a Performance Overview chart,
 * four KPI stat cards + a Recent Transactions panel, and a Recent
 * Wallet Transactions table.
 *
 * Trading figures arrive USD-normalised from the parent (`totals`,
 * `usd`, `usdSub`); wallet balances (Main / Referral) come from their
 * own endpoints in their own currency and are converted to ₹ locally.
 */
export default function AccountOverview({
  accounts = [], balances = [], deposits = [], withdrawals = [],
  positions = [], priceMap = {}, totals = {}, usd, usdSub, fxRate, setView,
}) {
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const inr = (n) => `₹${fmtNum(Number(n) || 0, 2)}`;
  const usdStr = (inrVal) => `≈ $${fmtNum((Number(inrVal) || 0) / rate, 2)} USD`;
  const toInr = (amount, currency) => {
    const n = Number(amount) || 0;
    return currency === 'USD' ? n * rate : n; // INR / unknown treated as INR
  };

  // ── Extra data this dashboard needs (parent already has the rest) ──
  const [mainWallet, setMainWallet] = useState(null);   // subscription wallet
  const [refWallet, setRefWallet] = useState(null);     // bonus wallet (referral/IB)
  const [partner, setPartner] = useState(null);         // partner volume dashboard
  const [dash, setDash] = useState(null);               // /user/dashboard
  const [closed, setClosed] = useState({ items: [], summary: null });
  const [series, setSeries] = useState([]);             // monthly-series buckets
  const [perfRange, setPerfRange] = useState('1m');
  const [rangeStats, setRangeStats] = useState({ week: null, month: null, year: null });

  useEffect(() => {
    let dead = false;
    const grab = (p) => p.then((r) => r.data.data).catch(() => null);
    (async () => {
      const [mw, rw, pt, db, cl, wk, mo, yr] = await Promise.all([
        grab(api.get('/subscription-wallet')),
        grab(api.get('/bonus-wallet')),
        grab(api.get('/partner/volume-dashboard')),
        grab(api.get('/user/dashboard')),
        grab(api.get('/trading/positions/history', { params: { limit: 6 } })),
        grab(api.get('/user/dashboard/lifetime-stats', { params: { days: 7 } })),
        grab(api.get('/user/dashboard/lifetime-stats', { params: { days: 30 } })),
        grab(api.get('/user/dashboard/lifetime-stats', { params: { days: 365 } })),
      ]);
      if (dead) return;
      setMainWallet(mw); setRefWallet(rw); setPartner(pt); setDash(db);
      if (cl) setClosed({ items: cl.items || [], summary: cl.summary || null });
      setRangeStats({ week: wk, month: mo, year: yr });
    })();
    return () => { dead = true; };
  }, []);

  // Performance chart series follows the range dropdown.
  useEffect(() => {
    let dead = false;
    api.get('/user/dashboard/monthly-series', { params: { range: perfRange } })
      .then((r) => { if (!dead) setSeries(r.data.data?.buckets || []); })
      .catch(() => { if (!dead) setSeries([]); });
    return () => { dead = true; };
  }, [perfRange]);

  // ── Derived wallet balances (₹) ──────────────────────────────────
  const mainInr = toInr(mainWallet?.balance, mainWallet?.currency);
  const refInr = toInr(refWallet?.balance, refWallet?.currency);
  const tradingInr = (Number(totals.equity) || 0) * rate;
  const totalInr = mainInr + refInr + tradingInr;

  // Deposit / withdrawal totals (₹) from the real records.
  const isSettled = (s) => ['CONFIRMED', 'COMPLETED', 'APPROVED'].includes(String(s).toUpperCase());
  const isPending = (s) => ['PENDING', 'PROCESSING'].includes(String(s).toUpperCase());
  const totalDeposits = deposits.filter((d) => isSettled(d.status)).reduce((s, d) => s + toInr(d.amount, d.currency), 0);
  const totalWithdrawals = withdrawals.filter((w) => isSettled(w.status)).reduce((s, w) => s + toInr(w.amount, w.currency), 0);
  const pendingWithdrawals = withdrawals.filter((w) => isPending(w.status)).reduce((s, w) => s + toInr(w.amount, w.currency), 0);

  // ── Per-account unrealized P&L (₹) ───────────────────────────────
  const unrealByAcc = useMemo(() => {
    const m = new Map();
    for (const p of positions) {
      const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
      const entry = Number(p.entryPrice);
      const qty = Number(p.quantity);
      const pnl = p.side === 'BUY' ? (mark - entry) * qty : (entry - mark) * qty;
      const acc = accounts.find((a) => String(a._id) === String(p.accountId));
      const cur = acc?.baseCurrency || 'INR';
      m.set(String(p.accountId), (m.get(String(p.accountId)) || 0) + toInr(pnl, cur));
    }
    return m;
  }, [positions, priceMap, accounts, rate]);

  const realAccounts = accounts.filter((a) => a.accountType !== 'DEMO' && a.accountType !== 'VIRTUAL');
  const accountRows = realAccounts.map((a) => {
    const bals = balances.filter((b) => String(b.accountId) === String(a._id));
    const cur = a.baseCurrency || bals[0]?.currency || 'INR';
    const balanceInr = bals.reduce((s, b) => s + toInr(b.balance, b.currency), 0);
    const pnl = unrealByAcc.get(String(a._id)) || 0;
    const equity = balanceInr + pnl;
    const pct = balanceInr > 0 ? (pnl / balanceInr) * 100 : 0;
    return { a, cur, balanceInr, equity, pnl, pct };
  });

  // ── Stat figures ──────────────────────────────────────────────────
  const openCount = positions.length;
  const posPnl = (p) => {
    const mark = Number(priceMap[p.symbol] || p.markPrice || p.entryPrice);
    const entry = Number(p.entryPrice);
    return p.side === 'BUY' ? mark - entry : entry - mark;
  };
  const winningOpen = positions.filter((p) => posPnl(p) >= 0).length;
  const losingOpen = openCount - winningOpen;
  const winRate = dash?.pnl?.winRate ?? (closed.summary && (closed.summary.wins + closed.summary.losses) > 0
    ? (closed.summary.wins / (closed.summary.wins + closed.summary.losses)) * 100 : null);
  const totalTrades = closed.summary?.totalTrades ?? dash?.trades?.totalLive ?? 0;
  const wins = closed.summary?.wins ?? 0;
  const losses = closed.summary?.losses ?? 0;

  const rangeNet = (s) => (s ? Number(s.netProfit || 0) : 0); // USD base
  const netWeek = rangeNet(rangeStats.week);
  const netMonth = rangeNet(rangeStats.month);
  const netYear = rangeNet(rangeStats.year);

  // Performance headline = sum over the selected series (USD base).
  const perfNet = series.reduce((s, b) => s + Number(b.netProfit || 0), 0);
  const perfPct = (() => {
    const base = Number(totals.equity) || 0;
    return base > 0 ? (perfNet / base) * 100 : 0;
  })();

  // ── Recent transactions (deposits + withdrawals) ─────────────────
  const recent = useMemo(() => {
    const d = deposits.map((x) => ({ ...x, _kind: 'deposit' }));
    const w = withdrawals.map((x) => ({ ...x, _kind: 'withdraw' }));
    return [...d, ...w].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }, [deposits, withdrawals]);

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary">Account Overview</h1>
          <p className="text-sm text-text-secondary mt-1">Manage your funds, view balance and wallet history</p>
        </div>
        <div className="flex items-center gap-2">
          <HeaderBtn primary onClick={() => setView('grow')} icon={<IcPlus />} label="Deposit" />
          <HeaderBtn onClick={() => setView('withdraw')} icon={<IcDown />} label="Withdraw" />
          <HeaderBtn onClick={() => setView('transfer')} icon={<IcSwap />} label="Transfer" />
        </div>
      </div>

      {/* ── Total Wallet Balance summary bar ───────────────────────── */}
      <div className="bg-white border border-border-dark rounded-2xl p-5">
        <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_auto_1fr_auto_1fr_auto_1fr] items-center gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Total Wallet Balance</div>
            <div className="text-2xl sm:text-3xl font-extrabold font-mono tabular-nums text-text-primary mt-1">{inr(totalInr)}</div>
            <div className="text-[11px] font-mono text-text-muted mt-0.5">{usdStr(totalInr)}</div>
            <div className="text-[11px] text-text-muted mt-1">All wallets total (excludes trading accounts)</div>
          </div>
          <Eq />
          <BreakPart tint="#1D4ED8" icon={<IcWallet />} label="Main Wallet" value={inr(mainInr)} sub={usdStr(mainInr)} />
          <Plus />
          <BreakPart tint="#8B5CF6" icon={<IcGift />} label="Referral Wallet" value={inr(refInr)} sub={usdStr(refInr)} />
          <Plus />
          <BreakPart tint="#16A34A" icon={<IcChart />} label="Trading Accounts (Equity)" value={inr(tradingInr)} sub={usdStr(tradingInr)} />
        </div>
      </div>

      {/* ── Main Wallet + Referral/IB Wallet cards ─────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Main Wallet */}
        <div className="rounded-2xl border border-border-dark overflow-hidden" style={{ background: 'linear-gradient(135deg,#EFF6FF,#FFFFFF 60%)' }}>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: '#1D4ED815', color: '#1D4ED8' }} />
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: '#1D4ED815', color: '#1D4ED8' }}>Deposit &amp; Withdraw</span>
              </div>
              <Link to="/subscription-wallet" className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 inline-flex items-center gap-1">View Main Wallet History <IcArrow /></Link>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <span className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={{ background: '#1D4ED8', color: '#fff' }}><IcWallet big /></span>
              <div>
                <div className="text-sm font-bold text-text-primary">Main Wallet</div>
                <div className="text-2xl font-extrabold font-mono tabular-nums text-text-primary">{inr(mainInr)}</div>
                <div className="text-[11px] text-text-muted">Available Balance</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-4">
              <MiniStat label="Total Deposits" value={inr(totalDeposits)} tone="bull" />
              <MiniStat label="Total Withdrawals" value={inr(totalWithdrawals)} tone="bear" />
            </div>
          </div>
          <div className="flex items-center gap-2 px-5 pb-5">
            <CardBtn primary to="/subscription-wallet" icon={<IcDown up />} label="Deposit" />
            <CardBtn to="/subscription-wallet" icon={<IcDown />} label="Withdraw" />
          </div>
        </div>

        {/* Referral / IB Wallet */}
        <div className="rounded-2xl border border-border-dark overflow-hidden" style={{ background: 'linear-gradient(135deg,#F5F3FF,#FFFFFF 60%)' }}>
          <div className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: '#8B5CF615', color: '#8B5CF6' }}>Withdraw Only</span>
              <Link to="/bonus-wallet" className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 inline-flex items-center gap-1">View Referral Wallet History <IcArrow /></Link>
            </div>
            <div className="flex items-center gap-3 mt-3">
              <span className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={{ background: '#8B5CF6', color: '#fff' }}><IcUsers /></span>
              <div>
                <div className="text-sm font-bold text-text-primary">Referral / IB Wallet</div>
                <div className="text-2xl font-extrabold font-mono tabular-nums text-text-primary">{inr(refInr)}</div>
                <div className="text-[11px] text-text-muted">Referral Earnings</div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-4">
              <MiniStat label="Lifetime Earnings" value={inr(toInr(refWallet?.totalEarnings ?? partner?.totalCommissionEarned, refWallet?.currency))} tone="bull" small />
              <MiniStat label="Total Withdrawals" value={inr(toInr(partner?.paidCommission, partner?.walletCurrency))} tone="bear" small />
              <MiniStat label="This Month" value={inr(toInr(partner?.monthlyCommission, partner?.walletCurrency))} tone="neutral" small />
            </div>
          </div>
          <div className="px-5 pb-5">
            <Link to="/bonus-wallet" className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold keep-white" style={{ background: '#8B5CF6', color: '#fff' }}>
              <IcDown /> Withdraw Now
            </Link>
          </div>
        </div>
      </div>

      {/* ── Overall Trading Summary ────────────────────────────────── */}
      <div className="bg-white border border-border-dark rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-bold text-text-primary">Overall Trading Summary</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <SummaryTile tint="#1D4ED8" icon={<IcChart />} label="Equity (Total)" value={usd(totals.equity)} sub={usdSub(totals.equity)} pct={perfPct} />
          <SummaryTile tint="#F59E0B" icon={<IcClock />} label="Pending Withdrawals" value={inr(pendingWithdrawals)} />
          <SummaryTile tint="#0EA5E9" icon={<IcTrend />} label="Free Margin" value={usd(totals.free)} sub={usdSub(totals.free)} />
          <SummaryTile tint="#8B5CF6" icon={<IcLock />} label="Used Margin" value={usd(totals.locked)} sub={usdSub(totals.locked)} />
          <SummaryTile tint="#16A34A" icon={<IcShield />} label="Margin Level"
            value={totals.marginLevel != null ? `${fmtNum(totals.marginLevel, 2)}%` : '—'}
            note={totals.marginLevel == null ? '' : totals.marginLevel >= 100 ? 'Safe' : 'At risk'}
            noteTone={totals.marginLevel != null && totals.marginLevel < 100 ? 'bear' : 'bull'} />
          <SummaryTile tint={(Number(totals.unrealized) || 0) >= 0 ? '#16A34A' : '#DC2626'} icon={<IcTrend />} label="Today's P&L"
            value={`${(Number(totals.unrealized) || 0) >= 0 ? '+' : ''}${usd(totals.unrealized)}`}
            valueColor={(Number(totals.unrealized) || 0) >= 0 ? '#16A34A' : '#DC2626'} />
        </div>
      </div>

      {/* ── Trading Accounts table + Performance ───────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Your Trading Accounts */}
        <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
            <h3 className="text-sm font-bold text-text-primary">Your Trading Accounts</h3>
            <button onClick={() => setView('details')} className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 inline-flex items-center gap-1">View All Accounts <IcArrow /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
                <tr>
                  <th className="text-left px-4 py-2.5">Account</th>
                  <th className="text-right px-4 py-2.5">Balance</th>
                  <th className="text-right px-4 py-2.5">Equity</th>
                  <th className="text-right px-4 py-2.5">P&L (Today)</th>
                  <th className="text-center px-4 py-2.5">Status</th>
                  <th className="text-center px-4 py-2.5">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {accountRows.length === 0 ? (
                  <tr><td colSpan={6} className="py-8 text-center text-text-muted text-xs">No trading accounts yet</td></tr>
                ) : accountRows.map(({ a, balanceInr, equity, pnl, pct }) => (
                  <tr key={a._id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-[11px] font-bold" style={{ background: '#1D4ED815', color: '#1D4ED8' }}>{(a.accountNumber || 'AC').slice(-2)}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12px] font-bold text-text-primary truncate">{a.accountNumber || a._id.slice(-6)}</span>
                            <span className="text-[8px] font-bold uppercase px-1 py-0.5 rounded" style={{ background: '#16A34A15', color: '#16A34A' }}>Live</span>
                          </div>
                          <div className="text-[10px] text-text-muted truncate">{a.nickname || a.accountType}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-text-primary">{inr(balanceInr)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-text-primary">{inr(equity)}</td>
                    <td className={`px-4 py-3 text-right font-mono tabular-nums font-bold ${pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                      {pnl >= 0 ? '+' : ''}{inr(pnl)}
                      <div className="text-[10px] font-normal">{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</div>
                    </td>
                    <td className="px-4 py-3 text-center"><span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full" style={{ background: '#16A34A15', color: '#15803D' }}><span className="w-1.5 h-1.5 rounded-full bg-bull" /> Active</span></td>
                    <td className="px-4 py-3 text-center"><button onClick={() => setView('details')} className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 px-2 py-1 rounded-lg border border-border-dark">View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Performance Overview */}
        <div className="bg-white border border-border-dark rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-text-primary">Performance Overview</h3>
            <select value={perfRange} onChange={(e) => setPerfRange(e.target.value)} className="text-[11px] font-semibold text-text-primary bg-white border border-border-dark rounded-lg px-2 py-1 outline-none cursor-pointer">
              <option value="1w">This Week</option>
              <option value="1m">This Month</option>
              <option value="1y">This Year</option>
            </select>
          </div>
          <div className="mt-1">
            <div className="text-[11px] text-text-muted">Total Profit/Loss</div>
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-extrabold font-mono tabular-nums ${perfNet >= 0 ? 'text-bull' : 'text-bear'}`}>{perfNet >= 0 ? '+' : ''}{inr(perfNet * rate)}</span>
              <span className={`text-[11px] font-bold ${perfPct >= 0 ? 'text-bull' : 'text-bear'}`}>{perfPct >= 0 ? '+' : ''}{perfPct.toFixed(2)}%</span>
            </div>
          </div>
          <AreaChart buckets={series} />
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border-subtle">
            <PerfStat label="This Week" value={netWeek} rate={rate} inr={inr} />
            <PerfStat label="This Month" value={netMonth} rate={rate} inr={inr} />
            <PerfStat label="This Year" value={netYear} rate={rate} inr={inr} />
          </div>
        </div>
      </div>

      {/* ── KPI stat cards + Recent Transactions ───────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="grid grid-cols-2 gap-3">
          <KpiCard tint="#1D4ED8" icon={<IcLayers />} value={openCount} label="Open Positions" foot={`${winningOpen} Winning · ${losingOpen} Losing`} />
          <KpiCard tint="#16A34A" icon={<IcTarget />} value={winRate == null ? '—' : `${Number(winRate).toFixed(2)}%`} label="Winning Rate" foot={`${wins} Wins · ${losses} Losses`} />
          <KpiCard tint="#8B5CF6" icon={<IcChart />} value={totalTrades} label="Total Trades" foot="All time" />
          <KpiCard tint="#0EA5E9" icon={<IcDown up />} value={inr(totalDeposits)} label="Total Deposits" foot={`Withdrawn ${inr(totalWithdrawals)}`} small />
        </div>

        {/* Recent Transactions panel */}
        <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
            <h3 className="text-sm font-bold text-text-primary">Recent Transactions</h3>
            <button onClick={() => setView('history')} className="text-[11px] font-semibold text-primary-600 hover:text-primary-700">View All</button>
          </div>
          <div className="divide-y divide-border-subtle">
            {recent.length === 0 ? (
              <div className="py-8 text-center text-xs text-text-muted">No transactions yet</div>
            ) : recent.slice(0, 5).map((t) => {
              const dep = t._kind === 'deposit';
              const amt = toInr(t.amount, t.currency);
              return (
                <div key={t._id} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: dep ? '#16A34A15' : '#DC262615', color: dep ? '#16A34A' : '#DC2626' }}>
                    <IcDown up={dep} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12px] font-semibold text-text-primary truncate">{dep ? 'Deposit' : 'Withdrawal Request'}{t.method ? ` via ${t.method}` : ''}</div>
                    <div className="text-[10px] text-text-muted">{fmtDT(t.createdAt)}</div>
                  </div>
                  <div className="text-right">
                    <div className={`text-[12px] font-bold font-mono ${dep ? 'text-bull' : 'text-bear'}`}>{dep ? '+' : '-'}{inr(amt)}</div>
                    <TxStatus status={t.status} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Recent Wallet Transactions table ───────────────────────── */}
      <div className="bg-white border border-border-dark rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <h3 className="text-sm font-bold text-text-primary">Recent Wallet Transactions</h3>
          <button onClick={() => setView('history')} className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 inline-flex items-center gap-1">View All <IcArrow /></button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
              <tr>
                <th className="text-left px-4 py-2.5">Date &amp; Time</th>
                <th className="text-left px-4 py-2.5">Wallet Type</th>
                <th className="text-left px-4 py-2.5">Type</th>
                <th className="text-left px-4 py-2.5">Description</th>
                <th className="text-right px-4 py-2.5">Amount (₹)</th>
                <th className="text-right px-4 py-2.5">Amount (USD)</th>
                <th className="text-center px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {recent.length === 0 ? (
                <tr><td colSpan={7} className="py-8 text-center text-text-muted text-xs">No wallet transactions yet</td></tr>
              ) : recent.slice(0, 8).map((t) => {
                const dep = t._kind === 'deposit';
                const amtInr = toInr(t.amount, t.currency);
                return (
                  <tr key={t._id} className="hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-3 text-[12px] text-text-secondary whitespace-nowrap">{fmtDT(t.createdAt)}</td>
                    <td className="px-4 py-3 text-[12px] text-text-secondary">Main Wallet</td>
                    <td className="px-4 py-3"><span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${dep ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear'}`}>{dep ? 'Deposit' : 'Withdrawal'}</span></td>
                    <td className="px-4 py-3 text-[12px] text-text-secondary truncate max-w-[220px]">{t.note || `${dep ? 'Deposit' : 'Withdrawal'}${t.method ? ` · ${t.method}` : ''}`}</td>
                    <td className={`px-4 py-3 text-right font-mono tabular-nums font-bold ${dep ? 'text-bull' : 'text-bear'}`}>{dep ? '+' : '-'}{inr(amtInr)}</td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-text-muted">{dep ? '+' : '-'}${fmtNum(amtInr / rate, 2)}</td>
                    <td className="px-4 py-3 text-center"><TxStatus status={t.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Small building blocks ────────────────────────────────────────────
const Eq = () => <span className="hidden lg:flex text-text-muted text-xl font-light justify-center">=</span>;
const Plus = () => <span className="hidden lg:flex text-text-muted text-xl font-light justify-center">+</span>;

function BreakPart({ tint, icon, label, value, sub }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${tint}15`, color: tint }}>{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted truncate">{label}</div>
        <div className="text-sm font-bold font-mono tabular-nums text-text-primary truncate">{value}</div>
        <div className="text-[10px] font-mono text-text-muted truncate">{sub}</div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, tone, small }) {
  const c = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text-primary';
  return (
    <div className="rounded-xl bg-white/70 border border-border-subtle px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted truncate">{label}</div>
      <div className={`${small ? 'text-[12px]' : 'text-sm'} font-bold font-mono tabular-nums truncate ${c}`}>{value}</div>
    </div>
  );
}

function SummaryTile({ tint, icon, label, value, sub, pct, note, noteTone, valueColor }) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-hover/40 p-3.5 min-w-0">
      <span className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${tint}15`, color: tint }}>{icon}</span>
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted mt-2 truncate">{label}</div>
      <div className="text-lg font-extrabold font-mono tabular-nums truncate" style={{ color: valueColor || undefined }}>{value}</div>
      {sub && <div className="text-[10px] font-mono text-text-muted truncate">{sub}</div>}
      {pct != null && Math.abs(pct) > 0.005 && <div className={`text-[10px] font-bold ${pct >= 0 ? 'text-bull' : 'text-bear'}`}>{pct >= 0 ? '↑ +' : '↓ '}{pct.toFixed(2)}%</div>}
      {note && <div className={`text-[10px] font-semibold ${noteTone === 'bear' ? 'text-bear' : 'text-bull'}`}>● {note}</div>}
    </div>
  );
}

function KpiCard({ tint, icon, value, label, foot, small }) {
  return (
    <div className="rounded-2xl border border-border-dark bg-white p-4 min-w-0">
      <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${tint}15`, color: tint }}>{icon}</span>
      <div className={`${small ? 'text-lg' : 'text-2xl'} font-extrabold font-mono tabular-nums text-text-primary mt-2 truncate`}>{value}</div>
      <div className="text-[11px] font-semibold text-text-secondary">{label}</div>
      <div className="text-[10px] text-text-muted mt-0.5 truncate">{foot}</div>
    </div>
  );
}

function PerfStat({ label, value, rate, inr }) {
  const pos = value >= 0;
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`text-[13px] font-bold font-mono tabular-nums ${pos ? 'text-bull' : 'text-bear'}`}>{pos ? '+' : ''}{inr(value * rate)}</div>
    </div>
  );
}

function TxStatus({ status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    COMPLETED: ['#16A34A15', '#15803D'], CONFIRMED: ['#16A34A15', '#15803D'], APPROVED: ['#16A34A15', '#15803D'],
    PROCESSING: ['#2563EB15', '#1D4ED8'], PENDING: ['#D9770615', '#B45309'], REJECTED: ['#DC262615', '#B91C1C'], CANCELLED: ['#64748B15', '#475569'],
  };
  const [bg, fg] = map[s] || ['#64748B15', '#475569'];
  const label = s === 'CONFIRMED' ? 'Success' : s.charAt(0) + s.slice(1).toLowerCase();
  return <span className="inline-block text-[9px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: bg, color: fg }}>{label}</span>;
}

// Lightweight SVG area chart over monthly-series buckets (uses cumulative equity).
function AreaChart({ buckets }) {
  const vals = (buckets || []).map((b) => Number(b.equity || 0));
  if (vals.length < 2) return <div className="h-32 flex items-center justify-center text-[11px] text-text-muted">Not enough data yet</div>;
  const W = 600, H = 120, min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  const span = max - min || 1;
  const x = (i) => (i / (vals.length - 1)) * W;
  const y = (v) => H - ((v - min) / span) * H;
  const pos = vals[vals.length - 1] >= vals[0];
  const stroke = pos ? '#16A34A' : '#DC2626';
  const line = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const labels = buckets.filter((_, i) => i % Math.ceil(buckets.length / 5) === 0);
  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32" preserveAspectRatio="none">
        <defs>
          <linearGradient id="perfFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#perfFill)" />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between mt-1">
        {labels.map((b, i) => <span key={i} className="text-[9px] text-text-muted">{b.label}</span>)}
      </div>
    </div>
  );
}

function HeaderBtn({ primary, onClick, icon, label }) {
  if (primary) {
    return (
      <button onClick={onClick} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-bold keep-white shadow-card" style={{ background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)', color: '#fff' }}>
        {icon} {label}
      </button>
    );
  }
  return <button onClick={onClick} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-semibold text-text-primary border border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5 transition-colors">{icon} {label}</button>;
}

function CardBtn({ primary, onClick, to, icon, label }) {
  const cls = primary
    ? 'flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-bold keep-white'
    : 'flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold text-text-primary bg-white border border-border-dark hover:border-primary-500/40 transition-colors';
  const style = primary ? { background: '#1D4ED8', color: '#fff' } : undefined;
  if (to) return <Link to={to} className={cls} style={style}>{icon} {label}</Link>;
  return <button onClick={onClick} className={cls} style={style}>{icon} {label}</button>;
}

const fmtDT = (d) => {
  if (!d) return '-';
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
};

// ─── Inline glyphs ────────────────────────────────────────────────────
const G = (props) => <svg width={props.big ? 22 : 15} height={props.big ? 22 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{props.children}</svg>;
const IcPlus = () => <G><path d="M12 5v14M5 12h14" /></G>;
const IcDown = ({ up }) => <G>{up ? <><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></> : <><path d="M12 21V9" /><path d="M7 14l5 5 5-5" /><path d="M4 3h16" /></>}</G>;
const IcSwap = () => <G><path d="M7 7h11l-3-3" /><path d="M17 17H6l3 3" /></G>;
const IcWallet = (p) => <G {...p}><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /><circle cx="17" cy="15" r="1.3" /></G>;
const IcGift = () => <G><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18" /><path d="M12 8S9 3 7 4.5 8 8 12 8z" /><path d="M12 8s3-5 5-3.5S16 8 12 8z" /></G>;
const IcChart = () => <G><path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-7" /></G>;
const IcUsers = () => <G><circle cx="9" cy="8" r="3.5" /><path d="M3 21v-1.5A4.5 4.5 0 0 1 7.5 15h3A4.5 4.5 0 0 1 15 19.5V21" /><path d="M16 4a3.5 3.5 0 0 1 0 7" /><path d="M18 15a4.5 4.5 0 0 1 3 4.5V21" /></G>;
const IcArrow = () => <G><path d="M5 12h14M13 6l6 6-6 6" /></G>;
const IcClock = () => <G><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></G>;
const IcTrend = () => <G><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></G>;
const IcLock = () => <G><rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></G>;
const IcShield = () => <G><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></G>;
const IcLayers = () => <G><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></G>;
const IcTarget = () => <G><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" /></G>;
