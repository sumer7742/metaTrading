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

      {/* Peer-to-peer wallet transfers — admin toggle + limits + fee. */}
      <UserTransfersSettingsCard settings={settings} save={save} saving={saving} />

      {/* Partner / Referral program. */}
      <PartnerSettingsCard settings={settings} save={save} saving={saving} />

      {/* Raw settings dump — useful for debugging. */}
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer hover:text-text-secondary">Raw settings</summary>
        <pre className="mt-2 bg-bg-dark p-3 rounded overflow-auto">{JSON.stringify(settings, null, 2)}</pre>
      </details>
    </div>
  );
}

/**
 * Peer-to-peer wallet transfer admin controls. Mirrors the four
 * SystemSetting keys: `userTransfer.enabled`, `userTransfer.min`,
 * `userTransfer.max`, `userTransfer.feePercent`.
 *
 * Save semantics: the page already debounces saves through the parent
 * `save({...})` helper. To avoid one PUT per keystroke we hold the
 * draft locally and only fire on blur / explicit Save.
 */
function UserTransfersSettingsCard({ settings, save, saving }) {
  const initial = {
    enabled:    settings['userTransfer.enabled'] !== false,
    min:        String(settings['userTransfer.min']        ?? '1'),
    max:        String(settings['userTransfer.max']        ?? '0'),
    feePercent: String(settings['userTransfer.feePercent'] ?? '0'),
  };
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); /* eslint-disable-next-line */ }, [
    settings['userTransfer.enabled'],
    settings['userTransfer.min'],
    settings['userTransfer.max'],
    settings['userTransfer.feePercent'],
  ]);

  const dirty =
    draft.enabled    !== initial.enabled    ||
    draft.min        !== initial.min        ||
    draft.max        !== initial.max        ||
    draft.feePercent !== initial.feePercent;

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Wallet — Peer Transfers</h2>
          <p className="text-xs text-text-muted mt-1 max-w-md">
            User-to-user wallet transfers reuse the existing ledger. Funds move atomically
            between sender (INTERNAL_TRANSFER_OUT) and receiver (INTERNAL_TRANSFER_IN) with
            a shared reference id for audit.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded transition-colors ${
            draft.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bear/20 text-bear'
          }`}
        >
          {draft.enabled ? 'ENABLED' : 'DISABLED'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">Min transfer</label>
          <input
            type="number" min="0" step="0.01"
            value={draft.min}
            onChange={(e) => setDraft({ ...draft, min: e.target.value })}
            className="w-full px-3 py-2 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none"
          />
          <div className="mt-1 text-[10px] text-text-muted">0 = no minimum</div>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">Max transfer</label>
          <input
            type="number" min="0" step="0.01"
            value={draft.max}
            onChange={(e) => setDraft({ ...draft, max: e.target.value })}
            className="w-full px-3 py-2 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none"
          />
          <div className="mt-1 text-[10px] text-text-muted">0 = no maximum</div>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">Fee %</label>
          <input
            type="number" min="0" max="100" step="0.01"
            value={draft.feePercent}
            onChange={(e) => setDraft({ ...draft, feePercent: e.target.value })}
            className="w-full px-3 py-2 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none"
          />
          <div className="mt-1 text-[10px] text-text-muted">Charged to sender on top of amount</div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        {dirty && (
          <button
            type="button"
            onClick={() => setDraft(initial)}
            disabled={saving}
            className="px-3 py-1.5 rounded text-xs font-semibold border border-border-dark text-text-secondary hover:text-white hover:border-border-accent transition-colors"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => save({ userTransfer: {
            enabled:    draft.enabled,
            min:        draft.min,
            max:        draft.max,
            feePercent: draft.feePercent,
          }})}
          className="px-4 py-1.5 rounded text-xs font-bold bg-primary-500 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-600 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * Partner / Referral program admin controls. Mirrors the SystemSetting keys:
 *   partner.enabled, partner.bonusAmount, partner.minDeposit, partner.tiers
 *
 * Tiers are stored as a JSON array of { name, minActive, maxActive, percent }.
 * Admin edits each row inline; the Save handler validates server-side that
 * thresholds are strictly increasing.
 */
function PartnerSettingsCard({ settings, save, saving }) {
  const initial = {
    enabled:     settings['partner.enabled'] !== false,
    bonusAmount: String(settings['partner.bonusAmount'] ?? '10'),
    minDeposit:  String(settings['partner.minDeposit']  ?? '50'),
    bonusCurrency: String(settings['partner.bonusCurrency'] ?? 'USD').toUpperCase(),
    volumeTiers: Array.isArray(settings['partner.volumeTiers']) && settings['partner.volumeTiers'].length
      ? settings['partner.volumeTiers'].map((t) => ({
          name:      String(t.name),
          minVolume: Number(t.minVolume),
          percent:   String(t.percent),
        }))
      : [
          { name: 'BRONZE',   minVolume: 0,         percent: '10' },
          { name: 'SILVER',   minVolume: 100000,    percent: '15' },
          { name: 'GOLD',     minVolume: 500000,    percent: '20' },
          { name: 'PLATINUM', minVolume: 2000000,   percent: '25' },
          { name: 'ELITE',    minVolume: 10000000,  percent: '30' },
        ],
  };
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); /* eslint-disable-next-line */ }, [
    settings['partner.enabled'],
    settings['partner.bonusAmount'],
    settings['partner.minDeposit'],
    settings['partner.bonusCurrency'],
    JSON.stringify(settings['partner.volumeTiers']),
  ]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const updateVolumeTier = (i, patch) => {
    const next = draft.volumeTiers.map((t, idx) => idx === i ? { ...t, ...patch } : t);
    setDraft({ ...draft, volumeTiers: next });
  };

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-base font-semibold text-white">Partner / Referral Program</h2>
          <p className="text-xs text-text-muted mt-1 max-w-md">
            Instant bonus on referee's first qualifying deposit + a partner level that
            progresses on TOTAL referral trading volume (shown on the partner dashboard).
            Tier thresholds below are by volume. All earnings credit the subscription wallet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
          className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded transition-colors ${
            draft.enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bear/20 text-bear'
          }`}
        >
          {draft.enabled ? 'ENABLED' : 'DISABLED'}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">First-deposit bonus ({draft.bonusCurrency})</label>
          <input
            type="number" min="0" step="0.01"
            value={draft.bonusAmount}
            onChange={(e) => setDraft({ ...draft, bonusAmount: e.target.value })}
            className="w-full px-3 py-2 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none"
          />
          <div className="mt-1 text-[10px] text-text-muted">Paid to the referrer, once per referee, on their first qualifying deposit</div>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">Min first deposit ({draft.bonusCurrency})</label>
          <input
            type="number" min="0" step="0.01"
            value={draft.minDeposit}
            onChange={(e) => setDraft({ ...draft, minDeposit: e.target.value })}
            className="w-full px-3 py-2 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none"
          />
          <div className="mt-1 text-[10px] text-text-muted">Below this, deposit doesn't trigger bonus or count toward tier</div>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1">Reward currency</label>
          <select
            value={draft.bonusCurrency}
            onChange={(e) => setDraft({ ...draft, bonusCurrency: e.target.value })}
            className="w-full px-3 py-2 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none"
          >
            {['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'AED'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="mt-1 text-[10px] text-text-muted">Currency recorded on the bonus payout & audit trail</div>
        </div>
      </div>

      <div className="mb-2 text-[11px] uppercase tracking-wider font-bold text-text-muted">Tier thresholds (by total referral volume)</div>
      <div className="space-y-2">
        {draft.volumeTiers.map((t, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center bg-bg-dark border border-border-dark rounded p-2">
            <div className="col-span-4">
              <label className="block text-[10px] text-text-muted mb-0.5">Tier</label>
              <input
                value={t.name}
                onChange={(e) => updateVolumeTier(i, { name: e.target.value.toUpperCase() })}
                className="w-full px-2 py-1.5 rounded bg-bg-panel border border-border-dark text-xs font-bold text-white focus:border-primary-500 focus:outline-none"
              />
            </div>
            <div className="col-span-5">
              <label className="block text-[10px] text-text-muted mb-0.5">Min volume (USD)</label>
              <input
                type="number" min="0" step="1000"
                value={t.minVolume}
                onChange={(e) => updateVolumeTier(i, { minVolume: Number(e.target.value) })}
                className="w-full px-2 py-1.5 rounded bg-bg-panel border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none"
              />
            </div>
            <div className="col-span-3">
              <label className="block text-[10px] text-text-muted mb-0.5">% rev share</label>
              <input
                type="number" min="0" max="100" step="0.1"
                value={t.percent}
                onChange={(e) => updateVolumeTier(i, { percent: e.target.value })}
                className="w-full px-2 py-1.5 rounded bg-bg-panel border border-border-dark text-xs font-mono text-white focus:border-primary-500 focus:outline-none"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        {dirty && (
          <button
            type="button"
            onClick={() => setDraft(initial)}
            disabled={saving}
            className="px-3 py-1.5 rounded text-xs font-semibold border border-border-dark text-text-secondary hover:text-white hover:border-border-accent transition-colors"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => save({ partner: {
            enabled:       draft.enabled,
            bonusAmount:   draft.bonusAmount,
            minDeposit:    draft.minDeposit,
            bonusCurrency: draft.bonusCurrency,
            volumeTiers:   draft.volumeTiers,
          }})}
          className="px-4 py-1.5 rounded text-xs font-bold bg-primary-500 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary-600 transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

