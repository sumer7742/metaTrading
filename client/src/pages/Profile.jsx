import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { useAuthStore } from '../store/auth';
import { useConfirm } from '../components/ConfirmProvider';
import PasswordInput from '../components/PasswordInput';

const VALID_TABS = new Set(['profile', 'kyc', 'security', 'devices']);

// Shared password policy (mirrors the backend util) — used by the change-
// password checklist.
const PASSWORD_RULES = [
  { test: (p) => p.length >= 8,          label: 'At least 8 characters' },
  { test: (p) => /[A-Z]/.test(p),        label: 'One uppercase letter' },
  { test: (p) => /[a-z]/.test(p),        label: 'One lowercase letter' },
  { test: (p) => /[0-9]/.test(p),        label: 'One number' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), label: 'One special character' },
];

// Show a friendly country name from a stored ISO-2 code (e.g. "IN" → "India").
// Falls back to the raw value when it's already a full name or an unknown code.
const countryName = (code) => {
  if (!code) return '—';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(String(code).toUpperCase()) || code;
  } catch {
    return code;
  }
};

export default function Profile() {
  const { user, refreshUser } = useAuthStore();
  const [params, setParams] = useSearchParams();
  const initial = params.get('tab');
  const [tab, _setTab] = useState(VALID_TABS.has(initial) ? initial : 'profile');
  const setTab = (next) => {
    _setTab(next);
    const np = new URLSearchParams(params);
    if (next === 'profile') np.delete('tab'); else np.set('tab', next);
    setParams(np, { replace: true });
  };

  const initials = useMemo(() => {
    const f = (user?.firstName || '').trim();
    const l = (user?.lastName || '').trim();
    if (f || l) return `${f[0] || ''}${l[0] || ''}`.toUpperCase();
    return (user?.email || '?')[0].toUpperCase();
  }, [user?.firstName, user?.lastName, user?.email]);

  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
    : '—';

  const tabs = [
    { id: 'profile',  label: 'Profile',           icon: IconUser },
    { id: 'kyc',      label: 'KYC Verification',  icon: IconShieldCheck },
    { id: 'security', label: 'Security',          icon: IconLock },
    { id: 'devices',  label: 'Active Sessions',   icon: IconMonitor },
  ];

  return (
    <div className="space-y-6 max-w-[1100px] mx-auto pb-10">
      {/* ── Hero ────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-border-dark bg-gradient-to-br from-white via-bg-card to-primary-500/5 p-6 sm:p-8 shadow-card">
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(15,23,42,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.6) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
        <div
          className="absolute -top-24 -right-24 w-72 h-72 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(29,78,216,0.18), transparent 60%)' }}
        />

        <div className="relative flex items-start gap-5 flex-wrap">
          {/* Avatar with gradient halo */}
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary-500/30 to-primary-500/0 blur-xl scale-110" />
            <div
              className="relative w-20 h-20 rounded-2xl flex items-center justify-center text-2xl font-extrabold text-white shadow-lg"
              style={{ background: 'linear-gradient(135deg, #1D4ED8 0%, #4F46E5 100%)' }}
            >
              {initials}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-[0.25em] font-bold text-primary-600 mb-1.5 flex items-center gap-2">
              <span className="w-6 h-px bg-primary-500" />
              Account
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-text-primary tracking-tight">
              {(user?.firstName || user?.lastName)
                ? `${user?.firstName || ''} ${user?.lastName || ''}`.trim()
                : 'Welcome back'}
            </h1>
            <div className="text-sm text-text-secondary mt-1 truncate">{user?.email || '—'}</div>

            {/* Permanent public User ID — prominent + copyable */}
            {user?.userUid && (
              <button
                type="button"
                onClick={() => { navigator.clipboard.writeText(user.userUid); toast.success('User ID copied'); }}
                title="Copy your User ID"
                className="mt-3 inline-flex items-center gap-2.5 rounded-xl border border-primary-500/30 bg-primary-500/5 pl-3 pr-2.5 py-1.5 hover:border-primary-500/60 hover:bg-primary-500/10 transition-colors group/uid"
              >
                <span className="text-[10px] uppercase tracking-[0.15em] font-bold text-text-muted">User ID</span>
                <span className="font-mono font-extrabold text-primary-600 text-sm tracking-wide">{user.userUid}</span>
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-text-muted group-hover/uid:text-primary-600 transition-colors">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  Copy
                </span>
              </button>
            )}

            {/* Status chips */}
            <div className="flex flex-wrap items-center gap-1.5 mt-4">
              <StatusPill
                active={!!user?.isEmailVerified}
                activeLabel="Email verified"
                inactiveLabel="Email unverified"
                icon={IconCheck}
              />
              <KycPill status={user?.kycStatus || 'NOT_SUBMITTED'} />
              <StatusPill
                active={!!user?.twoFactorEnabled}
                activeLabel="2FA on"
                inactiveLabel="2FA off"
                icon={IconLock}
              />
              {user?.referralCode && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-bg-hover text-text-secondary border border-border-subtle">
                  <IconGift className="w-3 h-3" />
                  Code <span className="font-mono text-primary-600">{user.referralCode}</span>
                </span>
              )}
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-text-muted">Member since</div>
            <div className="text-sm font-bold text-text-primary mt-1">{memberSince}</div>
          </div>
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────── */}
      <div className="card p-1.5 overflow-x-auto no-scrollbar">
        <div className="flex gap-1 min-w-max">
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-all ${
                  active
                    ? 'bg-primary-500 text-white shadow-[0_4px_12px_rgba(29,78,216,0.25)]'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                <Icon className="w-4 h-4" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'profile'  && <ProfileTab  user={user} onUpdate={refreshUser} />}
      {tab === 'kyc'      && <KycTab      user={user} onUpdate={refreshUser} />}
      {tab === 'security' && <SecurityTab user={user} onUpdate={refreshUser} />}
      {tab === 'devices'  && <DevicesTab />}
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
  const [resendCooldown, setResendCooldown] = useState(0);
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const dirty =
    form.firstName !== (user?.firstName || '') ||
    form.lastName  !== (user?.lastName  || '') ||
    form.phone     !== (user?.phone     || '');

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
    if (resendCooldown > 0) return;
    try {
      await api.post('/auth/resend-verification');
      toast.success('Verification email sent');
      setResendCooldown(30);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-5">
      {/* Email + verification */}
      <SectionCard
        icon={IconMail}
        title="Email address"
        subtitle="Used for sign-in, security alerts, and trade notifications."
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="font-mono text-sm font-bold text-text-primary truncate">{user?.email}</div>
          {user?.isEmailVerified ? (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bull/10 text-bull text-xs font-bold border border-bull/20">
              <IconCheck className="w-3.5 h-3.5" />
              Verified
            </span>
          ) : (
            <button
              onClick={resendVerify}
              disabled={resendCooldown > 0}
              className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend verification'}
            </button>
          )}
        </div>
      </SectionCard>

      {/* Referral */}
      <SectionCard
        icon={IconGift}
        title="Referral"
        subtitle="Track who invited you and share your code to earn commissions."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InfoBlock label="Referred by">
            {user?.referredBy ? (
              <div>
                <div className="font-semibold text-text-primary text-sm">
                  {(user.referredBy.firstName || user.referredBy.lastName)
                    ? `${user.referredBy.firstName || ''} ${user.referredBy.lastName || ''}`.trim()
                    : (user.referredBy.email || 'Anonymous referrer')}
                </div>
                {user.referredBy.referralCode && (
                  <div className="text-[11px] font-mono text-text-muted mt-0.5">
                    Code <span className="text-primary-600 font-bold">{user.referredBy.referralCode}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-text-muted text-sm">Signed up directly</div>
            )}
          </InfoBlock>
          <InfoBlock label="Your code">
            {user?.referralCode ? (
              <div className="flex items-center gap-2">
                <span className="font-mono font-extrabold text-primary-600 text-base">{user.referralCode}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(user.referralCode); toast.success('Code copied'); }}
                  className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-primary-500/10 text-primary-600 hover:bg-primary-500/15 transition-colors"
                >
                  Copy
                </button>
              </div>
            ) : (
              <div className="text-text-muted text-sm">—</div>
            )}
          </InfoBlock>
        </div>
      </SectionCard>

      {/* Personal info */}
      <SectionCard
        icon={IconUser}
        title="Personal information"
        subtitle="Your legal name should match KYC documents."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="First name">
            <input
              className="input"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              placeholder="First name"
            />
          </Field>
          <Field label="Last name">
            <input
              className="input"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              placeholder="Last name"
            />
          </Field>
          <Field label="Phone">
            <input
              className="input"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="+91 98xxxxxxxx"
            />
          </Field>
          <Field label="Country">
            <input
              className="input opacity-70 cursor-not-allowed"
              value={countryName(user?.country)}
              disabled
              title="Set at registration / KYC"
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-3 pt-2 mt-2 border-t border-border-subtle">
          <span className={`text-[11px] font-semibold ${dirty ? 'text-warn' : 'text-text-muted'}`}>
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

// ============== KYC ==============
function KycTab({ user, onUpdate }) {
  const [docs, setDocs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [docType, setDocType] = useState('ID_FRONT');
  const [dragOver, setDragOver] = useState(false);

  const refresh = async () => {
    try { const r = await api.get('/compliance/kyc/documents'); setDocs(r.data.data); }
    catch (_) { /* ignore */ }
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

  const rawStatus = user?.kycStatus || 'NOT_SUBMITTED';
  // If documents are on file but the account status hasn't flipped yet (legacy
  // accounts uploaded under the old "needs 2 docs" rule), treat it as PENDING —
  // a submitted document IS under review.
  const hasReviewableDocs = docs.some((d) => d.status !== 'REJECTED');
  const status = rawStatus === 'NOT_SUBMITTED' && hasReviewableDocs ? 'PENDING' : rawStatus;
  const statusMeta = {
    APPROVED:      { color: 'bull',  bg: 'bg-bull/10  border-bull/20',  text: 'text-bull',  desc: 'Your identity is verified. You have full trading access.' },
    PENDING:       { color: 'warn',  bg: 'bg-warn/10  border-warn/20',  text: 'text-warn',  desc: 'We are reviewing your documents. This usually takes 1-2 business days.' },
    REJECTED:      { color: 'bear',  bg: 'bg-bear/10  border-bear/20',  text: 'text-bear',  desc: 'Your submission was rejected. Please re-upload corrected documents.' },
    NOT_SUBMITTED: { color: 'muted', bg: 'bg-bg-hover border-border-subtle', text: 'text-text-muted', desc: 'Verify your identity to unlock Live trading and withdrawals.' },
  }[status];

  return (
    <div className="space-y-5">
      {/* Status banner */}
      <div className={`rounded-2xl border ${statusMeta.bg} p-5 sm:p-6`}>
        <div className="flex items-start gap-4">
          <div className={`shrink-0 w-12 h-12 rounded-xl flex items-center justify-center bg-white border border-border-subtle ${statusMeta.text}`}>
            <IconShieldCheck className="w-6 h-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-extrabold text-text-primary text-base">KYC Verification</h3>
              <span className={`text-[10px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded-full ${statusMeta.text} bg-white border border-current/20`}>
                {status.replace('_', ' ')}
              </span>
            </div>
            <p className="text-sm text-text-secondary mt-1">{statusMeta.desc}</p>
            {user?.kycRejectionReason && (
              <div className="mt-3 p-3 rounded-lg bg-white border border-bear/30 text-sm text-bear">
                <span className="font-bold">Rejection reason: </span>{user.kycRejectionReason}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Upload */}
      <SectionCard
        icon={IconUpload}
        title="Upload document"
        subtitle="JPG, PNG, or PDF — max 10MB per file."
      >
        <Field label="Document type">
          <select className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="ID_FRONT">ID Card / Passport — Front</option>
            <option value="ID_BACK">ID Card — Back</option>
            <option value="SELFIE">Selfie with ID</option>
            <option value="ADDRESS_PROOF">Address proof (utility bill, bank statement)</option>
          </select>
        </Field>

        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) upload(f);
          }}
          className={`relative block mt-3 rounded-xl border-2 border-dashed transition-all cursor-pointer ${
            dragOver
              ? 'border-primary-500 bg-primary-500/5'
              : 'border-border-dark bg-bg-hover/30 hover:border-primary-500/50 hover:bg-primary-500/[0.02]'
          } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => upload(e.target.files?.[0])}
            disabled={uploading}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
          <div className="px-4 py-8 text-center">
            <div className="mx-auto w-12 h-12 rounded-xl bg-primary-500/10 text-primary-600 flex items-center justify-center mb-3">
              <IconUpload className="w-6 h-6" />
            </div>
            <div className="text-sm font-bold text-text-primary">
              {uploading ? 'Uploading…' : 'Drop file here or click to browse'}
            </div>
            <div className="text-xs text-text-muted mt-1">Max 10MB · JPG, PNG, PDF</div>
          </div>
        </label>
      </SectionCard>

      {/* Documents list */}
      <SectionCard
        icon={IconFolder}
        title="Uploaded documents"
        subtitle={`${docs.length} document${docs.length === 1 ? '' : 's'} on file`}
        padded={false}
      >
        {docs.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <div className="mx-auto w-12 h-12 rounded-xl bg-bg-hover text-text-muted flex items-center justify-center mb-3">
              <IconFolder className="w-6 h-6" />
            </div>
            <div className="text-sm text-text-muted">No documents uploaded yet</div>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {docs.map((d) => (
              <div key={d._id} className="flex items-center gap-3 px-5 py-3 hover:bg-bg-hover transition-colors">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-primary-500/10 text-primary-600 flex items-center justify-center">
                  <IconFile className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-text-primary truncate">
                    {d.docType.replace('_', ' ')}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">
                    {d.originalFilename} · {new Date(d.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <span className={`shrink-0 text-[10px] uppercase tracking-wider font-extrabold px-2 py-1 rounded ${
                  d.status === 'APPROVED' ? 'bg-bull/10 text-bull' :
                  d.status === 'REJECTED' ? 'bg-bear/10 text-bear' :
                  'bg-warn/10 text-warn'
                }`}>{d.status}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

const fileToBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(file);
});

// ============== CHANGE PASSWORD ==============
function ChangePasswordCard() {
  const [cur, setCur] = useState('');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const rulesPass = PASSWORD_RULES.every((r) => r.test(pwd));
  const match = pwd && pwd === confirm;

  const submit = async (e) => {
    e.preventDefault();
    if (!cur) return toast.error('Enter your current password');
    if (!rulesPass) return toast.error('New password does not meet all requirements');
    if (!match) return toast.error('Passwords do not match');
    setLoading(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: cur,
        newPassword: pwd,
        // Keep THIS session alive; sign out other devices.
        keepRefreshToken: localStorage.getItem('refreshToken') || undefined,
      });
      toast.success('Password changed. Other devices have been signed out.');
      setCur(''); setPwd(''); setConfirm('');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SectionCard icon={IconLock} title="Password" subtitle="Change your account password.">
      <form onSubmit={submit} className="space-y-4 max-w-md">
        <Field label="Current password">
          <PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" placeholder="Current password" />
        </Field>
        <Field label="New password">
          <PasswordInput value={pwd} onChange={(e) => setPwd(e.target.value)} autoComplete="new-password" placeholder="New password" minLength={8} maxLength={128} />
        </Field>

        <ul className="space-y-1">
          {PASSWORD_RULES.map((r) => {
            const ok = r.test(pwd);
            return (
              <li key={r.label} className={`flex items-center gap-2 text-[12px] ${ok ? 'text-bull' : 'text-text-muted'}`}>
                <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${ok ? 'bg-bull/15' : 'bg-bg-hover'}`}>
                  {ok ? <IconCheck className="w-3 h-3" /> : <span className="w-1 h-1 rounded-full bg-text-muted" />}
                </span>
                {r.label}
              </li>
            );
          })}
        </ul>

        <Field label="Confirm new password">
          <PasswordInput
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            placeholder="Re-enter new password"
            aria-invalid={confirm && !match ? true : undefined}
          />
          {confirm && !match && <p className="mt-1 text-[11px] text-bear font-semibold">Passwords do not match</p>}
        </Field>

        <button type="submit" disabled={loading || !cur || !rulesPass || !match} className="btn-primary">
          {loading ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </SectionCard>
  );
}

