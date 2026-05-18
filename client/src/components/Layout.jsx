import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { useThemeStore } from '../store/theme';
import SearchModal from './SearchModal';
import InstrumentStrip from './InstrumentStrip';
import NotificationCenter from './NotificationCenter';
import { api } from '../services/api';
import { wsClient } from '../services/ws';
import { useFxRate } from '../hooks/useFxRate';
import { fmtNum } from '../utils/format';

// Inline SVG icons — kept inline so we don't pull in another icon library.
const Icon = ({ d, size = 18, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);
const I = {
  search:   <Icon d={['M21 21l-4.35-4.35', 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z']} />,
  bell:     <Icon d={['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0']} />,
  chevron:  <Icon d="M6 9l6 6 6-6" />,
  wallet:   <Icon d={['M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1', 'M16 12h4']} />,
  reports:  <Icon d={['M9 12h6', 'M9 16h6', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']} />,
  help:     <Icon d={['M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z', 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3', 'M12 17h.01']} />,
  settings: <Icon d={['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z']} />,
  logout:   <Icon d={['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9']} />,
  user:     <Icon d={['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']} />,
  menu:     <Icon d={['M3 12h18', 'M3 6h18', 'M3 18h18']} />,
  close:    <Icon d={['M18 6L6 18', 'M6 6l12 12']} />,
};

// Primary top-nav categories — sit in the brand header.
const PRIMARY_NAV = [
  { to: '/explore', label: 'Explore' },
  { to: '/dashboard', label: 'Portfolio' },
  { to: '/wallet', label: 'Wallets' },
  { to: '/reports', label: 'Reports' },
];

// Secondary nav was removed — these destinations now live in Explore's
// "Products & Tools" section instead. Kept as an empty array so the
// mobile flyout spread (`...SECONDARY_NAV`) and any other consumers
// don't need a conditional.
const SECONDARY_NAV = [];

export default function Layout({ children }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const profileRef = useRef(null);
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);

  // Click-outside for the profile menu — keeps the dropdown lightweight
  // without bringing in a popover library.
  useEffect(() => {
    if (!profileOpen) return;
    const onDoc = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [profileOpen]);

  // Collapse menus on route change so the menu doesn't linger after nav.
  useEffect(() => {
    setProfileOpen(false);
    setMobileOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // Global ⌘/Ctrl+K to open the search modal. "/" also opens unless the user
  // is typing in a real input — matches Groww/GitHub/Linear muscle memory.
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === '/' && !mod) {
        const tag = (e.target?.tagName || '').toLowerCase();
        const isEditable = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
        if (!isEditable) {
          e.preventDefault();
          setSearchOpen(true);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const initials = (fullName || 'T').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  // Total REAL balance — sums the live free balance across every REAL
  // account the user owns (DEMO/VIRTUAL excluded). Re-fetched on any
  // 'wallet' WS event so deposits/withdrawals propagate to the chip in
  // real time. Currency is taken from the first REAL account; if you
  // have REAL accounts in mixed currencies this still shows the sum
  // (assumes the accountant view is roughly base-currency normalised).
  const [realBalance, setRealBalance] = useState(null);
  const [realCurrency, setRealCurrency] = useState('USD');
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data: ad } = await api.get('/user/accounts');
        const accounts = (ad?.data || []).filter((a) => String(a.accountType).toUpperCase() === 'REAL');
        if (!accounts.length) {
          if (!cancelled) { setRealBalance(0); setRealCurrency('USD'); }
          return;
        }
        const results = await Promise.allSettled(
          accounts.map((a) => api.get('/wallet/balances', { params: { accountId: a._id } }))
        );
        if (cancelled) return;
        let total = 0;
        let ccy = accounts[0].baseCurrency || 'USD';
        results.forEach((r, i) => {
          if (r.status !== 'fulfilled') return;
          const a = accounts[i];
          const w = (r.value.data?.data || []).find((b) => b.currency === a.baseCurrency);
          if (w?.free != null) total += Number(w.free) || 0;
        });
        setRealBalance(total);
        setRealCurrency(ccy);
      } catch (_) { /* keep prior */ }
    };
    load();
    const unsub = wsClient.subscribe('wallet', load);
    return () => { cancelled = true; unsub && unsub(); };
  }, [user]);

  // Convert the real balance (USD-base) into INR for the primary
  // label, and keep USD as a small subline — same India-first
  // pattern the rest of the app uses (Wallet, Dashboard hero, etc.).
  const fxRate = useFxRate();
  const rate = Number(fxRate) > 0 ? Number(fxRate) : 83;
  const usdEquivalent = realBalance != null
    ? (realCurrency === 'USD' ? Number(realBalance) : Number(realBalance) / rate)
    : null;
  const inrEquivalent = usdEquivalent != null ? usdEquivalent * rate : null;
  const balanceLabel = inrEquivalent != null
    ? `₹${fmtNum(inrEquivalent, 2)}`
    : '—';
  const balanceSubLabel = usdEquivalent != null
    ? `≈ $${fmtNum(usdEquivalent, 2)} USD`
    : '';

  const isActive = (to) => location.pathname === to;

  return (
    <div className="min-h-screen bg-white text-text-primary flex flex-col">
      {/* ── Primary header — logo, primary nav, search, bell, profile.
          Hidden entirely on /trade so the terminal owns the full viewport. */}
      <header className={`${location.pathname === '/trade' ? 'hidden' : 'sticky top-0 z-40 bg-white border-b border-border-dark'}`}>
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 h-16 flex items-center gap-4">
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="md:hidden p-2 -ml-2 text-text-secondary hover:text-text-primary"
            aria-label="Toggle navigation"
          >
            {mobileOpen ? I.close : I.menu}
          </button>

          {/* Brand — rounded gradient "T" icon with a corner PRO badge.
              IMPORTANT: the global light-mode override turns `text-white`
              into dark text. We bypass it by setting `color` inline on
              both the "T" glyph and the corner PRO chip so they actually
              render white against the blue gradient. */}
          <Link to="/explore" className="flex items-center gap-3 shrink-0">
            <span
              className="relative w-10 h-10 rounded-[12px] flex items-center justify-center font-extrabold shrink-0"
              style={{
                background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 55%, #1E3A8A 100%)',
                boxShadow: '0 4px 12px rgba(29, 78, 216, 0.35)',
                color: '#FFFFFF',
              }}
            >
              <span
                className="text-xl leading-none"
                style={{ fontFamily: 'Georgia, serif', color: '#FFFFFF' }}
              >
                T
              </span>
              {/* Tiny PRO badge in the bottom-right corner of the icon */}
              <span
                className="absolute -bottom-1 -right-1 text-[7px] font-extrabold tracking-wider px-1 py-px rounded-md"
                style={{
                  background: '#1E3A8A',
                  boxShadow: '0 0 0 2px #FFFFFF',
                  color: '#FFFFFF',
                }}
              >
                PRO
              </span>
            </span>
            <span className="hidden sm:flex flex-col leading-none">
              <span className="font-extrabold text-[18px] tracking-tight text-text-primary">TradePro</span>
              <span className="text-[12px] uppercase tracking-[0.18em] text-primary-500 mt-1 font-bold">PRO</span>
            </span>
          </Link>

          {/* Primary nav */}
          <nav className="hidden md:flex items-center ml-4">
            {PRIMARY_NAV.map((item) => (
              <NavLink
                key={item.label}
                to={item.to}
                className={`topnav-link ${isActive(item.to) ? 'topnav-link-active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* Search trigger — Groww-style input pill with the Ctrl+K hint
              sitting RIGHT-aligned inside, not as a separate badge. */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            aria-label="Open search"
            className="hidden md:flex flex-1 max-w-md ml-auto items-center gap-3 bg-white hover:bg-bg-card border border-border-dark rounded-full px-4 py-2 text-sm text-text-muted transition-colors"
          >
            <span className="text-text-muted">{I.search}</span>
            <span className="flex-1 text-left">Search markets…</span>
            <span className="hidden lg:inline text-[11px] text-text-muted font-medium">
              Ctrl+K
            </span>
          </button>

          {/* Right cluster — mobile search + terminal CTA + theme + bell + profile */}
          <div className="flex items-center gap-2 ml-auto md:ml-0">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Open search"
              className="md:hidden p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {I.search}
            </button>
            {/* Terminal CTA — simple bordered button matching the
                old secondary-nav style. Trade page auto-enters
                fullscreen on the `?view=terminal` query flag.
                Hidden on mobile — burger menu has the regular Trade
                entry. */}
            <Link
              to="/trade?view=terminal"
              title="Open trading terminal"
              className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-dark hover:border-primary-500/50 hover:bg-primary-500/5 text-text-primary text-[13px] font-medium transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h6v6H4z" />
                <path d="M14 4h6v6h-6z" />
                <path d="M4 14h6v6H4z" />
                <path d="M14 14h6v6h-6z" />
              </svg>
              Terminal
            </Link>
            <button
              type="button"
              onClick={toggleTheme}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              aria-label="Toggle theme"
              className="p-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {theme === 'dark' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
              )}
            </button>
            <NotificationCenter />

            <div className="relative" ref={profileRef}>
              <button
                type="button"
                onClick={() => setProfileOpen((o) => !o)}
                className="group flex items-center gap-2 p-1 pr-1.5 rounded-full hover:bg-bg-hover transition-all"
                aria-haspopup="true"
                aria-expanded={profileOpen}
              >
                <span className="relative shrink-0">
                  <span
                    className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold tracking-wide ring-2 ring-white transition-shadow group-hover:ring-primary-500/30"
                    style={{
                      background: 'linear-gradient(135deg, #3B82F6 0%, #1D4ED8 55%, #1E3A8A 100%)',
                      boxShadow: '0 2px 8px rgba(29, 78, 216, 0.35)',
                      color: '#FFFFFF',
                    }}
                  >
                    {initials}
                  </span>
                  {/* Online status dot — green with a white ring so it pops
                      against any background. */}
                  <span
                    className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-white"
                    style={{ background: '#16A34A' }}
                    title="Online"
                  />
                </span>
                <span className="hidden sm:inline text-text-muted group-hover:text-text-primary transition-colors">
                  {I.chevron}
                </span>
              </button>

              {profileOpen && (
                <div
                  className="absolute right-0 mt-2 w-72 z-50 bg-white border border-border-dark rounded-xl shadow-elevated overflow-hidden"
                  role="menu"
                >
                  <div className="px-4 py-3 border-b border-border-subtle">
                    <div className="text-sm font-semibold text-text-primary truncate">{fullName}</div>
                    <div className="text-xs text-text-muted truncate">{user?.email || ''}</div>
                  </div>

                  <Link
                    to="/wallet"
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors"
                    role="menuitem"
                    title="Total real account balance"
                  >
                    <div className="flex items-center gap-3 text-sm text-text-primary">
                      <span className="text-text-muted">{I.wallet}</span>
                      Balance
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-bold text-text-primary font-mono tabular-nums">{balanceLabel}</div>
                      {balanceSubLabel && (
                        <div className="text-[10px] font-mono text-text-muted">{balanceSubLabel}</div>
                      )}
                    </div>
                  </Link>

                  <Link
                    to="/reports"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">{I.reports}</span>
                    Reports
                  </Link>

                  <Link
                    to="/helpdesk"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">{I.help}</span>
                    Support
                  </Link>

                  <Link
                    to="/profile"
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-primary hover:bg-bg-hover transition-colors"
                    role="menuitem"
                  >
                    <span className="text-text-muted">{I.settings}</span>
                    Settings
                  </Link>

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-bear hover:bg-bear/5 transition-colors border-t border-border-subtle"
                    role="menuitem"
                  >
                    <span>{I.logout}</span>
                    Log Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Horizontal instruments rail — replaces the old secondary
            nav strip. Renders a live, ticker-driven pill for every
            tradable instrument so users can jump straight to /trade
            with one click. Hidden on /trade so the terminal can claim
            the full vertical viewport below the primary header. */}
        {location.pathname !== '/trade' && (
          <div className="border-t border-border-subtle bg-bg-card">
            <div className="max-w-[1400px] mx-auto">
              <InstrumentStrip />
            </div>
          </div>
        )}
      </header>

      {/* ── Mobile flyout — combined primary + secondary in a single list ─ */}
      {mobileOpen && (
        <div className="md:hidden border-b border-border-dark bg-white">
          <div className="px-4 py-3 space-y-1">
            {[...PRIMARY_NAV, ...SECONDARY_NAV].map((item, idx) => (
              <NavLink
                key={`${item.to}-${idx}`}
                to={item.to}
                className={({ isActive: a }) =>
                  `block px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    a ? 'bg-primary-500/10 text-primary-600' : 'text-text-primary hover:bg-bg-hover'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      {/* ── Main content — Groww-style centered container, white surface.
          /trade is a pro terminal that wants every pixel — it gets a
          thin-padded full-bleed container that uses a flex chain so the
          page locks to exactly (viewport - header) with no overflow.
          Everything else stays at the comfortable 1400px reading width. */}
      <main className={`flex-1 ${location.pathname === '/trade' ? 'flex flex-col overflow-hidden' : ''}`}>
        {location.pathname === '/trade' ? (
          // No padding — Trade page is locked to `h-screen` and applies
          // its own slim `p-2` inner padding.
          <div className="flex-1 flex flex-col min-h-0">{children}</div>
        ) : (
          <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6">{children}</div>
        )}
      </main>

      {/* Global search modal — mounted once at the layout level */}
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
