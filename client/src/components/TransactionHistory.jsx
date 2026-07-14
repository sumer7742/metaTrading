import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum, currencySymbol } from '../utils/format';

/**
 * Unified Transaction History — a single rich table that merges wallet
 * deposits, withdrawals and ledger postings (trades, fees, adjustments,
 * transfers) into one filterable, paginated view.
 *
 * Design mirrors the reference screenshot: Date & Time · Transaction ID ·
 * Amount · Status · Type · Payment Method · Currency · Received From ·
 * Destination · Description · Note · Actions — with a filter bar
 * (Date Range / Type / Status / Accounts / Search), Export-to-CSV, and
 * bottom pagination.
 *
 * It is purely presentational over data the Wallet page already loads:
 *   - deposits   → /wallet/deposits
 *   - withdrawals→ /wallet/withdrawals
 *   - ledger     → /wallet/ledger
 * Personal per-row notes are stored client-side (localStorage) since the
 * backend has no user-note field on transactions.
 */

// ─── Label maps ───────────────────────────────────────────────────────
const METHOD_LABEL = {
  UPI: 'UPI',
  BANK: 'Bank Transfer',
  CRYPTO: 'Crypto',
  CARD: 'Card',
  RAZORPAY: 'Razorpay',
  DEMO: 'Wallet Balance',
  MANUAL: 'Manual',
};

const LEDGER_TYPE = {
  TRADE_OPEN: 'Trade Open',
  TRADE_CLOSE: 'Trade Close',
  FEE: 'Fee',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Internal Transfer',
  INTERNAL_TRANSFER_OUT: 'Transfer Sent',
  INTERNAL_TRANSFER_IN: 'Transfer Received',
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  CONVERSION: 'Conversion',
};

const methodLabel = (m) => METHOD_LABEL[String(m || '').toUpperCase()] || (m ? String(m) : 'System');

// ─── Date formatting: "13 Jul 2026, 10:09:36 PM" ──────────────────────
function fmtDateTime(d) {
  if (!d) return '-';
  const s = new Date(d).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  });
  return s.replace(/\b(am|pm)\b/i, (x) => x.toUpperCase());
}

// ─── Transaction ID display: TXN-XXXXXXXXXXXX ─────────────────────────
const txnDisplayId = (raw) => 'TXN-' + String(raw || '').slice(-12).toUpperCase().padStart(12, '0');

// ─── Normalizers → one common row shape ───────────────────────────────
function normalizeDeposit(d) {
  const method = String(d.method || '').toUpperCase();
  let receivedFrom = 'External';
  if (method === 'UPI') receivedFrom = d.senderUpiId ? `UPI ID\n${d.senderUpiId}` : 'UPI ID';
  else if (method === 'BANK') receivedFrom = 'Bank Account';
  else if (method === 'CRYPTO') receivedFrom = 'Crypto Wallet';
  else if (method === 'CARD') receivedFrom = 'Card';
  return {
    id: String(d._id || d.id),
    kind: 'deposit',
    date: d.createdAt,
    amount: Number(d.amount || 0),
    currency: d.currency || 'INR',
    status: d.status || 'PENDING',
    type: 'Deposit',
    typeKey: 'Deposit',
    method: methodLabel(d.method),
    receivedFrom,
    destination: 'Main Wallet',
    description: d.note || `Deposit via ${methodLabel(d.method)}`,
    accountId: d.accountId ? String(d.accountId) : null,
    raw: d,
  };
}

function normalizeWithdrawal(w) {
  const method = String(w.method || '').toUpperCase();
  let destination = w.destination || 'External';
  if (method === 'UPI') destination = w.upiId ? `UPI ID\n${w.upiId}` : (w.destination || 'UPI ID');
  else if (method === 'BANK') destination = w.destination || 'Bank Account';
  else if (method === 'CRYPTO') destination = w.destination || 'Crypto Wallet';
  return {
    id: String(w._id || w.id),
    kind: 'withdrawal',
    date: w.createdAt,
    amount: -Math.abs(Number(w.amount || 0)),
    currency: w.currency || 'INR',
    status: w.status || 'PENDING',
    type: 'Withdrawal',
    typeKey: 'Withdrawal',
    method: methodLabel(w.method),
    receivedFrom: 'Main Wallet',
    destination,
    description: w.note || `Withdrawal via ${methodLabel(w.method)}`,
    accountId: w.accountId ? String(w.accountId) : null,
    raw: w,
  };
}

