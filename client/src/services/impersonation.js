/**
 * Read-only "View As User" impersonation (client side).
 *
 * An admin opens the client app at `/#imp=<token>`. We capture that token
 * on first load, stash it in sessionStorage (TAB-SCOPED — so it can't leak
 * into or clobber a real login in another tab, and dies when the tab
 * closes), then strip it from the URL so it isn't bookmarked/shared.
 *
 * While a session is active:
 *   - api.js sends THIS token (not localStorage) on every request,
 *   - api.js blocks every mutating method (POST/PUT/PATCH/DELETE),
 *   - a fixed READ-ONLY banner is shown.
 *
 * The real server-side guard lives in the backend auth middleware; this is
 * the UX + defence-in-depth layer.
 */
const KEY = 'impersonationToken';
const INFO = 'impersonationInfo';

// Capture `#imp=<token>` (optionally `&info=<base64 json>`) once on load.
(function captureFromHash() {
  try {
    const hash = window.location.hash || '';
    const m = hash.match(/[#&]imp=([^&]+)/);
    if (m) {
      sessionStorage.setItem(KEY, decodeURIComponent(m[1]));
      const im = hash.match(/[#&]info=([^&]+)/);
      if (im) sessionStorage.setItem(INFO, decodeURIComponent(im[1]));
      // Strip the token from the visible URL (keep history clean / unbookmarkable).
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', clean);
    }
  } catch (_) { /* sessionStorage blocked → impersonation simply won't engage */ }
})();

export const isImpersonating = () => {
  try { return !!sessionStorage.getItem(KEY); } catch { return false; }
};

export const getImpersonationToken = () => {
  try { return sessionStorage.getItem(KEY) || null; } catch { return null; }
};

export const getImpersonationInfo = () => {
  try {
    const raw = sessionStorage.getItem(INFO);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

// Methods that change state — blocked entirely during impersonation.
export const isMutatingMethod = (method) =>
  !['get', 'head', 'options'].includes(String(method || 'get').toLowerCase());

// Clear the local session (used by "Return to Admin").
export const clearImpersonation = () => {
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(INFO); } catch { /* ignore */ }
};
