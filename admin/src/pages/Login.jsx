import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
      toast.success('Welcome, admin');
      navigate(from, { replace: true });
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === '2FA_REQUIRED') {
        setShow2FA(true);
        toast('2FA code required', { icon: '🔐' });
      } else {
        toast.error(err.message || errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <div className="text-3xl font-bold text-white">
            <span className="text-primary-500">▲</span> TradePro
          </div>
          <p className="text-sm text-gray-400 mt-2">Admin Console</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Admin Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="admin@tradingplatform.local"
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
          </div>
          {show2FA && (
            <div>
              <label className="label">2FA Code</label>
              <input
                type="text"
                className="input font-mono"
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value)}
                maxLength={6}
                required
              />
            </div>
          )}
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <div className="mt-6 pt-4 border-t border-border-dark text-xs text-gray-500 text-center">
          Demo: admin@tradingplatform.local / Admin@12345
        </div>
      </div>
    </div>
  );
}
