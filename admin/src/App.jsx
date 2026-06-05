import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import { accessForPath, canAccess, roleHome } from './config/roles';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Instruments from './pages/Instruments';
import Withdrawals from './pages/Withdrawals';
import Deposits from './pages/Deposits';
import AuditLog from './pages/AuditLog';
import Reports from './pages/Reports';
import ExecutionStats from './pages/ExecutionStats';
import DataFeeds from './pages/DataFeeds';
import Settings from './pages/Settings';
import Security from './pages/Security';
import Plans from './pages/Plans';
import AccountPlans from './pages/AccountPlans';
import SubscriptionWallets from './pages/SubscriptionWallets';
import BonusWallets from './pages/BonusWallets';
import UserTransfers from './pages/UserTransfers';
import Partners from './pages/Partners';
import Admins from './pages/Admins';
import Managers from './pages/Managers';
import Assignments from './pages/Assignments';
import ManagerDashboard from './pages/ManagerDashboard';
import HierarchyTree from './pages/HierarchyTree';
import ManagerChats from './pages/ManagerChats';

// Centralized, path-driven role gate. Looks up the current route's allow-list
// from the single source of truth (config/roles) and bounces a disallowed
// role to ITS OWN home — never an error screen. This is what keeps a MANAGER
// off /dashboard (→ /my-users) and admins off super-admin-only pages.
function RoleGate({ children }) {
  const { user } = useAuthStore();
  const { pathname } = useLocation();
  if (!user) return null; // ProtectedRoute handles the unauthenticated case
  if (!canAccess(user.role, accessForPath(pathname))) {
    return <Navigate to={roleHome(user.role)} replace />;
  }
  return children;
}

// Auth + chrome + role gate, applied uniformly to every protected route.
const wrap = (el) => (
  <ProtectedRoute>
    <Layout>
      <RoleGate>{el}</RoleGate>
    </Layout>
  </ProtectedRoute>
);

// Sends a signed-in user to their role home, and a signed-out user to login.
// Used for "/" and any unknown path so nobody ever lands on a page they
// can't use.
function HomeRedirect() {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  return <Navigate to={user ? roleHome(user.role) : '/login'} replace />;
}

export default function App() {
  const { init } = useAuthStore();
  useEffect(() => { init(); }, []);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />

      {/* Operations / money / insights / infra — gated to admins by default
          via ROUTE_ACCESS's DEFAULT_ROUTE_ROLES (managers are bounced home). */}
      <Route path="/dashboard" element={wrap(<Dashboard />)} />
      <Route path="/users" element={wrap(<Users />)} />
      <Route path="/instruments" element={wrap(<Instruments />)} />
      <Route path="/withdrawals" element={wrap(<Withdrawals />)} />
      <Route path="/deposits" element={wrap(<Deposits />)} />
      <Route path="/audit" element={wrap(<AuditLog />)} />
      <Route path="/reports" element={wrap(<Reports />)} />
      <Route path="/execution" element={wrap(<ExecutionStats />)} />
      <Route path="/data-feeds" element={wrap(<DataFeeds />)} />
      <Route path="/plans" element={wrap(<Plans />)} />
      <Route path="/account-plans" element={wrap(<AccountPlans />)} />
      <Route path="/subscription-wallets" element={wrap(<SubscriptionWallets />)} />
      <Route path="/bonus-wallets" element={wrap(<BonusWallets />)} />
      <Route path="/user-transfers" element={wrap(<UserTransfers />)} />
      <Route path="/partners" element={wrap(<Partners />)} />

      {/* Hierarchy / manager scope — role-gated by ROUTE_ACCESS. */}
      <Route path="/admins" element={wrap(<Admins />)} />
      <Route path="/managers" element={wrap(<Managers />)} />
      <Route path="/assignments" element={wrap(<Assignments />)} />
      <Route path="/hierarchy-tree" element={wrap(<HierarchyTree />)} />
      <Route path="/my-users" element={wrap(<ManagerDashboard />)} />
      <Route path="/support-chats" element={wrap(<ManagerChats />)} />

      <Route path="/settings" element={wrap(<Settings />)} />
      <Route path="/security" element={wrap(<Security />)} />

      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}
