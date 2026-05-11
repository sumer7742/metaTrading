import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { useThemeStore } from '../store/theme';

// SVG icon components — kept inline to avoid an extra deps install
const Icon = ({ d, ...p }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);
const I = {
  dashboard: <Icon d={['M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z']} />,
  chart: <Icon d={['M3 3v18h18', 'M7 14l4-4 4 4 5-7']} />,
  reports: <Icon d={['M9 12h6', 'M9 16h6', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']} />,
  wallet: <Icon d={['M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1', 'M16 12h4']} />,
  account: <Icon d={['M3 3v18h18', 'M7 17l3-6 4 3 5-9']} />,
  funds: <Icon d={['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']} />,
  copy: <Icon d={['M20 7H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z', 'M16 21V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h2']} />,
  pamm: <Icon d={['M3 21h18', 'M5 21V10', 'M9 21V4', 'M13 21V8', 'M17 21V12', 'M21 21V6']} />,
  mam: <Icon d={['M21 21V8l-9-5-9 5v13', 'M9 22V12h6v10']} />,
  ib: <Icon d={['M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M8.5 7.5a4 4 0 1 0 0 .01z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M15 3.13a4 4 0 0 1 0 7.75']} />,
  bonus: <Icon d={['M20 12v10H4V12', 'M2 7h20v5H2z', 'M12 22V7', 'M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z', 'M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z']} />,
  help: <Icon d={['M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1z', 'M21 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2a1 1 0 0 0 1-1z', 'M3 14a9 9 0 0 1 18 0']} />,
  feedback: <Icon d={['M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z']} />,
  download: <Icon d={['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3']} />,
  user: <Icon d={['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z']} />,
  sun: <Icon d={['M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42', 'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2', 'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42', 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z']} />,
  moon: <Icon d={['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z']} />,
  logout: <Icon d={['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9']} />,
  menu: <Icon d={['M3 12h18', 'M3 6h18', 'M3 18h18']} />,
  close: <Icon d={['M18 6L6 18', 'M6 6l12 12']} />,
};

// Nav grouped into sections so the long flat list reads better and so we can
// give each section a tiny header label. Order is intentional — TRADE first,
// money things second, growth/affiliate third, help last.
const NAV_SECTIONS = [
  {
    title: 'Trade',
    items: [
      { to: '/dashboard', icon: I.dashboard, label: 'Dashboard' },
      { to: '/trade', icon: I.chart, label: 'Chart' },
      { to: '/reports', icon: I.reports, label: 'Reports' },
    ],
  },
  {
    title: 'Portfolio',
    items: [
      { to: '/wallet', icon: I.wallet, label: 'Wallets' },
      { to: '/accounts', icon: I.account, label: 'Trading Account' },
      { to: '/funds', icon: I.funds, label: 'Funds' },
    ],
  },
  {
    title: 'Grow',
    items: [
      { to: '/ib-room', icon: I.ib, label: 'IB Room' },
      { to: '/bonuses', icon: I.bonus, label: 'Plans & Pricing' },
    ],
  },
  {
    title: 'Support',
    items: [
      { to: '/helpdesk', icon: I.help, label: 'Helpdesk' },
      { to: '/feedback', icon: I.feedback, label: 'Leave feedback' },
      { to: '/download', icon: I.download, label: 'Download App' },
    ],
  },
];

export default function Layout({ children }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Trader';
  const initials = (fullName || 'T').split(' ').map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  return (
    <div className="h-screen flex bg-bg-dark overflow-hidden">
      {/* Sidebar:
          • Mobile (<lg): `fixed` overlay slide-in (translate-x), full 256px
          • Desktop (lg+): in-flow flex item, 64px collapsed, 256px on hover —
            so the main content SHIFTS instead of being overlayed.
          The static positioning on desktop is what causes the push effect. */}
      <aside
        className={`group/sidebar h-screen flex flex-col border-r border-border-dark sidebar-elevated overflow-hidden transition-all duration-200 ease-out
          fixed inset-y-0 left-0 z-40 lg:static lg:z-auto
          w-64 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:w-16 lg:hover:w-64 lg:shrink-0`}
      >
        {/* Brand — only logo when collapsed; full text appears on hover */}
        <div className="relative h-16 flex items-center justify-between px-3 lg:px-3 border-b border-border-dark shrink-0">
          <Link to="/dashboard" className="flex items-center gap-3 text-lg font-extrabold text-white tracking-tight group/brand min-w-0">
            <span
              className="w-10 h-10 rounded-lg flex items-center justify-center font-extrabold text-bg-dark text-base shadow-md transition-transform group-hover/brand:scale-105 shrink-0"
              style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
            >
              T
            </span>
            <span className="flex flex-col leading-none whitespace-nowrap opacity-100 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-150">
              <span className="font-extrabold">TradePro</span>
              <span className="text-[9px] uppercase tracking-[0.2em] text-primary-500 mt-0.5 font-bold">PRO</span>
            </span>
          </Link>
          <button onClick={() => setMobileOpen(false)} className="lg:hidden text-text-secondary shrink-0">
            {I.close}
          </button>
        </div>

        {/* Nav — section headers fade out when collapsed; only icons show.
            On hover the section headers fade back in along with labels. */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 px-3 space-y-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="px-3 pb-1.5 text-[10px] uppercase tracking-[0.2em] font-bold text-text-muted whitespace-nowrap opacity-100 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-150 h-3">
                {section.title}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/dashboard'}
                    title={item.label}
                    className={({ isActive }) =>
                      `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`
                    }
                    onClick={() => setMobileOpen(false)}
                  >
                    <span className="sidebar-link-icon shrink-0">{item.icon}</span>
                    <span className="flex-1 whitespace-nowrap opacity-100 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-150">
                      {item.label}
                    </span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer — profile pill + theme/logout. Labels fade with same pattern. */}
        <div className="border-t border-border-dark p-3 space-y-2 shrink-0">
          <NavLink
            to="/profile"
            onClick={() => setMobileOpen(false)}
            title="View profile"
            className={({ isActive }) =>
              `flex items-center gap-3 p-2 rounded-lg border transition-colors ${
                isActive
                  ? 'border-primary-500/50 bg-primary-500/5'
                  : 'border-border-dark hover:border-border-accent hover:bg-bg-hover'
              }`
            }
          >
            <span
              className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold text-bg-dark shrink-0"
              style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
            >
              {initials}
            </span>
            <div className="min-w-0 flex-1 whitespace-nowrap opacity-100 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-150">
              <div className="text-sm text-white font-semibold truncate">{fullName}</div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted">
                View profile
              </div>
            </div>
          </NavLink>

          {/* Theme toggle — icon-only when collapsed; pill with label on hover */}
          <button
            type="button"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border-dark text-text-secondary hover:text-text-primary hover:border-border-accent hover:bg-bg-hover transition-colors text-sm"
          >
            <span className="text-text-muted shrink-0">{theme === 'dark' ? I.sun : I.moon}</span>
            <span className="flex-1 text-left whitespace-nowrap opacity-100 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-150">
              {theme === 'dark' ? 'Dark' : 'Light'}
            </span>
          </button>

          <button
            type="button"
            onClick={handleLogout}
            title="Log Out"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-bear/30 text-bear hover:bg-bear/10 transition-colors text-sm"
          >
            <span className="shrink-0">{I.logout}</span>
            <span className="flex-1 text-left whitespace-nowrap opacity-100 lg:opacity-0 lg:group-hover/sidebar:opacity-100 transition-opacity duration-150">
              Log Out
            </span>
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 h-screen">
        {/* Mobile top bar */}
        <div className="lg:hidden h-14 flex items-center justify-between px-4 bg-bg-sidebar border-b border-border-dark flex-shrink-0">
          <button onClick={() => setMobileOpen(true)} className="text-gray-300">{I.menu}</button>
          <Link to="/dashboard" className="text-white font-semibold">TradePro</Link>
          <div className="w-6" />
        </div>
        {/* min-h-0 lets the flex child actually shrink so its overflow-y-auto
            engages — without it long content pushes past the viewport and
            takes the (otherwise pinned) sidebar with it on edge cases. */}
        <main className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
