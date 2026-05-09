import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuthStore, errorMessage } from '../store/auth';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [show2FA, setShow2FA] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/dashboard';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password, twoFactorCode || undefined);
      toast.success('Welcome back');
      navigate(from, { replace: true });
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === '2FA_REQUIRED') {
        setShow2FA(true);
        toast('Enter your 2FA code', { icon: '🔐' });
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card p-8 w-full max-w-md">
        <div className="text-center mb-7">
          <div className="inline-flex items-center gap-2.5 text-2xl font-extrabold text-white tracking-tight">
            <span
              className="w-11 h-11 rounded-md flex items-center justify-center font-extrabold text-bg-dark text-xl"
              style={{ background: 'linear-gradient(135deg, #FFE74D 0%, #FCD535 100%)' }}
            >
              T
            </span>
            <span>TradePro</span>
          </div>
          <p className="text-sm text-text-secondary mt-3">Sign in to your trading account</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="trader@tradingplatform.local"
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <div className="text-right mt-1">
              <Link to="/forgot-password" className="text-xs text-teal-accent hover:underline">Forgot password?</Link>
            </div>
          </div>
          {show2FA && (
            <div>
              <label className="label">2FA Code</label>
              <input
                type="text"
                className="input font-mono"
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value)}
                placeholder="6-digit code or backup XXXX-XXXX"
                required
              />
              <div className="text-xs text-gray-500 mt-1">Lost your authenticator? Enter a backup code.</div>
            </div>
          )}
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <div className="mt-6 text-center text-sm text-gray-400">
          Don't have an account?{' '}
          <Link to="/register" className="text-primary-500 hover:text-primary-600">
            Create one
          </Link>
        </div>
        <div className="mt-6 pt-4 border-t border-border-dark text-xs text-gray-500 text-center">
          Demo: trader@tradingplatform.local / Trader@12345
        </div>
      </div>
    </div>
  );
}
