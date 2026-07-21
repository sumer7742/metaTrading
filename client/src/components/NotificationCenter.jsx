import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useNotifications, NOTIFICATION_META } from '../hooks/useNotifications';
import CreateAlertModal from './CreateAlertModal';

const TABS = ['All', 'Trading', 'Markets', 'Account'];

// Inline SVG icons keyed by NOTIFICATION_META[type].icon. Kept inline so
// no extra icon library ships.
const ICONS = {
  order:  <path d="M9 11l3 3L22 4M22 12v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />,
  signal: <><path d="M2 12h4" /><path d="M10 7h4" /><path d="M18 2h4" /><path d="M2 18h4" /><path d="M10 13h4" /><path d="M18 8h4" /></>,
  pie:    <><circle cx="12" cy="12" r="10" /><path d="M12 2v10l8 6" /></>,
  bell:   <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></>,
  bolt:   <path d="M13 2L3 14h7l-1 8 10-12h-7z" />,
  filter: <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />,
  user:   <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" /></>,
};

const STATUS_DOT = {
  success: '#16A34A',
  error: '#DC2626',
  warning: '#3B82F6',
  info: '#94A3B8',
};

function relativeTime(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s || 1}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function NotificationIcon({ type }) {
  const meta = NOTIFICATION_META[type] || NOTIFICATION_META.TRADING;
  const path = ICONS[meta.icon] || ICONS.bell;
  return (
    <span
      className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
      style={{ background: `${meta.tint}18`, color: meta.tint }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {path}
      </svg>
    </span>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors text-left"
    >
      <span className="text-[13px] text-text-primary">{label}</span>
      <span
        className={`relative inline-flex w-9 h-5 rounded-full transition-colors shrink-0 ${
          checked ? 'bg-primary-500' : 'bg-border-dark'
        }`}
      >
        <span
          className={`keep-white absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

export default function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('All');
  const [view, setView] = useState('list'); // 'list' | 'prefs'
  const ref = useRef(null);
  const {
    notifications,
    unreadCount,
    prefs,
    markRead,
    markAllRead,
    clear,
    updatePrefs,
  } = useNotifications();

  // Quick "set a price alert" — opens the shared create-alert modal INLINE (no
  // page navigation). Instruments are fetched lazily on first open.
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertInstruments, setAlertInstruments] = useState([]);
  const openAlert = async () => {
    setOpen(false);
    setAlertOpen(true);
    if (!alertInstruments.length) {
      try { const { data } = await api.get('/instruments'); setAlertInstruments(data.data || []); }
      catch (_) { /* modal still opens — symbol list just starts empty */ }
    }
  };

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Reset to list view whenever the dropdown closes.
  useEffect(() => { if (!open) { setView('list'); setTab('All'); } }, [open]);

  // Live-tick the relative timestamps once a minute while open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [open]);

  const filtered = useMemo(() => {
    if (tab === 'All') return notifications;
    return notifications.filter((n) => (NOTIFICATION_META[n.type]?.tab || 'Trading') === tab);
  }, [notifications, tab]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        aria-label="Notifications"
        className="relative p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-primary-500 text-white text-[10px] font-bold leading-none flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-[380px] max-w-[calc(100vw-2rem)] z-50 bg-white border border-border-dark rounded-2xl shadow-elevated overflow-hidden animate-[fadeIn_0.15s_ease-out]"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-text-primary">Notifications</span>
              {unreadCount > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary-500/10 text-primary-600">
                  {unreadCount} new
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {view === 'list' && notifications.length > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-[11px] font-semibold text-primary-600 hover:text-primary-700 px-2 py-1 rounded transition-colors"
                  title="Mark all as read"
                >
                  Mark all read
                </button>
              )}
              <button
                type="button"
                onClick={() => setView((v) => v === 'list' ? 'prefs' : 'list')}
                title={view === 'list' ? 'Notification preferences' : 'Back'}
                className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                {view === 'list' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 0 1 4.21 16.96l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                )}
              </button>
            </div>
          </div>

          {view === 'list' ? (
            <>
              {/* Tabs */}
              <div className="px-2 pt-2 flex items-center gap-1 border-b border-border-subtle">
                {TABS.map((t) => {
                  const isActive = tab === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTab(t)}
                      className={`relative px-3 py-2 text-[12px] font-semibold transition-colors ${
                        isActive ? 'text-primary-600' : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {t}
                      {isActive && <span className="absolute left-2 right-2 -bottom-px h-0.5 bg-primary-500 rounded-full" />}
                    </button>
                  );
                })}
              </div>

              {/* List */}
              <div className="max-h-[420px] overflow-y-auto">
                {filtered.length === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <div className="w-12 h-12 rounded-full bg-bg-hover mx-auto flex items-center justify-center mb-3 text-text-muted">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
                    </div>
                    <p className="text-sm font-semibold text-text-primary">You're all caught up</p>
                    <p className="text-xs text-text-muted mt-1">
                      {tab === 'All' ? 'New alerts will appear here.' : `No ${tab.toLowerCase()} notifications yet.`}
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y divide-border-subtle">
                    {filtered.map((n) => {
                      const meta = NOTIFICATION_META[n.type] || NOTIFICATION_META.TRADING;
                      const Wrapper = n.link ? Link : 'div';
                      const wrapperProps = n.link
                        ? { to: n.link, onClick: () => { markRead(n.id); setOpen(false); } }
                        : { onClick: () => markRead(n.id) };
                      return (
                        <li key={n.id}>
                          <Wrapper
                            {...wrapperProps}
                            className={`flex items-start gap-3 px-4 py-3 hover:bg-bg-hover transition-colors cursor-pointer ${
                              !n.read ? 'bg-primary-500/[0.04]' : ''
                            }`}
                          >
                            <NotificationIcon type={n.type} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: meta.tint }}>
                                  {meta.label}
                                </span>
                                <span
                                  className="w-1.5 h-1.5 rounded-full mt-1 shrink-0"
                                  style={{ background: STATUS_DOT[n.status] || STATUS_DOT.info }}
                                />
                              </div>
                              <div className="text-sm font-semibold text-text-primary mt-0.5 truncate">{n.title}</div>
                              {n.message && (
                                <div className="text-xs text-text-secondary mt-0.5 line-clamp-2">{n.message}</div>
                              )}
                              <div className="text-[10px] text-text-muted mt-1.5 tabular-nums">{relativeTime(n.timestamp)}</div>
                            </div>
                            {!n.read && (
                              <span className="w-2 h-2 rounded-full bg-primary-500 mt-2 shrink-0" />
                            )}
                          </Wrapper>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Footer — quick "set a price alert" (always) + clear all */}
              <div className="border-t border-border-subtle flex items-stretch divide-x divide-border-subtle">
                <button
                  type="button"
                  onClick={openAlert}
                  className="flex-1 px-4 py-2.5 text-[12px] font-semibold text-primary-600 hover:text-primary-700 hover:bg-bg-hover transition-colors flex items-center justify-center gap-1.5"
                  title="Set a price alert"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  + Price alert
                </button>
                {notifications.length > 0 && (
                  <button
                    type="button"
                    onClick={clear}
                    className="flex-1 px-4 py-2.5 text-[12px] font-semibold text-text-secondary hover:text-bear hover:bg-bg-hover transition-colors"
                  >
                    Clear all
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Preferences pane */}
              <div className="px-4 py-3 border-b border-border-subtle">
                <div className="text-[11px] uppercase tracking-wider font-bold text-text-muted">Channels</div>
              </div>
              <Toggle
                checked={prefs.enableTrading}
                onChange={(v) => updatePrefs({ enableTrading: v })}
                label="Trading (orders, positions, portfolio)"
              />
              <Toggle
                checked={prefs.enableMarkets}
                onChange={(v) => updatePrefs({ enableMarkets: v })}
                label="Markets (price, volatility, screener)"
              />
              <Toggle
                checked={prefs.enableAccount}
                onChange={(v) => updatePrefs({ enableAccount: v })}
                label="Account (wallet, security)"
              />
            </>
          )}
        </div>
      )}

      {alertOpen && (
        <CreateAlertModal
          instruments={alertInstruments}
          onClose={() => setAlertOpen(false)}
          onCreated={() => setAlertOpen(false)}
        />
      )}
    </div>
  );
}
