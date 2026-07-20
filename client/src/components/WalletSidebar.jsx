import { Link } from 'react-router-dom';

/**
 * WalletSidebar — left-rail nav shared between the Wallet page and the
 * new-account flow pages (/accounts/new, /accounts/new/:tier). Two
 * modes:
 *
 *   onSelect provided  → renders <button> items that call onSelect(id)
 *                        Used on the Wallet page where view state is
 *                        held locally and we don't want a navigation.
 *
 *   onSelect omitted   → renders <Link> items pointing at
 *                        /wallet?view=<id>. Used on the new-account
 *                        pages so clicking a sidebar item jumps back
 *                        to Wallet on the right tab.
 *
 * `activeId` picks the highlighted item — pass null on pages where no
 * Wallet view is currently active (e.g. /accounts/new).
 */
const NAV_ITEMS = [
  { id: 'details',  label: 'Account Details',      icon: <NIDetails /> },
  { id: 'overview', label: 'Account Overview',     icon: <NIOverview /> },
  { id: 'grow',     label: 'Deposit Funds',        icon: <NIDeposit /> },
  { id: 'withdraw', label: 'Withdraw Funds',       icon: <NIWithdraw /> },
  { id: 'transfer', label: 'Internal Transfer',    icon: <NITransfer /> },
  // Subscription Wallet is a SEPARATE page (its own balance, plan
  // charges only). Always navigate via Link even when the sidebar is
  // in onSelect-callback mode on the Wallet page.
  { id: 'subscription', label: 'Main Wallet', icon: <NISubscription />, to: '/subscription-wallet' },
  // Bonus Wallet — referral/partner earnings land here. Separate page;
  // always navigates via Link (no withdraw, transfer-only out).
  { id: 'bonus', label: 'Bonus Wallet', icon: <NIBonus />, to: '/bonus-wallet' },
  { id: 'history',  label: 'Transaction History',  icon: <NIHistory /> },
];

export default function WalletSidebar({ activeId = null, onSelect = null }) {
  return (
    <aside className="col-span-12 lg:col-span-2 xl:col-span-2 flex flex-col gap-4 min-w-0 lg:sticky lg:top-28 lg:self-start">
      <nav className="bg-white border border-border-dark rounded-2xl p-2 flex flex-row lg:flex-col gap-1 lg:gap-0.5 overflow-x-auto lg:overflow-visible no-scrollbar">
        {NAV_ITEMS.map((n) => {
          const isActive = activeId === n.id;
          const content = (
            <>
              <span className={`shrink-0 ${isActive ? 'text-primary-600' : 'text-text-muted'}`}>
                {n.icon}
              </span>
              <span className={`text-[13px] truncate ${isActive ? 'font-bold' : 'font-medium'}`}>
                {n.label}
              </span>
              {n.newBadge && (
                <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-primary-600 bg-primary-500/15 px-1.5 py-0.5 rounded">
                  New
                </span>
              )}
            </>
          );
          const className = `flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left transition-colors shrink-0 ${
            isActive
              ? 'bg-primary-500/10 text-primary-600'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
          }`;
          // Items with an explicit `to` (e.g. Subscription Wallet) ALWAYS
          // navigate via Link — they live on a separate page and can't be
          // rendered inside the Wallet view-switcher.
          if (n.to) {
            return (
              <Link key={n.id} to={n.to} className={className}>
                {content}
              </Link>
            );
          }
          if (onSelect) {
            return (
              <button key={n.id} type="button" onClick={() => onSelect(n.id)} className={className}>
                {content}
              </button>
            );
          }
          return (
            <Link key={n.id} to={`/wallet?view=${n.id}`} className={className}>
              {content}
            </Link>
          );
        })}
      </nav>

      {/* Support card — hidden on mobile */}
      <div className="hidden lg:block bg-white border border-border-dark rounded-2xl p-4">
        <div className="text-sm font-bold text-text-primary">Need Help?</div>
        <div className="text-[11px] text-text-muted mt-0.5">Our support team is available 24/7</div>
        <Link
          to="/helpdesk"
          className="mt-3 inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-xl border border-border-dark text-text-primary text-xs font-semibold hover:shadow-card transition-all"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
            <path d="M21 14v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z" />
            <path d="M3 14v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z" />
          </svg>
          Contact Support
        </Link>
      </div>

      {/* Secure footer card — hidden on mobile */}
      <div className="hidden lg:block rounded-2xl p-4 border" style={{ background: '#3B82F608', borderColor: '#3B82F633' }}>
        <div className="flex items-start gap-2.5">
          <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: '#3B82F618', color: '#3B82F6' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-text-primary">100% Secure</div>
            <div className="text-[11px] text-text-muted mt-0.5">Your funds are safe with us</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Nav glyphs (copied from Wallet so the new pages don't reach
//      back into the wallet module). Keeping them inline avoids a
//      circular import between WalletSidebar ↔ Wallet. ─────────────
const NS = (props) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props} />;
function NIOverview() { return <NS><circle cx="12" cy="12" r="9" /><path d="M9 12h6" /><path d="M12 9v6" /></NS>; }
function NIDeposit()  { return <NS><circle cx="12" cy="12" r="9" /><path d="M8 12l4-4 4 4" /><path d="M12 16V8" /></NS>; }
function NIWithdraw() { return <NS><circle cx="12" cy="12" r="9" /><path d="M8 12l4 4 4-4" /><path d="M12 8v8" /></NS>; }
function NITransfer() { return <NS><path d="M7 17l-4-4 4-4" /><path d="M3 13h13" /><path d="M17 7l4 4-4 4" /><path d="M21 11H8" /></NS>; }
function NIHistory()  { return <NS><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></NS>; }
function NIMethods()  { return <NS><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /></NS>; }
function NIDetails()  { return <NS><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" /></NS>; }
function NIBonus()    { return <NS><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M3 12h18" /><path d="M12 8v13" /><path d="M12 8s-3-5-5-3 1 3 5 3z" /><path d="M12 8s3-5 5-3-1 3-5 3z" /></NS>; }
function NISubscription() { return <NS><rect x="2" y="6" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 16h4" /><circle cx="17" cy="16" r="1.2" /></NS>; }
