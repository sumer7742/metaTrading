import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
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

const wrap = (el) => (
  <ProtectedRoute>
    <Layout>{el}</Layout>
  </ProtectedRoute>
);

// Role-gated route — redirects to the role's home if the current user
// isn't allowed. SUPER_ADMIN always passes.
function RoleRoute({ roles, children }) {
  const { user } = useAuthStore();
  if (!user) return null; // ProtectedRoute handles the unauthenticated case
  const allowed = user.role === 'SUPER_ADMIN' || roles.includes(user.role);
  if (!allowed) return <Navigate to={user.role === 'MANAGER' ? '/my-users' : '/dashboard'} replace />;
  return children;
}
const wrapRole = (el, roles) => wrap(<RoleRoute roles={roles}>{el}</RoleRoute>);

export default function App() {
  const { init } = useAuthStore();
  useEffect(() => { init(); }, []);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={wrap(<Navigate to="/dashboard" replace />)} />
      <Route path="/dashboard" element={wrap(<Dashboard />)} />
      <Route path="/users" element={wrap(<Users />)} />
      <Route path="/instruments" element={wrap(<Instruments />)} />
      <Route path="/withdrawals" element={wrap(<Withdrawals />)} />
      <Route path="/deposits" element={wrap(<Deposits />)} />
      <Route path="/audit" element={wrap(<AuditLog />)} />
      <Route path="/reports" element={wrap(<Reports />)} />
      <Route path="/data-feeds" element={wrap(<DataFeeds />)} />
      <Route path="/plans" element={wrap(<Plans />)} />
      <Route path="/account-plans" element={wrap(<AccountPlans />)} />
      <Route path="/subscription-wallets" element={wrap(<SubscriptionWallets />)} />
      <Route path="/bonus-wallets" element={wrap(<BonusWallets />)} />
      <Route path="/user-transfers" element={wrap(<UserTransfers />)} />
      <Route path="/partners" element={wrap(<Partners />)} />
      {/* ── Hierarchy management (role-gated) ──────────────────────── */}
      <Route path="/admins" element={wrapRole(<Admins />, ['SUPER_ADMIN'])} />
      <Route path="/managers" element={wrapRole(<Managers />, ['SUPER_ADMIN', 'ADMIN'])} />
      <Route path="/assignments" element={wrapRole(<Assignments />, ['SUPER_ADMIN', 'ADMIN'])} />
      <Route path="/hierarchy-tree" element={wrapRole(<HierarchyTree />, ['SUPER_ADMIN'])} />
      <Route path="/my-users" element={wrapRole(<ManagerDashboard />, ['SUPER_ADMIN', 'ADMIN', 'MANAGER'])} />
      <Route path="/support-chats" element={wrapRole(<ManagerChats />, ['SUPER_ADMIN', 'ADMIN', 'MANAGER'])} />
      <Route path="/settings" element={wrap(<Settings />)} />
      <Route path="/security" element={wrap(<Security />)} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