// ============== SECURITY ==============
function SecurityTab({ user, onUpdate }) {
  const [setup, setSetup] = useState(null);
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
    <div className="space-y-5">
      {/* Change password */}
      <ChangePasswordCard />

      {/* 2FA card */}
      <SectionCard
        icon={IconLock}
        title="Two-Factor Authentication"
        subtitle="Add an extra layer of security with an authenticator app."
        action={
          user?.twoFactorEnabled ? (
            <button onClick={disable} className="btn-bear text-sm">Disable</button>
          ) : !setup ? (
            <button onClick={init2FA} className="btn-primary text-sm">Enable 2FA</button>
          ) : null
        }
      >
        {/* Status banner */}
        <div className={`flex items-center gap-3 p-3 rounded-lg border ${
          user?.twoFactorEnabled
            ? 'bg-bull/10 border-bull/20'
            : 'bg-warn/10 border-warn/20'
        }`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center bg-white ${
            user?.twoFactorEnabled ? 'text-bull' : 'text-warn'
          }`}>
            {user?.twoFactorEnabled ? <IconCheck className="w-4 h-4" /> : <IconWarn className="w-4 h-4" />}
          </div>
          <div className="text-sm">
            <div className={`font-bold ${user?.twoFactorEnabled ? 'text-bull' : 'text-warn'}`}>
              {user?.twoFactorEnabled ? '2FA is active' : '2FA is not enabled'}
            </div>
            <div className="text-text-secondary text-[12px]">
              {user?.twoFactorEnabled
                ? 'Your account is protected by a second authentication factor.'
                : 'Enable 2FA to protect your account from unauthorized access.'}
            </div>
          </div>
        </div>

        {/* Setup wizard */}
        {setup && !user?.twoFactorEnabled && (
          <div className="mt-4 rounded-xl border border-border-dark bg-bg-hover/30 p-5 space-y-4">
            <StepRow
              step={1}
              title="Scan with your authenticator app"
              desc="Use Google Authenticator, Authy, or 1Password."
            >
              <div className="flex flex-col sm:flex-row items-center gap-4 mt-3">
                <img src={setup.qrDataUrl} alt="2FA QR" className="w-40 h-40 bg-white p-2 rounded-xl border border-border-dark" />
                <div className="text-center sm:text-left">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">Or enter manually</div>
                  <code className="block mt-1 px-3 py-2 rounded-lg bg-white border border-border-dark text-primary-600 font-mono text-xs break-all">
                    {setup.secret}
                  </code>
                  <button
                    onClick={() => { navigator.clipboard.writeText(setup.secret); toast.success('Secret copied'); }}
                    className="mt-2 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded bg-primary-500/10 text-primary-600 hover:bg-primary-500/15 transition-colors"
                  >
                    Copy secret
                  </button>
                </div>
              </div>
            </StepRow>

            <StepRow
              step={2}
              title="Enter the 6-digit code from the app"
            >
              <div className="flex gap-2 mt-3">
                <input
                  type="text"
                  inputMode="numeric"
                  className="input font-mono text-center tracking-[0.5em] text-lg font-bold"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  placeholder="000000"
                />
                <button onClick={enable} className="btn-primary shrink-0">Confirm</button>
              </div>
            </StepRow>
          </div>
        )}

        {/* Backup codes display */}
        {backupCodes && (
          <div className="mt-4 rounded-xl bg-warn/10 border border-warn/30 p-5">
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-white text-warn flex items-center justify-center">
                <IconWarn className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h4 className="text-warn font-extrabold text-sm">Save these backup codes</h4>
                <p className="text-xs text-text-secondary mt-1">
                  Each code can be used once if you lose access to your authenticator. They won't be shown again.
                </p>
                <pre className="mt-3 bg-white border border-border-dark rounded-lg p-3 text-primary-600 font-mono text-xs grid grid-cols-2 gap-1">
                  {backupCodes.map((c) => <span key={c}>{c}</span>)}
                </pre>
                <button
                  onClick={() => { navigator.clipboard.writeText(backupCodes.join('\n')); toast.success('Copied'); }}
                  className="btn-secondary text-sm mt-3"
                >
                  Copy all codes
                </button>
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ============== DEVICES ==============
function DevicesTab() {
  const confirm = useConfirm();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    try { const r = await api.get('/auth/devices'); setDevices(r.data.data); }
    catch (_) { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);

  const revoke = async (id) => {
    if (!(await confirm('Revoke this session? You will be logged out from that device.'))) return;
    try { await api.delete(`/auth/devices/${id}`); toast.success('Session revoked'); refresh(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <SectionCard
      icon={IconMonitor}
      title="Active sessions"
      subtitle={loading ? 'Loading…' : `${devices.length} active session${devices.length === 1 ? '' : 's'}`}
      padded={false}
    >
      {loading ? (
        <div className="px-5 py-8 text-center text-text-muted text-sm">Loading sessions…</div>
      ) : devices.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-bg-hover text-text-muted flex items-center justify-center mb-3">
            <IconMonitor className="w-6 h-6" />
          </div>
          <div className="text-sm text-text-muted">No active sessions</div>
        </div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-5 py-3 hover:bg-bg-hover transition-colors">
              <div className="shrink-0 w-9 h-9 rounded-lg bg-primary-500/10 text-primary-600 flex items-center justify-center">
                <IconMonitor className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-text-primary truncate">{d.deviceInfo || 'Unknown device'}</div>
                <div className="text-[11px] text-text-muted">Created {new Date(d.createdAt).toLocaleString()}</div>
              </div>
              <button
                onClick={() => revoke(d.id)}
                className="shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded text-bear hover:bg-bear/10 transition-colors"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ============== PRIMITIVES ==============
function SectionCard({ icon: Icon, title, subtitle, action, children, padded = true }) {
  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-border-subtle flex items-center gap-3">
        {Icon && (
          <div className="shrink-0 w-9 h-9 rounded-lg bg-primary-500/10 text-primary-600 flex items-center justify-center">
            <Icon className="w-4 h-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-extrabold text-text-primary text-sm">{title}</h3>
          {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={padded ? 'p-5 space-y-4' : ''}>{children}</div>
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function InfoBlock({ label, children }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-hover/40 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function StatusPill({ active, activeLabel, inactiveLabel, icon: Icon }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
      active
        ? 'bg-bull/10 text-bull border-bull/20'
        : 'bg-bear/10 text-bear border-bear/20'
    }`}>
      <Icon className="w-3 h-3" />
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

function KycPill({ status }) {
  const map = {
    APPROVED:      { c: 'bull', l: 'KYC verified'   },
    PENDING:       { c: 'warn', l: 'KYC pending'    },
    REJECTED:      { c: 'bear', l: 'KYC rejected'   },
    NOT_SUBMITTED: { c: 'muted', l: 'KYC not started'},
  }[status];
  const cls = {
    bull:  'bg-bull/10 text-bull border-bull/20',
    warn:  'bg-warn/10 text-warn border-warn/20',
    bear:  'bg-bear/10 text-bear border-bear/20',
    muted: 'bg-bg-hover text-text-secondary border-border-subtle',
  }[map.c];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${cls}`}>
      <IconShieldCheck className="w-3 h-3" />
      {map.l}
    </span>
  );
}

function StepRow({ step, title, desc, children }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-7 h-7 rounded-full bg-primary-500 text-white flex items-center justify-center font-extrabold text-xs">
        {step}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-text-primary">{title}</div>
        {desc && <div className="text-xs text-text-muted mt-0.5">{desc}</div>}
        {children}
      </div>
    </div>
  );
}

// ============== ICONS ==============
const Svg = ({ className = 'w-4 h-4', children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    {children}
  </svg>
);
const IconUser        = (p) => <Svg {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>;
const IconShieldCheck = (p) => <Svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></Svg>;
const IconLock        = (p) => <Svg {...p}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></Svg>;
const IconMonitor     = (p) => <Svg {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></Svg>;
const IconCheck       = (p) => <Svg {...p}><polyline points="20 6 9 17 4 12" /></Svg>;
const IconWarn        = (p) => <Svg {...p}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></Svg>;
const IconMail        = (p) => <Svg {...p}><rect x="2" y="4" width="20" height="16" rx="2" /><polyline points="22,6 12,13 2,6" /></Svg>;
const IconGift        = (p) => <Svg {...p}><polyline points="20 12 20 22 4 22 4 12" /><rect x="2" y="7" width="20" height="5" /><line x1="12" y1="22" x2="12" y2="7" /><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" /><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" /></Svg>;
const IconUpload      = (p) => <Svg {...p}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></Svg>;
const IconFolder      = (p) => <Svg {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></Svg>;
const IconFile        = (p) => <Svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></Svg>;
