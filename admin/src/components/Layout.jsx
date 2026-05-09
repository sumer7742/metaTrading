import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/auth';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: '◧' },
  { to: '/users', label: 'Users', icon: '◉' },
  { to: '/instruments', label: 'Instruments', icon: '▦' },
  { to: '/withdrawals', label: 'Withdrawals', icon: '↗' },
  { to: '/deposits', label: 'Deposits', icon: '↘' },
  { to: '/audit', label: 'Audit Log', icon: '☷' },
  { to: '/reports', label: 'Reports', icon: '▤' },
  { to: '/data-feeds', label: 'Data Feeds', icon: '◉' },
];

export default function Layout({ children }) {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen flex bg-bg-dark">
      {/* Sidebar */}
      <aside className="w-60 bg-bg-sidebar border-r border-border-dark flex flex-col">
        <div className="px-5 py-4 border-b border-border-dark">
          <Link to="/dashboard" className="text-lg font-semibold text-white">
            <span className="text-primary-500">▲</span> TradePro <span className="text-xs text-gray-500">Admin</span>
          </Link>
        </div>
        <nav className="flex-1 py-3 px-2 space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center px-3 py-2 rounded text-sm ${
                  isActive
                    ? 'bg-primary-600/20 text-primary-500'
                    : 'text-gray-400 hover:text-white hover:bg-bg-hover'
                }`
              }
            >
              <span className="mr-3 text-lg">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-border-dark">
          <div className="text-xs text-gray-400 mb-2 truncate">{user?.email}</div>
          <div className="text-xs text-primary-500 mb-2">{user?.role}</div>
          <button onClick={handleLogout} className="btn-ghost w-full text-xs">Logout</button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-7xl mx-auto px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
