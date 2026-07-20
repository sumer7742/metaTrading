import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import PageHero from '../components/PageHero';

// Which wallet the withdrawal was requested from (Withdrawal.source).
const SOURCE_LABEL = {
  TRADING: 'Trading Account',
  SUBSCRIPTION: 'Main Wallet',
  BONUS: 'Bonus Wallet',
};

export default function Withdrawals() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('PENDING');
  const [mode, setMode] = useState('');   // '' = all accounts, 'real', 'demo'
  const [viewing, setViewing] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const { data } = await api.get('/admin/withdrawals', {
        params: { ...(filter ? { status: filter } : {}), ...(mode ? { mode } : {}) },
      });
      setItems(data.data);
    } finally {
      setRefreshing(false);
    }
  };
  // Auto-poll + focus refresh so new requests land within 8 s without
  // an admin manually reloading the page.
  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, mode]);

  const approve = async (id, payoutData) => {
    try {
      const { data } = await api.post(`/admin/withdrawals/${id}/approve`, payoutData || {});
      if (data.data.needsAnotherApproval) {
        toast('Partial approval recorded - second approver required (>₹10L)', { icon: '🔐' });
      } else {
        toast.success('Withdrawal approved & marked as paid');
      }
      setViewing(null);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const reject = async (id, reason) => {
    try {
      await api.post(`/admin/withdrawals/${id}/reject`, { reason });
      toast.success('Withdrawal rejected, funds returned');
      setViewing(null);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const formatINR = (val) => Number(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = (cur) => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[cur] || (cur + ' '));

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Money"
        title="Withdrawal Requests"
        subtitle="Review pending withdrawals, transfer funds via UPI/bank/crypto, then mark as paid with proof. High-value (>10 lakh) requires two admin approvals."
      />

      <div className="flex items-center space-x-2">
        {['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', ''].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setFilter(s)}
            className={`text-xs px-3 py-1.5 rounded ${filter === s ? 'btn-primary' : 'bg-bg-card text-gray-400 hover:bg-bg-hover'}`}
          >
            {s || 'All'}
          </button>
        ))}
        <span className="w-px h-5 bg-border-dark mx-1" />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          className="text-xs px-3 py-1.5 rounded bg-bg-card text-gray-300 border border-border-dark hover:bg-bg-hover focus:outline-none"
          title="Filter by account type"
        >
          <option value="">All accounts</option>
          <option value="real">Real accounts</option>
          <option value="demo">Demo accounts</option>
        </select>
        <span className="flex-1" />
        <span className="text-[11px] text-gray-500 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${refreshing ? 'bg-bull animate-pulse' : 'bg-gray-600'}`} />
          Auto-refresh · 8s
        </span>
        <button onClick={load} className="text-xs px-3 py-1.5 rounded bg-bg-card text-gray-400 hover:bg-bg-hover" title="Refresh now">
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">User</th>
              <th className="text-left p-3">Method</th>
              <th className="text-right p-3">Amount</th>
              <th className="text-left p-3">Destination</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((w) => (
              <tr key={w._id} className="table-row">
                <td className="p-3 text-xs text-gray-400">{fmtDate(w.createdAt)}</td>
                <td className="p-3 text-xs">
                  {w.user?.userUid
                    ? <span className="font-mono font-bold text-primary-500">{w.user.userUid}</span>
                    : <span className="font-mono text-gray-400">{w.userId?.toString().slice(-6)}</span>}
                  {w.isDemo && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/20 text-purple-300 align-middle">DEMO</span>}
                  {w.user?.name && <div className="text-[10px] text-gray-500 truncate max-w-[160px]">{w.user.name}</div>}
                </td>
                <td className="p-3">
                  <span className="text-xs px-2 py-0.5 rounded bg-bg-hover text-white">
                    {w.method === 'UPI' ? '📱 UPI' : w.method === 'BANK' ? '🏦 Bank' : '₿ Crypto'}
                  </span>
                </td>
                <td className="p-3 text-right font-mono text-white font-semibold">
                  {symbol(w.currency)}{formatINR(w.amount)}
                </td>
                <td className="p-3 text-xs text-gray-300 font-mono max-w-[200px] truncate">
                  {w.method === 'UPI' && w.upiId}
                  {w.method === 'BANK' && `${w.bankAccountHolderName || ''} • ${w.bankAccountNumber || ''}`}
                  {w.method === 'CRYPTO' && `${(w.cryptoAddress || '').slice(0, 20)}... (${w.cryptoNetwork})`}
                </td>
                <td className="p-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    w.status === 'COMPLETED' ? 'bg-green-900/30 text-green-400' :
                    w.status === 'APPROVED' ? 'bg-blue-900/30 text-blue-400' :
                    w.status === 'REJECTED' ? 'bg-red-900/30 text-red-400' :
                    'bg-yellow-900/30 text-yellow-400'
                  }`}>{w.status}</span>
                </td>
                <td className="p-3 text-right">
                  <button onClick={() => setViewing(w)} className="btn-secondary text-xs">
                    {w.status === 'PENDING' ? 'Process' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="text-center text-gray-500 py-6 text-sm">No withdrawals matching filter</div>}
      </div>

      {viewing && (
        <WithdrawalDetailModal
          withdrawal={viewing}
          onClose={() => setViewing(null)}
          onApprove={(payoutData) => approve(viewing._id, payoutData)}
          onReject={(reason) => reject(viewing._id, reason)}
        />
      )}
    </div>
  );
}

function WithdrawalDetailModal({ withdrawal: w, onClose, onApprove, onReject }) {
  const [showApprovalForm, setShowApprovalForm] = useState(false);
  const [payoutTxReference, setPayoutTxReference] = useState('');
  const [payoutProof, setPayoutProof] = useState(null);
  const [payoutProofMimeType, setPayoutProofMimeType] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const symbol = (cur) => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[cur] || (cur + ' '));
  const formatINR = (val) => Number(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Image only');
    if (file.size > 500 * 1024) return toast.error('Max 500KB');
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPayoutProof(ev.target.result);
      setPayoutProofMimeType(file.type);
    };
    reader.readAsDataURL(file);
  };

  const handleApprove = async () => {
    // Both the TX reference and the proof screenshot are optional now.
    setSubmitting(true);
    try {
      await onApprove({ payoutTxReference, payoutProof, payoutProofMimeType });
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = () => {
    const reason = window.prompt('Rejection reason (visible to user):');
    if (reason) onReject(reason);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-bg-card border border-border-dark rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Withdrawal Details</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Amount */}
          <div>
            <div className="text-xs text-gray-500 uppercase mb-1">Amount Requested</div>
            <div className="text-3xl font-bold text-primary-500 font-mono">
              {symbol(w.currency)}{formatINR(w.amount)}
            </div>
          </div>

          {/* User info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">User ID</div>
              <div className="text-white font-mono text-sm">{w.user?.userUid || '—'}</div>
              {w.user?.name && <div className="text-[11px] text-gray-500 mt-0.5">{w.user.name}</div>}
              <div className="text-[10px] text-gray-600 font-mono mt-0.5 break-all">{w.userId}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Submitted</div>
              <div className="text-white text-sm">{new Date(w.createdAt).toLocaleString('en-IN')}</div>
            </div>
          </div>

          {/* Source wallet — which wallet + account this withdrawal came from */}
          <div>
            <div className="text-xs text-gray-500 uppercase mb-1">Source Wallet</div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white text-sm font-semibold">{SOURCE_LABEL[w.source] || w.source || 'Trading Account'}</span>
              {w.accountNickname && <span className="text-gray-400 text-sm">· {w.accountNickname}</span>}
              {w.source === 'TRADING' && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${w.isDemo ? 'bg-amber-500/20 text-amber-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                  {w.isDemo ? 'DEMO' : 'REAL'}
                </span>
              )}
            </div>
            {w.accountNumber && <div className="text-[11px] text-gray-500 font-mono mt-0.5">{w.accountNumber}</div>}
          </div>

          {/* Destination details — different per method */}
          <div className="bg-bg-dark border border-border-dark rounded-lg p-4">
            <div className="text-xs text-gray-500 uppercase mb-2">
              {w.method === 'UPI' && '📱 UPI Destination'}
              {w.method === 'BANK' && '🏦 Bank Destination'}
              {w.method === 'CRYPTO' && '₿ Crypto Destination'}
            </div>

            {w.method === 'UPI' && (
              <div className="space-y-2">
                <div>
                  <span className="text-xs text-gray-500">UPI ID:</span>
                  <div className="font-mono text-white text-lg">{w.upiId}</div>
                </div>
                <div className="text-xs text-yellow-400 mt-2">
                  💡 Send ₹{formatINR(w.amount)} to <strong>{w.upiId}</strong> via your UPI app, then mark as paid below.
                </div>
              </div>
            )}

            {w.method === 'BANK' && (
              <div className="space-y-2 text-sm">
                <div className="grid grid-cols-[140px_1fr] gap-2">
                  <span className="text-gray-500">Holder Name:</span>
                  <span className="text-white font-medium">{w.bankAccountHolderName}</span>
                  <span className="text-gray-500">Account No:</span>
                  <span className="text-white font-mono">{w.bankAccountNumber}</span>
                  <span className="text-gray-500">IFSC:</span>
                  <span className="text-white font-mono">{w.bankIFSC}</span>
                  {w.bankName && (<>
                    <span className="text-gray-500">Bank:</span>
                    <span className="text-white">{w.bankName}</span>
                  </>)}
                </div>
                <div className="text-xs text-yellow-400 mt-2">
                  💡 Transfer ₹{formatINR(w.amount)} via NEFT/IMPS to above account, then mark as paid.
                </div>
              </div>
            )}

            {w.method === 'CRYPTO' && (
              <div className="space-y-2">
                <div>
                  <span className="text-xs text-gray-500">Network:</span>
                  <div className="text-white font-semibold">{w.cryptoNetwork}</div>
                </div>
                <div>
                  <span className="text-xs text-gray-500">Address:</span>
                  <div className="font-mono text-white text-sm break-all bg-black/30 p-2 rounded mt-1">
                    {w.cryptoAddress}
                  </div>
                </div>
                <div className="text-xs text-yellow-400 mt-2">
                  💡 Send equivalent crypto to address above on {w.cryptoNetwork} network.
                </div>
              </div>
            )}
          </div>

          {/* Status */}
          <div>
            <div className="text-xs text-gray-500 uppercase mb-1">Status</div>
            <span className={`text-sm px-2 py-1 rounded ${
              w.status === 'COMPLETED' ? 'bg-green-900/30 text-green-400' :
              w.status === 'APPROVED' ? 'bg-blue-900/30 text-blue-400' :
              w.status === 'REJECTED' ? 'bg-red-900/30 text-red-400' :
              'bg-yellow-900/30 text-yellow-400'
            }`}>{w.status}</span>
          </div>

          {/* If already paid, show proof */}
          {w.payoutProof && (
            <div>
              <div className="text-xs text-gray-500 uppercase mb-2">Payout Proof</div>
              <img
                src={w.payoutProof}
                alt="Payout proof"
                className="max-w-xs rounded border border-border-dark"
              />
              <div className="text-xs text-gray-400 mt-1">
                Tx Ref: <span className="font-mono text-white">{w.payoutTxReference}</span>
              </div>
            </div>
          )}

          {w.rejectedReason && (
            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Rejection Reason</div>
              <div className="text-bear text-sm">{w.rejectedReason}</div>
            </div>
          )}

          {/* Approval form */}
          {w.status === 'PENDING' && showApprovalForm && (
            <div className="bg-blue-900/10 border border-blue-700/30 rounded-lg p-4 space-y-3">
              <div className="text-sm font-semibold text-blue-300">After making the payment, fill below:</div>
              <div>
                <label className="label">Payout Tx Reference (UPI ref / Bank ref / Tx hash) (optional)</label>
                <input
                  className="input font-mono"
                  value={payoutTxReference}
                  onChange={(e) => setPayoutTxReference(e.target.value)}
                  placeholder="e.g. 4123456789012"
                />
              </div>
              <div>
                <label className="label">Proof of Payment Screenshot (optional)</label>
                {!payoutProof ? (
                  <div className="border-2 border-dashed border-border-dark rounded p-4 text-center">
                    <input
                      id="payout-proof"
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={handleFileChange}
                      className="hidden"
                    />
                    <label htmlFor="payout-proof" className="cursor-pointer text-primary-500 text-sm">
                      📸 Click to upload payment screenshot (max 500KB)
                    </label>
                  </div>
                ) : (
                  <div className="relative">
                    <img src={payoutProof} alt="Proof" className="max-h-32 rounded border border-border-dark" />
                    <button
                      onClick={() => { setPayoutProof(null); setPayoutProofMimeType(null); }}
                      className="absolute top-1 right-1 bg-bear text-white rounded w-6 h-6 text-xs"
                    >✕</button>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowApprovalForm(false)}
                  className="btn-secondary text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApprove}
                  disabled={submitting}
                  className="btn-bull flex-1 text-sm"
                >
                  {submitting ? 'Processing...' : '✓ Confirm Payment & Approve'}
                </button>
              </div>
            </div>
          )}

          {/* Action buttons */}
          {w.status === 'PENDING' && !showApprovalForm && (
            <div className="border-t border-border-dark pt-4 flex gap-3 justify-end">
              <button onClick={handleReject} className="btn-bear">
                ✗ Reject
              </button>
              <button onClick={() => setShowApprovalForm(true)} className="btn-bull">
                💸 Mark as Paid
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
