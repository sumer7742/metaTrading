import { useState } from 'react';
import toast from 'react-hot-toast';
import { brokerApi, isUsable } from '../../services/broker';
import { errorMessage } from '../../services/api';
import { Card, StatusChip, Placeholder } from './brokerUi';

/**
 * Broker connections manager.
 *
 * MODE 1 (manual token): the user pastes the access token they generated in
 * their broker's own dashboard. The FORM FIELDS ARE DRIVEN BY THE BACKEND
 * CATALOGUE (`credentialFields`), so a new broker with different fields needs
 * no change here — it just appears with its own inputs.
 *
 * Tokens are sent once over HTTPS and never returned; the UI only ever shows a
 * masked value.
 */
export default function ConnectBroker({ brokers = [], connections, loading, onChanged }) {
  const [selected, setSelected] = useState(null); // broker code being connected

  const byCode = Object.fromEntries((connections || []).map((c) => [c.broker, c]));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Your broker accounts" subtitle="Connect a broker to trade with your own account.">
        <Placeholder
          loading={loading}
          empty={!brokers.length ? 'No brokers available.' : undefined}
        >
          <div className="divide-y divide-border-subtle">
            {brokers.map((b) => {
              const conn = byCode[b.code];
              return (
                <BrokerRow
                  key={b.code}
                  broker={b}
                  connection={conn}
                  onConnect={() => setSelected(b.code)}
                  onChanged={onChanged}
                />
              );
            })}
          </div>
        </Placeholder>
      </Card>

      <div>
        {selected ? (
          <ConnectForm
            broker={brokers.find((b) => b.code === selected)}
            existing={byCode[selected]}
            onDone={() => { setSelected(null); onChanged?.(); }}
            onCancel={() => setSelected(null)}
          />
        ) : (
          <Card title="How it works">
            <ol className="px-5 py-4 space-y-3 text-sm text-text-secondary list-decimal list-inside">
              <li>Pick a broker on the left and choose <strong>Connect</strong>.</li>
              <li>Generate an access token in your broker's dashboard (for Dhan: Profile → DhanHQ Trading APIs → Generate Access Token).</li>
              <li>Paste it here — we validate it with the broker, then store it encrypted. It's never shown again.</li>
              <li>Place orders from the <strong>Trade</strong> tab; they route to your broker account.</li>
            </ol>
            <div className="px-5 pb-4 text-xs text-text-muted">
              We are a terminal, not a broker — execution, funds and holdings stay in your own broker account.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function BrokerRow({ broker, connection, onConnect, onChanged }) {
  const [busy, setBusy] = useState('');
  const connected = isUsable(connection);

  const run = async (action, fn, okMsg) => {
    setBusy(action);
    try {
      await fn();
      if (okMsg) toast.success(okMsg);
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm text-text-primary">{broker.name}</span>
          {connection && <StatusChip status={connection.status} />}
          {connection?.isDefault && (
            <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-500/10 text-primary-600">Default</span>
          )}
        </div>
        <div className="text-xs text-text-muted mt-0.5 truncate">
          {connection
            ? [connection.brokerUserName, connection.maskedToken].filter(Boolean).join(' · ') || 'Connected'
            : broker.description || `Trade through your ${broker.name} account`}
        </div>
        {connection?.lastError && (
          <div className="text-[11px] text-bear mt-0.5 truncate">{connection.lastError.message}</div>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {connected ? (
          <>
            {!connection.isDefault && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => run('default', () => brokerApi.setDefault(broker.code), 'Set as default broker')}
                className="text-xs font-medium px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
              >
                Make default
              </button>
            )}
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run('verify', () => brokerApi.verify(broker.code), 'Token is valid')}
              className="text-xs font-medium px-2.5 py-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
            >
              {busy === 'verify' ? 'Checking…' : 'Verify'}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run('disconnect', () => brokerApi.disconnect(broker.code), `${broker.name} disconnected`)}
              className="text-xs font-medium px-2.5 py-1.5 rounded-lg text-bear hover:bg-bear/5 transition-colors disabled:opacity-50"
            >
              {busy === 'disconnect' ? '…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors"
          >
            {connection ? 'Reconnect' : 'Connect'}
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectForm({ broker, existing, onDone, onCancel }) {
  const fields = broker?.credentialFields || [];
  const [values, setValues] = useState({});
  const [label, setLabel] = useState(existing?.label || '');
  const [submitting, setSubmitting] = useState(false);

  const setField = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const submit = async (e) => {
    e.preventDefault();
    const missing = fields.filter((f) => f.required && !String(values[f.key] || '').trim());
    if (missing.length) {
      toast.error(`${missing[0].label} is required`);
      return;
    }
    setSubmitting(true);
    try {
      await brokerApi.connect({
        broker: broker.code,
        label: label.trim() || undefined,
        credentials: values,
      });
      toast.success(`${broker.name} connected`);
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card title={`Connect ${broker.name}`} subtitle={existing ? 'Paste a fresh token to reconnect.' : undefined}>
      <form onSubmit={submit} className="px-5 py-4 space-y-4">
        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-xs font-semibold text-text-secondary">
              {f.label}{f.required && <span className="text-bear"> *</span>}
            </span>
            <input
              type={f.type === 'password' ? 'password' : 'text'}
              autoComplete={f.type === 'password' ? 'new-password' : 'off'}
              placeholder={f.placeholder || ''}
              value={values[f.key] || ''}
              onChange={(e) => setField(f.key, e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded-lg border border-border-dark bg-white text-sm text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition-shadow"
            />
            {f.help && <span className="block text-[11px] text-text-muted mt-1">{f.help}</span>}
          </label>
        ))}

        <label className="block">
          <span className="text-xs font-semibold text-text-secondary">Label (optional)</span>
          <input
            type="text"
            placeholder="e.g. My Dhan account"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-border-dark bg-white text-sm text-text-primary focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 transition-shadow"
          />
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-lg bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 transition-colors disabled:opacity-60"
          >
            {submitting ? 'Connecting…' : `Connect ${broker.name}`}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-lg border border-border-dark text-sm font-medium text-text-secondary hover:bg-bg-hover transition-colors"
          >
            Cancel
          </button>
        </div>
        <p className="text-[11px] text-text-muted">
          🔒 Your token is validated with {broker.name}, then stored encrypted (AES-256-GCM). It is never displayed or logged.
        </p>
      </form>
    </Card>
  );
}
