import { useState } from 'react';
import { api } from '../services/api';
import { isImpersonating, getImpersonationInfo, clearImpersonation } from '../services/impersonation';

/**
 * Fixed READ-ONLY banner shown across the whole app while an admin is in a
 * "View As User" impersonation session. Provides the only exit: Return to
 * Admin. Renders nothing for a normal user session.
 */
export default function ImpersonationBanner() {
  const [leaving, setLeaving] = useState(false);
  if (!isImpersonating()) return null;
  const info = getImpersonationInfo();

  const returnToAdmin = async () => {
    if (leaving) return;
    setLeaving(true);
    // Best-effort: tell the backend to close + audit the session (this one
    // POST is allow-listed for the impersonation token).
    try { await api.post('/auth/impersonation/end'); } catch (_) { /* ignore */ }
    clearImpersonation();
    // Back to the admin app (same origin, served under /admin/). The admin's
    // own session in localStorage is untouched, so no re-login is needed.
    window.location.href = '/admin/';
  };

  return (
    <div
      className="fixed top-0 inset-x-0 z-[9999] flex items-center gap-3 px-4 py-2.5 text-white shadow-lg"
      style={{ background: 'linear-gradient(90deg,#B45309,#92400E)' }}
      role="alert"
    >
      <span className="text-lg leading-none" aria-hidden>🔒</span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[13px] font-extrabold tracking-wide">VIEWING USER ACCOUNT (READ ONLY)</div>
        <div className="text-[11px] opacity-90 truncate">
          You are impersonating{info?.email ? ` ${info.email}` : ' this user'}. All actions are disabled.
        </div>
      </div>
      <button
        type="button"
        onClick={returnToAdmin}
        disabled={leaving}
        className="shrink-0 text-xs font-bold px-3.5 py-2 rounded-lg bg-white/15 hover:bg-white/25 border border-white/30 transition-colors disabled:opacity-60"
      >
        {leaving ? 'Returning…' : '← Return to Admin'}
      </button>
    </div>
  );
}
