/**
 * Reusable hero header for inner pages — matches the Dashboard's style:
 * yellow eyebrow, big title, subtitle, optional right-side action slot,
 * subtle radial yellow glow + grid pattern backdrop.
 *
 * Use as the first child of any page so the visual rhythm is consistent
 * across Wallet, Accounts, Reports, Profile, etc.
 *
 * Props:
 *   eyebrow   — small uppercase label above the title (e.g. "Trading")
 *   title     — main heading (string or node)
 *   subtitle  — supporting copy (string or node)
 *   actions   — optional right-aligned slot for buttons/links
 *   children  — optional extra content under the subtitle (chips, stats)
 */
export default function PageHero({ eyebrow, title, subtitle, actions, children }) {
  return (
    <div className="relative rounded-2xl border border-border-dark bg-bg-card p-6 sm:p-8 mb-6">
      {/* Decorative gradient + grid — clipped to its own wrapper so any
          dropdowns inside `actions` aren't accidentally cut off. */}
      <div className="absolute inset-0 rounded-2xl overflow-hidden pointer-events-none">
        <div
          className="absolute inset-0 opacity-50"
          style={{ background: 'radial-gradient(circle at 100% 0%, rgba(252, 213, 53, 0.10), transparent 55%)' }}
        />
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.4) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        />
      </div>

      <div className="relative flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] font-bold text-primary-500 mb-3">
              <span className="w-6 h-px bg-primary-500" />
              {eyebrow}
            </div>
          )}
          <h1 className="text-2xl sm:text-3xl font-bold text-white">{title}</h1>
          {subtitle && (
            <p className="text-sm text-text-secondary mt-2 max-w-2xl">{subtitle}</p>
          )}
          {children && <div className="mt-4">{children}</div>}
        </div>
        {actions && <div className="shrink-0 flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
    </div>
  );
}
