import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtDate } from '../utils/format';
import HelpdeskChat from './HelpdeskChat';

// Valid Helpdesk tabs — used to validate/restore the tab from the URL.
const TABS = ['chat', 'faq', 'tickets', 'new'];

/**
 * Helpdesk page — three panes:
 *  • Knowledge Base (static FAQ — answers to common questions)
 *  • My Tickets (filtered SUPPORT-category feedback rows)
 *  • New Ticket form (posts to /user/feedback with category='SUPPORT')
 *
 * Reuses the existing Feedback model so we don't add a second nearly-
 * identical schema. Server-side, category='SUPPORT' is already valid.
 */

const STATUS_STYLES = {
  OPEN: 'bg-info/15 text-info border-info/30',
  TRIAGED: 'bg-primary-500/15 text-primary-500 border-primary-500/30',
  IN_PROGRESS: 'bg-warn/15 text-warn border-warn/30',
  RESOLVED: 'bg-bull/15 text-bull border-bull/30',
  WONT_FIX: 'bg-bear/15 text-bear border-bear/30',
};

const KB_ARTICLES = [
  {
    q: 'How long do withdrawals take?',
    a: 'UPI: ≤ 2 hours. Bank transfer: 1 business day. Crypto: ~30 minutes once admin approves. High-value (>10 lakh) needs two-admin approval — adds 24h.',
    tag: 'Funds',
    link: '/wallet',
  },
  {
    q: 'Why is my position showing in CLOSING status?',
    a: 'You (or the worker) submitted a close order; engine is matching it. Auto-resolves in seconds. If it sticks for >30s, the engine likely failed — try the Close button again.',
    tag: 'Trading',
    link: '/trade',
  },
  {
    q: 'How is margin calculated?',
    a: 'margin = (quantity × price) ÷ leverage. Locked at order placement, released when the position closes. Settlement = margin + PnL − fee.',
    tag: 'Trading',
  },
  {
    q: 'What does Margin Call mean?',
    a: 'When equity / used margin × 100 ≤ 80% you get a Margin Call notification. At ≤ 50% (Stop Out level), the broker auto-liquidates your largest losing position until equity recovers.',
    tag: 'Risk',
    link: '/wallet',
  },
  {
    q: 'KYC rejected — what to do?',
    a: 'Re-upload clearer photos with all four corners visible, no glare, and matching name across documents. The rejection note tells you the specific issue.',
    tag: 'Account',
    link: '/profile',
  },
  {
    q: 'Why is BUY/SELL disabled in the order form?',
    a: 'Likely insufficient free margin, or the instrument is paused (check Mode badge). KYC must be APPROVED for live trading; demo accounts always work.',
    tag: 'Trading',
    link: '/trade',
  },
  {
    q: 'Where do I see my IB / referral commissions?',
    a: 'IB Room shows total earned + per-trade breakdown. Commissions credit to your wallet automatically when a referred user trades.',
    tag: 'Affiliate',
    link: '/ib-room',
  },
  {
    q: 'My chart shows "Loading…" forever',
    a: 'Backend likely lost DB connection or your session expired. Check Wallets — if it loads, refresh Trade. If both fail, log out and back in.',
    tag: 'Technical',
  },
];

