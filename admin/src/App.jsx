import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import { canUserAccessPath, roleHome } from './config/roles';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Portfolio from './pages/Portfolio';
import Users from './pages/Users';
import Accounts from './pages/Accounts';
import Instruments from './pages/Instruments';
import RecommendedMarkets from './pages/RecommendedMarkets';
import MarketExposure from './pages/MarketExposure';
import Orders from './pages/Orders';
import CmsPages from './pages/CmsPages';
import CmsNews from './pages/CmsNews';
import GlobalAlerts from './pages/GlobalAlerts';
import GlobalAlertPopup from './components/GlobalAlertPopup';
import Withdrawals from './pages/Withdrawals';
import Deposits from './pages/Deposits';
import Finance from './pages/Finance';
import Audit from './pages/Audit';
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
import ManagerPermissions from './pages/ManagerPermissions';
import AdminAccess from './pages/AdminAccess';
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
  // Permission-aware: a manager hitting a disabled module's URL is bounced to
  // their home (403 effect) — direct URL access can't bypass a toggled-off
  // permission. Backend middleware blocks the APIs regardless.
  if (!canUserAccessPath(user, pathname)) {
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
  const { init, refresh } = useAuthStore();
  useEffect(() => { init(); }, []);
  // Apply Manager Access Control changes without a logout: re-pull /auth/me on
  // tab focus and every 60s so toggled permissions / disabled access take
  // effect promptly for a signed-in manager.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    const id = setInterval(refresh, 60000);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(id); };
  }, [refresh]);

  return (
    <>
    <GlobalAlertPopup />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />

      {/* Operations / money / insights / infra — gated to admins by default
          via ROUTE_ACCESS's DEFAULT_ROUTE_ROLES (managers are bounced home). */}
      <Route path="/dashboard" element={wrap(<Dashboard />)} />
      <Route path="/portfolio" element={wrap(<Portfolio />)} />
      <Route path="/users" element={wrap(<Users />)} />
      <Route path="/accounts" element={wrap(<Accounts />)} />
      <Route path="/instruments" element={wrap(<Instruments />)} />
      <Route path="/recommended-markets" element={wrap(<RecommendedMarkets />)} />
      <Route path="/market-exposure" element={wrap(<MarketExposure />)} />
      <Route path="/orders" element={wrap(<Orders />)} />
      <Route path="/cms-pages" element={wrap(<CmsPages />)} />
      <Route path="/cms-news" element={wrap(<CmsNews />)} />
      <Route path="/global-alerts" element={wrap(<GlobalAlerts />)} />
      <Route path="/withdrawals" element={wrap(<Withdrawals />)} />
      <Route path="/deposits" element={wrap(<Deposits />)} />
      <Route path="/finance" element={wrap(<Finance />)} />
      <Route path="/audit-compliance" element={wrap(<Audit />)} />
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
      <Route path="/access-control" element={wrap(<ManagerPermissions />)} />
      <Route path="/admin-access" element={wrap(<AdminAccess />)} />
      <Route path="/my-users" element={wrap(<ManagerDashboard />)} />
      <Route path="/support-chats" element={wrap(<ManagerChats />)} />

      <Route path="/settings" element={wrap(<Settings />)} />
      <Route path="/security" element={wrap(<Security />)} />

      <Route path="*" element={<HomeRedirect />} />
    </Routes>
    </>
  );
}
