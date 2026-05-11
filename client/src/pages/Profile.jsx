import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import PageHero from '../components/PageHero';

export default function Profile() {
  const { user, refreshUser } = useAuthStore();
  const [tab, setTab] = useState('profile');

  return (
    <div className="space-y-6 max-w-[1100px]">
      <PageHero
        eyebrow="Account"
        title="Profile & Security"
        subtitle="Manage your account details, KYC verification, password, 2FA, and active sessions."
      />

      <div className="flex border-b border-border-dark">
        {[
          { id: 'profile', label: 'Profile' },
          { id: 'kyc', label: 'KYC Verification' },
          { id: 'security', label: 'Security' },
          { id: 'devices', label: 'Active Sessions' },
          { id: 'whitelist', label: 'Withdrawal Whitelist' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t.id ? 'text-teal-accent border-b-2 border-teal-accent' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'profile' && <ProfileTab user={user} onUpdate={refreshUser} />}
      {tab === 'kyc' && <KycTab user={user} onUpdate={refreshUser} />}
      {tab === 'security' && <SecurityTab user={user} onUpdate={refreshUser} />}
      {tab === 'devices' && <DevicesTab />}
      {tab === 'whitelist' && <WhitelistTab />}
    </div>
  );
}

// ============== PROFILE ==============
function ProfileTab({ user, onUpdate }) {
  const [form, setForm] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    phone: user?.phone || '',
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/user/profile', form);
      toast.success('Profile updated');
      if (onUpdate) await onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const resendVerify = async () => {
    try { await api.post('/auth/resend-verification'); toast.success('Verification email sent'); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-xs uppercase text-gray-500">Email</div>
            <div className="text-white font-medium">{user?.email}</div>
          </div>
          {user?.isEmailVerified ? (
            <span className="px-3 py-1 rounded-full bg-bull/15 text-bull text-xs font-semibold">✓ Verified</span>
          ) : (
            <button onClick={resendVerify} className="btn-secondary text-sm">Resend verification</button>
          )}
        </div>
      </div>

      <div className="card p-6 space-y-4">
        <h3 className="text-white font-semibold">Personal information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">First name</label>
            <input className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
        </div>
        <button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save changes'}</button>
      </div>
    </div>
  );
}

// ============== KYC ==============
function KycTab({ user, onUpdate }) {
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('ID_FRONT');

  const refresh = async () => {
    try { const r = await api.get('/compliance/kyc/documents'); setDocs(r.data.data); }
    catch (e) { /* ignore */ }
  };
  useEffect(() => { refresh(); }, []);

  const upload = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast.error('File too large (max 10MB)');
    setUploading(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await api.post('/compliance/kyc/documents', {
        docType,
        filename: file.name,
        mimeType: file.type,
        dataBase64,
      });
      toast.success('Document uploaded');
      refresh();
      if (onUpdate) await onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setUploading(false); }
  };

  const status = user?.kycStatus || 'NOT_SUBMITTED';
  const statusClass = {
    APPROVED: 'bg-bull/15 text-bull',
    PENDING: 'bg-warn/15 text-warn',
    REJECTED: 'bg-bear/15 text-bear',
    NOT_SUBMITTED: 'bg-gray-700 text-gray-400',
  }[status];

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-white font-semibold">KYC verification status</h3>
            <p className="text-xs text-gray-400 mt-1">Required to trade on a Live account.</p>
          </div>
          <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusClass}`}>{status.replace('_', ' ')}</span>
        </div>
        {user?.kycRejectionReason && (
          <div className="mt-3 p-3 rounded bg-bear/10 border border-bear/30 text-sm text-bear">
            Rejection reason: {user.kycRejectionReason}
          </div>
        )}
      </div>

      <div className="card p-6 space-y-4">
        <h3 className="text-white font-semibold">Upload document</h3>
        <div>
          <label className="label">Document type</label>
          <select className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="ID_FRONT">ID Card / Passport — Front</option>
            <option value="ID_BACK">ID Card — Back</option>
            <option value="SELFIE">Selfie with ID</option>
            <option value="ADDRESS_PROOF">Address proof (utility bill, bank statement)</option>
          </select>
        </div>
        <div>
          <label className="label">File (JPG, PNG, PDF — max 10MB)</label>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => upload(e.target.files?.[0])}
            disabled={uploading}
            className="block w-full text-sm text-gray-300 file:mr-3 file:py-2 file:px-4 file:rounded file:border-0 file:bg-teal-accent file:text-bg-dark file:font-semibold hover:file:bg-primary-600"
          />
          {uploading && <div className="text-xs text-gray-400 mt-2">Uploading…</div>}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-border-dark">
          <h3 className="text-white font-semibold">Uploaded documents</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-500 bg-bg-dark">
                <th className="text-left py-2 px-4">Type</th>
                <th className="text-left py-2 px-4">Filename</th>
                <th className="text-left py-2 px-4">Uploaded</th>
                <th className="text-left py-2 px-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 && (
                <tr><td colSpan={4} className="text-center py-6 text-gray-500">No documents uploaded</td></tr>
              )}
              {docs.map((d) => (
                <tr key={d._id} className="table-row">
                  <td className="py-2 px-4 text-white">{d.docType.replace('_', ' ')}</td>
                  <td className="py-2 px-4 text-gray-400">{d.originalFilename}</td>
                  <td className="py-2 px-4 text-gray-400">{new Date(d.createdAt).toLocaleString()}</td>
                  <td className="py-2 px-4">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      d.status === 'APPROVED' ? 'bg-bull/15 text-bull' :
                      d.status === 'REJECTED' ? 'bg-bear/15 text-bear' :
                      'bg-warn/15 text-warn'
                    }`}>{d.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const fileToBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(file);
});

