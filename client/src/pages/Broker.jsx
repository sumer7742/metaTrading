import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { brokerApi, isUsable } from '../services/broker';
import { errorMessage } from '../services/api';
import useWebSocketChannel from '../hooks/useWebSocketChannel';
import ConnectBroker from '../components/broker/ConnectBroker';
import BrokerOrderPad from '../components/broker/BrokerOrderPad';
import BrokerOrders from '../components/broker/BrokerOrders';
import BrokerPortfolio from '../components/broker/BrokerPortfolio';
import { StatusChip } from '../components/broker/brokerUi';

/**
 * Broker Terminal — the Indian stock-market trading surface.
 *
 * Users trade through THEIR OWN broker accounts (Dhan today; more later). This
 * page never talks to a broker directly — every call goes to our backend, which
 * routes to the right adapter. Entirely separate from the forex/crypto engine.
 */
const TABS = [
  { key: 'trade', label: 'Trade' },
  { key: 'portfolio', label: 'Portfolio' },
  { key: 'connections', label: 'Connections' },
];

export default function Broker() {
  const [brokers, setBrokers] = useState([]); // catalogue of supported brokers
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeBroker, setActiveBroker] = useState(''); // '' = use default
  const [tab, setTab] = useState('trade');
  // Bumped on every live order event / placement so child panels refetch.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const bump = useCallback(() => setRefreshSignal((n) => n + 1), []);

  const loadConnections = useCallback(async () => {
    try {
      const list = await brokerApi.listConnections();
      setConnections(list || []);
      return list || [];
    } catch (err) {
      // 404 when the module is disabled — surface once, don't spam.
      if (err?.response?.status !== 404) toast.error(errorMessage(err));
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [cat, conns] = await Promise.all([
          brokerApi.listBrokers().catch(() => []),
          loadConnections(),
        ]);
        if (cancelled) return;
        setBrokers(cat || []);
        // Default the active broker to the user's default/first usable connection.
        const usable = (conns || []).filter(isUsable);
        const def = usable.find((c) => c.isDefault) || usable[0];
        if (def) setActiveBroker(def.broker);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadConnections]);

  const usableConnections = useMemo(() => connections.filter(isUsable), [connections]);
  const hasConnection = usableConnections.length > 0;
  const activeConn = usableConnections.find((c) => c.broker === activeBroker) || usableConnections[0];

  // ── Live updates: one `user:broker` channel, typed payloads ──────────
  // The backend collapses order + stream events onto a single user channel
  // (matching the existing user:notifications pattern); we branch on `type`.
  useWebSocketChannel(hasConnection ? 'user:broker' : null, (data) => {
    if (!data) return;
    if (data.type === 'order') {
      bump();
      const o = data.order;
      if (o?.status === 'FILLED') toast.success(`Filled: ${o.side} ${o.filledQty || o.qty} ${o.symbol}`);
      else if (o?.status === 'REJECTED') toast.error(`Rejected: ${o.symbol} — ${o.statusMessage || 'broker rejected'}`);
    } else if (data.type === 'stream' && data.state === 'FAILED') {
      toast.error(`${data.broker || 'Broker'} live feed disconnected — reconnect your token.`);
      loadConnections();
    }
  });

  const onConnectionsChanged = useCallback(async () => {
    const list = await loadConnections();
    const usable = (list || []).filter(isUsable);
    if (!usable.some((c) => c.broker === activeBroker)) {
      const def = usable.find((c) => c.isDefault) || usable[0];
      setActiveBroker(def ? def.broker : '');
    }
  }, [loadConnections, activeBroker]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Broker Terminal</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Trade Indian stocks & F&O through your own broker account.
          </p>
        </div>

        {/* Broker switcher — only when the user has >1 usable connection. */}
        {usableConnections.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Account</span>
            <select
              value={activeBroker}
              onChange={(e) => { setActiveBroker(e.target.value); bump(); }}
              className="px-3 py-1.5 rounded-lg border border-border-dark bg-white text-sm font-medium text-text-primary focus:outline-none focus:border-primary-500"
            >
              {usableConnections.map((c) => (
                <option key={c.broker} value={c.broker}>{c.broker}{c.isDefault ? ' (default)' : ''}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border-dark">
        {TABS.map((t) => {
          const disabled = t.key !== 'connections' && !hasConnection;
          return (
            <button
              key={t.key}
              type="button"
              disabled={disabled}
              onClick={() => setTab(t.key)}
              className={`relative px-4 py-2.5 text-sm font-semibold transition-colors -mb-px border-b-2 ${
                tab === t.key
                  ? 'border-primary-500 text-primary-600'
                  : disabled
                    ? 'border-transparent text-text-muted/50 cursor-not-allowed'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              {t.label}
              {t.key === 'connections' && activeConn && (
                <StatusChip status={activeConn.status} className="ml-2" />
              )}
            </button>
          );
        })}
      </div>

      {/* No connection yet → nudge to Connections (unless already there). */}
      {!hasConnection && tab !== 'connections' && !loading && (
        <div className="bg-primary-500/5 border border-primary-500/20 rounded-xl px-5 py-8 text-center">
          <p className="text-sm font-medium text-text-primary">Connect a broker to start trading</p>
          <p className="text-xs text-text-muted mt-1">Link your Dhan account with an access token — takes a minute.</p>
          <button
            type="button"
            onClick={() => setTab('connections')}
            className="mt-4 px-4 py-2 rounded-lg bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 transition-colors"
          >
            Connect a broker
          </button>
        </div>
      )}

      {/* Tab bodies */}
      {tab === 'connections' && (
        <ConnectBroker
          brokers={brokers}
          connections={connections}
          loading={loading}
          onChanged={onConnectionsChanged}
        />
      )}

      {tab === 'trade' && hasConnection && (
        <div className="grid gap-4 lg:grid-cols-[380px_1fr] items-start">
          <BrokerOrderPad broker={activeConn?.broker} onPlaced={bump} />
          <BrokerOrders broker={activeConn?.broker} refreshSignal={refreshSignal} />
        </div>
      )}

      {tab === 'portfolio' && hasConnection && (
        <BrokerPortfolio broker={activeConn?.broker} refreshSignal={refreshSignal} />
      )}
    </div>
  );
}
