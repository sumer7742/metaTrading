import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import CmsFooter from './CmsFooter';

/**
 * Lightweight chrome for public CMS / news pages — works for both anonymous
 * visitors and signed-in users. Minimal header + the CMS-driven footer.
 */
export default function PublicShell({ children }) {
  const { user } = useAuthStore();
  return (
    <div className="min-h-screen flex flex-col bg-bg-dark">
      <header className="border-b border-border-dark">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-lg font-extrabold text-text-primary">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center font-extrabold text-white text-sm"
              style={{ background: 'linear-gradient(135deg, #1D4ED8 0%, #1E40AF 100%)' }}>T</span>
            TradePro
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/news" className="text-sm text-text-secondary hover:text-primary-500 transition-colors px-3 py-1.5">News</Link>
            <Link to={user ? '/explore' : '/login'} className="btn-primary text-sm px-4 py-1.5">
              {user ? 'Back to App' : 'Sign In'}
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <CmsFooter />
    </div>
  );
}
