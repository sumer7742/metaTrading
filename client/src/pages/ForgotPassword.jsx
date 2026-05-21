import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import BrandMark from '../components/BrandMark';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/password-reset/request', { email });
      setSubmitted(true);
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
          {!submitted ? (
            <>
              <h1 className="text-xl font-bold text-white mb-2">Forgot password?</h1>
              <p className="text-sm text-gray-400 mb-6">
                Enter your email and we'll send you a reset link valid for 30 minutes.
              </p>
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="label">Email</label>
                  <input
                    type="email"
                    className="input"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <button type="submit" disabled={loading} className="btn-primary w-full">
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
              </form>
            </>
          ) : (
            <div className="text-center py-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-bull/15 text-bull flex items-center justify-center mb-3">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-white mb-2">Check your email</h2>
              <p className="text-sm text-gray-400">
                If <b>{email}</b> is registered, a password reset link has been sent.
              </p>
            </div>
          )}
          <div className="mt-6 text-center text-sm">
            <Link to="/login" className="text-teal-accent hover:underline">Back to login</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
