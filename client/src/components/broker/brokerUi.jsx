import { statusTone } from '../../services/broker';

/**
 * Small shared bits for the broker terminal — kept together so the section's
 * visual language (chips, cards, empty states) stays consistent and the page
 * components read cleanly.
 */

const TONE_CLASS = {
  bull: 'bg-bull/10 text-bull',
  bear: 'bg-bear/10 text-bear',
  info: 'bg-primary-500/10 text-primary-600',
  muted: 'bg-bg-hover text-text-muted',
};

/** Coloured status pill (order status, connection status). */
export function StatusChip({ status, className = '' }) {
  if (!status) return null;
  const tone = TONE_CLASS[statusTone(status)] || TONE_CLASS.muted;
  const label = String(status).replace(/_/g, ' ');
  return (
    <span className={`inline-flex items-center text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ${tone} ${className}`}>
      {label}
    </span>
  );
}

/** Section card wrapper — matches the app's white surface + subtle border. */
export function Card({ title, subtitle, actions, children, className = '' }) {
  return (
    <section className={`bg-white border border-border-dark rounded-xl shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-border-subtle">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-bold text-text-primary truncate">{title}</h2>}
            {subtitle && <p className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Labelled metric tile (funds, totals). */
export function Stat({ label, value, tone, sub }) {
  const valueClass = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text-primary';
  return (
    <div className="bg-bg-card border border-border-subtle rounded-lg px-4 py-3">
      <div className="text-[11px] font-medium text-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-bold font-mono tabular-nums mt-1 ${valueClass}`}>{value}</div>
      {sub != null && <div className="text-[11px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** Empty / loading / error placeholder for a panel body. */
export function Placeholder({ loading, error, empty, children }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (error) {
    return <div className="px-4 py-8 text-center text-sm text-bear">{error}</div>;
  }
  if (empty) {
    return <div className="px-4 py-8 text-center text-sm text-text-muted">{empty}</div>;
  }
  return children;
}

/** ₹ money formatter — broker accounts are INR. */
export const inr = (v, decimals = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

/** Signed P&L with bull/bear colouring. */
export function Pnl({ value, className = '' }) {
  const n = Number(value) || 0;
  const tone = n > 0 ? 'text-bull' : n < 0 ? 'text-bear' : 'text-text-muted';
  const sign = n > 0 ? '+' : '';
  return <span className={`font-mono tabular-nums ${tone} ${className}`}>{sign}{inr(n)}</span>;
}
