import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useAuthStore } from '../store/auth';

/**
 * Global Alert Popup (admin console) — surfaces alerts that target staff roles
 * (Admin / Manager) or specific staff users. Same blocking UX as the client:
 * centered, no backdrop/ESC dismiss, OK acknowledges and advances. Pulls on
 * login, 60s poll, focus, and the `alerts:refresh` WebSocket nudge.
 */
const PRIORITY = {
  CRITICAL: { label: 'Critical', head: 'bg-bear text-white', ring: 'border-bear/60', icon: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' },
  WARNING:  { label: 'Warning',  head: 'bg-amber-500 text-bg-dark', ring: 'border-amber-400/60', icon: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' },
  INFO:     { label: 'Info',     head: 'bg-primary-500 text-bg-dark', ring: 'border-primary-500/50', icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
};

export default function GlobalAlertPopup() {
  const user = useAuthStore((s) => s.user);
  const [alerts, setAlerts] = useState([]);
  const [acking, setAcking] = useState(false);
  const dismissed = useRef(new Set());

  const fetchPending = useCallback(async () => {
    if (!useAuthStore.getState().user) return;
    try {
      const { data } = await api.get('/alerts/pending');
      setAlerts(Array.isArray(data.data) ? data.data : []);
    } catch (_) { /* best-effort */ }
  }, []);

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
    try { await api.post(`/alerts/${id}/acknowledge`); } catch (_) { /* dismiss locally anyway */ }
    dismissed.current.add(id);
    setAlerts((list) => list.filter((a) => String(a._id) !== id));
    setAcking(false);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" style={{ zIndex: 2000 }}>
      <div className={`w-full max-w-md bg-bg-card rounded-2xl shadow-2xl border-2 ${meta.ring} overflow-hidden`}>
        <div className={`flex items-center gap-2.5 px-5 py-3 ${meta.head}`}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={meta.icon} />
          </svg>
          <span className="font-bold text-sm uppercase tracking-wide">{meta.label}</span>
          {visible.length > 1 && <span className="ml-auto text-[11px] font-semibold opacity-90">1 of {visible.length}</span>}
        </div>
        <div className="px-5 py-4">
          <h3 className="text-lg font-extrabold text-white mb-2 break-words">{current.title}</h3>
          <div
            className="text-sm text-text-secondary leading-relaxed max-h-[50vh] overflow-y-auto break-words [&_a]:text-primary-500 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
            dangerouslySetInnerHTML={{ __html: current.message }}
          />
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end">
          <button onClick={handleOk} disabled={acking} className="btn-primary text-sm px-8 disabled:opacity-60">
            {acking ? 'Please wait…' : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
