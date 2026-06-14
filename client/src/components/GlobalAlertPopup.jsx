import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useAuthStore } from '../store/auth';

/**
 * Global Alert Popup — a blocking, centered announcement modal shown to the
 * signed-in user. Cannot be dismissed by backdrop click or ESC; the only
 * action is OK, which acknowledges the alert and advances to the next one
 * (Critical → Warning → Info order, server-sorted).
 *
 * Pending alerts are pulled on login, on a 60s poll, on window focus, and
 * instantly when the server publishes an `alerts:refresh` nudge over WebSocket
 * (so a freshly-created alert appears without a re-login).
 */
const PRIORITY = {
  CRITICAL: {
    label: 'Critical',
    ring: 'border-bear/60',
    head: 'bg-bear text-white',
    icon: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  },
  WARNING: {
    label: 'Warning',
    ring: 'border-amber-400/60',
    head: 'bg-amber-500 text-white',
    icon: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  },
  INFO: {
    label: 'Info',
    ring: 'border-primary-500/50',
    head: 'bg-primary-500 text-white',
    icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  },
};

export default function GlobalAlertPopup() {
  const user = useAuthStore((s) => s.user);
  const [alerts, setAlerts] = useState([]);
  const [acking, setAcking] = useState(false);
  // Alerts dismissed in THIS browser session — repeat-display alerts won't
  // re-appear until the next reload, non-repeat ones are also suppressed
  // immediately (before the server ack round-trips).
  const dismissed = useRef(new Set());

  const fetchPending = useCallback(async () => {
    if (!useAuthStore.getState().user) return;
    try {
      const { data } = await api.get('/alerts/pending');
      setAlerts(Array.isArray(data.data) ? data.data : []);
    } catch (_) { /* silent — popups are best-effort */ }
  }, []);

  // Load on auth, poll, focus, and WS nudge.
  useEffect(() => {
    if (!user) { setAlerts([]); dismissed.current = new Set(); return; }
    fetchPending();
    const poll = setInterval(fetchPending, 60000);
    const onFocus = () => fetchPending();
    window.addEventListener('focus', onFocus);
    const unsub = wsClient.subscribe('alerts:refresh', () => fetchPending());
    return () => { clearInterval(poll); window.removeEventListener('focus', onFocus); unsub && unsub(); };
  }, [user, fetchPending]);

  const visible = alerts.filter((a) => !dismissed.current.has(String(a._id)));
  const current = visible[0];

  // Block background scroll while a popup is showing.
  useEffect(() => {
    if (!current) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [current]);

  if (!current) return null;
  const meta = PRIORITY[current.priority] || PRIORITY.INFO;

  const handleOk = async () => {
    if (acking) return;
    setAcking(true);
    const id = String(current._id);
    try { await api.post(`/alerts/${id}/acknowledge`); } catch (_) { /* still dismiss locally */ }
    dismissed.current.add(id);
    // Drop it from the queue so the next alert shows immediately.
    setAlerts((list) => list.filter((a) => String(a._id) !== id));
    setAcking(false);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" style={{ zIndex: 2000 }}>
      <div className={`w-full max-w-md bg-white rounded-2xl shadow-2xl border-2 ${meta.ring} overflow-hidden animate-[fadeIn_120ms_ease-out]`}>
        {/* Header */}
        <div className={`flex items-center gap-2.5 px-5 py-3 ${meta.head}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={meta.icon} />
          </svg>
          <span className="font-bold text-sm uppercase tracking-wide">{meta.label}</span>
          {visible.length > 1 && <span className="ml-auto text-[11px] font-semibold opacity-90">1 of {visible.length}</span>}
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <h3 className="text-lg font-extrabold text-text-primary mb-2 break-words">{current.title}</h3>
          <div
            className="cms-content text-sm text-text-secondary leading-relaxed max-h-[50vh] overflow-y-auto break-words"
            dangerouslySetInnerHTML={{ __html: current.message }}
          />
        </div>

        {/* Footer — OK is the only way out */}
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end">
          <button onClick={handleOk} disabled={acking} className="btn-primary text-sm px-8 disabled:opacity-60">
            {acking ? 'Please wait…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
