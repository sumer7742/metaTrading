import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

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
      <div className="card p-8 max-w-md text-center">
        {status === 'verifying' && (
          <>
            <div className="text-teal-accent text-5xl mb-3">⏳</div>
            <p className="text-gray-300">Verifying your email…</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="text-bull text-5xl mb-3">✓</div>
            <h1 className="text-xl font-bold text-white mb-2">Email verified!</h1>
            <p className="text-sm text-gray-400 mb-4">Your account is now fully activated.</p>
            <Link to="/dashboard" className="btn-primary inline-flex">Go to Dashboard</Link>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-bear text-5xl mb-3">✗</div>
            <h1 className="text-xl font-bold text-white mb-2">Verification failed</h1>
            <p className="text-sm text-gray-400 mb-4">{msg}</p>
            <Link to="/dashboard" className="btn-secondary inline-flex">Continue</Link>
          </>
        )}
      </div>
    </div>
  );
}
