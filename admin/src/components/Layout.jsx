import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { canUserAccessPath } from '../config/roles';

// Inline SVG icons — keeps bundle slim and theme-tinted via currentColor.
const Icon = ({ d, ...p }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {Array.isArray(d) ? d.map((path, i) => <path key={i} d={path} />) : <path d={d} />}
  </svg>
);
const I = {
  dashboard: <Icon d={['M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z']} />,
  users: <Icon d={['M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M8.5 7.5a4 4 0 1 0 0 .01z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M15 3.13a4 4 0 0 1 0 7.75']} />,
  instruments: <Icon d={['M3 3v18h18', 'M7 14l4-4 4 4 5-7']} />,
  deposit: <Icon d={['M12 5v14', 'M19 12l-7 7-7-7']} />,
  withdrawal: <Icon d={['M12 19V5', 'M5 12l7-7 7 7']} />,
  audit: <Icon d={['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8']} />,
  reports: <Icon d={['M3 3v18h18', 'M9 17V9', 'M13 17v-5', 'M17 17v-2']} />,
  feed: <Icon d={['M2 2h2a2 2 0 0 1 2 2v6', 'M2 12a10 10 0 0 1 10 10', 'M2 6a16 16 0 0 1 16 16', 'M2 2v0', 'M22 22a20 20 0 0 0-20-20']} />,
  settings: <Icon d={['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z']} />,
  security: <Icon d={['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z']} />,
  plans: <Icon d={['M20 7h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z', 'M12 12v4', 'M10 14h4']} />,
  orders: <Icon d={['M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4', 'M9 3v4h6V3', 'M8 12l2 2 4-4']} />,
  logout: <Icon d={['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9']} />,
  bell: <Icon d={['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0']} />,
};

// Sectioned nav — matches the client's premium sidebar pattern. TRADE
// (operational pulse) goes first, MONEY (deposits/withdrawals) second,
// AUDIT/REPORTS third, INFRA last.
// Visibility is NOT encoded per-item here — it's derived from the SAME
// central route-access config the route guards use (config/roles), keyed by
// each item's `to`. That guarantees the sidebar and the guards can never
// disagree: a MANAGER only ever sees My Users + Support Chats, admins also
// see My Users, and pages not in the config default to admins-only.
const NAV_SECTIONS = [
  {
    title: 'Operations',
    items: [
      { to: '/dashboard', icon: I.dashboard, label: 'Dashboard' },
      { to: '/portfolio', icon: I.reports, label: 'Portfolio' },
      { to: '/users', icon: I.users, label: 'Users' },
      { to: '/accounts', icon: I.plans, label: 'Accounts' },
      { to: '/instruments', icon: I.instruments, label: 'Instruments' },
      { to: '/orders', icon: I.orders, label: 'Orders Management' },
      { to: '/market-exposure', icon: I.reports, label: 'Market Exposure' },
    ],
  },
  {
    title: 'Hierarchy',
    items: [
      { to: '/admins',         icon: I.users, label: 'Admins' },
      { to: '/managers',       icon: I.users, label: 'Managers' },
      { to: '/assignments',    icon: I.users, label: 'Assignments' },
      { to: '/hierarchy-tree', icon: I.dashboard, label: 'Hierarchy Tree' },
      { to: '/access-control', icon: I.security, label: 'Manager Permissions' },
      { to: '/admin-access', icon: I.security, label: 'Admin Access' },
      { to: '/my-users',       icon: I.users, label: 'My Users' },
    ],
  },
  {
    title: 'Money',
    items: [
      { to: '/finance', icon: I.deposit, label: 'Finance Dept' },
      { to: '/deposits', icon: I.deposit, label: 'Deposits' },
      { to: '/withdrawals', icon: I.withdrawal, label: 'Withdrawals' },
      { to: '/plans', icon: I.plans, label: 'Plans' },
      { to: '/account-plans', icon: I.plans, label: 'Account Plans' },
      { to: '/subscription-wallets', icon: I.plans, label: 'Sub. Wallets' },
      { to: '/bonus-wallets', icon: I.plans, label: 'Bonus Wallets' },
      { to: '/user-transfers', icon: I.deposit, label: 'User Transfers' },
      { to: '/partners', icon: I.plans, label: 'Partners' },
    ],
  },
  {
    title: 'Support',
    items: [
      { to: '/support-chats', icon: I.users, label: 'Support Chats' },
    ],
  },
  {
    title: 'Insights',
    items: [
      { to: '/reports', icon: I.reports, label: 'Reports' },
      { to: '/execution', icon: I.instruments, label: 'Execution' },
      { to: '/audit-compliance', icon: I.security, label: 'Audit & Compliance' },
      { to: '/audit', icon: I.audit, label: 'Audit Log' },
    ],
  },
  {
    title: 'Content',
    items: [
      { to: '/cms-pages', icon: I.audit, label: 'CMS Pages' },
      { to: '/cms-news', icon: I.reports, label: 'News' },
      { to: '/global-alerts', icon: I.bell, label: 'Global Alerts' },
    ],
  },
  {
    title: 'Infra',
    items: [
      { to: '/data-feeds', icon: I.feed, label: 'Data Feeds' },
      { to: '/settings', icon: I.settings, label: 'Settings' },
      { to: '/security', icon: I.security, label: 'Security' },
    ],
  },
];

// Visibility is driven by the central route-access config (keyed by path), so
// the sidebar and the route guards always agree. SUPER_ADMIN sees everything;
// managers only see routes whose allow-list includes MANAGER.
export default function Layout({ children }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const role = user?.role;
  // Permission-aware: managers only see modules their Super Admin enabled.
  const navSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((it) => canUserAccessPath(user, it.to)) }))
    .filter((s) => s.items.length);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const initials = (user?.email || 'A').split('@')[0].slice(0, 2).toUpperCase();

  return (
    <div className="h-screen flex bg-bg-dark overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 h-screen flex flex-col border-r border-border-dark sidebar-elevated">
        {/* Brand */}
        <div className="relative h-16 flex items-center px-5 border-b border-border-dark">
          <Link to="/dashboard" className="flex items-center gap-2.5 text-lg font-extrabold text-white tracking-tight group">
            <span
              className="w-9 h-9 rounded-lg flex items-center justify-center font-extrabold text-bg-dark text-base shadow-md transition-transform group-hover:scale-105"
              style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
            >
              T
            </span>
            <span className="flex flex-col leading-none">
              <span className="font-extrabold">TradePro</span>
              <span className="text-[9px] uppercase tracking-[0.2em] text-primary-500 mt-0.5 font-bold">Admin</span>
            </span>
          </Link>
        </div>

        {/* Sectioned nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-4">
          {navSections.map((section) => (
            <div key={section.title}>
              <div className="px-3 pb-1.5 text-[10px] uppercase tracking-[0.2em] font-bold text-text-muted">
                {section.title}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
                  >
                    <span className="sidebar-link-icon">{item.icon}</span>
                    <span className="flex-1">{item.label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer — admin profile pill + logout */}
        <div className="border-t border-border-dark p-3 space-y-2">
          <div className="flex items-center gap-3 p-2 rounded-lg border border-border-dark bg-bg-card">
            <span
              className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold text-bg-dark shrink-0"
              style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
            >
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-white font-semibold truncate">{user?.email}</div>
              <div className="text-[10px] uppercase tracking-wider text-primary-500 font-bold mt-0.5">
                {user?.role || 'ADMIN'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-bear/30 text-bear hover:bg-bear/10 transition-colors text-xs"
          >
            {I.logout}
            <span>Log Out</span>
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
