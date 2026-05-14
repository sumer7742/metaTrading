import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';

export default function Security() {
  const { user, init } = useAuthStore();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [busy, setBusy] = useState(false);

  const init2FA = async () => {
    setBusy(true);
    try {
      const r = await api.post('/auth/2fa/setup');
      setSetup(r.data.data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (!/^\d{6}$/.test(code)) return toast.error('Enter the 6-digit code');
    setBusy(true);
    try {
      const r = await api.post('/auth/2fa/enable', { code });
      setBackupCodes(r.data.data.backupCodes);
      toast.success('2FA enabled — save your backup codes');
      setSetup(null);
      setCode('');
      await init();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    const c = window.prompt('Enter your current 6-digit 2FA code to disable:');
    if (!c) return;
    setBusy(true);
    try {
      await api.post('/auth/2fa/disable', { code: c });
      toast.success('2FA disabled');
      setBackupCodes(null);
      await init();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const enabled = !!user?.twoFactorEnabled;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHero
        eyebrow="Account"
        title="Security"
        subtitle="Protect your admin login with a second factor. Required for production."
      />

      <div className="card p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Two-Factor Authentication</h2>
            <p className="text-xs text-text-muted mt-1 max-w-md">
              Use an authenticator app (Google Authenticator, Authy, 1Password) to generate a
              6-digit code on each login.
            </p>
          </div>
          <span
            className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded ${
              enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bear/20 text-bear'
            }`}
          >
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>

        <div className="mt-4">
          {enabled ? (
            <button onClick={disable} disabled={busy} className="btn-bear text-sm">
              Disable 2FA
            </button>
          ) : (
            <button onClick={init2FA} disabled={busy} className="btn-primary text-sm">
              {setup ? 'Restart Setup' : 'Enable 2FA'}
            </button>
          )}
        </div>

        {setup && !enabled && (
          <div className="mt-6 p-4 rounded bg-bg-dark border border-border-dark space-y-3">
            <p className="text-sm text-text-secondary">1. Scan this QR with your authenticator app:</p>
            <img
              src={setup.qrDataUrl}
              alt="2FA QR"
              className="w-48 h-48 mx-auto bg-white p-2 rounded"
            />
            <p className="text-xs text-text-muted text-center">
              Or manually enter: <code className="text-primary-500">{setup.secret}</code>
            </p>
            <p className="text-sm text-text-secondary mt-4">
              2. Enter the 6-digit code from your app to confirm:
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                className="input font-mono text-center tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                maxLength={6}
                placeholder="000000"
              />
              <button onClick={enable} disabled={busy} className="btn-primary">
                Confirm
              </button>
            </div>
          </div>
        )}

        {backupCodes && (
          <div className="mt-6 p-4 rounded bg-amber-500/10 border border-amber-500/30">
            <h3 className="text-amber-400 font-semibold mb-2">⚠ Save these backup codes</h3>
            <p className="text-xs text-text-secondary mb-3">
              Each code can be used once if you lose access to your authenticator. They won't
              be shown again.
            </p>
            <pre className="bg-bg-dark p-3 rounded text-primary-500 font-mono text-sm overflow-auto">
              {backupCodes.join('\n')}
            </pre>
            <button
              onClick={() => {
                navigator.clipboard.writeText(backupCodes.join('\n'));
                toast.success('Copied');
              }}
              className="btn-secondary text-sm mt-3"
            >
              Copy codes
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
