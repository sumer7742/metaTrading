import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import Layout from './Layout';
import CmsFooter from './CmsFooter';

/**
 * Chrome for public CMS / news pages.
 *   • Logged-in user → the FULL app Layout (same header/sidebar as every other
 *     page) so CMS/News feel native to the app.
 *   • Anonymous visitor → a minimal public header + the CMS-driven footer.
 */
export default function PublicShell({ children }) {
  const { user } = useAuthStore();

  if (user) return <Layout>{children}</Layout>;

  return (
    <div className="min-h-screen flex flex-col bg-bg-dark">
      <header className="border-b border-border-dark">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-lg font-extrabold text-text-primary">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center font-extrabold text-white text-sm"
              style={{ background: 'linear-gradient(135deg, #1D4ED8 0%, #1E40AF 100%)' }}>T</span>
            TradePro
          </Link>
          <Link to="/login" className="btn-primary text-sm px-4 py-1.5">Sign In</Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <CmsFooter />
    </div>
  );
}
