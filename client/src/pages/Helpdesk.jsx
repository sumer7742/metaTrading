import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import HelpdeskChat from './HelpdeskChat';

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
  const [tab, setTab] = useState('faq');
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  const filteredKb = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return KB_ARTICLES;
    return KB_ARTICLES.filter(
      (a) => a.q.toLowerCase().includes(q) || a.a.toLowerCase().includes(q) || a.tag.toLowerCase().includes(q)
    );
  }, [search]);

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
      });
      toast.success("Ticket opened — we'll respond shortly");
      setSubject('');
      setMessage('');
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
          { k: 'chat', label: 'Live Chat', count: null },
          { k: 'faq', label: 'Knowledge Base', count: KB_ARTICLES.length },
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
                  {t.adminNote && (
                    <div className="mt-3 text-xs text-text-secondary border-l-2 border-primary-500/40 pl-3 bg-primary-500/5 py-2 rounded-r">
                      <span className="text-primary-500 font-semibold text-[10px] uppercase tracking-wider">Support Reply</span>
                      <div className="mt-1">{t.adminNote}</div>
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
          <div className="text-xs text-text-secondary leading-relaxed">{article.a}</div>
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
