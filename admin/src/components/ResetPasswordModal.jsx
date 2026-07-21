import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Reset a staff member's login password.
 *   - SuperAdmin can reset any admin/manager.
 *   - Admin can reset only their own managers (server-enforced).
 * Leave the field blank to auto-generate a one-time temp password, which is
 * shown once (with a copy button) after the reset. Resetting logs the staff
 * member out of all active sessions.
 *
 * Props: { staff:{_id,firstName,lastName,email,role}, onClose, onDone }
 */
export default function ResetPasswordModal({ staff, onClose, onDone }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // the now-active password to reveal

  const name = [staff.firstName, staff.lastName].filter(Boolean).join(' ') || staff.email || 'this account';
  const roleLabel = staff.role === 'ADMIN' ? 'Admin' : staff.role === 'MANAGER' ? 'Manager' : staff.role;

  const submit = async () => {
    if (password && password.length < 6) return toast.error('Password must be at least 6 characters');
    setBusy(true);
    try {
      const { data } = await api.post(`/hierarchy/staff/${staff._id}/reset-password`, {
        password: password || undefined,
      });
      // generatedPassword is only returned when we auto-generated one.
      setResult(data.data?.generatedPassword || password);
      toast.success('Password reset · all sessions signed out');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(result); toast.success('Copied'); }
    catch { toast.error('Copy failed — select the text manually'); }
  };

  const close = () => { if (result) onDone?.(); onClose(); };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={close}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Reset password</h3>
          <button onClick={close} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {result ? (
          <div className="p-5 space-y-4 text-sm">
            <p className="text-text-secondary">
              New password for <span className="font-semibold text-text-primary">{name}</span> ({roleLabel}).
              Share it securely — it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-lg bg-bg-hover border border-border-dark font-mono text-text-primary break-all select-all">
                {result}
              </code>
              <button onClick={copy} className="btn-secondary text-xs shrink-0">Copy</button>
            </div>
            <p className="text-[12px] text-warn">⚠ The user has been signed out of all devices and must log in again with this password.</p>
            <div className="flex justify-end">
              <button onClick={close} className="btn-primary text-sm">Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-5 space-y-3 text-sm">
              <p className="text-text-secondary">
                Reset the login password for <span className="font-semibold text-text-primary">{name}</span>
                <span className="text-text-muted"> · {roleLabel}</span>.
              </p>
              <label className="block">
                <div className="label mb-1">New password (optional)</div>
                <input
                  className="input"
                  type="text"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank to auto-generate"
                  autoFocus
                />
              </label>
              <p className="text-[12px] text-text-muted">
                Leaving this blank generates a one-time temporary password shown on the next screen.
                Resetting immediately signs the user out of all active sessions.
              </p>
            </div>
            <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
              <button onClick={close} className="btn-ghost text-sm">Cancel</button>
              <button onClick={submit} disabled={busy} className="btn-primary text-sm disabled:opacity-50">
                {busy ? 'Resetting…' : 'Reset password'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
