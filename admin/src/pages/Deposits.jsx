import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtNum, fmtDate } from '../utils/format';

export default function Deposits() {
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('PENDING');
  const [viewing, setViewing] = useState(null); // deposit being viewed in detail modal

  const load = async () => {
    const { data } = await api.get('/admin/deposits', { params: filter ? { status: filter } : {} });
    setItems(data.data);
  };

  useEffect(() => { load(); }, [filter]);

  const confirm = async (id) => {
    if (!window.confirm('Confirm this deposit? This will credit the user wallet immediately.')) return;
    try {
      await api.post(`/admin/deposits/${id}/confirm`);
      toast.success('Deposit confirmed — user wallet credited');
      setViewing(null);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const reject = async (id) => {
    const reason = window.prompt('Rejection reason (visible to user):');
    if (!reason) return;
    try {
      await api.post(`/admin/deposits/${id}/reject`, { reason });
      toast.success('Deposit rejected');
      setViewing(null);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const formatINR = (val) => Number(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = (cur) => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[cur] || (cur + ' '));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">Deposit Verification</h1>
      <p className="text-sm text-gray-400">Review user payment screenshots and approve/reject deposits.</p>

      <div className="flex space-x-2">
        {['PENDING', 'CONFIRMED', 'REJECTED', ''].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setFilter(s)}
            className={`text-xs px-3 py-1.5 rounded ${filter === s ? 'btn-primary' : 'bg-bg-card text-gray-400 hover:bg-bg-hover'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left p-3">Date</th>
              <th className="text-left p-3">User</th>
              <th className="text-left p-3">Sender</th>
              <th className="text-left p-3">Method</th>
              <th className="text-right p-3">Amount</th>
              <th className="text-left p-3">Reference</th>
              <th className="text-center p-3">Proof</th>
              <th className="text-left p-3">Status</th>
              <th className="text-right p-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d._id} className="table-row">
                <td className="p-3 text-xs text-gray-400">{fmtDate(d.createdAt)}</td>
                <td className="p-3 text-xs text-gray-400 font-mono">{d.userId.toString().slice(-6)}</td>
                <td className="p-3 text-xs">
                  <div className="text-white">{d.senderName || '-'}</div>
                  {d.senderUpiId && <div className="text-gray-500 font-mono">{d.senderUpiId}</div>}
                </td>
                <td className="p-3 text-xs">{d.method || '-'}</td>
                <td className="p-3 text-right font-mono text-white font-semibold">
                  {symbol(d.currency)}{formatINR(d.amount)}
                </td>
                <td className="p-3 text-xs text-gray-400 font-mono">{d.txReference || '-'}</td>
                <td className="p-3 text-center">
                  {d.screenshot ? (
                    <button
                      onClick={() => setViewing(d)}
                      className="text-primary-500 hover:underline text-xs font-semibold"
                    >
                      📸 View
                    </button>
                  ) : (
                    <span className="text-gray-600 text-xs">—</span>
                  )}
                </td>
                <td className="p-3">
                  <span className={`text-xs px-2 py-0.5 rounded ${
                    d.status === 'CONFIRMED' ? 'bg-green-900/30 text-green-400' :
                    d.status === 'REJECTED' ? 'bg-red-900/30 text-red-400' :
                    'bg-yellow-900/30 text-yellow-400'
                  }`}>{d.status}</span>
                </td>
                <td className="p-3 text-right">
                  {d.status === 'PENDING' && (
                    <button onClick={() => setViewing(d)} className="btn-secondary text-xs">
                      Review
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && <div className="text-center text-gray-500 py-6 text-sm">No deposits matching filter</div>}
      </div>

      {/* Detail modal */}
      {viewing && (
        <DepositDetailModal
          deposit={viewing}
          onClose={() => setViewing(null)}
          onConfirm={() => confirm(viewing._id)}
          onReject={() => reject(viewing._id)}
        />
      )}
    </div>
  );
}

function DepositDetailModal({ deposit, onClose, onConfirm, onReject }) {
  const symbol = (cur) => ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' }[cur] || (cur + ' '));

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-bg-card border border-border-dark rounded-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-border-dark flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Deposit Details</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>

        <div className="p-5 grid md:grid-cols-2 gap-5">
          {/* Left: details */}
          <div className="space-y-3">
            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Amount</div>
              <div className="text-3xl font-bold text-primary-500 font-mono">
                {symbol(deposit.currency)}{Number(deposit.amount).toLocaleString('en-IN', {minimumFractionDigits: 2})}
              </div>
            </div>

            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Method</div>
              <div className="text-white">{deposit.method}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Sender Name</div>
              <div className="text-white">{deposit.senderName || '-'}</div>
            </div>

            {deposit.senderUpiId && (
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Sender UPI</div>
                <div className="text-white font-mono">{deposit.senderUpiId}</div>
              </div>
            )}

            {deposit.senderBankAccount && (
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Sender Bank A/c (last 4)</div>
                <div className="text-white font-mono">XXXX{deposit.senderBankAccount}</div>
              </div>
            )}

            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Transaction Reference</div>
              <div className="text-white font-mono break-all">{deposit.txReference || '-'}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">User ID</div>
              <div className="text-white font-mono text-sm">{deposit.userId}</div>
            </div>

            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Submitted At</div>
              <div className="text-white">{new Date(deposit.createdAt).toLocaleString('en-IN')}</div>
            </div>

            {deposit.note && (
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">User Note</div>
                <div className="text-gray-300 text-sm">{deposit.note}</div>
              </div>
            )}

            <div>
              <div className="text-xs text-gray-500 uppercase mb-1">Status</div>
              <span className={`text-sm px-2 py-1 rounded ${
                deposit.status === 'CONFIRMED' ? 'bg-green-900/30 text-green-400' :
                deposit.status === 'REJECTED' ? 'bg-red-900/30 text-red-400' :
                'bg-yellow-900/30 text-yellow-400'
              }`}>{deposit.status}</span>
            </div>

            {deposit.rejectionReason && (
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Rejection Reason</div>
                <div className="text-bear text-sm">{deposit.rejectionReason}</div>
              </div>
            )}
          </div>

          {/* Right: screenshot */}
          <div>
            <div className="text-xs text-gray-500 uppercase mb-2">Payment Screenshot</div>
            {deposit.screenshot ? (
              <div className="space-y-2">
                <img
                  src={deposit.screenshot}
                  alt="Payment proof"
                  className="w-full rounded border border-border-dark bg-bg-dark"
                />
                <a
                  href={deposit.screenshot}
                  download={`deposit-${deposit._id}.png`}
                  className="text-xs text-primary-500 hover:underline"
                >
                  ⬇ Download
                </a>
              </div>
            ) : (
              <div className="text-gray-500 text-sm bg-bg-dark p-6 rounded text-center border border-border-dark">
                No screenshot uploaded
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        {deposit.status === 'PENDING' && (
          <div className="p-5 border-t border-border-dark flex gap-3 justify-end">
            <button onClick={onReject} className="btn-bear">Reject</button>
            <button onClick={onConfirm} className="btn-bull">✓ Approve & Credit</button>
          </div>
        )}
      </div>
    </div>
  );
}
