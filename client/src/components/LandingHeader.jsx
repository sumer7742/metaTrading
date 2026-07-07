import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useThemeStore } from '../store/theme';

/**
 * Shared marketing header (landing + auth pages). It follows the app theme so
 * the whole surface stays consistent — light header on the light theme, white
 * text on the dark theme — and exposes the dark/light toggle.
 *
 *   sticky=true  → landing: transparent → frosted on scroll.
 *   sticky=false → auth pages: static, sits over the trading background.
 */
const NAV = [
  ['Features', '/#features'],
  ['Markets', '/#markets'],
  ['Platform', '/#platform'],
  ['How it works', '/#how'],
];

export default function LandingHeader({ sticky = true }) {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const dark = theme === 'dark';
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!sticky) return undefined;
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [sticky]);

  const frosted = dark ? 'bg-bg-card/90 backdrop-blur-xl border-b border-border-subtle shadow-card' : 'bg-white/90 backdrop-blur-xl border-b border-border-subtle shadow-card';
  // At the top of the page the bar stays lighter but still carries a soft
  // shadow so it reads as a distinct header (not floating text on the hero).
  const topBar = dark
    ? 'bg-bg-card/70 backdrop-blur-md shadow-card'
    : 'bg-white/70 backdrop-blur-md shadow-[0_4px_18px_rgba(15,23,42,0.08)]';
  const wrapCls = sticky
    ? `sticky top-0 z-50 transition-all ${scrolled ? frosted : topBar}`
    : 'relative z-10';
  const white = dark ? { color: '#fff' } : undefined;

  return (
    <header className={wrapCls}>
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 font-extrabold tracking-tight text-[19px]" style={white}>
          <span className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-base shadow-card" style={{ background: 'linear-gradient(135deg,#3B82F6 0%,#1D4ED8 100%)' }}>T</span>
          TradePro
        </Link>

        <nav className="hidden md:flex items-center gap-1">
          {NAV.map(([t, h]) => (
            <a
              key={h}
              href={h}
              className={`px-3 py-2 text-sm font-semibold transition-colors ${dark ? 'hover:opacity-100' : 'text-text-secondary hover:text-text-primary'}`}
              style={dark ? { color: 'rgba(255,255,255,0.85)' } : undefined}
            >
              {t}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {/* Theme toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={dark ? 'Light theme' : 'Dark theme'}
            className={`inline-flex items-center justify-center h-9 w-9 rounded-lg border transition-colors ${dark ? 'border-white/40 hover:bg-white/10' : 'border-border-dark text-text-secondary hover:bg-bg-hover'}`}
            style={white}
          >
            {dark ? <SunI /> : <MoonI />}
          </button>

          {dark ? (
            <>
              <Link to="/login" className="hidden sm:inline-flex items-center rounded-lg border border-white/55 px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/10" style={{ color: '#fff' }}>Sign In</Link>
              <Link to="/register" className="keep-white inline-flex items-center rounded-lg bg-white px-4 py-2 text-sm font-bold text-primary-600 transition-shadow hover:shadow-elevated">Get Started</Link>
            </>
          ) : (
            <>
              <Link to="/login" className="hidden sm:inline-flex btn-secondary text-sm px-4 py-2">Sign In</Link>
              <Link to="/register" className="btn-primary text-sm px-4 py-2">Get Started</Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

const SunI = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
const MoonI = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></svg>
);
