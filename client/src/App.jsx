import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import ComingSoon from './components/ComingSoon';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';
import Dashboard from './pages/Dashboard';
import Trade from './pages/Trade';
import Wallet from './pages/Wallet';
import Profile from './pages/Profile';
import Orders from './pages/Orders';
import Accounts from './pages/Accounts';
import Reports from './pages/Reports';
import Affiliate from './pages/Affiliate';
import PriceAlerts from './pages/PriceAlerts';
import Plans from './pages/Plans';
import Funds from './pages/Funds';
import Feedback from './pages/Feedback';

const Page = ({ children }) => (
  <ProtectedRoute>
    <Layout>{children}</Layout>
  </ProtectedRoute>
);

export default function App() {
  const { init } = useAuthStore();

  useEffect(() => {
    init();
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />

      <Route path="/" element={<Page><Navigate to="/dashboard" replace /></Page>} />
      <Route path="/dashboard" element={<Page><Dashboard /></Page>} />
      <Route path="/trade" element={<Page><Trade /></Page>} />
      <Route path="/orders" element={<Page><Orders /></Page>} />
      <Route path="/reports" element={<Page><Reports /></Page>} />
      <Route path="/alerts" element={<Page><PriceAlerts /></Page>} />
      <Route path="/affiliate" element={<Page><Affiliate /></Page>} />
      <Route path="/plans" element={<Page><Plans /></Page>} />
      <Route path="/wallet" element={<Page><Wallet /></Page>} />
      <Route path="/accounts" element={<Page><Accounts /></Page>} />
      <Route path="/profile" element={<Page><Profile /></Page>} />

      {/* Phase 2/3 modules from spec - placeholders */}
      <Route path="/funds" element={<Page><Funds /></Page>} />
      {/* Hidden until Phase 3 — also removed from sidebar in Layout.jsx.
          Re-enable by uncommenting both this block and the matching nav rows.
      <Route
        path="/copy-trading"
        element={
          <Page>
            <ComingSoon
              title="Copy Trading"
              description="Follow top traders and mirror their positions automatically. Coming in Phase 3."
              phase="Phase 3"
            />
          </Page>
        }
      />
      <Route
        path="/pamm"
        element={
          <Page>
            <ComingSoon
              title="PAMM Accounts"
              description="Percentage Allocation Management Module - lets money managers run pooled accounts."
              phase="Phase 3"
            />
          </Page>
        }
      />
      <Route
        path="/mam"
        element={
          <Page>
            <ComingSoon
              title="MAM Accounts"
              description="Multi-Account Manager - allocate trades across multiple sub-accounts."
              phase="Phase 3"
            />
          </Page>
        }
      />
      */}
      <Route
        path="/ib-room"
        element={
          <Page>
            <Affiliate />
          </Page>
        }
      />
      <Route
        path="/bonuses"
        element={
          <Page>
            <Plans />
          </Page>
        }
      />
      <Route
        path="/helpdesk"
        element={
          <Page>
            <ComingSoon
              title="Helpdesk"
              description="Open a support ticket or browse the knowledge base."
              phase="Phase 2"
            />
          </Page>
        }
      />
      <Route path="/feedback" element={<Page><Feedback /></Page>} />
      <Route
        path="/download"
        element={
          <Page>
            <ComingSoon
              title="Download Mobile App"
              description="Native iOS and Android trading apps."
              phase="Phase 4"
            />
          </Page>
        }
      />

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
