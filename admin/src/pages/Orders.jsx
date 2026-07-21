import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum, fmtMoney, fmtDate } from '../utils/format';
import { useAuthStore } from '../store/auth';
import { useConfirm } from '../components/ConfirmProvider';
import PageHero from '../components/PageHero';

/**
 * Orders Management — institutional dealing-desk console.
 *   Open Orders   = open positions (live floating PnL)
 *   Pending Orders= unfilled LIMIT/STOP orders
 *   Closed Orders = closed positions (realized PnL)
 * Plus a Risk Management view (live net exposure, hedge ratio, top accounts).
 *
 * Super/Admin act platform-wide; Managers see only their own users and may
 * only modify SL/TP (backend enforces). Auto-refreshes for a live feel.
 */

const sgn = (n) => (Number(n) > 0 ? 'text-bull' : Number(n) < 0 ? 'text-bear' : 'text-text-secondary');
const signed = (n) => `${Number(n) < 0 ? '-' : ''}$${fmtNum(Math.abs(Number(n) || 0), 2)}`;
const sideChip = (s) => (s === 'BUY'
  ? 'bg-bull/15 text-bull border-bull/30'
  : 'bg-bear/15 text-bear border-bear/30');
const bookChip = (b) => (b === 'A_BOOK'
  ? 'bg-sky-500/15 text-sky-400 border-sky-500/30'
  : 'bg-amber-500/15 text-amber-400 border-amber-500/30');

const EMPTY_FILTERS = {
  user: '', orderId: '', accountNumber: '', accountType: '', accountMode: '', symbol: '', side: '', orderType: '', book: '',
  closeReason: '', pnl: '', from: '', to: '', minVolume: '', maxVolume: '',
};

// Status = how a closed trade ended (its close reason). Values match the
// backend whitelist in adminOrdersController.closedOrders.
const CLOSE_REASON_OPTIONS = [
  { value: '',                 label: 'All' },
  { value: 'MANUAL',           label: 'Manual close' },
  { value: 'TAKE_PROFIT',      label: 'Take Profit' },
  { value: 'STOP_LOSS',        label: 'Stop Loss' },
  { value: 'TRAILING_STOP',    label: 'Trailing Stop' },
  { value: 'MARGIN_STOPOUT',   label: 'Margin Stop-out' },
  { value: 'NEGATIVE_BALANCE', label: 'Neg-balance' },
];

// Short ticket from a Mongo _id (last 6 hex, upper) — full id on hover.
const ticket = (id) => (id ? `#${String(id).slice(-6).toUpperCase()}` : '—');

// Fallback account-type list (used until the live /account-types list loads).
// Only the real, current tiers — demo/legacy are covered by the All Real /
// All Demo group options instead of individual rows.
const ACCOUNT_TYPES = ['STANDARD', 'STANDARD_IC', 'PRO', 'PRO_IC', 'FREE', 'FREE_IC'];