// ============== SECURITY (2FA + password) ==============
function SecurityTab({ user, onUpdate }) {
  const [setup, setSetup] = useState(null); // { secret, qrDataUrl }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);

  const init2FA = async () => {
    try { const r = await api.post('/auth/2fa/setup'); setSetup(r.data.data); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  const enable = async () => {
    if (!code) return toast.error('Enter the 6-digit code');
    try {
      const r = await api.post('/auth/2fa/enable', { code });
      setBackupCodes(r.data.data.backupCodes);
      toast.success('2FA enabled. Save your backup codes!');
      setSetup(null);
      setCode('');
      if (onUpdate) await onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const disable = async () => {
    const c = window.prompt('Enter your current 6-digit 2FA code to disable:');
    if (!c) return;
    try {
      await api.post('/auth/2fa/disable', { code: c });
      toast.success('2FA disabled');
      if (onUpdate) await onUpdate();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6">
      <div className="card p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h3 className="text-white font-semibold">Two-Factor Authentication</h3>
            <p className="text-xs text-gray-400 mt-1">Use an authenticator app (Google Authenticator, Authy) for extra security.</p>
          </div>
          {user?.twoFactorEnabled ? (
            <button onClick={disable} className="btn-bear text-sm">Disable 2FA</button>
          ) : (
            <button onClick={init2FA} className="btn-primary text-sm">Enable 2FA</button>
          )}
        </div>

        {setup && !user?.twoFactorEnabled && (
          <div className="mt-6 p-4 rounded bg-bg-dark border border-border-dark space-y-3">
            <p className="text-sm text-gray-300">1. Scan this QR with your authenticator app:</p>
            <img src={setup.qrDataUrl} alt="2FA QR" className="w-48 h-48 mx-auto bg-white p-2 rounded" />
            <p className="text-xs text-gray-400 text-center">Or manually enter: <code className="text-teal-accent">{setup.secret}</code></p>
            <p className="text-sm text-gray-300 mt-4">2. Enter the 6-digit code from your app:</p>
            <div className="flex gap-2">
              <input
                type="text"
                className="input font-mono text-center tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={6}
                placeholder="000000"
              />
              <button onClick={enable} className="btn-primary">Confirm</button>
            </div>
          </div>
        )}

        {backupCodes && (
          <div className="mt-6 p-4 rounded bg-warn/10 border border-warn/30">
            <h4 className="text-warn font-semibold mb-2">⚠️ Save these backup codes</h4>
            <p className="text-xs text-gray-300 mb-3">Each code can be used once if you lose access to your authenticator. They won't be shown again.</p>
            <pre className="bg-bg-dark p-3 rounded text-teal-accent font-mono text-sm">{backupCodes.join('\n')}</pre>
            <button
              onClick={() => { navigator.clipboard.writeText(backupCodes.join('\n')); toast.success('Copied'); }}
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

// ============== DEVICES ==============
function DevicesTab() {
  const [devices, setDevices] = useState([]);
  const refresh = async () => {
    try { const r = await api.get('/auth/devices'); setDevices(r.data.data); }
    catch (e) { /* ignore */ }
  };
  useEffect(() => { refresh(); }, []);

  const revoke = async (id) => {
    if (!confirm('Revoke this session? You will be logged out from that device.')) return;
    try { await api.delete(`/auth/devices/${id}`); toast.success('Session revoked'); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="card p-6">
      <h3 className="text-white font-semibold mb-4">Active sessions</h3>
      {devices.length === 0 ? (
        <div className="text-gray-500 text-sm">No active sessions</div>
      ) : (
        <div className="space-y-2">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center justify-between p-3 rounded bg-bg-dark border border-border-dark">
              <div>
                <div className="text-sm text-white">{d.deviceInfo}</div>
                <div className="text-xs text-gray-500">Created {new Date(d.createdAt).toLocaleString()}</div>
              </div>
              <button onClick={() => revoke(d.id)} className="btn-ghost text-xs text-bear">Revoke</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============== WITHDRAWAL WHITELIST ==============
function WhitelistTab() {
  const [items, setItems] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = async () => {
    try { const r = await api.get('/compliance/whitelist'); setItems(r.data.data); }
    catch (e) { /* ignore */ }
  };
  useEffect(() => { refresh(); }, []);

  const remove = async (id) => {
    if (!confirm('Remove this whitelisted address?')) return;
    try { await api.delete(`/compliance/whitelist/${id}`); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-white font-semibold">Withdrawal whitelist</h3>
          <p className="text-xs text-gray-400 mt-1">Withdrawals can only go to addresses on this list. New entries have a 24h cooldown.</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary text-sm">+ Add address</button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-500 bg-bg-dark">
                <th className="text-left py-2 px-4">Label</th>
                <th className="text-left py-2 px-4">Method</th>
                <th className="text-left py-2 px-4">Currency</th>
                <th className="text-left py-2 px-4">Address / Bank</th>
                <th className="text-left py-2 px-4">Status</th>
                <th className="text-right py-2 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={6} className="text-center py-6 text-gray-500">No whitelisted addresses</td></tr>
              )}
              {items.map((w) => {
                const cooldown = w.activeFrom && new Date(w.activeFrom) > new Date();
                return (
                  <tr key={w._id} className="table-row">
                    <td className="py-2 px-4 text-white">{w.label}</td>
                    <td className="py-2 px-4 text-gray-300">{w.method}</td>
                    <td className="py-2 px-4 text-gray-300">{w.currency}</td>
                    <td className="py-2 px-4 text-gray-400 font-mono text-xs">
                      {w.address || w.bankDetails?.accountNumber || '—'}
                    </td>
                    <td className="py-2 px-4">
                      {cooldown ? (
                        <span className="px-2 py-0.5 rounded text-xs bg-warn/15 text-warn">Cooldown</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-xs bg-bull/15 text-bull">Active</span>
                      )}
                    </td>
                    <td className="py-2 px-4 text-right">
                      <button onClick={() => remove(w._id)} className="btn-ghost text-xs text-bear">Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && <AddWhitelistModal onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refresh(); }} />}
    </div>
  );
}

function AddWhitelistModal({ onClose, onAdded }) {
  const [form, setForm] = useState({
    label: '',
    method: 'CRYPTO',
    currency: 'USDT',
    address: '',
    network: 'TRC20',
  });
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!form.label || (form.method === 'CRYPTO' && !form.address)) {
      return toast.error('Label and address are required');
    }
    setLoading(true);
    try {
      await api.post('/compliance/whitelist', form);
      toast.success('Added. 24h cooldown before first use.');
      onAdded();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-xl border border-border-dark p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">Add whitelisted address</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="label">Label</label>
            <input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. My Coinbase BTC" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Method</label>
              <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                <option value="CRYPTO">Crypto</option>
                <option value="BANK">Bank</option>
              </select>
            </div>
            <div>
              <label className="label">Currency</label>
              <input className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
            </div>
          </div>
          {form.method === 'CRYPTO' ? (
            <>
              <div>
                <label className="label">Address</label>
                <input className="input font-mono text-xs" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div>
                <label className="label">Network</label>
                <select className="input" value={form.network} onChange={(e) => setForm({ ...form, network: e.target.value })}>
                  <option>BTC</option><option>ETH</option><option>TRC20</option><option>ERC20</option><option>BEP20</option>
                </select>
              </div>
            </>
          ) : (
            <div className="text-xs text-gray-400 italic">Bank details collection coming soon — use crypto for now.</div>
          )}
          <div className="flex gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button onClick={submit} disabled={loading} className="btn-primary flex-1">
              {loading ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
