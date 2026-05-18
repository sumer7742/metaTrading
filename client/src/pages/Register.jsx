import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuthStore, errorMessage } from '../store/auth';

export default function Register() {
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    phone: '',
    country: '',
    referralCode: '',
  });
  const [loading, setLoading] = useState(false);
  const { register } = useAuthStore();
  const navigate = useNavigate();

  const update = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password.length < 8) return toast.error('Password must be at least 8 characters');
    setLoading(true);
    try {
      await register(form);
      toast.success('Account created! A demo account with $10,000 has been added.');
      navigate('/explore');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
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
          <p className="text-sm text-text-secondary mt-3">Create your trading account</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">First Name</label>
              <input className="input" value={form.firstName} onChange={update('firstName')} />
            </div>
            <div>
              <label className="label">Last Name</label>
              <input className="input" value={form.lastName} onChange={update('lastName')} />
            </div>
          </div>
          <div>
            <label className="label">Email *</label>
            <input type="email" className="input" value={form.email} onChange={update('email')} required />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" value={form.phone} onChange={update('phone')} />
          </div>
          <div>
            <label className="label">Country (ISO code, e.g. IN, US, GB)</label>
            <input className="input" value={form.country} onChange={update('country')} maxLength={2} placeholder="IN" />
          </div>
          <div>
            <label className="label">Password *</label>
            <input
              type="password"
              className="input"
              value={form.password}
              onChange={update('password')}
              required
              minLength={8}
            />
            <p className="text-xs text-gray-500 mt-1">Min 8 characters</p>
          </div>
          <div>
            <label className="label">Referral Code (Optional)</label>
            <input className="input" value={form.referralCode} onChange={update('referralCode')} />
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
    </div>
  );
}
