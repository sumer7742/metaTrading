import { useWatchlists } from '../hooks/useWatchlists';
import { useWatchlistModal } from './watchlistModalContext';

/**
 * <WatchlistButton /> — the bookmark control dropped onto every instrument
 * card / list row, for any asset class. Clicking it opens the shared
 * "Add to Watchlist" modal for `symbol`.
 *
 * Visibility (driven purely by Tailwind, `md` = desktop):
 *   • Mobile     → always visible.
 *   • Desktop    → hidden, fades + slides in on card hover (the PARENT must
 *                  carry the `group` class). Keyboard focus also reveals it.
 *   • Saved      → always visible (active bookmark persists on every breakpoint).
 *   • persistent → always visible on every breakpoint regardless of hover.
 *                  Use for header / toolbar placements (e.g. the chart-header
 *                  / order-panel button) that aren't a hover-reveal row action.
 *
 * Rendered as a focusable <span role="button"> rather than a <button> so it
 * can be nested inside card/row elements that are themselves <button>s
 * without producing invalid (button-in-button) markup. Clicks are stopped
 * from bubbling so the card's own onClick (usually "open trade") never fires.
 *
 * `variant`:
 *   • 'overlay' (default) → pill with bg/border/shadow, for absolute overlay
 *                           on top of card artwork.
 *   • 'ghost'             → bare icon, for list rows where the row's own
 *                           hover background provides the affordance.
 *   • 'toolbar'           → crisp h-8 bordered square that matches the chart
 *                           toolbar's other action buttons (expand/fullscreen).
 */
const BookmarkIcon = ({ size, filled }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

export default function WatchlistButton({
  symbol,
  row = null,
  size = 16,
  variant = 'overlay',
  persistent = false,
  className = '',
}) {
  const { inAnyList } = useWatchlists();
  const { open } = useWatchlistModal();

  if (!symbol) return null;
  const saved = inAnyList(symbol);

  const activate = (e) => {
    e.preventDefault();
    e.stopPropagation();
    open(symbol, row);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') activate(e);
  };

  const pad = size >= 18 ? 'p-2' : 'p-1.5';
  const base = 'inline-flex items-center justify-center cursor-pointer select-none transition-all duration-200 ease-out active:scale-95';

  // Each variant owns its own shape (radius + sizing) so a toolbar button can
  // be a crisp h-8 square while card overlays stay soft pill-rounded.
  const skin =
    variant === 'toolbar'
      ? saved
        ? 'h-8 w-8 rounded text-primary-500 bg-primary-500/10 border border-primary-500/40'
        : 'h-8 w-8 rounded text-text-secondary bg-white border border-border-dark hover:text-primary-500 hover:bg-bg-hover hover:border-border-accent'
      : variant === 'overlay'
        ? saved
          ? `${pad} rounded-lg text-primary-500 bg-white/95 border border-primary-500/30 shadow-sm`
          : `${pad} rounded-lg text-text-muted bg-white/90 border border-border-dark shadow-sm hover:text-primary-500 hover:border-primary-500/40`
        : saved
          ? `${pad} rounded-lg text-primary-500`
          : `${pad} rounded-lg text-text-muted hover:text-primary-500`;

  // Always-on when saved or persistent; otherwise mobile-on / desktop-hover
  // (fade + slide). Opacity/translate (not display) → zero layout shift.
  const visibility = (saved || persistent)
    ? 'opacity-100 translate-x-0'
    : 'opacity-100 translate-x-0 ' +
      'md:opacity-0 md:translate-x-1.5 md:pointer-events-none ' +
      'md:group-hover:opacity-100 md:group-hover:translate-x-0 md:group-hover:pointer-events-auto ' +
      'md:focus-visible:opacity-100 md:focus-visible:translate-x-0 md:focus-visible:pointer-events-auto';

  return (
    <span
      role="button"
      tabIndex={0}
      aria-pressed={saved}
      aria-label={saved ? `Edit watchlists for ${symbol}` : `Add ${symbol} to watchlist`}
      title={saved ? 'In your watchlist — edit' : 'Add to Watchlist'}
      onClick={activate}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className={`${base} ${skin} ${visibility} ${className}`}
    >
      <BookmarkIcon size={size} filled={saved} />
    </span>
  );
}
