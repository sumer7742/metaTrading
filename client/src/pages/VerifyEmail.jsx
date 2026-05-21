import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import BrandMark from '../components/BrandMark';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [status, setStatus] = useState('verifying'); // 'verifying' | 'success' | 'error'
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMsg('Missing verification token in URL.');
      return;
    }
    (async () => {
      try {
        await api.post('/auth/verify-email', { token });
        setStatus('success');
      } catch (err) {
        setStatus('error');
        setMsg(err?.response?.data?.error?.message || 'Verification failed');
      }
    })();
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-bg-dark">
      <div className="card p-8 max-w-md w-full text-center">
        <div className="mb-6 flex justify-center">
          <BrandMark wordmark={false} />
        </div>

        {status === 'verifying' && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-teal-accent/15 text-teal-accent flex items-center justify-center mb-3">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin" style={{ animationDuration: '1.1s' }}>
                <circle cx="12" cy="12" r="9" strokeOpacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-gray-300">Verifying your email…</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-bull/15 text-bull flex items-center justify-center mb-3">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">Email verified!</h1>
            <p className="text-sm text-gray-400 mb-4">Your account is now fully activated.</p>
            <Link to="/dashboard" className="btn-primary inline-flex">Go to Dashboard</Link>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-bear/15 text-bear flex items-center justify-center mb-3">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">Verification failed</h1>
            <p className="text-sm text-gray-400 mb-4">{msg}</p>
            <div className="flex items-center justify-center gap-2">
              <Link to="/login" className="btn-secondary inline-flex">Back to login</Link>
              <Link to="/profile" className="btn-primary inline-flex">Resend email</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
