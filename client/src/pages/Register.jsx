import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuthStore, errorMessage } from '../store/auth';
import BrandMark from '../components/BrandMark';
import AuthShell from '../components/AuthShell';
import PasswordInput from '../components/PasswordInput';
import { COUNTRY_OPTIONS } from '../utils/countries';
import { v, sanitize } from '../utils/validation';

export default function Register() {
  const [params] = useSearchParams();
  const refFromUrl = (params.get('ref') || '').trim().toUpperCase();
  useEffect(() => {
    if (refFromUrl) {
      try { localStorage.setItem('tradepro:pending-ref', refFromUrl); } catch (_) {}
    }
  }, [refFromUrl]);
  const referralFromStorage = (() => {
    try { return localStorage.getItem('tradepro:pending-ref') || ''; } catch (_) { return ''; }
  })();
  const initialRef = refFromUrl || referralFromStorage || '';

  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    phone: '',
    country: '',
    referralCode: initialRef,
  });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [loading, setLoading] = useState(false);
  const { register } = useAuthStore();
  const navigate = useNavigate();

  // Update with a per-field sanitiser so disallowed characters never
  // make it into state. Keeps the form value and the on-the-wire value
  // identical (no surprises at submit).
  const update = (k, clean) => (e) => {
    const raw = e.target.value;
    const next = clean ? clean(raw) : raw;
    setForm((f) => ({ ...f, [k]: next }));
    // Live-clear the error once it becomes valid — encouraging feedback.
    if (touched[k]) {
      const err = v[k] ? v[k](next, k === 'password' ? { strict: true } : undefined) : null;
      setErrors((errs) => ({ ...errs, [k]: err }));
    }
  };

  const onBlur = (field) => () => {
    setTouched((t) => ({ ...t, [field]: true }));
    const val = form[field];
    const err = v[field]
      ? v[field](val, field === 'password' ? { strict: true } : undefined)
      : null;
    setErrors((errs) => ({ ...errs, [field]: err }));
  };

  const showError = (field) => touched[field] && errors[field];

  const validateAll = () => {
    const next = {
      email:        v.email(form.email),
      password:     v.password(form.password, { strict: true }),
      firstName:    v.firstName(form.firstName),
      lastName:     v.lastName(form.lastName),
      phone:        v.phone(form.phone),
      country:      v.country(form.country),
      referralCode: v.referralCode(form.referralCode),
    };
    const cleaned = Object.fromEntries(Object.entries(next).filter(([_, val]) => val));
    setErrors(cleaned);
    return Object.keys(cleaned).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Mark every field as touched so all errors become visible at once.
    setTouched({
      email: true, password: true, firstName: true, lastName: true,
      phone: true, country: true, referralCode: true,
    });
    if (!validateAll()) {
      toast.error('Please fix the highlighted fields');
      return;
    }
    setLoading(true);
    try {
      const payload = {
        ...form,
        email: form.email.trim().toLowerCase(),
        firstName: form.firstName.trim(),
        lastName:  form.lastName.trim(),
        phone:     form.phone.trim(),
        country:   form.country.trim().toUpperCase(),
        referralCode: form.referralCode ? form.referralCode.trim().toUpperCase() : '',
      };
      await register(payload);
      try { localStorage.removeItem('tradepro:pending-ref'); } catch (_) {}
      if (payload.referralCode) {
        toast.success(`Account created · referral ${payload.referralCode} applied`);
      } else {
        toast.success('Account created! A demo account with $10,000 has been added.');
      }
      navigate('/explore');
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 'INVALID_REFERRAL_CODE' || code === 'REFERRER_BLOCKED') {
        toast.error(errorMessage(err), { duration: 6000 });
        setErrors((errs) => ({ ...errs, referralCode: errorMessage(err) }));
        setTouched((t) => ({ ...t, referralCode: true }));
        setTimeout(() => {
          const el = document.querySelector('input[name="referralCode"]');
          if (el) { el.focus(); el.select?.(); }
        }, 100);
      } else if (code === 'DUPLICATE_EMAIL') {
        setErrors((errs) => ({ ...errs, email: 'This email is already registered' }));
        setTouched((t) => ({ ...t, email: true }));
        toast.error(errorMessage(err));
      } else if (code === 'DUPLICATE_PHONE') {
        setErrors((errs) => ({ ...errs, phone: 'This phone is already registered with another account' }));
        setTouched((t) => ({ ...t, phone: true }));
        toast.error(errorMessage(err));
        setTimeout(() => {
          const el = document.querySelector('input[name="phone"]');
          if (el) { el.focus(); el.select?.(); }
        }, 100);
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
          <p className="text-sm text-text-secondary mt-3">Create your trading account</p>
        </div>

        {initialRef && (
          <div className="mb-4 rounded-lg border border-bull/30 bg-bull/10 p-3 flex items-start gap-2.5">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-bull shrink-0 mt-0.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-bull">Referral applied</div>
              <div className="text-[11.5px] text-text-secondary mt-0.5 leading-snug">
                You'll be linked to referral code{' '}
                <span className="font-mono font-bold text-text-primary">{initialRef}</span>
                {' '}after sign-up — commissions on your future trades will credit them.
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-3">
          {/* First / Last name */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First Name *</label>
              <input
                name="firstName"
                className={`input ${showError('firstName') ? 'border-bear focus:border-bear' : ''}`}
                value={form.firstName}
                onChange={update('firstName', sanitize.name)}
                onBlur={onBlur('firstName')}
                autoFocus
                autoComplete="given-name"
                maxLength={50}
                required
                aria-invalid={!!showError('firstName')}
              />
              <FieldError msg={showError('firstName')} />
            </div>
            <div>
              <label className="label">Last Name</label>
              <input
                name="lastName"
                className={`input ${showError('lastName') ? 'border-bear focus:border-bear' : ''}`}
                value={form.lastName}
                onChange={update('lastName', sanitize.name)}
                onBlur={onBlur('lastName')}
                autoComplete="family-name"
                maxLength={50}
                aria-invalid={!!showError('lastName')}
              />
              <FieldError msg={showError('lastName')} />
            </div>
          </div>

          {/* Email */}
          <div>
            <label className="label">Email *</label>
            <input
              name="email"
              type="email"
              className={`input ${showError('email') ? 'border-bear focus:border-bear' : ''}`}
              value={form.email}
              onChange={update('email', sanitize.email)}
              onBlur={onBlur('email')}
              required
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              spellCheck={false}
              aria-invalid={!!showError('email')}
            />
            <FieldError msg={showError('email')} />
          </div>

          {/* Phone */}
          <div>
            <label className="label">Phone</label>
            <input
              name="phone"
              type="tel"
              className={`input ${showError('phone') ? 'border-bear focus:border-bear' : ''}`}
              value={form.phone}
              onChange={update('phone', sanitize.phone)}
              onBlur={onBlur('phone')}
              autoComplete="tel"
              inputMode="tel"
              placeholder="+91 …"
              maxLength={16}
              aria-invalid={!!showError('phone')}
            />
            <FieldError msg={showError('phone')} />
          </div>

          {/* Country — select restricts the value to valid ISO codes */}
          <div>
            <label className="label">Country *</label>
            <select
              name="country"
              className={`input ${showError('country') ? 'border-bear focus:border-bear' : ''}`}
              value={form.country}
              onChange={update('country')}
              onBlur={onBlur('country')}
              autoComplete="country"
              required
              aria-invalid={!!showError('country')}
            >
              <option value="">Select country…</option>
              {COUNTRY_OPTIONS.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
            <FieldError msg={showError('country')} />
          </div>

          {/* Password */}
          <div>
            <label className="label">Password *</label>
            <PasswordInput
              name="password"
              value={form.password}
              onChange={update('password')}
              onBlur={onBlur('password')}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              aria-invalid={!!showError('password')}
            />
            <FieldError msg={showError('password')} />
            <PasswordStrength password={form.password} />
          </div>

          {/* Referral code */}
          <div>
            <label className="label">
              Referral Code (Optional)
              {initialRef && form.referralCode === initialRef && (
                <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-bull">· from link</span>
              )}
            </label>
            <input
              name="referralCode"
              className={`input font-mono uppercase ${
                showError('referralCode') ? 'border-bear focus:border-bear'
                : (initialRef && form.referralCode === initialRef ? 'bg-bull/5 border-bull/40' : '')
              }`}
              value={form.referralCode}
              onChange={update('referralCode', sanitize.referralCode)}
              onBlur={onBlur('referralCode')}
              placeholder="ABC12345"
              maxLength={16}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!showError('referralCode')}
            />
            <FieldError msg={showError('referralCode')} />
          </div>

          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? 'Creating...' : 'Create Account'}
          </button>
        </form>
        <div className="mt-6 text-center text-sm text-gray-400">
          Already have an account?{' '}
          <Link to="/login" className="text-primary-500 hover:text-primary-600">
            Sign in
          </Link>
        </div>
      </div>
    </AuthShell>
  );
}

// Inline error chip — same component as Login, defined locally here so
// either file can be deleted without breaking the other.
function FieldError({ msg }) {
  if (!msg) return null;
  return (
    <div className="mt-1 text-[11px] text-bear font-semibold flex items-center gap-1" role="alert">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      {msg}
    </div>
  );
}

function PasswordStrength({ password }) {
  const len = password.length;
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSym   = /[^A-Za-z0-9]/.test(password);
  const score = (len >= 8 ? 1 : 0) + (len >= 12 ? 1 : 0) + Math.min(2, [hasLower, hasUpper, hasDigit, hasSym].filter(Boolean).length - 1);
  const safeScore = Math.max(0, Math.min(4, score));
  const labels = ['Too short', 'Weak', 'Fair', 'Strong', 'Excellent'];
  const colors = ['bg-bear', 'bg-orange-500', 'bg-amber-400', 'bg-lime-500', 'bg-bull'];
  return (
    <div className="mt-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-1 flex-1 rounded transition-colors ${i < safeScore ? colors[safeScore] : 'bg-bg-hover'}`}
          />
        ))}
      </div>
      <p className="text-xs text-gray-500 mt-1">
        {len === 0 ? 'Min 8 characters · mix letters, numbers, symbols' : labels[safeScore]}
      </p>
    </div>
  );
}
