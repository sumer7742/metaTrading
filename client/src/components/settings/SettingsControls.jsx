/**
 * Animated pill toggle — used for every on/off setting.
 * Pure presentational; parent owns state.
 */
export function Toggle({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:opacity-40 disabled:cursor-not-allowed ${
        checked
          ? 'bg-primary-500 border-primary-500'
          : 'bg-bg-hover border-border-dark'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
        style={{ marginTop: '0.5px' }}
      />
    </button>
  );
}

/**
 * Checkbox with a custom check icon — used inside Calendar Filters.
 */
export function Checkbox({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-left disabled:opacity-40 group"
    >
      <span
        className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all shrink-0 ${
          checked
            ? 'bg-primary-500 border-primary-500'
            : 'bg-white border-border-dark group-hover:border-primary-500/50'
        }`}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="keep-white">
            <path d="M5 13l4 4L19 7" />
          </svg>
        )}
      </span>
      <span className={`text-xs font-medium transition-colors ${checked ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}`}>{label}</span>
    </button>
  );
}

/**
 * Native <select> dropdown — matches the platform's existing dropdown
 * style (same as the instruments-category filter). Reliable, fits the
 * narrow drawer with no overflow / clipping issues, and feels native
 * on every device including mobile.
 */
export function Dropdown({ value, onChange, options, label }) {
  return (
    <div className="relative inline-block">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="appearance-none cursor-pointer pl-3 pr-7 py-1.5 rounded-lg border border-border-dark bg-white text-xs font-semibold text-text-primary hover:border-primary-500/40 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 transition-all min-w-[120px]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <svg
        width="11" height="11" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary pointer-events-none"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}

/**
 * Section block — uppercase header + subtle divider + children.
 */
export function SettingsSection({ title, children, id }) {
  return (
    <section data-section-id={id} className="space-y-2">
      <h3 className="text-[10px] uppercase tracking-[0.18em] font-bold text-text-muted px-1">{title}</h3>
      <div className="bg-white rounded-xl border border-border-dark shadow-sm divide-y divide-border-subtle overflow-hidden">
        {children}
      </div>
    </section>
  );
}

/**
 * Single row inside a section — label/desc on the left, control on the right.
 */
export function SettingsRow({ label, desc, children }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 hover:bg-bg-hover/40 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-text-primary truncate">{label}</div>
        {desc && <div className="text-[10px] text-text-muted truncate mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
