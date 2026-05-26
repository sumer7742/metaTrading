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

const wrap = (el) => (
  <ProtectedRoute>
    <Layout>{el}</Layout>
  </ProtectedRoute>
);

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
      <Route path="/settings" element={wrap(<Settings />)} />
      <Route path="/security" element={wrap(<Security />)} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