export default function Helpdesk() {
  // Restore the exact tab + search from the URL so a refresh keeps the user
  // where they were (no snap-back to the default tab).
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(() => (TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'faq'));
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [chatUnread, setChatUnread] = useState(0);
  // Admin-managed KB articles (fetched once) — merged with the built-in defaults.
  const [adminKb, setAdminKb] = useState([]);
  useEffect(() => {
    let on = true;
    api.get('/cms/knowledge-base')
      .then((r) => { if (on) setAdminKb(Array.isArray(r.data?.data?.articles) ? r.data.data.articles : []); })
      .catch(() => { /* keep defaults only */ });
    return () => { on = false; };
  }, []);

  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attachment, setAttachment] = useState(null); // { name, dataUrl } | null
  const onAttachFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the user re-pick the same file
    if (!file) return;
    if (!/^(image\/|application\/pdf)/.test(file.type)) { toast.error('Attach an image or a PDF'); return; }
    if (file.size > 3 * 1024 * 1024) { toast.error('File too large — max 3 MB'); return; }
    const reader = new FileReader();
    reader.onload = () => setAttachment({ name: file.name, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  };

  const load = async () => {
    try {
      const { data } = await api.get('/user/feedback');
      setTickets((data.data || []).filter((f) => f.category === 'SUPPORT'));
    } catch (_) { /* keep prior list on transient error */ }
    finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Live: an admin reply / status change pushes on `user:tickets` → merge it
  // into the matching ticket so "My Tickets" updates without a manual refresh.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:tickets', (d) => {
      const t = d?.ticket;
      if (!t?._id) return;
      setTickets((prev) => {
        const i = prev.findIndex((x) => x._id === t._id);
        if (i === -1) return t.category === 'SUPPORT' ? [t, ...prev] : prev;
        const next = prev.slice();
        next[i] = { ...next[i], ...t };
        return next;
      });
    });
    return () => unsub && unsub();
  }, []);

  // Persist tab + search in the URL (replace, so we don't spam history).
  // Rehydrated above on mount → exact Helpdesk state survives a refresh.
  useEffect(() => {
    const next = new URLSearchParams();
    next.set('tab', tab);
    if (search.trim()) next.set('q', search.trim());
    setSearchParams(next, { replace: true });
  }, [tab, search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real-time unread badge on the Live Chat tab. Increments on inbound
  // messages while the user isn't on the chat tab; clears when they open it.
  const tabRef = useRef(tab);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => { if (tab === 'chat') setChatUnread(0); }, [tab]);
  useEffect(() => {
    const unsub = wsClient.subscribe('user:chat', (d) => {
      if (d?.event === 'message' && d.message?.senderRole !== 'USER') {
        setChatUnread((n) => (tabRef.current === 'chat' ? 0 : n + 1));
      }
    });
    return () => unsub && unsub();
  }, []);

  // Built-in defaults + admin-managed articles (admin ones appended).
  const allKb = useMemo(() => [...KB_ARTICLES, ...adminKb], [adminKb]);
  const filteredKb = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allKb;
    return allKb.filter(
      (a) => (a.q || '').toLowerCase().includes(q) || (a.a || '').toLowerCase().includes(q) || (a.tag || '').toLowerCase().includes(q)
    );
  }, [search, allKb]);

  const submitTicket = async (e) => {
    e.preventDefault();
    if (subject.trim().length < 3) return toast.error('Subject too short');
    if (message.trim().length < 10) return toast.error('Describe your issue (min 10 chars)');
    setSubmitting(true);
    try {
      await api.post('/user/feedback', {
        category: 'SUPPORT',
        subject,
        message,
        context: { page: '/helpdesk' },
        attachment: attachment?.dataUrl,
        attachmentName: attachment?.name,
      });
      toast.success("Ticket opened — we'll respond shortly");
      setSubject('');
      setMessage('');
      setAttachment(null);
      setTab('tickets');
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-[1400px]">
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold text-white">Helpdesk</h1>
        <p className="text-sm text-text-secondary mt-2">
          Browse the knowledge base, or open a ticket — our team responds in &lt; 24 hours.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-border-dark px-2 gap-1">
        {[
          { k: 'chat', label: 'Live Chat', count: chatUnread || null },
          { k: 'faq', label: 'Knowledge Base', count: allKb.length },
          { k: 'tickets', label: 'My Tickets', count: tickets.length },
          { k: 'new', label: 'New Ticket', count: null },
        ].map((t) => (
          <button
            key={t.k}
            onClick={() => setTab(t.k)}
            className={`relative px-4 py-3 text-sm font-medium flex items-center gap-2 transition-colors ${
              tab === t.k ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {t.label}
            {t.count != null && (
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  tab === t.k ? 'bg-primary-500/20 text-primary-500' : 'bg-bg-hover text-text-muted'
                }`}
              >
                {t.count}
              </span>
            )}
            {tab === t.k && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary-500 rounded-t-full" />}
          </button>
        ))}
      </div>

      {tab === 'chat' && <HelpdeskChat embedded />}

      {tab === 'faq' && (
        <div className="space-y-4">
          <input
            type="text"
            placeholder="Search articles… (e.g. margin, withdrawal, KYC)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input w-full sm:w-96"
          />
          {!filteredKb.length ? (
            <div className="card p-10 text-center">
              <div className="text-sm text-text-secondary">No articles match "{search}"</div>
              <button onClick={() => setTab('new')} className="btn-primary mt-4 text-xs">
                Open a ticket
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredKb.map((a, i) => <KbCard key={i} article={a} />)}
            </div>
          )}
        </div>
      )}

      {tab === 'tickets' && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
            <h3 className="text-white font-semibold">Your Tickets</h3>
            <button onClick={() => setTab('new')} className="btn-primary text-xs px-3 py-1.5">
              + New Ticket
            </button>
          </div>
          {loading ? (
            <div className="p-10 text-center text-sm text-text-secondary">Loading…</div>
          ) : !tickets.length ? (
            <div className="p-10 text-center">
              <div className="w-12 h-12 mx-auto rounded-full bg-bg-hover border border-border-dark flex items-center justify-center text-text-muted mb-3">
                <TicketIcon />
              </div>
              <div className="text-sm text-text-secondary">No tickets yet</div>
              <div className="text-xs text-text-muted mt-1">
                Browse the knowledge base — most issues are answered there.
              </div>
              <button onClick={() => setTab('new')} className="btn-primary text-xs mt-4 px-4 py-2">
                Open Your First Ticket
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border-subtle">
              {tickets.map((t) => (
                <div key={t._id} className="px-5 py-4 hover:bg-bg-hover transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-white">{t.subject}</div>
                      <div className="text-[11px] text-text-muted mt-0.5">
                        #{t._id.slice(-6).toUpperCase()} · {fmtDate(t.createdAt)}
                      </div>
                      <div className="text-xs text-text-secondary mt-2 line-clamp-2">{t.message}</div>
                    </div>
                    <span
                      className={`text-[10px] uppercase font-bold px-2 py-1 rounded border shrink-0 ${
                        STATUS_STYLES[t.status] || STATUS_STYLES.OPEN
                      }`}
                    >
                      {t.status.replace('_', ' ')}
                    </span>
                  </div>
                  {t.adminReply && (
                    <div className="mt-3 text-xs text-text-secondary border-l-2 border-primary-500/40 pl-3 bg-primary-500/5 py-2 rounded-r">
                      <span className="text-primary-500 font-semibold text-[10px] uppercase tracking-wider">
                        Support Reply{t.repliedAt ? ` · ${fmtDate(t.repliedAt)}` : ''}
                      </span>
                      <div className="mt-1 whitespace-pre-wrap">{t.adminReply}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'new' && (
        <form onSubmit={submitTicket} className="card p-5 sm:p-6 space-y-5 max-w-3xl">
          <div className="flex items-center gap-2">
            <span className="w-1 h-5 bg-primary-500 rounded-full" />
            <h2 className="text-lg font-bold text-text-primary">Open a Support Ticket</h2>
          </div>
          <p className="text-xs text-text-muted -mt-3">
            Describe your issue clearly — include account numbers, error messages, or screenshots if relevant.
          </p>

          <div>
            <label className="label">Subject</label>
            <input
              type="text"
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Withdrawal stuck in PENDING"
              className="input"
              required
            />
          </div>

          <div>
            <label className="label">Describe your issue</label>
            <textarea
              maxLength={4000}
              rows={8}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What happened? What did you expect? Steps to reproduce?"
              className="input resize-y leading-relaxed"
              required
            />
            <div className="text-[10px] text-text-muted mt-1 font-mono text-right">
              {4000 - message.length} chars left
            </div>
          </div>

          <div>
            <label className="label">Attach a file <span className="font-normal text-text-muted">(optional — image or PDF, ≤ 3 MB)</span></label>
            {attachment ? (
              <div className="flex items-center gap-3 rounded-lg border border-border-dark bg-bg-card px-3 py-2">
                {/^data:image\//.test(attachment.dataUrl) ? (
                  <img src={attachment.dataUrl} alt="attachment preview" className="w-10 h-10 rounded object-cover shrink-0 border border-border-subtle" />
                ) : (
                  <span className="w-10 h-10 rounded bg-bg-hover flex items-center justify-center text-[10px] font-bold text-text-muted shrink-0">PDF</span>
                )}
                <span className="text-xs text-text-secondary truncate flex-1 min-w-0">{attachment.name}</span>
                <button type="button" onClick={() => setAttachment(null)} className="text-xs text-bear hover:underline shrink-0">Remove</button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border-dark text-xs text-text-secondary hover:border-primary-500 hover:text-primary-600 cursor-pointer transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
                Attach image or PDF
                <input type="file" accept="image/*,application/pdf" className="hidden" onChange={onAttachFile} />
              </label>
            )}
          </div>

          <div className="bg-info/5 border border-info/30 rounded-lg p-3 text-xs text-text-secondary flex gap-2">
            <span className="text-info shrink-0 mt-0.5"><InfoIcon /></span>
            <div>
              Average first response: <span className="text-text-primary font-semibold">2-4 hours</span>.
              For urgent payment issues, ticket will be auto-prioritized.
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setTab('faq')} className="btn-secondary text-sm">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="btn-primary text-sm">
              {submitting ? 'Submitting…' : 'Submit Ticket'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// Convert a YouTube / Vimeo watch URL to an embeddable iframe src; null when we
// can't embed (caller then shows a direct <video> or a plain link).
function toEmbedUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    if (host.endsWith('youtube.com')) {
      const id = u.searchParams.get('v') || (u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : '');
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host.endsWith('vimeo.com')) {
      const id = u.pathname.split('/').filter(Boolean).pop();
      return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch { /* not a URL */ }
  return null;
}

function KbVideo({ url, title }) {
  const embed = toEmbedUrl(url);
  if (embed) {
    return (
      <div className="mt-3 aspect-video w-full overflow-hidden rounded-lg border border-border-subtle" onClick={(e) => e.stopPropagation()}>
        <iframe
          src={embed}
          title={title}
          className="w-full h-full"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
    return <video src={url} controls className="mt-3 w-full rounded-lg border border-border-subtle" onClick={(e) => e.stopPropagation()} />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 mt-2 text-xs text-primary-500 hover:underline"
    >
      ▶ Watch video
    </a>
  );
}

function KbCard({ article }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="card p-4 cursor-pointer hover:border-border-accent/50 transition-colors group"
      onClick={() => setOpen((o) => !o)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase font-bold tracking-wider text-primary-500 mb-1.5">
            {article.tag}
          </div>
          <div className="text-sm font-semibold text-text-primary group-hover:text-primary-500 transition-colors">
            {article.q}
          </div>
        </div>
        <span className={`text-text-muted text-xl shrink-0 transition-transform ${open ? 'rotate-45' : ''}`}>
          +
        </span>
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          <div className="text-xs text-text-secondary leading-relaxed whitespace-pre-line">{article.a}</div>
          {article.videoUrl && <KbVideo url={article.videoUrl} title={article.q} />}
          {article.link && (
            <Link
              to={article.link}
              className="inline-flex items-center gap-1 mt-2 text-xs text-primary-500 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Go to {article.tag} →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

const TicketIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 9V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" />
    <path d="M13 5v2M13 17v2M13 11v2" />
  </svg>
);

const InfoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);
