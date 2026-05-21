import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

export default function Affiliate() {
  const [summary, setSummary] = useState(null);
  const [commissions, setCommissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [s, c] = await Promise.all([
          api.get('/compliance/affiliate/summary'),
          api.get('/compliance/affiliate/commissions'),
        ]);
        setSummary(s.data.data);
        setCommissions(c.data.data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Public origin for share links — prefer the build-time env var so a
  // user sharing from localhost still hands out the live URL. Fall back
  // to deriving it from VITE_API_URL (strip the /api suffix), then to
  // window.location.origin as a last resort (dev only).
  const PUBLIC_ORIGIN = (() => {
    const explicit = (import.meta.env.VITE_PUBLIC_URL || '').replace(/\/+$/, '');
    if (explicit) return explicit;
    const apiUrl = String(import.meta.env.VITE_API_URL || '');
    if (/^https?:\/\//i.test(apiUrl)) {
      // Strip trailing /api so the share link points at the SPA root.
      return apiUrl.replace(/\/api\/?$/, '').replace(/\/+$/, '');
    }
    return window.location.origin;
  })();

  const link = summary?.referralCode
    ? `${PUBLIC_ORIGIN}/register?ref=${summary.referralCode}`
    : '';

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success('Referral link copied');
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch (_) { toast.error('Copy failed'); }
  };

  const shareNative = async () => {
    if (!link) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join me on TradePro',
          text: "I'm trading on TradePro — sign up with my link and we both win.",
          url: link,
        });
      } catch (_) { /* cancelled */ }
    } else {
      copyLink();
    }
  };

  const shareTo = (platform) => {
    if (!link) return;
    const text = encodeURIComponent("Join me on TradePro — sign up with my link and start trading.");
    const url = encodeURIComponent(link);
    const map = {
      whatsapp: `https://wa.me/?text=${text}%20${url}`,
      telegram: `https://t.me/share/url?url=${url}&text=${text}`,
      twitter:  `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      mail:     `mailto:?subject=${encodeURIComponent('Join me on TradePro')}&body=${text}%20${url}`,
    };
    window.open(map[platform], '_blank', 'noopener,noreferrer');
  };

  // Aggregate the multi-level commissions into ONE total — the page
  // now presents referral earnings as a single flat number, not as
  // L1/L2/L3 ladders.
  const stats = useMemo(() => {
    if (!summary) return null;
    return {
      total:    Number(summary.total || 0),
      paid:     Number(summary.paid || 0),
      pending:  Number(summary.pending || 0),
      refCount: Number(summary.refereeCount || 0),
    };
  }, [summary]);

  if (loading) {
    return (
      <div className="space-y-6 max-w-[1200px] mx-auto">
        <div className="h-80 rounded-3xl bg-bg-hover/40 animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-2xl bg-bg-hover/40 animate-pulse" />)}
        </div>
        <div className="h-64 rounded-2xl bg-bg-hover/40 animate-pulse" />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="max-w-md mx-auto card p-6 text-center text-bear">
        Could not load referral data.
      </div>
    );
  }

  const fmt = (n) =>
    Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="max-w-[1200px] mx-auto space-y-8">

      {/* ════════════════════════════════════════════════════════════════
          HERO
          A single dramatic banner with the referral link front-and-centre.
          Dark gradient bg, soft animated blobs, illustration on the right.
          ════════════════════════════════════════════════════════════════ */}
      <section
        className="relative overflow-hidden rounded-3xl border border-border-dark"
        style={{
          background:
            'radial-gradient(85% 130% at 15% 0%, rgba(59,130,246,0.28) 0%, rgba(59,130,246,0) 55%),' +
            'radial-gradient(65% 110% at 105% 105%, rgba(236,72,153,0.22) 0%, rgba(236,72,153,0) 65%),' +
            'linear-gradient(135deg, #0B1220 0%, #1E293B 55%, #0B1220 100%)',
        }}
      >
        {/* Floating decorative orbs */}
        <div className="absolute -top-20 -left-20 w-72 h-72 rounded-full bg-blue-500/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 right-20 w-80 h-80 rounded-full bg-pink-500/15 blur-3xl pointer-events-none" />

        {/* Grid pattern overlay */}
        <svg className="absolute inset-0 w-full h-full opacity-[0.06] pointer-events-none" aria-hidden="true">
          <defs>
            <pattern id="aff-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#aff-grid)" />
        </svg>

        <div className="relative grid grid-cols-1 lg:grid-cols-12 gap-8 p-6 sm:p-10 lg:p-12">
          {/* LEFT — copy + link.
              We force colors inline because the app's light-mode CSS rewrites
              `text-white` / `text-gray-300` etc. to nearly-black, which made
              the hero copy invisible on the dark gradient. */}
          <div className="lg:col-span-7 flex flex-col justify-center hero-light">
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur text-[10px] font-extrabold uppercase tracking-[0.18em] w-fit"
              style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(255,255,255,0.95)' }}
            >
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70 animate-ping" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              Refer · Earn · Repeat
            </span>

            <h1
              className="mt-4 text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.02]"
              style={{ color: '#FFFFFF' }}
            >
              Invite friends.<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-violet-400 to-pink-400">
                Earn forever.
              </span>
            </h1>

            <p
              className="mt-5 text-base sm:text-lg leading-relaxed max-w-xl"
              style={{ color: 'rgba(226,232,240,0.88)' }}
            >
              Share your link with friends. For every friend who signs up
              through it, you earn a referral bonus — credited straight to
              your wallet.
            </p>

            {/* Referral link box */}
            <div
              className="mt-7 rounded-2xl backdrop-blur-md p-3 sm:p-4 max-w-xl shadow-elevated"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.18)' }}
            >
              <div className="flex items-center justify-between mb-2">
                <span
                  className="text-[10px] uppercase tracking-[0.18em] font-bold"
                  style={{ color: 'rgba(203,213,225,0.85)' }}
                >
                  Your personal link
                </span>
                <span
                  className="font-mono text-[10.5px] px-2 py-0.5 rounded"
                  style={{ color: 'rgba(255,255,255,0.92)', background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.15)' }}
                >
                  {summary.referralCode || '—'}
                </span>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <div
                  className="flex-1 min-w-0 font-mono text-[12px] sm:text-[13px] truncate px-3 py-2.5 rounded-lg"
                  style={{ color: '#FFFFFF', background: 'rgba(0,0,0,0.40)', border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  {link || 'Loading…'}
                </div>
                <button
                  onClick={copyLink}
                  disabled={!link}
                  className="shrink-0 inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg font-bold text-sm transition-all whitespace-nowrap"
                  style={{
                    background: copied ? '#10B981' : '#FFFFFF',
                    color: copied ? '#FFFFFF' : '#0F172A',
                    boxShadow: copied ? '0 4px 14px rgba(16,185,129,0.35)' : '0 4px 14px rgba(255,255,255,0.18)',
                  }}
                >
                  {copied ? (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                      Copy link
                    </>
                  )}
                </button>
              </div>

              {/* Quick-share row */}
              <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                <span
                  className="text-[10px] uppercase tracking-wider font-bold mr-1"
                  style={{ color: 'rgba(148,163,184,0.95)' }}
                >
                  Share via
                </span>
                <ShareBtn onClick={() => shareTo('whatsapp')} color="#25D366">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.1-1.7-.8-2-.9-.3-.1-.5-.1-.7.2-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.1-1.2-.4-2.4-1.5-.9-.8-1.5-1.8-1.6-2.1-.2-.3 0-.5.1-.6l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5 0-.1-.7-1.7-1-2.3-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1 2.9 1.2 3.1c.1.2 2 3.1 4.9 4.3.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.5-.1 1.7-.7 1.9-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3zM12 2C6.5 2 2 6.5 2 12c0 1.9.5 3.6 1.5 5.2L2 22l5-1.5c1.5.9 3.2 1.4 5 1.4 5.5 0 10-4.5 10-10S17.5 2 12 2z" /></svg>
                  WhatsApp
                </ShareBtn>
                <ShareBtn onClick={() => shareTo('telegram')} color="#229ED9">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" /></svg>
                  Telegram
                </ShareBtn>
                <ShareBtn onClick={() => shareTo('twitter')} color="#FFFFFF">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                  X
                </ShareBtn>
                <ShareBtn onClick={() => shareTo('mail')} color="#FFFFFF">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                  Email
                </ShareBtn>
                <button
                  type="button"
                  onClick={shareNative}
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors"
                  style={{ color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.20)' }}
                  title="More share options"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>
                  More
                </button>
              </div>
            </div>
          </div>

          {/* RIGHT — illustration */}
          <div className="lg:col-span-5 flex items-center justify-center">
            <ReferIllustration />
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════════════
          STATS — total earnings · paid · pending · referees
          ════════════════════════════════════════════════════════════════ */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Total earnings"
          value={`$${fmt(stats.total)}`}
          accent="primary"
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>}
        />
        <StatCard
          label="Paid to wallet"
          value={`$${fmt(stats.paid)}`}
          accent="bull"
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
        />
        <StatCard
          label="Pending"
          value={`$${fmt(stats.pending)}`}
          accent="warn"
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}
        />
        <StatCard
          label="Friends joined"
          value={stats.refCount}
          accent="violet"
          icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>}
        />
      </section>

      {/* ════════════════════════════════════════════════════════════════
          HOW IT WORKS — 3 simple steps
          ════════════════════════════════════════════════════════════════ */}
      <section>
        <h2 className="text-text-primary text-xl font-extrabold tracking-tight mb-4">How it works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Step
            num={1}
            accent="from-blue-500 to-blue-700"
            title="Share your link"
            body="Send your unique referral link to friends via WhatsApp, Telegram, or email."
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>}
          />
          <Step
            num={2}
            accent="from-violet-500 to-violet-700"
            title="They sign up"
            body="Your friend opens your link, creates their account, and is automatically linked to you."
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" /></svg>}
          />
          <Step
            num={3}
            accent="from-emerald-500 to-emerald-700"
            title="You get a referral bonus"
            body="A bonus is credited to your wallet for every friend you successfully refer — withdraw anytime."
            icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg>}
          />
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════════════
          ACTIVITY — flat list of referral earnings (no level jargon)
          ════════════════════════════════════════════════════════════════ */}
      <section className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-border-dark flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-text-primary font-bold tracking-tight text-lg">Referral bonuses</h2>
            <p className="text-xs text-text-muted mt-0.5">
              Every referral bonus credited to your wallet, newest first.
            </p>
          </div>
          <span className="text-[10px] uppercase tracking-[0.15em] font-bold text-text-muted bg-bg-hover/60 px-2 py-1 rounded">
            {commissions.length} {commissions.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        {commissions.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-bg-hover to-bg-card flex items-center justify-center text-text-muted mb-4 border border-border-subtle">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
            </div>
            <div className="text-base font-bold text-text-primary">No referral bonuses yet</div>
            <div className="text-sm text-text-muted mt-1 max-w-sm mx-auto">
              Share your link above — your first referral bonus will appear here once a friend signs up.
            </div>
            <button onClick={copyLink} className="mt-4 btn-primary text-sm">
              Copy referral link
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {commissions.map((c) => {
              const isAdj = c.sourceType === 'ADJUSTMENT';
              const when = new Date(c.createdAt);
              return (
                <div key={c._id} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-bg-hover/40 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`w-9 h-9 shrink-0 rounded-lg flex items-center justify-center ${
                      isAdj ? 'bg-violet-500/15 text-violet-500' : 'bg-bull/15 text-bull'
                    }`}>
                      {isAdj ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="text-text-primary text-sm font-semibold truncate">
                        {isAdj ? 'Bonus from admin' : 'Referral earning'}
                      </div>
                      <div className="text-[11px] text-text-muted truncate">
                        {isAdj && c.note ? c.note + ' · ' : ''}
                        {when.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right">
                      <div className="text-bull font-mono font-extrabold tabular-nums">
                        +${Number(c.amount).toFixed(2)}
                      </div>
                      <div className="text-[10px] text-text-muted font-mono">{c.currency || 'USD'}</div>
                    </div>
                    <span className={`text-[9.5px] font-bold uppercase tracking-wider px-2 py-1 rounded ${
                      c.status === 'PAID'      ? 'bg-bull/15 text-bull' :
                      c.status === 'REVERSED'  ? 'bg-bear/15 text-bear' :
                                                 'bg-warn/15 text-warn'
                    }`}>{c.status}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ════════════════════════════════════════════════════════════════
          FOOTER NOTE
          ════════════════════════════════════════════════════════════════ */}
      <p className="text-center text-[11px] text-text-muted">
        Referral bonuses are credited to your primary trading wallet.
        Bonuses are reviewed and released by our admin team.
      </p>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function ShareBtn({ children, onClick, color = '#FFFFFF' }) {
  // Inline styles to bypass the light-mode text-white override.
  // Background is a tinted version of the brand color (with alpha) so
  // the chip reads as "WhatsApp green" etc. on the dark hero.
  const tint = color === '#FFFFFF' ? 'rgba(255,255,255,0.10)' : `${color}26`; // ~15% alpha
  const border = color === '#FFFFFF' ? 'rgba(255,255,255,0.20)' : `${color}55`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded transition-colors hover:brightness-110"
      style={{ color, background: tint, border: `1px solid ${border}` }}
    >
      {children}
    </button>
  );
}

function StatCard({ label, value, accent, icon }) {
  const tone = {
    primary: { iconBg: 'bg-primary-500/15 text-primary-500', glow: 'hover:shadow-[0_6px_20px_rgba(59,130,246,0.18)]', ring: 'hover:ring-primary-500/30' },
    bull:    { iconBg: 'bg-bull/15 text-bull',               glow: 'hover:shadow-[0_6px_20px_rgba(16,185,129,0.18)]', ring: 'hover:ring-bull/30' },
    warn:    { iconBg: 'bg-warn/15 text-warn',               glow: 'hover:shadow-[0_6px_20px_rgba(245,158,11,0.18)]', ring: 'hover:ring-warn/30' },
    violet:  { iconBg: 'bg-violet-500/15 text-violet-500',   glow: 'hover:shadow-[0_6px_20px_rgba(139,92,246,0.18)]', ring: 'hover:ring-violet-500/30' },
  }[accent] || {};
  return (
    <div className={`bg-white border border-border-subtle rounded-2xl p-5 transition-all hover:-translate-y-0.5 hover:ring-1 ${tone.ring} ${tone.glow}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-text-muted">{label}</div>
          <div className="text-2xl font-extrabold text-text-primary mt-2 font-mono tabular-nums tracking-tight">{value}</div>
        </div>
        <span className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${tone.iconBg}`}>{icon}</span>
      </div>
    </div>
  );
}

function Step({ num, accent, title, body, icon }) {
  return (
    <div className="relative bg-white border border-border-subtle rounded-2xl p-5 overflow-hidden hover:-translate-y-0.5 hover:shadow-card transition-all">
      {/* Big background numeral */}
      <span className={`absolute -right-2 -top-4 text-[88px] font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-br ${accent} opacity-[0.07] select-none pointer-events-none leading-none`}>
        {num}
      </span>
      <div className={`relative w-11 h-11 rounded-xl bg-gradient-to-br ${accent} text-white flex items-center justify-center shadow-card`}>
        {icon}
      </div>
      <div className="relative mt-4">
        <div className="text-[10px] uppercase tracking-[0.18em] font-bold text-text-muted">Step {num}</div>
        <h3 className="text-text-primary font-extrabold tracking-tight mt-1 text-base">{title}</h3>
        <p className="text-sm text-text-secondary mt-1.5 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function ReferIllustration() {
  // Three smiling people circles + connecting gift box with confetti.
  // Simple, friendly, no level-numbers — just "you share with friends".
  return (
    <svg viewBox="0 0 320 260" width="100%" height="100%" className="max-w-[360px]" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="il-card" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.05" />
        </linearGradient>
        <linearGradient id="il-gift" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
        <linearGradient id="il-ribbon" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FCD34D" />
          <stop offset="100%" stopColor="#F59E0B" />
        </linearGradient>
        <radialGradient id="il-coin">
          <stop offset="0%" stopColor="#FDE68A" />
          <stop offset="100%" stopColor="#F59E0B" />
        </radialGradient>
      </defs>

      {/* Dashed orbits */}
      <circle cx="160" cy="135" r="100" fill="none" stroke="white" strokeWidth="1" strokeDasharray="3 6" opacity="0.15" />
      <circle cx="160" cy="135" r="70"  fill="none" stroke="white" strokeWidth="1" strokeDasharray="3 6" opacity="0.10" />

      {/* Center gift box */}
      <g transform="translate(160 135)">
        {/* Box base */}
        <rect x="-28" y="-8" width="56" height="40" rx="4" fill="url(#il-gift)" stroke="#1E293B" strokeWidth="1" />
        {/* Box lid */}
        <rect x="-32" y="-18" width="64" height="14" rx="3" fill="url(#il-gift)" stroke="#1E293B" strokeWidth="1" />
        {/* Vertical ribbon */}
        <rect x="-4" y="-18" width="8" height="50" fill="url(#il-ribbon)" />
        {/* Bow */}
        <circle cx="0" cy="-22" r="6" fill="url(#il-ribbon)" stroke="#92400E" strokeWidth="0.5" />
        <circle cx="-10" cy="-22" r="5" fill="url(#il-ribbon)" stroke="#92400E" strokeWidth="0.5" />
        <circle cx="10" cy="-22" r="5" fill="url(#il-ribbon)" stroke="#92400E" strokeWidth="0.5" />
      </g>

      {/* Friend bubble — left */}
      <g transform="translate(50 100)">
        <circle r="26" fill="#1E293B" stroke="#3B82F6" strokeWidth="2.5" />
        <circle cx="0" cy="-5" r="8" fill="#FDE68A" />
        <path d="M -10 8 Q 0 16 10 8" fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="-3" cy="-6" r="1" fill="#1E293B" />
        <circle cx="3" cy="-6" r="1" fill="#1E293B" />
      </g>

      {/* Friend bubble — top right */}
      <g transform="translate(260 75)">
        <circle r="22" fill="#1E293B" stroke="#A855F7" strokeWidth="2.5" />
        <circle cx="0" cy="-4" r="7" fill="#FDE68A" />
        <path d="M -8 6 Q 0 13 8 6" fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="-2.5" cy="-5" r="1" fill="#1E293B" />
        <circle cx="2.5" cy="-5" r="1" fill="#1E293B" />
      </g>

      {/* Friend bubble — bottom right */}
      <g transform="translate(245 210)">
        <circle r="20" fill="#1E293B" stroke="#EC4899" strokeWidth="2.5" />
        <circle cx="0" cy="-4" r="6.5" fill="#FDE68A" />
        <path d="M -7 5 Q 0 11 7 5" fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="-2.2" cy="-4.5" r="0.9" fill="#1E293B" />
        <circle cx="2.2" cy="-4.5" r="0.9" fill="#1E293B" />
      </g>

      {/* Friend bubble — bottom left */}
      <g transform="translate(75 215)">
        <circle r="18" fill="#1E293B" stroke="#10B981" strokeWidth="2.5" />
        <circle cx="0" cy="-3.5" r="6" fill="#FDE68A" />
        <path d="M -6 4 Q 0 10 6 4" fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="-2" cy="-4" r="0.8" fill="#1E293B" />
        <circle cx="2" cy="-4" r="0.8" fill="#1E293B" />
      </g>

      {/* Lines from friends to gift */}
      <path d="M 75 105 Q 110 130 138 130" fill="none" stroke="#3B82F6" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
      <path d="M 240 80 Q 200 110 180 125" fill="none" stroke="#A855F7" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
      <path d="M 225 205 Q 200 175 182 150" fill="none" stroke="#EC4899" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />
      <path d="M 95 210 Q 130 180 142 155" fill="none" stroke="#10B981" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />

      {/* Floating coins */}
      <g transform="translate(35 50)">
        <circle r="11" fill="url(#il-coin)" stroke="#92400E" strokeWidth="1" />
        <text y="4" textAnchor="middle" fontSize="13" fontWeight="900" fill="#78350F" fontFamily="Georgia, serif">$</text>
      </g>
      <g transform="translate(285 35)">
        <circle r="8" fill="url(#il-coin)" stroke="#92400E" strokeWidth="1" />
        <text y="3" textAnchor="middle" fontSize="10" fontWeight="900" fill="#78350F" fontFamily="Georgia, serif">$</text>
      </g>
      <g transform="translate(295 155)">
        <circle r="9" fill="url(#il-coin)" stroke="#92400E" strokeWidth="1" />
        <text y="3.5" textAnchor="middle" fontSize="11" fontWeight="900" fill="#78350F" fontFamily="Georgia, serif">$</text>
      </g>
      <g transform="translate(25 165)">
        <circle r="8" fill="url(#il-coin)" stroke="#92400E" strokeWidth="1" />
        <text y="3" textAnchor="middle" fontSize="10" fontWeight="900" fill="#78350F" fontFamily="Georgia, serif">$</text>
      </g>

      {/* Confetti sparkles */}
      <circle cx="160" cy="40"  r="2"   fill="#FCD34D" />
      <circle cx="190" cy="55"  r="1.5" fill="#FFFFFF" opacity="0.8" />
      <circle cx="135" cy="55"  r="1.5" fill="#FFFFFF" opacity="0.8" />
      <rect   x="120" y="35"   width="3" height="3" fill="#EC4899" transform="rotate(35 121.5 36.5)" />
      <rect   x="200" y="30"   width="3" height="3" fill="#3B82F6" transform="rotate(20 201.5 31.5)" />
    </svg>
  );
}
