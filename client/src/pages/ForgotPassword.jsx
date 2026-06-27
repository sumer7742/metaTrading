import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import BrandMark from '../components/BrandMark';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import { v, sanitize } from '../utils/validation';

/**
 * Forgot Password — Email-OTP reset in three steps:
 *   1. Email   → POST /auth/forgot-password   (always generic; no enumeration)
 *   2. OTP     → POST /auth/verify-reset-otp   (returns a short-lived ticket)
 *   3. Password→ POST /auth/reset-password     (ticket + new password)
 * Then redirect to /login. Theme-aware via AuthShell (light/dark), responsive.
 */

const PASSWORD_RULES = [
  { test: (p) => p.length >= 8,            label: 'At least 8 characters' },
  { test: (p) => /[A-Z]/.test(p),          label: 'One uppercase letter' },
  { test: (p) => /[a-z]/.test(p),          label: 'One lowercase letter' },
  { test: (p) => /[0-9]/.test(p),          label: 'One number' },
  { test: (p) => /[^A-Za-z0-9]/.test(p),   label: 'One special character' },
];

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [step, setStep] = useState('email'); // email | otp | password | done
  const [loading, setLoading] = useState(false);

  const [email, setEmail] = useState('');
  const [emailErr, setEmailErr] = useState(null);

  const [digits, setDigits] = useState(Array(6).fill(''));
  const otp = digits.join('');
  const [cooldown, setCooldown] = useState(0);

  const [resetToken, setResetToken] = useState('');
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');

  const rulesPass = PASSWORD_RULES.every((r) => r.test(pwd));
  const pwdMatch = pwd && pwd === confirm;

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  // ── Step 1: request OTP ──
  const submitEmail = async (e) => {
    e.preventDefault();
    const err = v.email(email);
    setEmailErr(err);
    if (err) return;
    setLoading(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { email });
      toast.success(data?.data?.message || 'If an account exists, an OTP has been sent.');
      setDigits(Array(6).fill(''));
      setStep('otp');
      setCooldown(60);
    } catch (err2) {
      toast.error(errorMessage(err2));
    } finally {
      setLoading(false);
    }
  };

  // Resend (reuses step 1).
  const resend = async () => {
    if (cooldown > 0 || loading) return;
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setDigits(Array(6).fill(''));
      setCooldown(60);
      toast.success('A new code has been sent.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: verify OTP ──
  const verify = async (code = otp) => {
    if (code.length !== 6 || loading) return;
    setLoading(true);
    try {
      const { data } = await api.post('/auth/verify-reset-otp', { email, otp: code });
      setResetToken(data?.data?.resetToken || '');
      setStep('password');
    } catch (err) {
      setDigits(Array(6).fill(''));
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Step 3: set new password ──
  const submitPassword = async (e) => {
    e.preventDefault();
    if (!rulesPass) return toast.error('Password does not meet all requirements.');
    if (!pwdMatch) return toast.error('Passwords do not match.');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { resetToken, newPassword: pwd });
      setStep('done');
      toast.success('Password updated successfully.');
      setTimeout(() => navigate('/login', { replace: true }), 1800);
    } catch (err) {
      const code = err.response?.data?.error?.code;
      toast.error(errorMessage(err));
      // Ticket expired / session invalid → send them back to step 1.
      if (code === 'RESET_TOKEN_INVALID' || code === 'RESET_NOT_VERIFIED') {
        setStep('email');
        setDigits(Array(6).fill(''));
        setResetToken('');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className="card p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <BrandMark />
        </div>

        {step !== 'done' && <Stepper step={step} />}

        {/* ── Step 1: email ── */}
        {step === 'email' && (
          <>
            <h1 className="text-xl font-bold text-text-primary mb-1.5">Forgot password?</h1>
            <p className="text-sm text-text-secondary mb-6">
              Enter your registered email and we'll send you a 6-digit verification code.
            </p>
            <form onSubmit={submitEmail} noValidate className="space-y-4">
              <div>
                <label className="label">Email</label>
                <input
                  type="email"
                  className={`input ${emailErr ? 'border-bear focus:border-bear' : ''}`}
                  value={email}
                  onChange={(e) => { setEmail(sanitize.email(e.target.value)); if (emailErr) setEmailErr(null); }}
                  required
                  autoFocus
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                />
                {emailErr && <p className="mt-1 text-[11px] text-bear font-semibold">{emailErr}</p>}
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full">
                {loading ? 'Sending…' : 'Send code'}
              </button>
            </form>
          </>
        )}

        {/* ── Step 2: OTP ── */}
        {step === 'otp' && (
          <>
            <h1 className="text-xl font-bold text-text-primary mb-1.5">Enter verification code</h1>
            <p className="text-sm text-text-secondary mb-6">
              If an account exists, a 6-digit code was sent to <b className="text-text-primary">{email}</b>. It expires in 10 minutes.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); verify(); }} className="space-y-5">
              <OtpInput digits={digits} setDigits={setDigits} disabled={loading} onComplete={(code) => verify(code)} />

              <div className="text-center text-sm text-text-secondary">
                Didn't get it?{' '}
                {cooldown > 0 ? (
                  <span className="text-text-muted">Resend in {cooldown}s</span>
                ) : (
                  <button type="button" onClick={resend} disabled={loading} className="text-teal-accent hover:underline font-semibold">
                    Resend code
                  </button>
                )}
              </div>

              <button type="submit" disabled={loading || otp.length !== 6} className="btn-primary w-full">
                {loading ? 'Verifying…' : 'Verify code'}
              </button>

              <button
                type="button"
                onClick={() => { setStep('email'); setDigits(Array(6).fill('')); }}
                className="w-full text-center text-xs text-text-muted hover:text-text-primary"
              >
                ← Change email
              </button>
            </form>
          </>
        )}

        {/* ── Step 3: new password ── */}
        {step === 'password' && (
          <>
            <h1 className="text-xl font-bold text-text-primary mb-1.5">Set a new password</h1>
            <p className="text-sm text-text-secondary mb-6">Choose a strong password you haven't used before.</p>
            <form onSubmit={submitPassword} noValidate className="space-y-4">
              <div>
                <label className="label">New password</label>
                <PasswordInput
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  required
                  minLength={8}
                  maxLength={128}
                  placeholder="New password"
                />
              </div>

              {/* Live rules checklist */}
              <ul className="space-y-1">
                {PASSWORD_RULES.map((r) => {
                  const ok = r.test(pwd);
                  return (
                    <li key={r.label} className={`flex items-center gap-2 text-[12px] ${ok ? 'text-bull' : 'text-text-muted'}`}>
                      <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${ok ? 'bg-bull/15' : 'bg-bg-hover'}`}>
                        {ok ? (
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                        ) : <span className="w-1 h-1 rounded-full bg-text-muted" />}
                      </span>
                      {r.label}
                    </li>
                  );
                })}
              </ul>

              <div>
                <label className="label">Confirm password</label>
                <PasswordInput
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={128}
                  placeholder="Re-enter password"
                  aria-invalid={confirm && !pwdMatch ? true : undefined}
                />
                {confirm && !pwdMatch && <p className="mt-1 text-[11px] text-bear font-semibold">Passwords do not match</p>}
              </div>

              <button type="submit" disabled={loading || !rulesPass || !pwdMatch} className="btn-primary w-full">
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </form>
          </>
        )}

        {/* ── Step 4: done ── */}
        {step === 'done' && (
          <div className="text-center py-4">
            <div className="mx-auto w-14 h-14 rounded-full bg-bull/15 text-bull flex items-center justify-center mb-3">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            </div>
            <h2 className="text-lg font-bold text-text-primary mb-2">Password updated</h2>
            <p className="text-sm text-text-secondary">Redirecting you to login…</p>
            <button onClick={() => navigate('/login', { replace: true })} className="btn-primary w-full mt-5">Go to login</button>
          </div>
        )}

        {step !== 'done' && (
          <div className="mt-6 text-center text-sm">
            <Link to="/login" className="text-teal-accent hover:underline">Back to login</Link>
          </div>
        )}
      </div>
    </AuthShell>
  );
}

/* ── 6-digit OTP input: auto-advance, backspace-back, arrow nav, paste-fill ── */
function OtpInput({ digits, setDigits, disabled, onComplete }) {
  const refs = useRef([]);

  const commit = (next) => {
    setDigits(next);
    if (next.every((d) => d !== '')) onComplete?.(next.join(''));
  };

  const onChangeBox = (i, raw) => {
    const d = raw.replace(/\D/g, '');
    if (!d) return;
    const next = [...digits];
    let pos = i;
    for (const ch of d) { if (pos < 6) { next[pos] = ch; pos += 1; } }
    commit(next);
    refs.current[Math.min(pos, 5)]?.focus();
  };

  const onKeyDownBox = (i, e) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) next[i] = '';
      else if (i > 0) { next[i - 1] = ''; refs.current[i - 1]?.focus(); }
      setDigits(next);
    } else if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
  };

  const onPaste = (e) => {
    e.preventDefault();
    const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!d) return;
    const next = Array(6).fill('');
    d.split('').forEach((c, k) => { next[k] = c; });
    commit(next);
    refs.current[Math.min(d.length, 5)]?.focus();
  };

  return (
    <div className="flex gap-2 justify-center" onPaste={onPaste}>
      {digits.map((c, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          value={c}
          disabled={disabled}
          autoFocus={i === 0}
          onChange={(e) => onChangeBox(i, e.target.value)}
          onKeyDown={(e) => onKeyDownBox(i, e)}
          onFocus={(e) => e.target.select()}
          aria-label={`Digit ${i + 1}`}
          className="w-11 h-14 sm:w-12 text-center text-xl font-bold rounded-lg border border-border-dark bg-bg-panel text-text-primary focus:border-teal-accent focus:outline-none transition-colors disabled:opacity-50"
        />
      ))}
    </div>
  );
}

/* ── Minimal 3-step progress indicator ── */
function Stepper({ step }) {
  const order = ['email', 'otp', 'password'];
  const idx = order.indexOf(step);
  return (
    <div className="flex items-center justify-center gap-2 mb-6">
      {order.map((s, i) => (
        <span
          key={s}
          className={`h-1.5 rounded-full transition-all duration-300 ${i <= idx ? 'bg-teal-accent w-8' : 'bg-border-dark w-4'}`}
        />
      ))}
    </div>
  );
}
