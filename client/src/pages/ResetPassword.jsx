import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import BrandMark from '../components/BrandMark';
import PasswordInput from '../components/PasswordInput';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 8) return toast.error('Password must be at least 8 characters');
    if (password !== confirm) return toast.error('Passwords do not match');
    setLoading(true);
    try {
      await api.post('/auth/password-reset/confirm', { token, newPassword: password });
      toast.success('Password reset. Please log in.');
      navigate('/login');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg-dark">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <BrandMark />
        </div>

        <div className="card p-8">
          {!token ? (
            <div className="text-center py-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-bear/15 text-bear flex items-center justify-center mb-3">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-white mb-2">Invalid reset link</h2>
              <p className="text-sm text-gray-400 mb-4">
                This link is missing a token or has expired. Reset links are valid for 30&nbsp;minutes.
              </p>
              <Link to="/forgot-password" className="btn-primary inline-flex">Request a new link</Link>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-white mb-2">Set a new password</h1>
              <p className="text-sm text-gray-400 mb-6">Choose a strong password (8+ characters).</p>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="label">New password</label>
                  <PasswordInput
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    autoFocus
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="label">Confirm password</label>
                  <PasswordInput
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    minLength={8}
                    autoComplete="new-password"
                  />
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full">
                  {loading ? 'Resetting…' : 'Reset password'}
                </button>
              </form>
            </>
          )}
          <div className="mt-6 text-center text-sm">
            <Link to="/login" className="text-teal-accent hover:underline">Back to login</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
