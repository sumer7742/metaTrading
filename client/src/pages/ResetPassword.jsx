import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

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
          <div className="inline-flex items-center gap-2 text-2xl font-bold text-white">
            <span className="w-10 h-10 rounded-lg bg-teal-accent text-bg-dark flex items-center justify-center">▲</span>
            TradePro
          </div>
        </div>

        <div className="card p-8">
          {!token ? (
            <div className="text-center text-bear">Invalid reset link. Request a new one.</div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-white mb-2">Set a new password</h1>
              <p className="text-sm text-gray-400 mb-6">Choose a strong password (8+ characters).</p>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="label">New password</label>
                  <input type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
                </div>
                <div>
                  <label className="label">Confirm password</label>
                  <input type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
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