export default function Orders() {
  const { user } = useAuthStore();
  const role = user?.role;
  const canManage = role === 'SUPER_ADMIN' || role === 'ADMIN';
  const confirm = useConfirm();

  const [tab, setTab] = useState('open'); // open | pending | closed | risk
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  // Column sort (low/high toggle). dir 1 = ascending (low→high), -1 = descending.
  const [sort, setSort] = useState({ key: '', dir: 1 });
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [risk, setRisk] = useState(null);
  // Account types actually present in the DB → drives the filter dropdown so it
  // only ever lists types that exist (no dead/legacy options).
  const [acctTypeOptions, setAcctTypeOptions] = useState(ACCOUNT_TYPES);
  useEffect(() => {
    api.get('/order-management/account-types')
      .then(({ data }) => { if (Array.isArray(data.data) && data.data.length) setAcctTypeOptions(data.data); })
      .catch(() => {});
  }, []);

  const [draft, setDraft] = useState(EMPTY_FILTERS); // filter inputs
  const [filters, setFilters] = useState(EMPTY_FILTERS); // applied filters
  const [selected, setSelected] = useState(() => new Set());
  const [live, setLive] = useState(true);

  const [drawer, setDrawer] = useState(null);     // { kind, id }
  const [sltpModal, setSltpModal] = useState(null); // position row
  const [commentModal, setCommentModal] = useState(null);
  const [pendingModal, setPendingModal] = useState(null); // order row

  const busyRef = useRef(false);

  const queryParams = useCallback((extra = {}) => {
    const p = { page, limit: 25, ...filters, ...extra };
    Object.keys(p).forEach((k) => { if (p[k] === '' || p[k] == null) delete p[k]; });
    return p;
  }, [page, filters]);

  const loadSummary = useCallback(async () => {
    try { const { data } = await api.get('/order-management/summary'); setSummary(data.data); }
    catch (e) { /* surfaced by list */ }
  }, []);

  const loadList = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get(`/order-management/${tab}`, { params: queryParams() });
      setRows(data.data.items || []);
      setPagination(data.data.pagination || { page: 1, pages: 1, total: 0 });
    } catch (e) { if (!silent) toast.error(errorMessage(e)); }
    finally { if (!silent) setLoading(false); }
  }, [tab, queryParams]);

  const loadRisk = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { const { data } = await api.get('/order-management/risk'); setRisk(data.data); }
    catch (e) { if (!silent) toast.error(errorMessage(e)); }
    finally { if (!silent) setLoading(false); }
  }, []);

  // Initial + on tab/filter/page change.
  useEffect(() => {
    setSelected(new Set());
    loadSummary();
    if (tab === 'risk') loadRisk(); else loadList();
  }, [tab, filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live polling — every 8s, refresh quietly when no modal/drawer is open.
  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      if (busyRef.current || sltpModal || commentModal || pendingModal) return;
      loadSummary();
      if (tab === 'risk') loadRisk(true); else loadList(true);
    }, 8000);
    return () => clearInterval(id);
  }, [live, tab, sltpModal, commentModal, pendingModal, loadList, loadRisk, loadSummary]);

  const applyFilters = () => { setPage(1); setFilters(draft); };
  const resetFilters = () => { setDraft(EMPTY_FILTERS); setFilters(EMPTY_FILTERS); setPage(1); };

  const refreshAll = () => { loadSummary(); tab === 'risk' ? loadRisk() : loadList(); };

  /* ── column sort (low/high toggle) — sorts the loaded page ── */
  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
  const sortedRows = useMemo(() => {
    if (!sort.key) return rows;
    const col = (COLUMNS[tab] || []).find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = col.sortVal || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * sort.dir;
    });
  }, [rows, sort, tab]);

  /* ── selection ── */
  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r._id));
  const toggleAll = () => setSelected((s) => {
    const n = new Set(s);
    if (allOnPage) rows.forEach((r) => n.delete(r._id)); else rows.forEach((r) => n.add(r._id));
    return n;
  });

  /* ── single actions ── */
  const doForceClose = async (row) => {
    if (!(await confirm({ title: 'Force close position', message: `Close ${row.side} ${fmtNum(row.volume, 4)} ${row.symbol} for ${row.userName} at market?`, danger: true, confirmText: 'Force Close' }))) return;
    busyRef.current = true;
    try { await api.post(`/order-management/positions/${row._id}/close`); toast.success('Position closed'); refreshAll(); }
    catch (e) { toast.error(errorMessage(e)); } finally { busyRef.current = false; }
  };
  const doMoveBook = async (row, book) => {
    if (!(await confirm({ title: `Move to ${book === 'A_BOOK' ? 'A-Book' : 'B-Book'}`, message: `Reclassify ${row.symbol} (${row.userName}) risk to ${book}?` }))) return;
    busyRef.current = true;
    try { await api.post(`/order-management/positions/${row._id}/book`, { book }); toast.success(`Moved to ${book}`); refreshAll(); }
    catch (e) { toast.error(errorMessage(e)); } finally { busyRef.current = false; }
  };
  const doCancel = async (row) => {
    if (!(await confirm({ title: 'Cancel pending order', message: `Cancel ${row.orderType} ${row.side} ${row.symbol} for ${row.userName}?`, danger: true, confirmText: 'Cancel Order' }))) return;
    busyRef.current = true;
    try { await api.post(`/order-management/orders/${row._id}/cancel`); toast.success('Order cancelled'); refreshAll(); }
    catch (e) { toast.error(errorMessage(e)); } finally { busyRef.current = false; }
  };
  const doForceExecute = async (row) => {
    if (!(await confirm({ title: 'Force execute', message: `Execute ${row.orderType} ${row.side} ${row.symbol} for ${row.userName} immediately at market?`, danger: true, confirmText: 'Force Execute' }))) return;
    busyRef.current = true;
    try { await api.post(`/order-management/orders/${row._id}/execute`); toast.success('Order executed'); refreshAll(); }
    catch (e) { toast.error(errorMessage(e)); } finally { busyRef.current = false; }
  };

  /* ── bulk ── */
  const ids = useMemo(() => [...selected], [selected]);
  const bulk = async (action, body = {}) => {
    if (!ids.length) return;
    busyRef.current = true;
    try {
      const { data } = await api.post('/order-management/bulk', { action, ids, ...body });
      const r = data.data;
      toast.success(`${action}: ${r.succeeded}/${r.total} done${r.failed ? `, ${r.failed} failed` : ''}`);
      setSelected(new Set()); refreshAll();
    } catch (e) { toast.error(errorMessage(e)); } finally { busyRef.current = false; }
  };
  const bulkClose = async () => { if (await confirm({ title: 'Bulk force close', message: `Force-close ${ids.length} position(s) at market?`, danger: true, confirmText: 'Close All' })) bulk('close'); };
  const bulkCancel = async () => { if (await confirm({ title: 'Bulk cancel', message: `Cancel ${ids.length} pending order(s)?`, danger: true, confirmText: 'Cancel All' })) bulk('cancel'); };
  const bulkMove = async (book) => { if (await confirm({ title: `Bulk → ${book}`, message: `Move ${ids.length} position(s) to ${book}?` })) bulk('moveBook', { book }); };

  /* ── CSV export of current view ── */
  const exportCsv = () => {
    if (!rows.length) return;
    const cols = COLUMNS[tab].filter((c) => c.key !== '_sel' && c.key !== '_act');
    const head = cols.map((c) => c.label);
    const lines = [head.join(',')];
    for (const r of rows) lines.push(cols.map((c) => csv(c.csv ? c.csv(r) : r[c.key])).join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `orders_${tab}_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} rows`);
  };

  return (
    <div className="space-y-4 max-w-[1700px]">
      <PageHero
        eyebrow="Risk · Dealing Desk"
        title="Orders Management"
        subtitle={canManage
          ? 'Monitor, control and audit all trading across the platform — open positions, pending orders, closed history and live risk exposure.'
          : 'Monitor your users’ trading activity. You can adjust SL/TP; force-close and book transfers are restricted.'}
        actions={(
          <div className="flex items-center gap-2">
            <button onClick={() => setLive((v) => !v)}
              className={`text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${live ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400' : 'border-border-dark text-text-secondary hover:text-white'}`}>
              <span className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${live ? 'bg-emerald-400 animate-pulse' : 'bg-text-muted'}`} />
              {live ? 'Live' : 'Paused'}
            </button>
            <button onClick={refreshAll} className="btn-ghost text-xs">↻ Refresh</button>
          </div>
        )}
      />

      <SummaryCards s={summary} />

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border-dark">
        {[['open', 'Open Orders'], ['pending', 'Pending Orders'], ['closed', 'Closed History'], ['risk', 'Risk Management']].map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); setPage(1); setSort({ key: '', dir: 1 }); }}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${tab === k ? 'border-primary-500 text-white' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>
            {label}
            {k === 'open' && summary ? <span className="ml-1.5 text-xs text-text-muted">{summary.totalOpenOrders}</span> : null}
            {k === 'pending' && summary ? <span className="ml-1.5 text-xs text-text-muted">{summary.totalPendingOrders}</span> : null}
          </button>
        ))}
      </div>

      {tab !== 'risk' && (
        <FilterBar tab={tab} draft={draft} setDraft={setDraft} onApply={applyFilters} onReset={resetFilters} onExport={exportCsv} acctTypeOptions={acctTypeOptions} />
      )}

      {/* Bulk toolbar */}
      {canManage && tab !== 'risk' && selected.size > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-2 border border-primary-500/30">
          <span className="text-sm font-semibold text-white mr-2">{selected.size} selected</span>
          {tab === 'open' && <>
            <button onClick={bulkClose} className="btn-bear text-xs px-3 py-1.5">Close</button>
            <button onClick={() => bulkMove('A_BOOK')} className="btn-ghost text-xs">→ A-Book</button>
            <button onClick={() => bulkMove('B_BOOK')} className="btn-ghost text-xs">→ B-Book</button>
          </>}
          {tab === 'pending' && <button onClick={bulkCancel} className="btn-bear text-xs px-3 py-1.5">Cancel</button>}
          <button onClick={exportCsv} className="btn-ghost text-xs">⭳ Export</button>
          <button onClick={() => setSelected(new Set())} className="btn-ghost text-xs ml-auto">Clear</button>
        </div>
      )}

      {/* Body */}
      {tab === 'risk' ? (
        <RiskView risk={risk} loading={loading} />
      ) : (
        <>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="text-[11px] text-text-muted uppercase tracking-wide border-b border-border-dark">
                <tr>
                  {COLUMNS[tab].map((c) => {
                    if (c.key === '_sel') return canManage ? (
                      <th key="_sel" className="p-2.5 w-8 text-left"><input type="checkbox" checked={allOnPage} onChange={toggleAll} /></th>
                    ) : null;
                    if (c.key === '_act') return <th key="_act" className="p-2.5 text-right">Actions</th>;
                    return (
                      <th key={c.key}
                        onClick={c.sortable ? () => toggleSort(c.key) : undefined}
                        className={`p-2.5 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.sortable ? 'cursor-pointer select-none hover:text-text-secondary' : ''}`}>
                        {c.label}
                        {c.sortable && <span className="ml-0.5 text-[10px]">{sort.key === c.key ? (sort.dir === 1 ? '↑' : '↓') : '⇅'}</span>}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {loading ? <SkeletonRows cols={COLUMNS[tab].length} /> : rows.length === 0 ? (
                  <tr><td colSpan={COLUMNS[tab].length} className="p-10 text-center text-text-muted">No {tab} orders match the filters.</td></tr>
                ) : sortedRows.map((r) => (
                  <Row key={r._id} tab={tab} r={r} canManage={canManage} selected={selected.has(r._id)} onSel={() => toggleSel(r._id)}
                    onView={() => setDrawer({ kind: r.kind, id: r._id })}
                    onSltp={() => setSltpModal(r)} onComment={() => setCommentModal(r)} onClose={() => doForceClose(r)}
                    onMove={(b) => doMoveBook(r, b)} onCancel={() => doCancel(r)} onExecute={() => doForceExecute(r)}
                    onModifyPending={() => setPendingModal(r)} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-text-muted">
            <span>Showing {rows.length} of {pagination.total}</span>
            <div className="flex items-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-ghost text-xs disabled:opacity-30">Prev</button>
              <span>Page {pagination.page} / {pagination.pages || 1}</span>
              <button disabled={page >= (pagination.pages || 1)} onClick={() => setPage(page + 1)} className="btn-ghost text-xs disabled:opacity-30">Next</button>
            </div>
          </div>
        </>
      )}

      {drawer && <DetailDrawer target={drawer} onClose={() => setDrawer(null)} />}
      {sltpModal && <SltpModal row={sltpModal} onClose={() => setSltpModal(null)} onSaved={() => { setSltpModal(null); refreshAll(); }} />}
      {commentModal && <CommentModal row={commentModal} onClose={() => setCommentModal(null)} onSaved={() => { setCommentModal(null); }} />}
      {pendingModal && <PendingModal row={pendingModal} onClose={() => setPendingModal(null)} onSaved={() => { setPendingModal(null); refreshAll(); }} />}
    </div>
  );
}

/* ───────────────────────── summary cards ───────────────────────── */
function SummaryCards({ s }) {
  const cards = [
    { label: 'Open Orders', val: s ? fmtNum(s.totalOpenOrders, 0) : '—' },
    { label: 'Pending Orders', val: s ? fmtNum(s.totalPendingOrders, 0) : '—' },
    { label: 'Closed Today', val: s ? fmtNum(s.totalClosedToday, 0) : '—' },
    { label: 'Open Volume (Lots)', val: s ? fmtNum(s.totalOpenVolume, 2) : '—' },
    { label: 'Floating PnL', val: s ? signed(s.totalFloatingPnl) : '—', cls: s ? sgn(s.totalFloatingPnl) : '' },
    { label: 'Margin Used', val: s ? fmtMoney(s.totalMarginUsed) : '—' },
    { label: 'Net Exposure', val: s ? signed(s.netExposure) : '—', cls: s ? sgn(s.netExposure) : '' },
    { label: 'A-Book Exposure', val: s ? fmtMoney(s.aBookExposure) : '—', cls: 'text-sky-400' },
    { label: 'B-Book Exposure', val: s ? fmtMoney(s.bBookExposure) : '—', cls: 'text-amber-400' },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="card p-3.5">
          <div className="text-[10px] text-text-muted uppercase tracking-wide">{c.label}</div>
          <div className={`text-xl font-bold mt-1 ${c.cls || 'text-white'}`}>{c.val}</div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── filter bar ───────────────────────── */
function FilterBar({ tab, draft, setDraft, onApply, onReset, onExport, acctTypeOptions = ACCOUNT_TYPES }) {
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  return (
    <form onSubmit={(e) => { e.preventDefault(); onApply(); }}
      className="card p-3 sticky top-0 z-20 flex flex-wrap gap-2.5 items-end">
      <Field label="User (id/email/name)"><input className="input w-44" value={draft.user} onChange={set('user')} placeholder="search user" /></Field>
      <Field label="Order ID"><input className="input w-28" value={draft.orderId} onChange={set('orderId')} placeholder="#ABC123" /></Field>
      <Field label="Account #"><input className="input w-32" value={draft.accountNumber} onChange={set('accountNumber')} /></Field>
      <Field label="Mode">
        <select className="input w-24" value={draft.accountMode} onChange={set('accountMode')}>
          <option value="">All</option>
          <option value="real">Real</option>
          <option value="demo">Demo</option>
        </select>
      </Field>
      <Field label="Acct Type">
        <select className="input w-28" value={draft.accountType} onChange={set('accountType')}>
          <option value="">All</option>
          {acctTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Instrument"><input className="input w-28" value={draft.symbol} onChange={set('symbol')} placeholder="EURUSD" /></Field>
      <Field label="Side"><select className="input w-24" value={draft.side} onChange={set('side')}><option value="">All</option><option value="BUY">Buy</option><option value="SELL">Sell</option></select></Field>
      {tab === 'pending' && (
        <Field label="Type"><select className="input w-28" value={draft.orderType} onChange={set('orderType')}><option value="">All</option><option value="LIMIT">Limit</option><option value="STOP">Stop</option><option value="MARKET">Market</option></select></Field>
      )}
      {tab !== 'pending' && (
        <Field label="Book"><select className="input w-28" value={draft.book} onChange={set('book')}><option value="">All</option><option value="A_BOOK">A-Book</option><option value="B_BOOK">B-Book</option></select></Field>
      )}
      {tab === 'closed' && (
        <Field label="Status">
          <select className="input w-36" value={draft.closeReason} onChange={set('closeReason')}>
            {CLOSE_REASON_OPTIONS.map((o) => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      )}
      {tab === 'closed' && (
        <Field label="P/L"><select className="input w-28" value={draft.pnl} onChange={set('pnl')}><option value="">All</option><option value="profit">Profit</option><option value="loss">Loss</option></select></Field>
      )}
      <Field label="From"><input type="date" className="input w-36" value={draft.from} onChange={set('from')} /></Field>
      <Field label="To"><input type="date" className="input w-36" value={draft.to} onChange={set('to')} /></Field>
      <button type="submit" className="btn-primary text-sm">Apply</button>
      <button type="button" onClick={onReset} className="btn-ghost text-xs">Reset</button>
      <button type="button" onClick={onExport} className="btn-ghost text-xs ml-auto">⭳ CSV</button>
    </form>
  );
}
const Field = ({ label, children }) => (
  <div className="flex flex-col gap-1"><span className="label">{label}</span>{children}</div>
);

/* ───────────────────────── table columns + row ───────────────────────── */
const byTime = (k) => (r) => (r[k] ? new Date(r[k]).getTime() : 0);
const COLUMNS = {
  open: [
    { key: '_sel' },
    { key: 'orderId', label: 'Order ID', csv: (r) => ticket(r._id) },
    { key: 'symbol', label: 'Symbol' }, { key: 'side', label: 'Type' },
    { key: 'volume', label: 'Volume', align: 'right', sortable: true, csv: (r) => r.volume },
    { key: 'openPrice', label: 'Open', align: 'right', sortable: true },
    { key: 'currentPrice', label: 'Current', align: 'right', sortable: true },
    { key: 'floatingPnl', label: 'Floating PnL', align: 'right', sortable: true },
    { key: 'commission', label: 'Commission', align: 'right', sortable: true },
    { key: 'charges', label: 'Charges', align: 'right', sortable: true },
    { key: 'stopLoss', label: 'SL', align: 'right' }, { key: 'takeProfit', label: 'TP', align: 'right' },
    { key: 'margin', label: 'Margin', align: 'right', sortable: true }, { key: 'book', label: 'Exec' },
    { key: 'userUid', label: 'User ID' }, { key: 'userName', label: 'User' },
    { key: 'accountNumber', label: 'Account' }, { key: 'accountType', label: 'Acct Type' },
    { key: 'openTime', label: 'Open Time', sortable: true, sortVal: byTime('openTime'), csv: (r) => fmtDate(r.openTime) }, { key: '_act' },
  ],
  pending: [
    { key: '_sel' },
    { key: 'orderId', label: 'Order ID', csv: (r) => ticket(r._id) },
    { key: 'symbol', label: 'Symbol' }, { key: 'side', label: 'Side' }, { key: 'orderType', label: 'Type' },
    { key: 'entryPrice', label: 'Entry', align: 'right', sortable: true }, { key: 'volume', label: 'Volume', align: 'right', sortable: true },
    { key: 'commission', label: 'Commission (est)', align: 'right', sortable: true },
    { key: 'charges', label: 'Charges (est)', align: 'right', sortable: true },
    { key: 'stopLoss', label: 'SL', align: 'right' }, { key: 'takeProfit', label: 'TP', align: 'right' },
    { key: 'userUid', label: 'User ID' }, { key: 'userName', label: 'User' },
    { key: 'accountNumber', label: 'Account' }, { key: 'accountType', label: 'Acct Type' },
    { key: 'createdTime', label: 'Created', sortable: true, sortVal: byTime('createdTime'), csv: (r) => fmtDate(r.createdTime) }, { key: '_act' },
  ],
  closed: [
    { key: '_sel' },
    { key: 'orderId', label: 'Order ID', csv: (r) => ticket(r._id) },
    { key: 'symbol', label: 'Symbol' }, { key: 'side', label: 'Type' },
    { key: 'volume', label: 'Volume', align: 'right', sortable: true },
    { key: 'openPrice', label: 'Open', align: 'right', sortable: true }, { key: 'closePrice', label: 'Close', align: 'right', sortable: true },
    { key: 'realizedPnl', label: 'Realized PnL', align: 'right', sortable: true },
    { key: 'commission', label: 'Commission', align: 'right', sortable: true },
    { key: 'charges', label: 'Charges', align: 'right', sortable: true },
    { key: 'book', label: 'Exec' }, { key: 'userUid', label: 'User ID' }, { key: 'userName', label: 'User' },
    { key: 'accountNumber', label: 'Account' }, { key: 'accountType', label: 'Acct Type' },
    { key: 'openTime', label: 'Open', sortable: true, sortVal: byTime('openTime'), csv: (r) => fmtDate(r.openTime) },
    { key: 'closeTime', label: 'Close', sortable: true, sortVal: byTime('closeTime'), csv: (r) => fmtDate(r.closeTime) },
    { key: '_act' },
  ],
};

function Row({ tab, r, canManage, selected, onSel, onView, onSltp, onComment, onClose, onMove, onCancel, onExecute, onModifyPending }) {
  const price = (v) => (v == null ? '—' : fmtNum(v, 5));
  const charge = (v) => (Number(v) ? <span className="text-text-secondary">{signed(-Math.abs(Number(v)))}</span> : '—');
  // A trade's single fee belongs to ONE group (by type): commission-type →
  // Commission column; charge-type → Charges column. Swap is always a charge.
  const _isCharge = r.feeCategory === 'CHARGES';
  const _fee = Number(r.commission) || 0;
  const commCell = _isCharge ? 0 : _fee;
  const chargeCell = (_isCharge ? _fee : 0) + (Number(r.swap) || 0);
  return (
    <tr className="table-row align-middle">
      {canManage && <td className="p-2.5"><input type="checkbox" checked={selected} onChange={onSel} /></td>}
      <td className="p-2.5 font-mono text-[11px] text-text-muted" title={r._id}>{ticket(r._id)}</td>
      <td className="p-2.5 font-semibold text-white">{r.symbol}</td>
      {tab === 'open' && <>
        <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[11px] font-bold border ${sideChip(r.side)}`}>{r.side}</span></td>
        <td className="p-2.5 text-right">{fmtNum(r.volume, 4)}</td>
        <td className="p-2.5 text-right text-text-secondary">{price(r.openPrice)}</td>
        <td className="p-2.5 text-right">{price(r.currentPrice)}</td>
        <td className={`p-2.5 text-right font-semibold ${sgn(r.floatingPnl)}`}>{signed(r.floatingPnl)}</td>
        <td className="p-2.5 text-right text-text-muted">{charge(commCell)}</td>
        <td className="p-2.5 text-right text-text-muted">{charge(chargeCell)}</td>
        <td className="p-2.5 text-right text-text-secondary">{price(r.stopLoss)}</td>
        <td className="p-2.5 text-right text-text-secondary">{price(r.takeProfit)}</td>
        <td className="p-2.5 text-right text-text-muted">{fmtMoney(r.margin)}</td>
        <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${bookChip(r.book)}`}>{r.book === 'A_BOOK' ? 'A' : 'B'}</span></td>
      </>}
      {tab === 'pending' && <>
        <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[11px] font-bold border ${sideChip(r.side)}`}>{r.side}</span></td>
        <td className="p-2.5 text-text-secondary">{r.orderType}</td>
        <td className="p-2.5 text-right">{price(r.entryPrice)}</td>
        <td className="p-2.5 text-right">{fmtNum(r.volume, 4)}</td>
        <td className="p-2.5 text-right text-text-muted" title="Estimated — charged when the order fills & the position closes">{charge(commCell)}</td>
        <td className="p-2.5 text-right text-text-muted" title="Estimated — charged when the order fills & the position closes">{charge(chargeCell)}</td>
        <td className="p-2.5 text-right text-text-secondary">{price(r.stopLoss)}</td>
        <td className="p-2.5 text-right text-text-secondary">{price(r.takeProfit)}</td>
      </>}
      {tab === 'closed' && <>
        <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[11px] font-bold border ${sideChip(r.side)}`}>{r.side}</span></td>
        <td className="p-2.5 text-right">{fmtNum(r.volume, 4)}</td>
        <td className="p-2.5 text-right text-text-secondary">{price(r.openPrice)}</td>
        <td className="p-2.5 text-right">{price(r.closePrice)}</td>
        <td className={`p-2.5 text-right font-semibold ${sgn(r.realizedPnl)}`}>{signed(r.realizedPnl)}</td>
        <td className="p-2.5 text-right text-text-muted">{charge(commCell)}</td>
        <td className="p-2.5 text-right text-text-muted">{charge(chargeCell)}</td>
        <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${bookChip(r.book)}`}>{r.book === 'A_BOOK' ? 'A' : 'B'}</span></td>
      </>}
      <td className="p-2.5 font-mono text-[11px] text-text-secondary">{r.userUid || '—'}</td>
      <td className="p-2.5 text-text-secondary">{r.userName}</td>
      <td className="p-2.5 text-text-muted">{r.accountNumber}</td>
      <td className="p-2.5 text-text-muted text-xs">{r.accountType || '—'}</td>
      {tab === 'open' && <><td className="p-2.5 text-text-muted text-xs">{fmtDate(r.openTime)}</td></>}
      {tab === 'pending' && <td className="p-2.5 text-text-muted text-xs">{fmtDate(r.createdTime)}</td>}
      {tab === 'closed' && <><td className="p-2.5 text-text-muted text-xs">{fmtDate(r.openTime)}</td><td className="p-2.5 text-text-muted text-xs">{fmtDate(r.closeTime)}</td></>}
      <td className="p-2.5 text-right">
        <div className="inline-flex items-center gap-1">
          <button onClick={onView} className="btn-ghost text-[11px] px-2 py-1" title="View details">View</button>
          {tab === 'open' && <>
            <button onClick={onSltp} className="btn-ghost text-[11px] px-2 py-1" title="Modify SL/TP">SL/TP</button>
            {canManage && <>
              <button onClick={onClose} className="text-[11px] px-2 py-1 rounded text-bear hover:bg-bear/10" title="Force close">Close</button>
              <BookMenu onMove={onMove} current={r.book} />
              <button onClick={onComment} className="btn-ghost text-[11px] px-2 py-1" title="Internal comment">💬</button>
            </>}
          </>}
          {tab === 'pending' && canManage && <>
            <button onClick={onModifyPending} className="btn-ghost text-[11px] px-2 py-1" title="Modify order">Edit</button>
            <button onClick={onExecute} className="text-[11px] px-2 py-1 rounded text-emerald-400 hover:bg-emerald-500/10" title="Force execute">Execute</button>
            <button onClick={onCancel} className="text-[11px] px-2 py-1 rounded text-bear hover:bg-bear/10" title="Cancel">Cancel</button>
          </>}
        </div>
      </td>
    </tr>
  );
}