function normalizeLedger(l) {
  const type = LEDGER_TYPE[l.type] || l.type || 'Other';
  const amt = Number(l.amount || 0);
  const cp = l.counterparty?.name;
  const isTransfer = l.type === 'INTERNAL_TRANSFER_OUT' || l.type === 'INTERNAL_TRANSFER_IN' || l.type === 'TRANSFER';
  let receivedFrom = '-';
  let destination = '-';
  let method = 'System';
  if (l.type === 'TRADE_OPEN') { receivedFrom = 'Main Wallet'; destination = 'Trading Account'; }
  else if (l.type === 'TRADE_CLOSE') { receivedFrom = 'Trading Account'; destination = 'Main Wallet'; }
  else if (l.type === 'FEE') { receivedFrom = '-'; destination = 'System'; }
  else if (l.type === 'ADJUSTMENT') { receivedFrom = 'System'; destination = 'Main Wallet'; }
  else if (l.type === 'INTERNAL_TRANSFER_OUT') { method = 'Internal'; receivedFrom = 'Main Wallet'; destination = cp || 'User Wallet'; }
  else if (l.type === 'INTERNAL_TRANSFER_IN') { method = 'Internal'; receivedFrom = cp || 'User Wallet'; destination = 'Main Wallet'; }
  else if (l.type === 'TRANSFER') { method = 'Internal'; receivedFrom = amt >= 0 ? 'Wallet' : 'Main Wallet'; destination = amt >= 0 ? 'Main Wallet' : 'Wallet'; }
  return {
    id: String(l._id || l.id),
    kind: 'ledger',
    date: l.createdAt,
    amount: amt,
    currency: l.currency || 'USD',
    status: 'COMPLETED',
    type,
    typeKey: type,
    method,
    receivedFrom,
    destination,
    description: l.note || type,
    accountId: l.accountId ? String(l.accountId) : null,
    raw: l,
  };
}

// ─── Status pill ──────────────────────────────────────────────────────
function StatusPill({ status }) {
  const s = String(status || '').toUpperCase();
  const map = {
    COMPLETED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    CONFIRMED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    APPROVED: { dot: '#16A34A', bg: '#16A34A14', fg: '#15803D' },
    PROCESSING: { dot: '#2563EB', bg: '#2563EB14', fg: '#1D4ED8' },
    PENDING: { dot: '#D97706', bg: '#D9770614', fg: '#B45309' },
    REJECTED: { dot: '#DC2626', bg: '#DC262614', fg: '#B91C1C' },
    CANCELLED: { dot: '#64748B', bg: '#64748B14', fg: '#475569' },
  };
  const c = map[s] || { dot: '#64748B', bg: '#64748B14', fg: '#475569' };
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide whitespace-nowrap"
      style={{ background: c.bg, color: c.fg }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c.dot }} />
      {s || 'UNKNOWN'}
    </span>
  );
}

// ─── Copy-to-clipboard button ─────────────────────────────────────────
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy Transaction ID"
      onClick={() => {
        try { navigator.clipboard?.writeText(text); } catch (_) {}
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="text-text-muted hover:text-primary-600 transition-colors shrink-0"
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </button>
  );
}

// ─── Shared dropdown helpers ──────────────────────────────────────────
function useDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return { open, setOpen, ref };
}

