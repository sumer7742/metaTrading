import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/auth';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import ComingSoon from './components/ComingSoon';
import ErrorBoundary from './components/ErrorBoundary';

// Auth pages are eager-loaded — they're the first thing a logged-out
// user sees, and they're small.
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import VerifyEmail from './pages/VerifyEmail';

// Authenticated pages are code-split so the initial JS bundle stays small.
// Each route becomes its own chunk — Trade alone pulls in lightweight-charts
// (~80KB) and we don't want to ship that to users who only check the dashboard.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Trade = lazy(() => import('./pages/Trade'));
const Wallet = lazy(() => import('./pages/Wallet'));
const Profile = lazy(() => import('./pages/Profile'));
const Orders = lazy(() => import('./pages/Orders'));
const Accounts = lazy(() => import('./pages/Accounts'));
const Reports = lazy(() => import('./pages/Reports'));
const Affiliate = lazy(() => import('./pages/Affiliate'));
const PriceAlerts = lazy(() => import('./pages/PriceAlerts'));
const Plans = lazy(() => import('./pages/Plans'));
const Funds = lazy(() => import('./pages/Funds'));
const Feedback = lazy(() => import('./pages/Feedback'));
const Helpdesk = lazy(() => import('./pages/Helpdesk'));

// Minimal fallback while a chunk is fetched. Branded so it doesn't feel
// jarring; lasts <100ms on a warm cache, <500ms on first cold load.
const RouteFallback = () => (
  <div className="min-h-[60vh] flex items-center justify-center">
    <div className="flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      <div className="text-xs text-text-muted">Loading…</div>
    </div>
  </div>
);

const Page = ({ children }) => (
  <ProtectedRoute>
    <Layout>
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </Layout>
  </ProtectedRoute>
);

export default function App() {
  const { init } = useAuthStore();

  useEffect(() => {
    init();
  }, []);

  return (
    <ErrorBoundary>
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
        <Route path="/funds" element={<Page><Funds /></Page>} />
        <Route path="/ib-room" element={<Page><Affiliate /></Page>} />
        <Route path="/bonuses" element={<Page><Plans /></Page>} />
        <Route path="/helpdesk" element={<Page><Helpdesk /></Page>} />
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
    </ErrorBoundary>
  );
}