function BookMenu({ onMove, current }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button onClick={() => setOpen((v) => !v)} className="btn-ghost text-[11px] px-2 py-1" title="Transfer book">A/B</button>
      {open && (
        <span className="absolute right-0 top-full mt-1 z-30 flex flex-col bg-bg-card border border-border-dark rounded-lg shadow-xl text-left" onMouseLeave={() => setOpen(false)}>
          <button disabled={current === 'A_BOOK'} onClick={() => { setOpen(false); onMove('A_BOOK'); }} className="px-3 py-1.5 text-[11px] text-sky-400 hover:bg-bg-hover disabled:opacity-30 whitespace-nowrap">→ A-Book</button>
          <button disabled={current === 'B_BOOK'} onClick={() => { setOpen(false); onMove('B_BOOK'); }} className="px-3 py-1.5 text-[11px] text-amber-400 hover:bg-bg-hover disabled:opacity-30 whitespace-nowrap">→ B-Book</button>
        </span>
      )}
    </span>
  );
}

/* ───────────────────────── risk view ───────────────────────── */
function RiskView({ risk, loading }) {
  const [q, setQ] = useState('');
  if (loading && !risk) return <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-xl bg-bg-hover animate-pulse" />)}</div>;
  if (!risk) return <div className="card p-8 text-center text-text-muted text-sm">No exposure data.</div>;
  const query = q.trim().toLowerCase();
  const exposures = query ? risk.exposures.filter((e) => String(e.symbol).toLowerCase().includes(query)) : risk.exposures;
  const maxNet = Math.max(1, ...exposures.map((e) => Math.abs(e.netExposure)));
  return (
    <div className="space-y-4">
      <div className="card overflow-x-auto">
        <div className="p-3 flex items-center justify-between gap-3 border-b border-border-dark">
          <span className="text-sm font-semibold text-white">Live Net Exposure per Instrument</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search symbol…"
            className="input w-48 text-xs py-1"
          />
        </div>
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="text-[11px] text-text-muted uppercase border-b border-border-dark">
            <tr>
              <th className="p-2.5 text-left">Symbol</th><th className="p-2.5 text-right">Long</th><th className="p-2.5 text-right">Short</th>
              <th className="p-2.5 text-right">Net</th><th className="p-2.5 text-left w-48">Exposure</th>
              <th className="p-2.5 text-right">Hedged</th><th className="p-2.5 text-right">Unhedged</th>
              <th className="p-2.5 text-right">Hedge %</th><th className="p-2.5 text-right">A/B</th><th className="p-2.5 text-left">Dir</th>
            </tr>
          </thead>
          <tbody>
            {exposures.length === 0 ? (
              <tr><td colSpan={10} className="p-8 text-center text-text-muted">{query ? 'No instruments match your search.' : 'No open B-book/A-book exposure.'}</td></tr>
            ) : exposures.map((e) => (
              <tr key={e.symbol} className="table-row">
                <td className="p-2.5 font-semibold text-white">{e.symbol}</td>
                <td className="p-2.5 text-right text-bull">{fmtMoney(e.longExposure)}</td>
                <td className="p-2.5 text-right text-bear">{fmtMoney(e.shortExposure)}</td>
                <td className={`p-2.5 text-right font-semibold ${sgn(e.netExposure)}`}>{signed(e.netExposure)}</td>
                <td className="p-2.5">
                  <div className="h-2.5 w-44 bg-bg-hover rounded-full overflow-hidden">
                    <div className={`h-full ${e.netExposure >= 0 ? 'bg-bull' : 'bg-bear'}`} style={{ width: `${Math.min(100, (Math.abs(e.netExposure) / maxNet) * 100)}%` }} />
                  </div>
                </td>
                <td className="p-2.5 text-right text-text-secondary">{fmtMoney(e.hedgedVolume)}</td>
                <td className="p-2.5 text-right text-warn">{fmtMoney(e.unhedgedVolume)}</td>
                <td className="p-2.5 text-right text-text-secondary">{fmtNum(e.hedgeRatio, 1)}%</td>
                <td className="p-2.5 text-right text-text-muted text-xs"><span className="text-sky-400">{fmtNum(e.aBookNotional, 0)}</span> / <span className="text-amber-400">{fmtNum(e.bBookNotional, 0)}</span></td>
                <td className="p-2.5 text-xs font-semibold">{e.direction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AccountList title="Largest Floating Loss" rows={risk.largestLoss} field="floatingPnl" />
        <AccountList title="Largest Floating Profit" rows={risk.largestProfit} field="floatingPnl" />
        <AccountList title="Top Risk (Margin at Work)" rows={risk.topRisky} field="margin" money />
      </div>
    </div>
  );
}
function AccountList({ title, rows, field, money }) {
  return (
    <div className="card p-3">
      <div className="text-sm font-semibold text-white mb-2">{title}</div>
      {(!rows || !rows.length) ? <div className="text-text-muted text-xs py-4 text-center">No accounts.</div> : (
        <div className="space-y-1.5">
          {rows.map((a) => (
            <div key={a.accountId} className="flex items-center justify-between text-xs">
              <div className="min-w-0">
                <div className="text-text-secondary truncate">{a.userName}</div>
                <div className="text-text-muted">{a.accountNumber} · {a.positions} pos</div>
              </div>
              <div className={`font-semibold ${money ? 'text-white' : sgn(a[field])}`}>{money ? fmtMoney(a[field]) : signed(a[field])}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── detail drawer ───────────────────────── */
function DetailDrawer({ target, onClose }) {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let on = true;
    (async () => {
      setLoading(true);
      try { const { data } = await api.get(`/order-management/detail/${target.kind}/${target.id}`); if (on) setD(data.data); }
      catch (e) { toast.error(errorMessage(e)); onClose(); }
      finally { if (on) setLoading(false); }
    })();
    return () => { on = false; };
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const o = d?.order; const p = d?.position;
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-xl h-full bg-bg-card border-l border-border-dark overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-card border-b border-border-dark p-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-bold text-white">{target.kind === 'order' ? 'Pending Order' : 'Position'} Details</h2>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        {loading || !d ? (
          <div className="p-4 space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-lg bg-bg-hover animate-pulse" />)}</div>
        ) : (
          <div className="p-4 space-y-4">
            <Section title="Overview">
              <Grid items={target.kind === 'order' ? [
                ['Order ID', ticket(o._id)], ['Symbol', o.symbol], ['Side', o.side], ['Type', o.type],
                ['Status', o.status], ['Quantity', fmtNum(o.quantity, 4)], ['Filled', fmtNum(o.filledQuantity, 4)],
                ['Limit', o.price ?? '—'], ['Stop', o.stopPrice ?? '—'], ['SL', o.stopLoss ?? '—'], ['TP', o.takeProfit ?? '—'],
              ] : [
                ['Order ID', ticket(p._id)], ['Symbol', p.symbol], ['Side', p.side], ['Book', p.book],
                ['Volume', fmtNum(p.quantity, 4)], ['Open Price', fmtNum(p.entryPrice, 5)], ['Current', fmtNum(p.currentPrice, 5)],
                ['Floating PnL', signed(p.floatingPnl)], ['Margin', fmtMoney(p.margin)], ['SL', p.stopLoss ?? '—'], ['TP', p.takeProfit ?? '—'],
                ['Status', p.status],
              ]} />
            </Section>

            <Section title="User & Account">
              <Grid items={[
                ['User', d.user ? ([d.user.firstName, d.user.lastName].filter(Boolean).join(' ') || d.user.email) : '—'],
                ['Email', d.user?.email || '—'], ['Account', d.account?.accountNumber || '—'],
                ['Type', d.account?.accountType || '—'], ['Leverage', d.account?.leverage ? `1:${d.account.leverage}` : '—'],
              ]} />
              {d.stats && <Grid items={[
                ['Open Positions', d.stats.openPositions], ['Closed', d.stats.closedPositions],
                ['Realized PnL', signed(d.stats.totalRealizedPnl)], ['Win Rate', `${d.stats.winRate}%`],
              ]} />}
            </Section>

            <Section title="Timeline">
              {(!d.timeline || !d.timeline.length) ? <Empty /> : (
                <div className="space-y-2">
                  {d.timeline.map((t, i) => (
                    <div key={i} className="flex gap-3 text-xs">
                      <div className="text-text-muted w-36 shrink-0">{fmtDate(t.at)}</div>
                      <div><span className="text-white font-medium">{t.event}</span>{t.detail ? <span className="text-text-muted"> · {t.detail}</span> : null}</div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Related Trades / Execution">
              {(!d.trades || !d.trades.length) ? <Empty /> : (
                <div className="space-y-1 text-xs">
                  {d.trades.map((t) => (
                    <div key={t._id} className="flex justify-between text-text-secondary">
                      <span>{fmtDate(t.executedAt)}</span><span>{fmtNum(t.quantity, 4)} @ {fmtNum(t.price, 5)}</span><span className="text-text-muted">{t.routing}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Admin Action History">
              {(!d.history || !d.history.length) ? <Empty text="No admin actions recorded." /> : (
                <div className="space-y-2">
                  {d.history.map((h) => (
                    <div key={h._id} className="text-xs border-l-2 border-border-dark pl-2">
                      <div className="text-white font-medium">{h.action} <span className="text-text-muted font-normal">· {h.actorRole}</span></div>
                      <div className="text-text-muted">{fmtDate(h.createdAt)}{h.metadata?.note ? ` · ${h.metadata.note}` : ''}{h.ip ? ` · ${h.ip}` : ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}
const Section = ({ title, children }) => (
  <div><div className="text-xs uppercase tracking-wide text-primary-500 font-bold mb-2">{title}</div>{children}</div>
);
const Grid = ({ items }) => (
  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-2">
    {items.map(([k, v], i) => (
      <div key={i} className="flex justify-between text-xs"><span className="text-text-muted">{k}</span><span className="text-text-secondary font-medium text-right truncate ml-2">{String(v)}</span></div>
    ))}
  </div>
);
const Empty = ({ text = 'Nothing yet.' }) => <div className="text-text-muted text-xs">{text}</div>;

/* ───────────────────────── modals ───────────────────────── */
function ModalShell({ title, onClose, children, footer }) {
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-dark rounded-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-base font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
        <div className="px-4 py-3 border-t border-border-dark flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}

function SltpModal({ row, onClose, onSaved }) {
  const [sl, setSl] = useState(row.stopLoss ?? '');
  const [tp, setTp] = useState(row.takeProfit ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/order-management/positions/${row._id}/modify`, { stopLoss: sl === '' ? null : sl, takeProfit: tp === '' ? null : tp });
      toast.success('SL/TP updated'); onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <ModalShell title={`Modify SL/TP · ${row.symbol}`} onClose={onClose}
      footer={<><button onClick={onClose} className="btn-secondary text-sm">Cancel</button><button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button></>}>
      <div className="text-xs text-text-muted">{row.side} {fmtNum(row.volume, 4)} · open {fmtNum(row.openPrice, 5)} · current {fmtNum(row.currentPrice, 5)}</div>
      <div><label className="label">Stop Loss</label><input className="input" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="blank = none" /></div>
      <div><label className="label">Take Profit</label><input className="input" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="blank = none" /></div>
    </ModalShell>
  );
}

function CommentModal({ row, onClose, onSaved }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try { await api.post(`/order-management/positions/${row._id}/comment`, { note }); toast.success('Comment added'); onSaved(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <ModalShell title={`Internal Comment · ${row.symbol}`} onClose={onClose}
      footer={<><button onClick={onClose} className="btn-secondary text-sm">Cancel</button><button onClick={save} disabled={saving || !note.trim()} className="btn-primary text-sm">{saving ? 'Saving…' : 'Add'}</button></>}>
      <div className="text-xs text-text-muted">Recorded in the audit trail for {row.userName}.</div>
      <textarea className="input min-h-[90px]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason / note for compliance…" />
    </ModalShell>
  );
}

function PendingModal({ row, onClose, onSaved }) {
  const [price, setPrice] = useState(row.entryPrice ?? '');
  const [sl, setSl] = useState(row.stopLoss ?? '');
  const [tp, setTp] = useState(row.takeProfit ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/order-management/orders/${row._id}/modify`, { price: price === '' ? null : price, stopLoss: sl === '' ? null : sl, takeProfit: tp === '' ? null : tp });
      toast.success('Order updated'); onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };
  return (
    <ModalShell title={`Modify Order · ${row.symbol}`} onClose={onClose}
      footer={<><button onClick={onClose} className="btn-secondary text-sm">Cancel</button><button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save'}</button></>}>
      <div className="text-xs text-text-muted">{row.orderType} {row.side} {fmtNum(row.volume, 4)}</div>
      <div><label className="label">Entry / Limit Price</label><input className="input" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
      <div><label className="label">Stop Loss</label><input className="input" value={sl} onChange={(e) => setSl(e.target.value)} /></div>
      <div><label className="label">Take Profit</label><input className="input" value={tp} onChange={(e) => setTp(e.target.value)} /></div>
    </ModalShell>
  );
}

/* ───────────────────────── misc ───────────────────────── */
function SkeletonRows({ cols, rows = 8 }) {
  return Array.from({ length: rows }).map((_, r) => (
    <tr key={r} className="border-t border-border-dark/50">
      {Array.from({ length: cols }).map((__, c) => (
        <td key={c} className="p-2.5"><div className="h-3.5 rounded bg-bg-hover animate-pulse" style={{ width: `${40 + ((r + c) % 4) * 15}%` }} /></td>
      ))}
    </tr>
  ));
}
const csv = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
