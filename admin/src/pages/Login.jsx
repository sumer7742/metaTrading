import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuthStore, errorMessage } from '../store/auth';
import { redirectAfterLogin } from '../config/roles';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [show2FA, setShow2FA] = useState(false);
  const [twoFactorMode, setTwoFactorMode] = useState('totp');
  const [showRecovery, setShowRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  // Where the user was originally headed (deep link), if any. The final
  // destination is resolved by role so MANAGERs never land on /dashboard.
  const from = location.state?.from?.pathname;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const user = await login(email, password, twoFactorCode || undefined);
      toast.success('Welcome back');
      navigate(redirectAfterLogin(user.role, from), { replace: true });
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
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                className="input pr-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShowPwd((v) => !v)}
                title={showPwd ? 'Hide password' : 'Show password'}
                aria-label={showPwd ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
              >
                {showPwd ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><path d="M1 1l22 22" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                )}
              </button>
            </div>
          </div>
          {show2FA && (
            <div>
              <label className="label">
                {twoFactorMode === 'backup' ? 'Backup Code' : 'Authenticator Code'}
              </label>
              <input
                type="text"
                className="input font-mono"
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value)}
                placeholder={twoFactorMode === 'backup' ? 'XXXX-XXXX' : '6-digit code'}
                maxLength={twoFactorMode === 'backup' ? 9 : 6}
                autoComplete="one-time-code"
                inputMode={twoFactorMode === 'backup' ? 'text' : 'numeric'}
                required
              />
              <div className="text-xs text-gray-500 mt-1">
                {twoFactorMode === 'backup'
                  ? 'Each backup code can only be used once.'
                  : 'Open your authenticator app to get the code.'}
              </div>
              <button
                type="button"
                onClick={() => setShowRecovery((v) => !v)}
                className="mt-3 text-xs text-primary-500 hover:underline"
              >
                {showRecovery ? 'Hide options' : 'Try another way'}
              </button>
              {showRecovery && (
                <div className="mt-2 rounded-md border border-border-dark bg-bg-panel/60 p-3 space-y-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setTwoFactorMode(twoFactorMode === 'backup' ? 'totp' : 'backup');
                      setTwoFactorCode('');
                    }}
                    className="block w-full text-left text-gray-300 hover:text-white"
                  >
                    {twoFactorMode === 'backup'
                      ? '• Use authenticator code instead'
                      : '• Use a backup code'}
                  </button>
                  <div className="text-gray-400">
                    <div className="text-gray-300">• Lost access to authenticator?</div>
                    <div className="mt-1 ml-3 text-gray-500">
                      Enter one of the 8 backup codes you saved when 2FA was set up.
                      Switch the input above to "Use a backup code".
                    </div>
                  </div>
                  <div className="text-gray-400">
                    <div className="text-gray-300">• Account recovery</div>
                    <div className="mt-1 ml-3 text-gray-500">
                      Admin accounts cannot be self-recovered. If you've lost both your
                      authenticator and backup codes, ask another super-admin to reset
                      your 2FA from the Security console, or use server-side recovery.
                    </div>
                  </div>
                </div>
              )}
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