// Trigger "chip" — label on top, current value below, chevron + open ring.
function FilterTrigger({ icon, label, value, open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 bg-white border rounded-xl px-3 py-2.5 text-left transition-all ${
        open ? 'border-primary-500 ring-2 ring-primary-500/30' : 'border-border-dark hover:border-primary-500/40'
      }`}
    >
      <span className="text-text-muted shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] uppercase tracking-wider text-text-muted font-bold truncate">{label}</span>
        <span className="block text-[13px] font-semibold text-text-primary truncate">{value}</span>
      </span>
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className={`text-text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

const Panel = ({ children }) => (
  <div className="absolute z-40 mt-1.5 w-full min-w-[248px] bg-white border border-border-dark rounded-xl shadow-elevated">
    {children}
  </div>
);

// iOS-style toggle switch.
function Toggle({ on, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${on ? 'bg-primary-600' : 'bg-gray-300'}`}
      aria-pressed={on}
    >
      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

// ─── Per-type leading icons (keyword-matched, with a fallback) ────────
function typeIcon(label) {
  const l = String(label).toLowerCase();
  const P = (d) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
  if (l.includes('deposit')) return P(<><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></>);
  if (l.includes('withdraw')) return P(<><path d="M12 21V9" /><path d="M7 14l5-5 5 5" /><path d="M4 3h16" /></>);
  if (l.includes('transfer')) return P(<><path d="M7 7h13l-3-3" /><path d="M17 17H4l3 3" /></>);
  if (l.includes('trade')) return P(<><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></>);
  if (l.includes('commission') || l.includes('referral')) return P(<><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7" /><rect x="2" y="7" width="20" height="5" rx="1" /><path d="M12 22V7" /><path d="M12 7S9 2 7 3.5 8 7 12 7z" /><path d="M12 7s3-5 5-3.5S16 7 12 7z" /></>);
  if (l.includes('charge')) return P(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></>);
  if (l.includes('invest')) return P(<><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></>);
  if (l.includes('bonus')) return P(<><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18" /></>);
  if (l.includes('conversion') || l.includes('adjust')) return P(<><path d="M4 7h13l-3-3" /><path d="M20 17H7l3 3" /></>);
  if (l.includes('fee')) return P(<><path d="M9 6l9 9" /><circle cx="7.5" cy="7.5" r="1.5" /><circle cx="16.5" cy="16.5" r="1.5" /><path d="M5 5l14 14" opacity="0" /></>);
  return P(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>);
}

const STATUS_COLOR = {
  COMPLETED: '#16A34A', CONFIRMED: '#16A34A', APPROVED: '#16A34A', DONE: '#16A34A',
  PROCESSING: '#2563EB', PENDING: '#D97706', REJECTED: '#DC2626', CANCELLED: '#94A3B8',
};
const statusDot = (status) => (
  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: STATUS_COLOR[String(status).toUpperCase()] || '#94A3B8' }} />
);

// ─── Fixed transaction-type categories (matches the reference UI) ─────
// The filter always shows this full set, regardless of which types the
// data currently contains. Every row is mapped into exactly one bucket
// via `categoryOf` so the toggles filter correctly.
const TYPE_CATEGORIES = [
  'Deposit',
  'Withdrawal',
  'Transfer - Internal',
  'Transfer - External',
  'Transfer - Wallet to Account',
  'Transfer - Account to Wallet',
  'Transfer - Wallet to Wallet',
  'Trade Open',
  'Trade Close',
  'Fee',
  'Commission',
  'Charge',
  'Investment',
  'Bonus',
  'Referral Commission Earned',
  'Referral Deposit Bonus',
  'Others',
];

function categoryIcon(label) {
  const P = (d) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
  switch (label) {
    case 'Deposit': return P(<><path d="M12 3v11" /><path d="M8 10l4 4 4-4" /><path d="M4 21h16" /></>);
    case 'Withdrawal': return P(<><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20" /><path d="M12 13v6" /><path d="M9 16l3 3 3-3" /></>);
    case 'Transfer - Internal': return P(<><path d="M7 7h12l-3-3" /><path d="M17 17H5l3 3" /></>);
    case 'Transfer - External': return P(<><path d="M4 12a8 8 0 0 1 13-6" /><path d="M17 3v3h-3" /><path d="M20 12a8 8 0 0 1-13 6" /><path d="M7 21v-3h3" /></>);
    case 'Transfer - Wallet to Account': return P(<><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>);
    case 'Transfer - Account to Wallet': return P(<><path d="M17 7H5l3-3" /><path d="M7 17h12l-3 3" /></>);
    case 'Transfer - Wallet to Wallet': return P(<><path d="M7 7h12l-3-3" /><path d="M17 17H5l3 3" /><circle cx="4" cy="8" r="1" /><circle cx="20" cy="16" r="1" /></>);
    case 'Trade Open': return P(<><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></>);
    case 'Trade Close': return P(<><path d="M3 7l6 6 4-4 8 8" /><path d="M14 17h7v-7" /></>);
    case 'Fee': return P(<><circle cx="12" cy="12" r="9" /><path d="M15 9.3c-.6-.9-1.7-1.3-3-1.3-1.7 0-3 .8-3 2s1.3 1.8 3 2 3 .9 3 2-1.3 2-3 2c-1.3 0-2.4-.5-3-1.4" /><path d="M12 6.5v11" /></>);
    case 'Commission': return P(<><circle cx="12" cy="12" r="3.2" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1l2.1-2.1M17 7l2.1-2.1" /></>);
    case 'Charge': return P(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
    case 'Investment': return P(<><path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" /></>);
    case 'Bonus': return P(<><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18" /><path d="M12 8S9 3 7 4.5 8 8 12 8z" /><path d="M12 8s3-5 5-3.5S16 8 12 8z" /></>);
    case 'Referral Commission Earned':
    case 'Referral Deposit Bonus': return P(<><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M2 11h20" /><circle cx="7" cy="16" r="1" /></>);
    default: return P(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>);
  }
}

// Map a normalized row into exactly one of the TYPE_CATEGORIES buckets.
function categoryOf(row) {
  if (row.kind === 'deposit') return 'Deposit';
  if (row.kind === 'withdrawal') return 'Withdrawal';
  const t = row.raw?.type;
  if (t === 'TRANSFER') return 'Transfer - Internal';
  if (t === 'INTERNAL_TRANSFER_OUT' || t === 'INTERNAL_TRANSFER_IN') return 'Transfer - External';
  if (t === 'TRADE_OPEN') return 'Trade Open';
  if (t === 'TRADE_CLOSE') return 'Trade Close';
  if (t === 'FEE') return 'Fee';
  const s = `${row.type} ${row.description}`.toLowerCase();
  if (s.includes('wallet to account')) return 'Transfer - Wallet to Account';
  if (s.includes('account to wallet')) return 'Transfer - Account to Wallet';
  if (s.includes('wallet to wallet')) return 'Transfer - Wallet to Wallet';
  if (s.includes('referral') && s.includes('commission')) return 'Referral Commission Earned';
  if (s.includes('referral') && (s.includes('deposit') || s.includes('bonus'))) return 'Referral Deposit Bonus';
  if (s.includes('commission')) return 'Commission';
  if (s.includes('bonus')) return 'Bonus';
  if (s.includes('charge')) return 'Charge';
  if (s.includes('invest')) return 'Investment';
  return 'Others';
}

// ─── Multi-select dropdown with header + Select All + toggles ─────────
function MultiSelect({ icon, label, title, options, selected, onChange, renderLeading }) {
  const { open, setOpen, ref } = useDropdown();
  const all = options.length > 0 && selected.length === options.length;
  const summary = options.length === 0 ? 'None'
    : all ? `All Selected (${options.length})`
    : selected.length === 0 ? 'None Selected'
    : `${selected.length} Selected`;
  const toggle = (o) => selected.includes(o) ? onChange(selected.filter((x) => x !== o)) : onChange([...selected, o]);
  return (
    <div className="relative min-w-0" ref={ref}>
      <FilterTrigger icon={icon} label={label} value={summary} open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Panel>
          <div className="flex items-center justify-between px-3.5 pt-3 pb-2 border-b border-border-subtle">
            <span className="text-[13px] font-bold text-text-primary">{title}</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-text-muted">Select All</span>
              <Toggle on={all} onChange={() => onChange(all ? [] : [...options])} />
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {options.map((o) => (
              <div key={o} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-bg-hover">
                {renderLeading && <span className="text-text-secondary shrink-0 flex items-center">{renderLeading(o)}</span>}
                <span className="text-[13px] text-text-primary truncate flex-1">{o}</span>
                <Toggle on={selected.includes(o)} onChange={() => toggle(o)} />
              </div>
            ))}
            {options.length === 0 && <div className="px-2 py-3 text-[12px] text-text-muted">No options</div>}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─── Date-range dropdown (presets + checkmarks + custom range) ────────
const CalIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></svg>;
const DATE_PRESETS = [
  { k: 'today', label: 'Today' },
  { k: 'yesterday', label: 'Yesterday' },
  { k: '7d', label: 'Last 7 Days' },
  { k: '30d', label: 'Last 30 Days' },
  { k: '90d', label: 'Last 90 Days' },
  { k: '3m', label: 'Last 3 Months' },
  { k: '6m', label: 'Last 6 Months' },
  { k: '1y', label: 'Last 1 Year' },
  { k: 'all', label: 'All Time' },
  { k: 'custom', label: 'Custom Range' },
];
function DateRangeSelect({ value, custom, onChange, onCustomChange }) {
  const { open, setOpen, ref } = useDropdown();
  const cur = DATE_PRESETS.find((p) => p.k === value) || DATE_PRESETS[8];
  return (
    <div className="relative min-w-0" ref={ref}>
      <FilterTrigger icon={<CalIcon />} label="Date Range" value={cur.label} open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Panel>
          <div className="px-3.5 pt-3 pb-2 border-b border-border-subtle text-[13px] font-bold text-text-primary">Select Date Range</div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {DATE_PRESETS.map((p) => {
              const active = value === p.k;
              return (
                <button
                  key={p.k}
                  type="button"
                  onClick={() => { onChange(p.k); if (p.k !== 'custom') setOpen(false); }}
                  className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors ${active ? 'bg-primary-500/10' : 'hover:bg-bg-hover'}`}
                >
                  <span className={active ? 'text-primary-600' : 'text-text-muted'}><CalIcon /></span>
                  <span className={`text-[13px] flex-1 truncate ${active ? 'text-primary-600 font-semibold' : 'text-text-primary'}`}>{p.label}</span>
                  {active && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-primary-600 shrink-0"><path d="M20 6L9 17l-5-5" /></svg>
                  )}
                </button>
              );
            })}
            {value === 'custom' && (
              <div className="px-2 pt-2 pb-1 flex flex-col gap-2">
                <label className="text-[11px] font-semibold text-text-muted">From
                  <input type="date" value={custom.from} onChange={(e) => onCustomChange({ ...custom, from: e.target.value })} className="mt-1 w-full text-[13px] text-text-primary border border-border-dark rounded-lg px-2 py-1.5 outline-none focus:border-primary-500" />
                </label>
                <label className="text-[11px] font-semibold text-text-muted">To
                  <input type="date" value={custom.to} onChange={(e) => onCustomChange({ ...custom, to: e.target.value })} className="mt-1 w-full text-[13px] text-text-primary border border-border-dark rounded-lg px-2 py-1.5 outline-none focus:border-primary-500" />
                </label>
              </div>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─── Account dropdown (single-select, radio rows) ─────────────────────
const WalletIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20" /><circle cx="17" cy="14.5" r="1.2" /></svg>;
function AccountSelect({ accounts, value, onChange }) {
  const { open, setOpen, ref } = useDropdown();
  const opts = [
    { id: 'all', name: 'All Accounts' },
    ...accounts.map((a) => ({ id: String(a._id), name: a.nickname || a.accountNumber || a.accountType || 'Account' })),
  ];
  const cur = opts.find((o) => o.id === value) || opts[0];
  return (
    <div className="relative min-w-0" ref={ref}>
      <FilterTrigger icon={<WalletIcon />} label="Accounts" value={cur.name} open={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <Panel>
          <div className="px-3.5 pt-3 pb-2 border-b border-border-subtle text-[13px] font-bold text-text-primary">Select Account</div>
          <div className="max-h-72 overflow-y-auto p-1.5">
            {opts.map((o) => {
              const active = value === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { onChange(o.id); setOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-bg-hover transition-colors"
                >
                  <span className="text-text-muted shrink-0"><WalletIcon /></span>
                  <span className="text-[13px] text-text-primary flex-1 truncate">{o.name}</span>
                  <span className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${active ? 'border-primary-600' : 'border-gray-300'}`}>
                    {active && <span className="w-2 h-2 rounded-full bg-primary-600" />}
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

// ─── Date-range predicate ─────────────────────────────────────────────
function inDateRange(d, range, custom) {
  if (range === 'all') return true;
  const t = new Date(d).getTime();
  if (!isFinite(t)) return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 864e5;
  switch (range) {
    case 'today': return t >= startOfToday;
    case 'yesterday': return t >= startOfToday - DAY && t < startOfToday;
    case '7d': return t >= now.getTime() - 7 * DAY;
    case '30d': return t >= now.getTime() - 30 * DAY;
    case '90d': return t >= now.getTime() - 90 * DAY;
    case '3m': { const s = new Date(now); s.setMonth(s.getMonth() - 3); return t >= s.getTime(); }
    case '6m': { const s = new Date(now); s.setMonth(s.getMonth() - 6); return t >= s.getTime(); }
    case '1y': { const s = new Date(now); s.setFullYear(s.getFullYear() - 1); return t >= s.getTime(); }
    case 'custom':
      if (custom?.from && t < new Date(custom.from).getTime()) return false;
      if (custom?.to && t > new Date(custom.to).getTime() + DAY) return false;
      return true;
    default: return true;
  }
}

// ─── Details modal ────────────────────────────────────────────────────
function DetailsModal({ row, onClose }) {
  if (!row) return null;
  const sign = row.amount > 0 ? '+' : row.amount < 0 ? '-' : '';
  const rows = [
    ['Transaction ID', txnDisplayId(row.id)],
    ['Date & Time', fmtDateTime(row.date)],
    ['Type', row.type],
    ['Amount', `${sign}${currencySymbol(row.currency)}${fmtNum(Math.abs(row.amount), 2)}`],
    ['Currency', row.currency],
    ['Status', row.status],
    ['Payment Method', row.method],
    ['Received From', String(row.receivedFrom).replace(/\n/g, ' · ')],
    ['Destination', String(row.destination).replace(/\n/g, ' · ')],
    ['Description', row.description],
  ];
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle sticky top-0 bg-white">
          <div className="text-sm font-bold text-text-primary">Transaction Details</div>
          <button type="button" onClick={onClose} className="text-text-muted hover:text-text-primary">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-5 space-y-3">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-4">
              <span className="text-[11px] uppercase tracking-wider text-text-muted font-bold shrink-0 pt-0.5">{k}</span>
              <span className="text-[13px] font-semibold text-text-primary text-right break-all">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────
export default function TransactionHistory({ deposits = [], withdrawals = [], ledger = [], accounts = [], loading }) {
  // Personal notes (client-side only — backend has no per-tx user note field).
  const [notes, setNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('txnNotes') || '{}'); } catch { return {}; }
  });
  const saveNote = (id, val) => {
    const next = { ...notes };
    if (val) next[id] = val; else delete next[id];
    setNotes(next);
    try { localStorage.setItem('txnNotes', JSON.stringify(next)); } catch (_) {}
  };
  const [editingNote, setEditingNote] = useState(null);
  const [detailRow, setDetailRow] = useState(null);

  // Filters
  const [dateRange, setDateRange] = useState('all');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [accountId, setAccountId] = useState('all');
  const [search, setSearch] = useState('');
  const [typeSel, setTypeSel] = useState(null);   // null = all (initialized once options known)
  const [statusSel, setStatusSel] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Build the unified list. Ledger DEPOSIT/WITHDRAWAL rows are dropped —
  // they'd duplicate the richer deposit/withdrawal records which carry the
  // full status lifecycle (pending/rejected), whereas the ledger only
  // posts settled entries.
  const allRows = useMemo(() => {
    const d = deposits.map(normalizeDeposit);
    const w = withdrawals.map(normalizeWithdrawal);
    const l = ledger
      .filter((e) => e.type !== 'DEPOSIT' && e.type !== 'WITHDRAWAL')
      .map(normalizeLedger);
    return [...d, ...w, ...l]
      .map((r) => ({ ...r, category: categoryOf(r) }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [deposits, withdrawals, ledger]);

  const typeOptions = TYPE_CATEGORIES;
  const statusOptions = useMemo(() => [...new Set(allRows.map((r) => r.status))].sort(), [allRows]);

  // Default the multiselects to "all" once options are known.
  const effTypeSel = typeSel === null ? typeOptions : typeSel;
  const effStatusSel = statusSel === null ? statusOptions : statusSel;

  const accountLabel = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(String(a._id), a.nickname || a.accountNumber || a.accountType || 'Account');
    return m;
  }, [accounts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (!inDateRange(r.date, dateRange, customRange)) return false;
      // Account
      if (accountId !== 'all' && r.accountId !== accountId) return false;
      // Type category
      if (!effTypeSel.includes(r.category)) return false;
      // Status
      if (!effStatusSel.includes(r.status)) return false;
      // Search
      if (q) {
        const hay = `${txnDisplayId(r.id)} ${r.description} ${r.destination} ${r.receivedFrom} ${r.type} ${r.method}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allRows, dateRange, customRange, accountId, effTypeSel, effStatusSel, search]);

  // Reset to first page whenever a filter changes.
  useEffect(() => { setPage(1); }, [dateRange, customRange, accountId, search, typeSel, statusSel, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  const exportCsv = () => {
    const cols = ['Date & Time', 'Transaction ID', 'Amount', 'Currency', 'Status', 'Type', 'Payment Method', 'Received From', 'Destination', 'Description', 'Note'];
    const esc = (v) => `"${String(v ?? '').replace(/\n/g, ' ').replace(/"/g, '""')}"`;
    const lines = [cols.map(esc).join(',')];
    for (const r of filtered) {
      lines.push([
        fmtDateTime(r.date), txnDisplayId(r.id), r.amount.toFixed(2), r.currency, r.status,
        r.type, r.method, r.receivedFrom, r.destination, r.description, notes[r.id] || '',
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pageNumbers = useMemo(() => {
    const out = [];
    const win = 2;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || Math.abs(i - clampedPage) <= win) out.push(i);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  }, [totalPages, clampedPage]);

  return (
    <div className="bg-white border border-border-dark rounded-2xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-5 py-4 border-b border-border-subtle">
        <div>
          <h2 className="text-lg font-bold text-text-primary">Transaction History</h2>
          <p className="text-[12px] text-text-muted mt-0.5">View and manage all your transactions in one place.</p>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-border-dark text-text-primary text-[13px] font-semibold hover:shadow-card hover:border-primary-500/40 transition-all self-start sm:self-auto"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
          Export
        </button>
      </div>

      {/* Filter bar */}
      <div className="px-5 py-4 border-b border-border-subtle grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
        <DateRangeSelect value={dateRange} custom={customRange} onChange={setDateRange} onCustomChange={setCustomRange} />
        <MultiSelect
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M7 12h10M10 18h4" /></svg>}
          label="Transaction Type" title="Select Transaction Type"
          options={typeOptions} selected={effTypeSel} onChange={setTypeSel} renderLeading={categoryIcon}
        />
        <MultiSelect
          icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 9 9h-9z" /></svg>}
          label="Status" title="Select Status"
          options={statusOptions} selected={effStatusSel} onChange={setStatusSel} renderLeading={statusDot}
        />
        <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} />
        <div className="flex items-center gap-2 bg-white border border-border-dark rounded-xl px-3 py-2.5 xl:col-span-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted shrink-0"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by ID, description…"
            className="w-full text-[13px] text-text-primary bg-transparent outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="py-16 text-center text-sm text-text-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-text-muted">No transactions match your filters</div>
        ) : (
          <table className="w-full text-sm min-w-[1180px]">
            <thead className="text-[10px] text-text-muted uppercase tracking-wider font-bold bg-bg-hover">
              <tr>
                <th className="text-left px-4 py-3">Date &amp; Time</th>
                <th className="text-left px-4 py-3">Transaction ID</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Payment Method</th>
                <th className="text-left px-4 py-3">Currency</th>
                <th className="text-left px-4 py-3">Received From</th>
                <th className="text-left px-4 py-3">Destination</th>
                <th className="text-left px-4 py-3">Description</th>
                <th className="text-center px-4 py-3">Note</th>
                <th className="text-center px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {pageRows.map((r) => {
                const sign = r.amount > 0 ? '+' : r.amount < 0 ? '-' : '';
                const amtColor = r.amount > 0 ? 'text-bull' : r.amount < 0 ? 'text-bear' : 'text-text-secondary';
                return (
                  <tr key={`${r.kind}-${r.id}`} className="hover:bg-bg-hover transition-colors align-top">
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-nowrap">{fmtDateTime(r.date)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-text-primary">{txnDisplayId(r.id)}</span>
                        <CopyBtn text={txnDisplayId(r.id)} />
                      </div>
                    </td>
                    <td className={`px-4 py-3 text-right font-mono tabular-nums font-bold whitespace-nowrap ${amtColor}`}>
                      {sign}{currencySymbol(r.currency)}{fmtNum(Math.abs(r.amount), 2)}
                    </td>
                    <td className="px-4 py-3"><StatusPill status={r.status} /></td>
                    <td className="px-4 py-3 text-text-primary text-[12px] font-medium whitespace-nowrap">{r.type}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-nowrap">{r.method}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] font-mono">{r.currency}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-pre-line max-w-[160px]">{r.receivedFrom}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] whitespace-pre-line max-w-[160px] break-words">{r.destination}</td>
                    <td className="px-4 py-3 text-text-secondary text-[12px] max-w-[200px]">{r.description}</td>
                    <td className="px-4 py-3 text-center">
                      {editingNote === r.id ? (
                        <input
                          autoFocus
                          defaultValue={notes[r.id] || ''}
                          onBlur={(e) => { saveNote(r.id, e.target.value.trim()); setEditingNote(null); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditingNote(null); }}
                          className="w-32 text-[12px] border border-primary-500/50 rounded-lg px-2 py-1 outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          title={notes[r.id] ? `Note: ${notes[r.id]}` : 'Add note'}
                          onClick={() => setEditingNote(r.id)}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition-colors ${notes[r.id] ? 'text-primary-600 bg-primary-500/10' : 'text-text-muted hover:text-primary-600 hover:bg-bg-hover'}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        type="button"
                        title="View details"
                        onClick={() => setDetailRow(r)}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-primary-600 hover:bg-bg-hover transition-colors"
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" /></svg>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer / pagination */}
      {!loading && filtered.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-5 py-4 border-t border-border-subtle">
          <div className="text-[12px] text-text-muted">
            Showing {(clampedPage - 1) * pageSize + 1} to {Math.min(clampedPage * pageSize, filtered.length)} of {filtered.length} entries
          </div>
          <div className="flex items-center gap-3">
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="text-[12px] font-semibold text-text-primary bg-white border border-border-dark rounded-lg px-2.5 py-1.5 outline-none cursor-pointer"
            >
              {[15, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </select>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={clampedPage === 1}
                onClick={() => setPage(clampedPage - 1)}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border-dark text-text-secondary disabled:opacity-40 hover:bg-bg-hover transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              {pageNumbers.map((n, i) =>
                n === '…' ? (
                  <span key={`e${i}`} className="w-8 h-8 flex items-center justify-center text-text-muted text-[12px]">…</span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg text-[12px] font-semibold transition-colors ${
                      n === clampedPage ? 'bg-primary-600 text-white' : 'border border-border-dark text-text-secondary hover:bg-bg-hover'
                    }`}
                  >
                    {n}
                  </button>
                )
              )}
              <button
                type="button"
                disabled={clampedPage === totalPages}
                onClick={() => setPage(clampedPage + 1)}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border-dark text-text-secondary disabled:opacity-40 hover:bg-bg-hover transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <DetailsModal row={detailRow} onClose={() => setDetailRow(null)} />
    </div>
  );
}
