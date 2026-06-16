import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuthStore, errorMessage } from '../store/auth';
import BrandMark from '../components/BrandMark';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import { v, sanitize } from '../utils/validation';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [show2FA, setShow2FA] = useState(false);
  const [twoFactorMode, setTwoFactorMode] = useState('totp');
  const [showRecovery, setShowRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  // Field-level errors keyed by field name. Cleared as the user types
  // a valid value, set on blur / submit.
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});

  const { login } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/explore';

  const validate = () => {
    const next = {
      email:    v.email(email),
      password: v.password(password),
    };
    if (show2FA) {
      next.twoFactor = twoFactorMode === 'backup'
        ? v.backupCode(twoFactorCode)
        : v.totp(twoFactorCode);
    }
    const cleaned = Object.fromEntries(Object.entries(next).filter(([_, val]) => val));
    setErrors(cleaned);
    return Object.keys(cleaned).length === 0;
  };

  const onBlur = (field) => () => {
    setTouched((t) => ({ ...t, [field]: true }));
    validate();
  };

  const showError = (field) => touched[field] && errors[field];

  const handleSubmit = async (e) => {
    e.preventDefault();
    setTouched({ email: true, password: true, twoFactor: show2FA });
    if (!validate()) return;
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password, twoFactorCode || undefined);
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
    <AuthShell>
      <div className="card p-8 w-full max-w-md">
        <div className="text-center mb-7">
          <BrandMark />
          <p className="text-sm text-text-secondary mt-3">Sign in to your trading account</p>
        </div>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {/* Email — strict format, auto-lowercase, trimmed */}
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className={`input ${showError('email') ? 'border-bear focus:border-bear' : ''}`}
              value={email}
              onChange={(e) => setEmail(sanitize.email(e.target.value))}
              onBlur={onBlur('email')}
              required
              autoFocus
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              spellCheck={false}
              placeholder="trader@tradingplatform.local"
              aria-invalid={!!showError('email')}
              aria-describedby="email-err"
            />
            <FieldError id="email-err" msg={showError('email')} />
          </div>

          {/* Password */}
          <div>
            <label className="label">Password</label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={onBlur('password')}
              required
              minLength={8}
              maxLength={128}
              autoComplete="current-password"
              aria-invalid={!!showError('password')}
            />
            <FieldError msg={showError('password')} />
            <div className="text-right mt-1">
              <Link to="/forgot-password" className="text-xs text-teal-accent hover:underline">Forgot password?</Link>
            </div>
          </div>

          {/* 2FA — strict format depending on mode */}
          {show2FA && (
            <div>
              <label className="label">
                {twoFactorMode === 'backup' ? 'Backup Code' : 'Authenticator Code'}
              </label>
              <input
                type="text"
                className={`input font-mono ${showError('twoFactor') ? 'border-bear focus:border-bear' : ''}`}
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(
                  twoFactorMode === 'backup'
                    ? sanitize.backupCode(e.target.value)
                    : sanitize.totp(e.target.value)
                )}
                onBlur={onBlur('twoFactor')}
                placeholder={twoFactorMode === 'backup' ? 'XXXX-XXXX' : '000000'}
                maxLength={twoFactorMode === 'backup' ? 9 : 6}
                pattern={twoFactorMode === 'backup' ? '[A-Z0-9]{4}-?[A-Z0-9]{4}' : '[0-9]{6}'}
                autoComplete="one-time-code"
                inputMode={twoFactorMode === 'backup' ? 'text' : 'numeric'}
                spellCheck={false}
                required
                aria-invalid={!!showError('twoFactor')}
              />
              <FieldError msg={showError('twoFactor')} />
              <div className="text-xs text-gray-500 mt-1">
                {twoFactorMode === 'backup'
                  ? 'Each backup code can only be used once.'
                  : 'Open your authenticator app to get the code.'}
              </div>
              <button
                type="button"
                onClick={() => setShowRecovery((vv) => !vv)}
                className="mt-3 text-xs text-teal-accent hover:underline"
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
                      setErrors((errs) => ({ ...errs, twoFactor: null }));
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
                      Enter one of the 8 backup codes you saved when 2FA was enabled.
                      Switch the input above to "Use a backup code".
                    </div>
                  </div>
                  <div className="text-gray-400">
                    <div className="text-gray-300">• Account recovery</div>
                    <div className="mt-1 ml-3 text-gray-500">
                      If you've lost your authenticator and all backup codes,{' '}
                      <Link to="/forgot-password" className="text-teal-accent hover:underline">
                        reset your password
                      </Link>{' '}
                      — this signs you out of all sessions. For 2FA reset, contact support.
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
    </AuthShell>
  );
}

// Inline field-level error pill — kept its own component because three
// fields need the same treatment.
function FieldError({ id, msg }) {
  if (!msg) return null;
  return (
    <div
      id={id}
      className="mt-1 text-[11px] text-bear font-semibold flex items-center gap-1"
      role="alert"
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      {msg}
    </div>
  );
}
