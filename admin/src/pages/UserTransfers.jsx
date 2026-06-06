import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import toast from 'react-hot-toast';
import PageHero from '../components/PageHero';
import DateFilter, { useDateFilter } from '../components/DateFilter';

/**
 * Admin · Peer-to-peer wallet transfers.
 *
 * Reads from the WalletLedger via /admin/transfers/user — pairs each
 * INTERNAL_TRANSFER_OUT row with its matching INTERNAL_TRANSFER_IN row
 * and renders one row per transfer. Unpaired OUT rows are tagged FAILED
 * so an on-call can spot stuck transfers and reconcile from the ledger.
 */
export default function UserTransfers() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    status: '',
    currency: '',
    email: '',
    fromUserId: '',
    toUserId: '',
    minAmount: '',
    maxAmount: '',
  });
  // Date range (defaults to all-time / no preset so nothing changes by default).
  const [range, setRange] = useDateFilter('admin.transfers.range', null);

  const fetchList = async () => {
    setLoading(true);
    try {
      const params = { limit: 200 };
      for (const [k, v] of Object.entries(filters)) {
        if (v !== '' && v != null) params[k] = v;
      }
      if (range?.fromDate) params.fromDate = range.fromDate;
      if (range?.toDate) params.toDate = range.toDate;
      const { data } = await api.get('/admin/transfers/user', { params });
      setItems(data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); /* eslint-disable-next-line */ }, [range]);

  const total = useMemo(() => items.reduce((s, r) => s + Number(r.amount || 0), 0), [items]);
  const failedCount = useMemo(() => items.filter((r) => r.status === 'FAILED').length, [items]);

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Wallet"
        title="User-to-user Transfers"
        subtitle="Every peer transfer routed through the internal wallet ledger. Filter by status, currency, or counterparty."
      />

      {/* Summary chips */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryChip label="Total transfers" value={items.length} />
        <SummaryChip label="Failed" value={failedCount} tint={failedCount > 0 ? 'bear' : 'muted'} />
        <SummaryChip label="Volume" value={total.toFixed(2)} suffix={items[0]?.currency || ''} />
        <SummaryChip label="Latest" value={items[0] ? fmtDate(items[0].createdAt) : '—'} />
      </div>

      {/* Filters */}
      <div className="card p-4">
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Date range</span>
          <DateFilter value={range} onChange={setRange} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          <FilterInput label="Email / name" value={filters.email} onChange={(v) => setFilters({ ...filters, email: v })} />
          <FilterInput label="Status" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} as="select" options={[['','any'], ['COMPLETED','Completed'], ['FAILED','Failed']]} />
          <FilterInput label="Currency" value={filters.currency} onChange={(v) => setFilters({ ...filters, currency: v })} as="select" options={[['',''], ['USD','USD'], ['EUR','EUR'], ['GBP','GBP'], ['INR','INR']]} />
          <FilterInput label="From user id" value={filters.fromUserId} onChange={(v) => setFilters({ ...filters, fromUserId: v })} />
          <FilterInput label="To user id"   value={filters.toUserId}   onChange={(v) => setFilters({ ...filters, toUserId: v })} />
          <FilterInput label="Min amount"   value={filters.minAmount}  onChange={(v) => setFilters({ ...filters, minAmount: v })} type="number" />
          <FilterInput label="Max amount"   value={filters.maxAmount}  onChange={(v) => setFilters({ ...filters, maxAmount: v })} type="number" />
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { setFilters({ status: '', currency: '', email: '', fromUserId: '', toUserId: '', minAmount: '', maxAmount: '' }); setRange({ period: null, fromDate: '', toDate: '' }); }}
            className="px-3 py-1.5 rounded text-xs font-semibold border border-border-dark text-text-secondary hover:text-white hover:border-border-accent transition-colors"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={fetchList}
            className="px-4 py-1.5 rounded text-xs font-bold bg-primary-500 text-white disabled:opacity-50 hover:bg-primary-600 transition-colors"
          >
            {loading ? 'Loading…' : 'Apply filters'}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] text-text-muted uppercase tracking-[0.15em] font-bold bg-bg-panel">
            <tr>
              <th className="text-left p-3">When</th>
              <th className="text-left p-3">From</th>
              <th className="text-left p-3">To</th>
              <th className="text-right p-3">Amount</th>
              <th className="text-right p-3">Fee</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Note</th>
              <th className="text-left p-3">Ref</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.referenceId} className="table-row">
                <td className="p-3 text-xs text-text-secondary whitespace-nowrap font-mono">{fmtDate(r.createdAt)}</td>
                <td className="p-3 text-xs">
                  <div className="font-semibold text-text-primary">{r.from?.name || r.from?.email || '—'}</div>
                  <div className="text-text-muted text-[10px] font-mono">{r.from?.referralCode || (r.from?.userId || '').slice(-8)}</div>
                </td>
                <td className="p-3 text-xs">
                  {r.to ? (
                    <>
                      <div className="font-semibold text-text-primary">{r.to.name || r.to.email}</div>
                      <div className="text-text-muted text-[10px] font-mono">{r.to.referralCode || r.to.userId.slice(-8)}</div>
                    </>
                  ) : (
                    <span className="text-bear text-[10px] font-mono">unpaired</span>
                  )}
                </td>
                <td className="p-3 text-right font-mono text-text-primary">
                  {r.amount} <span className="text-[10px] text-text-muted">{r.currency}</span>
                </td>
                <td className="p-3 text-right font-mono text-text-muted">{Number(r.fee) > 0 ? r.fee : '—'}</td>
                <td className="p-3 text-xs">
                  {r.status === 'COMPLETED'
                    ? <span className="chip-bull">COMPLETED</span>
                    : <span className="chip-bear">FAILED</span>}
                </td>
                <td className="p-3 text-[11px] text-text-secondary max-w-[260px] truncate" title={r.note || ''}>{r.note || '—'}</td>
                <td className="p-3 text-[10px] font-mono text-text-muted">{r.referenceId.slice(-10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !items.length && (
          <div className="text-center text-text-secondary py-10 text-sm">
            <div className="text-text-muted">No user-to-user transfers</div>
            <div className="text-xs text-text-muted mt-1">When users send funds to each other, the transfers will appear here.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryChip({ label, value, suffix, tint = 'muted' }) {
  const tintMap = {
    muted: 'text-text-secondary',
    bear:  'text-bear',
    bull:  'text-bull',
  };
  return (
    <div className="card p-3">
      <div className="text-[10px] text-text-muted uppercase tracking-wider font-bold">{label}</div>
      <div className={`mt-1 text-xl font-bold font-mono ${tintMap[tint] || tintMap.muted}`}>
        {value}{suffix ? <span className="ml-1 text-xs text-text-muted">{suffix}</span> : null}
      </div>
    </div>
  );
}

function FilterInput({ label, value, onChange, as = 'input', options = [], type = 'text' }) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider font-bold text-text-muted mb-1">{label}</label>
      {as === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs text-white focus:border-primary-500 focus:outline-none"
        >
          {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-bg-dark border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none"
        />
      )}
    </div>
  );
}
