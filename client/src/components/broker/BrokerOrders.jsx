import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { brokerApi, isTerminal } from '../../services/broker';
import { errorMessage } from '../../services/api';
import { fmtTime } from '../../utils/format';
import { Card, StatusChip, Placeholder, inr } from './brokerUi';

/**
 * Live order book for the connected broker.
 *
 * Refreshes on demand and whenever a `user:broker` order event arrives (pushed
 * up from the page via the `refreshSignal` prop). Modify/cancel act on our
 * clientOrderId — the platform maps it to the broker order id.
 */
export default function BrokerOrders({ broker, refreshSignal }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async (force = false) => {
    try {
      setError(null);
      const rows = await brokerApi.orders({ broker: broker || undefined, force });
      setOrders(rows || []);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [broker]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  // A live order event (or a placement) bumps refreshSignal → pull the book.
  useEffect(() => { if (refreshSignal) load(true); }, [refreshSignal, load]);

  const cancel = async (o) => {
    setBusyId(o.clientOrderId);
    try {
      await brokerApi.cancel(o.clientOrderId);
      toast.success('Cancellation submitted');
      load(true);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId('');
    }
  };

  return (
    <Card
      title="Orders"
      subtitle={orders.length ? `${orders.length} order(s) today` : undefined}
      actions={
        <button
          type="button"
          onClick={() => load(true)}
          className="text-xs font-medium px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          Refresh
        </button>
      }
    >
      <Placeholder loading={loading} error={error} empty={!orders.length ? 'No orders yet today.' : undefined}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">
                <th className="text-left font-semibold px-4 py-2">Instrument</th>
                <th className="text-right font-semibold px-3 py-2">Qty</th>
                <th className="text-right font-semibold px-3 py-2">Price</th>
                <th className="text-left font-semibold px-3 py-2">Type</th>
                <th className="text-left font-semibold px-3 py-2">Status</th>
                <th className="text-right font-semibold px-4 py-2">Time</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {orders.map((o) => (
                <tr key={o.clientOrderId} className="hover:bg-bg-hover/50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${o.side === 'BUY' ? 'bg-bull/10 text-bull' : 'bg-bear/10 text-bear'}`}>
                        {o.side}
                      </span>
                      <span className="font-semibold text-text-primary">{o.symbol}</span>
                      <span className="text-[11px] text-text-muted">{o.exchange}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">
                    {o.filledQty ? `${o.filledQty}/${o.qty}` : o.qty}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-text-secondary">
                    {o.orderType === 'MARKET' ? 'MKT' : inr(o.price)}
                  </td>
                  <td className="px-3 py-2.5 text-text-muted text-xs">{String(o.orderType).replace('_', '-')}</td>
                  <td className="px-3 py-2.5"><StatusChip status={o.status} /></td>
                  <td className="px-4 py-2.5 text-right text-xs text-text-muted font-mono">{fmtTime(o.createdAt)}</td>
                  <td className="px-3 py-2.5 text-right">
                    {!isTerminal(o.status) && (
                      <button
                        type="button"
                        disabled={busyId === o.clientOrderId}
                        onClick={() => cancel(o)}
                        className="text-xs font-medium text-bear hover:underline disabled:opacity-50"
                      >
                        {busyId === o.clientOrderId ? '…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Placeholder>
    </Card>
  );
}
