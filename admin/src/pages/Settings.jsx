import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';

/**
 * Admin Settings page — platform-wide knobs.
 *
 * Currently exposes:
 *   - Routing Mode (A_BOOK / B_BOOK)  → drives every order's execution path
 *   - Default LP Provider             → which adapter to use when A_BOOK
 *
 * The mode is a TOGGLE because it's a one-bit decision; the LP provider
 * is a dropdown because new providers are added at the adapter layer.
 * We also surface which providers are credentialed so admin can tell at
 * a glance whether a switch to A_BOOK will work without env changes.
 */
export default function Settings() {
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    try {
      const r = await api.get('/admin/system/settings');
      setData(r.data.data);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  useEffect(() => { refresh(); }, []);

  const save = async (patch) => {
    setSaving(true);
    try {
      const r = await api.put('/admin/system/settings', patch);
      setData((prev) => ({ ...prev, settings: r.data.data }));
      toast.success('Settings updated');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return <div className="text-text-muted p-6">Loading settings…</div>;
  }

  const { settings, lpProviders } = data;
  const mode = settings.routingMode || 'B_BOOK';
  const isA = mode === 'A_BOOK';
  const isB = mode === 'B_BOOK';
  const isHybrid = mode === 'HYBRID';
  const credentialedProviders = (lpProviders || []).filter((p) => p.credentialed).map((p) => p.provider);
  // LP is "wired" when either creds exist OR a provider is selected
  // (stub fills work in dev). Show warning only when A_BOOK / HYBRID
  // is active AND no provider is selected at all.
  const lpMissing = !settings.defaultLpProvider || settings.defaultLpProvider === 'NONE';
  const noCredsAtAll = credentialedProviders.length === 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHero
        eyebrow="Infrastructure"
        title="System Settings"
        subtitle="Platform-wide execution config — affects every account."
      />

      {/* Routing mode card */}
      <div className="card p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold text-white">Routing Mode</h2>
            <p className="text-xs text-text-muted mt-1 max-w-md">
              {isA && 'Every order is forwarded to the configured liquidity provider.'}
              {isB && 'Orders execute internally using the matching engine. No LP traffic.'}
              {isHybrid && 'Risk engine decides per order — big trades / profitable users → LP, rest → internal.'}
            </p>
          </div>
          <span className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded ${
            isA ? 'bg-blue-500/20 text-blue-400'
            : isHybrid ? 'bg-amber-500/20 text-amber-400'
            : 'bg-emerald-500/20 text-emerald-400'
          }`}>
            {mode}
          </span>
        </div>

        {/* Three-button toggle — B / HYBRID / A. Trying to switch to a
            mode that needs LP without creds shows a warning rather than
            blocking — admin can still save and configure LP after. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            disabled={saving}
            onClick={() => isB || save({ routingMode: 'B_BOOK' })}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              isB
                ? 'border-emerald-500 bg-emerald-500/10'
                : 'border-border-dark hover:border-border-accent bg-bg-dark'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">🏠</span>
              <span className="font-semibold text-white text-sm">B-Book</span>
              {isB && <span className="text-[10px] text-emerald-400 ml-auto">ACTIVE</span>}
            </div>
            <div className="text-xs text-text-muted">
              Internal execution only. Broker is counterparty.
            </div>
          </button>

          <button
            disabled={saving}
            onClick={() => isHybrid || save({ routingMode: 'HYBRID' })}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              isHybrid
                ? 'border-amber-500 bg-amber-500/10'
                : 'border-border-dark hover:border-border-accent bg-bg-dark'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">⚖️</span>
              <span className="font-semibold text-white text-sm">Hybrid</span>
              {isHybrid && <span className="text-[10px] text-amber-400 ml-auto">ACTIVE</span>}
            </div>
            <div className="text-xs text-text-muted">
              Risk engine routes per order. Mix of internal + LP.
            </div>
          </button>

          <button
            disabled={saving}
            onClick={() => isA || save({ routingMode: 'A_BOOK' })}
            className={`p-4 rounded-lg border-2 text-left transition-all ${
              isA
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-border-dark hover:border-border-accent bg-bg-dark'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">🌐</span>
              <span className="font-semibold text-white text-sm">A-Book</span>
              {isA && <span className="text-[10px] text-blue-400 ml-auto">ACTIVE</span>}
            </div>
            <div className="text-xs text-text-muted">
              Every order → LP. Broker is fully hedged.
            </div>
          </button>
        </div>

        {/* LP credential warning — shown when current mode NEEDS an LP
            but none of the providers have credentials configured.
            Doesn't block — stub fills work for dev — but yells loud. */}
        {(isA || isHybrid) && noCredsAtAll && (
          <div className="mt-4 flex items-start gap-2 text-xs bg-bear/10 border border-bear/30 text-bear rounded p-3">
            <span className="text-base leading-none">⚠</span>
            <div>
              <div className="font-semibold mb-0.5">No LP credentials configured</div>
              <div className="text-bear/80">
                {mode} mode needs a working LP. None of OANDA, BINANCE or CUSTOM_LP have
                API keys set in <code>.env</code> — orders will run in stub-fill mode
                (synthetic prices, fine for dev only). Set <code>OANDA_API_KEY</code> /
                <code>BINANCE_API_KEY</code> / <code>CUSTOM_LP_*</code> and restart backend
                before going live.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Default LP provider — only meaningful in A_BOOK mode but shown
          always so admin can pre-configure before flipping the switch. */}
      <div className="card p-6">
        <h2 className="text-base font-semibold text-white mb-1">Default LP Provider</h2>
        <p className="text-xs text-text-muted mb-4">
          Used when Routing Mode is A-Book. Greyed-out options below have no API
          credentials configured in <code className="text-text-secondary">.env</code> —
          they will run in stub-fill mode (development only).
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {['OANDA', 'BINANCE', 'CUSTOM_LP'].map((p) => {
            const active = settings.defaultLpProvider === p;
            const credentialed = credentialedProviders.includes(p);
            return (
              <button
                key={p}
                disabled={saving}
                onClick={() => save({ defaultLpProvider: p })}
                className={`p-3 rounded-lg border-2 text-left transition-all ${
                  active
                    ? 'border-primary-500 bg-primary-500/10'
                    : 'border-border-dark hover:border-border-accent bg-bg-dark'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-white text-sm">{p.replace('_', ' ')}</span>
                  <span className={`w-2 h-2 rounded-full ${credentialed ? 'bg-bull' : 'bg-gray-500'}`} />
                </div>
                <div className="text-[10px] text-text-muted">
                  {credentialed ? 'Credentials configured' : 'No credentials — stub mode'}
                </div>
              </button>
            );
          })}
        </div>

        {lpMissing && (isA || isHybrid) && (
          <div className="mt-3 text-xs text-bear bg-bear/10 border border-bear/30 rounded p-3">
            ⚠ {mode} mode active but no LP provider selected — A-routed orders will reject.
            Pick a provider above.
          </div>
        )}
      </div>

      {/* Raw settings dump — useful for debugging. */}
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer hover:text-text-secondary">Raw settings</summary>
        <pre className="mt-2 bg-bg-dark p-3 rounded overflow-auto">{JSON.stringify(settings, null, 2)}</pre>
      </details>
    </div>
  );
}

