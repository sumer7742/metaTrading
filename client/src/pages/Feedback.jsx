import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import { fmtDate } from '../utils/format';

/**
 * User-facing feedback page.
 *  - Form on the left: category, subject, message, optional rating
 *  - History on the right: last 50 submissions with status badge
 *
 * The history list re-fetches after a successful submit so the user sees
 * their entry appear immediately — confirms the submission landed and
 * doubles as a "you've already reported this" check before re-submitting.
 */

const CATEGORIES = [
  { value: 'BUG', label: '🐛 Bug Report', hint: 'Something broken or crashing' },
  { value: 'FEATURE', label: '✨ Feature Request', hint: 'New capability or idea' },
  { value: 'UX', label: '🎨 UX / Design', hint: 'Layout, copy, friction points' },
  { value: 'SUPPORT', label: '🤝 Support', hint: 'Account or trade-specific help' },
  { value: 'OTHER', label: '💬 Other', hint: 'General comments' },
];

const STATUS_STYLES = {
  OPEN: 'bg-info/15 text-info border-info/30',
  TRIAGED: 'bg-primary-500/15 text-primary-500 border-primary-500/30',
  IN_PROGRESS: 'bg-warn/15 text-warn border-warn/30',
  RESOLVED: 'bg-bull/15 text-bull border-bull/30',
  WONT_FIX: 'bg-bear/15 text-bear border-bear/30',
};

export default function Feedback() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  // Form state
  const [category, setCategory] = useState('FEATURE');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [rating, setRating] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/user/feedback');
      setItems(data.data);
    } catch (_) { /* keep previous list on transient error */ }
    finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Live: admin reply / status change pushes on `user:tickets` → merge it into
  // the matching row (or prepend) so the history updates without a refresh.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:tickets', (d) => {
      const t = d?.ticket;
      if (!t?._id) return;
      setItems((prev) => {
        const i = prev.findIndex((x) => x._id === t._id);
        if (i === -1) return [t, ...prev];
        const next = prev.slice();
        next[i] = { ...next[i], ...t };
        return next;
      });
    });
    return () => unsub && unsub();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (subject.trim().length < 3) return toast.error('Subject too short');
    if (message.trim().length < 10) return toast.error('Message too short (min 10 chars)');
    setSubmitting(true);
    try {
      await api.post('/user/feedback', {
        category,
        subject,
        message,
        rating: rating || null,
        context: {
          page: typeof window !== 'undefined' ? window.location.pathname : undefined,
          appVersion: import.meta.env.VITE_APP_VERSION || 'dev',
        },
      });
      toast.success('Thanks — feedback received');
      setSubject('');
      setMessage('');
      setRating(0);
      // Don't reset category — same user often files multiple of same kind.
      await load();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const charsLeft = 4000 - message.length;
  const charsBad = charsLeft < 0;

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold text-white">Leave Feedback</h1>
        <p className="text-sm text-text-secondary mt-2">
          Tell us what's working, what isn't, and what you'd love to see next.
          We read every submission.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* ─── Form ──────────────────────────────────────────────────── */}
        <form onSubmit={submit} className="lg:col-span-3 card p-5 sm:p-6 space-y-5">
          <div>
            <label className="label">Category</label>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setCategory(c.value)}
                  className={`text-left p-3 rounded-md border transition-colors ${
                    category === c.value
                      ? 'border-primary-500 bg-primary-500/10'
                      : 'border-border-dark hover:border-border-accent hover:bg-bg-hover'
                  }`}
                  title={c.hint}
                >
                  <div className="text-sm font-medium text-white">{c.label}</div>
                </button>
              ))}
            </div>
            <div className="text-[11px] text-text-muted mt-1.5">
              {CATEGORIES.find((c) => c.value === category)?.hint}
            </div>
          </div>

          <div>
            <label className="label">Subject</label>
            <input
              type="text"
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="One-line summary"
              className="input"
              required
            />
          </div>

          <div>
            <label className="label flex items-center justify-between">
              <span>Message</span>
              <span className={`font-mono normal-case tracking-normal text-[10px] ${
                charsBad ? 'text-bear' : 'text-text-muted'
              }`}>
                {charsLeft} chars
              </span>
            </label>
            <textarea
              maxLength={4000}
              rows={7}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Steps to reproduce, screenshot links, what you expected vs. saw…"
              className="input resize-y leading-relaxed"
              required
            />
          </div>

          <div>
            <label className="label">Overall rating (optional)</label>
            <StarPicker value={rating} onChange={setRating} />
          </div>

          <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
            <div className="text-xs text-text-muted">
              We don't share your message externally. Submissions go to the product team.
            </div>
            <button
              type="submit"
              disabled={submitting || charsBad}
              className="btn-primary"
            >
              {submitting ? 'Sending…' : 'Send Feedback'}
            </button>
          </div>
        </form>

        {/* ─── History ───────────────────────────────────────────────── */}
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-5 py-3 border-b border-border-dark">
            <h3 className="text-white font-semibold">Your Submissions</h3>
            <p className="text-[11px] text-text-muted mt-0.5">
              Latest 50 · status updates by team
            </p>
          </div>
          {loading ? (
            <div className="p-8 text-center text-sm text-text-secondary">Loading…</div>
          ) : !items.length ? (
            <div className="p-8 text-center text-sm text-text-secondary">
              No submissions yet.
            </div>
          ) : (
            <div className="divide-y divide-border-subtle max-h-[520px] overflow-y-auto">
              {items.map((it) => (
                <div key={it._id} className="px-5 py-3 hover:bg-bg-hover transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-white truncate">{it.subject}</div>
                      <div className="text-[11px] text-text-muted mt-0.5">
                        {fmtDate(it.createdAt)} · {it.category}
                        {it.rating != null && ` · ${'★'.repeat(it.rating)}`}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] uppercase font-bold px-2 py-1 rounded border shrink-0 ${
                        STATUS_STYLES[it.status] || STATUS_STYLES.OPEN
                      }`}
                    >
                      {it.status.replace('_', ' ')}
                    </span>
                  </div>
                  {it.adminReply && (
                    <div className="mt-2 text-[11px] text-text-secondary border-l-2 border-primary-500/40 pl-3 whitespace-pre-wrap">
                      <span className="text-primary-500 font-semibold">Team: </span>
                      {it.adminReply}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Five-star picker with hover preview. Click again on the active star to clear. */
function StarPicker({ value, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value;
  return (
    <div className="flex items-center gap-1.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(value === n ? 0 : n)}
          className="text-2xl leading-none transition-colors"
          aria-label={`Rate ${n} star${n > 1 ? 's' : ''}`}
          title={['', 'Very poor', 'Poor', 'Average', 'Good', 'Excellent'][n]}
        >
          <span className={n <= display ? 'text-primary-500' : 'text-text-muted'}>
            {n <= display ? '★' : '☆'}
          </span>
        </button>
      ))}
      {value > 0 && (
        <button
          type="button"
          onClick={() => onChange(0)}
          className="ml-2 text-[11px] text-text-muted hover:text-text-secondary"
        >
          Clear
        </button>
      )}
    </div>
  );
}
