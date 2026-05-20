import { useState } from 'react';
import OrderModalUI from '../components/OrderModalUI';

// Preview wrapper — purely for viewing the premium order modal UI.
// Click the floating button to re-open after closing.
export default function OrderModalPreview() {
  const [open, setOpen] = useState(true);

  return (
    <div className="min-h-[80vh] bg-gradient-to-br from-slate-50 via-blue-50/30 to-emerald-50/20 flex items-center justify-center p-6">
      {/* Decorative blur orbs */}
      <span className="fixed -top-32 -left-32 w-80 h-80 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.25), transparent 70%)' }} />
      <span className="fixed -bottom-32 -right-32 w-80 h-80 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(16,185,129,0.20), transparent 70%)' }} />

      {/* Heading */}
      <div className="relative max-w-md text-center">
        <div className="text-[10px] uppercase tracking-[0.25em] font-bold text-slate-500">UI Preview</div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">Premium Order Modal</h1>
        <p className="mt-2 text-sm text-slate-500">Pure UI design — no backend or order logic wired.</p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold shadow-lg hover:scale-[1.02] active:scale-[0.98] transition-all"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12h6" /><path d="M12 9v6" />
          </svg>
          Open Order Modal
        </button>
      </div>

      <OrderModalUI open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
