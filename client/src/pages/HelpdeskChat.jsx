import { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';

/**
 * Helpdesk Chat — live conversation with the user's ASSIGNED manager.
 * No manager picker: the backend resolves it from user.managerId. Realtime
 * over the existing ws stack (channel 'user:chat'). Light/white theme.
 */
export default function HelpdeskChat({ embedded = false }) {
  const [conv, setConv] = useState(null);
  const [counterpart, setCounterpart] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [theyTyping, setTheyTyping] = useState(false);
  const [uploadCfg, setUploadCfg] = useState(null);   // effective upload limits for this role
  const [pending, setPending] = useState([]);          // staged attachments before send
  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);
  const fileRef = useRef(null);
  // Mirror of `messages` so merge/poll logic can read the latest list
  // synchronously (a closure over state would be stale inside intervals).
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // Effective upload limits for this user's role (drives validation + hints).
  useEffect(() => { api.get('/chat/upload-config').then((r) => setUploadCfg(r.data.data)).catch(() => {}); }, []);

  const scrollToBottom = () => requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; });
  // Only auto-scroll when the user is already near the bottom, so an incoming
  // message never yanks them away from older history they're reading.
  const isNearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const markSeen = useCallback((id) => { if (id) api.post(`/chat/conversations/${id}/seen`).catch(() => {}); }, []);

  // Single funnel for ALL new messages — optimistic send, WS echo, and the
  // polling fallback all go through here. Dedupes by _id (so the optimistic
  // message and the socket echo never double up), keeps the thread
  // time-ordered, auto-scrolls when appropriate, and marks inbound seen.
  const mergeIncoming = useCallback((incoming, { forceScroll = false } = {}) => {
    const list = (Array.isArray(incoming) ? incoming : [incoming]).filter((m) => m && m._id);
    if (!list.length) return;
    const existing = new Set(messagesRef.current.map((m) => m._id));
    const adds = list.filter((m) => !existing.has(m._id));
    if (!adds.length) return; // everything already shown → no duplicates
    const shouldScroll = forceScroll || isNearBottom();
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m._id));
      const merged = [...prev, ...adds.filter((m) => !seen.has(m._id))];
      merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return merged;
    });
    if (shouldScroll) scrollToBottom();
    if (adds.some((m) => m.senderRole !== 'USER') && conv?._id) markSeen(conv._id);
  }, [conv?._id, markSeen]);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/chat/conversation');
      setConv(data.data.conversation);
      setCounterpart(data.data.counterpart);
      setMessages(data.data.messages || []);
      if (data.data.conversation?._id) markSeen(data.data.conversation._id);
      scrollToBottom();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  }, [markSeen]);

  useEffect(() => { load(); }, [load]);

  // Realtime — subscribe to the user's chat channel.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:chat', (d) => {
      if (!d) return;
      if (d.event === 'message') {
        mergeIncoming(d.message); // deduped vs optimistic / poll
      } else if (d.event === 'typing') {
        if (d.by !== 'USER') {
          setTheyTyping(true);
          clearTimeout(typingTimer.current);
          typingTimer.current = setTimeout(() => setTheyTyping(false), 3000);
        }
      } else if (d.event === 'seen') {
        if (d.by !== 'USER') setMessages((prev) => prev.map((m) => (m.senderRole === 'USER' && !m.seenAt ? { ...m, seenAt: new Date().toISOString() } : m)));
      } else if (d.event === 'presence') {
        setCounterpart((c) => (c && String(c.id) === String(d.userId) ? { ...c, online: d.online } : c));
      }
    });
    return () => { unsub && unsub(); clearTimeout(typingTimer.current); };
  }, [conv?._id, markSeen, mergeIncoming]);

  // Polling fallback — guarantees new messages appear without a refresh even
  // if the socket is down or an echo is missed. Fetches ONLY messages created
  // after the last one we hold (cheap; no re-downloading attachments), and
  // pauses while the tab is hidden.
  useEffect(() => {
    if (!conv?._id) return undefined;
    const id = setInterval(async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try {
        const last = messagesRef.current[messagesRef.current.length - 1];
        const params = last?.createdAt ? { after: last.createdAt } : { limit: 50 };
        const { data } = await api.get(`/chat/conversations/${conv._id}/messages`, { params });
        mergeIncoming(data.data || []);
      } catch (_) { /* transient — retry next tick */ }
    }, 5000);
    return () => clearInterval(id);
  }, [conv?._id, mergeIncoming]);

  const onType = (v) => {
    setText(v);
    const now = Date.now();
    if (conv?._id && counterpart && now - lastTypingSent.current > 1500) {
      lastTypingSent.current = now;
      api.post(`/chat/conversations/${conv._id}/typing`).catch(() => {});
    }
  };

  const send = async (attachments) => {
    const body = { text: text.trim(), attachments };
    if (!body.text && !(attachments && attachments.length)) return;
    setSending(true);
    try {
      const { data } = await api.post(`/chat/conversations/${conv._id}/messages`, body);
      setText('');
      // Optimistic: render instantly from the API response. Deduped by _id
      // against the WS echo + polling, so it never appears twice.
      mergeIncoming(data.data, { forceScroll: true });
    } catch (e) {
      const code = e.response?.data?.error?.code;
      toast.error(code === 'NO_MANAGER' ? 'No manager is assigned to you yet.' : errorMessage(e));
    } finally { setSending(false); }
  };

  // ── Attachment staging (validate → read with progress → stage → send) ──
  const extOf = (n) => { const m = String(n || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; };
  const validateFile = (file) => {
    const c = uploadCfg;
    if (!c || c.enabled === false) return 'File uploads are currently disabled.';
    const ext = extOf(file.name);
    if ((c.blockedExtensions || []).includes(ext)) return `Executable / unsafe files (.${ext}) are not allowed.`;
    if ((c.allowedExtensions || []).length && !c.allowedExtensions.includes(ext)) return `.${ext || '?'} is not allowed. Allowed: ${c.allowedExtensions.join(', ')}.`;
    if (file.size > (c.maxFileMB || 5) * 1024 * 1024) return `"${file.name}" exceeds the ${c.maxFileMB} MB per-file limit.`;
    return null;
  };

  const onPickFile = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    const c = uploadCfg;
    if (!files.length) return;
    if (!c || c.enabled === false) { toast.error('File uploads are currently disabled.'); return; }
    const maxFiles = c.maxFiles > 0 ? c.maxFiles : Infinity;       // 0 = unlimited
    const maxTotalBytes = c.maxTotalMB > 0 ? c.maxTotalMB * 1024 * 1024 : Infinity;
    let staged = pending.length;
    let runningBytes = pending.reduce((s, p) => s + (p.sizeBytes || 0), 0);
    for (const file of files) {
      if (staged >= maxFiles) { toast.error(`You can attach at most ${c.maxFiles} file(s) per message.`); break; }
      const err = validateFile(file);
      if (err) { toast.error(err); continue; }
      if (runningBytes + file.size > maxTotalBytes) { toast.error(`Total attachments would exceed the ${c.maxTotalMB} MB limit.`); continue; }
      staged += 1; runningBytes += file.size;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPending((prev) => [...prev, { id, name: file.name, mimeType: file.type, dataUrl: '', sizeBytes: file.size, progress: 0 }]);
      const reader = new FileReader();
      reader.onprogress = (ev) => { if (ev.lengthComputable) { const p = Math.round((ev.loaded / ev.total) * 100); setPending((prev) => prev.map((x) => (x.id === id ? { ...x, progress: p } : x))); } };
      reader.onload = () => setPending((prev) => prev.map((x) => (x.id === id ? { ...x, dataUrl: String(reader.result), progress: 100 } : x)));
      reader.onerror = () => { toast.error(`Failed to read "${file.name}"`); setPending((prev) => prev.filter((x) => x.id !== id)); };
      reader.readAsDataURL(file);
    }
  };
  const removePending = (id) => setPending((prev) => prev.filter((x) => x.id !== id));

  // Unified send: includes staged attachments (must be fully read first).
  const submit = () => {
    if (sending) return;
    if (pending.some((p) => !p.dataUrl)) { toast.error('Please wait — files are still being read…'); return; }
    const attachments = pending.filter((p) => p.dataUrl).map((p) => ({ name: p.name, mimeType: p.mimeType, dataUrl: p.dataUrl }));
    if (!text.trim() && !attachments.length) return;
    send(attachments);
    setPending([]);
  };

  if (loading) {
    return <div className={`${embedded ? '' : 'max-w-3xl mx-auto px-4 '}py-10 text-center text-text-muted`}>Loading chat…</div>;
  }

  const body = !counterpart ? (
    <div className="bg-white border border-border-dark rounded-2xl p-10 text-center shadow-sm">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-primary-500/10 text-primary-600 flex items-center justify-center">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
      </div>
      <h3 className="mt-3 text-base font-bold text-text-primary">A support manager will be assigned soon</h3>
      <p className="mt-1 text-sm text-text-secondary">Once your account is assigned a manager, you can chat with them here in real time.</p>
    </div>
  ) : (
    <div className="bg-white border border-border-dark rounded-2xl shadow-sm flex flex-col overflow-hidden" style={{ height: embedded ? '68vh' : '70vh' }}>
      {/* Manager card / header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-3 bg-bg-card">
        <div className="relative">
          <span className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold" style={{ background: 'linear-gradient(135deg,#3B82F6,#1D4ED8)' }}>
            {(counterpart.name || 'M').slice(0, 1).toUpperCase()}
          </span>
          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-white ${counterpart.online ? 'bg-bull' : 'bg-text-muted'}`} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold text-text-primary truncate">{counterpart.name}</div>
          <div className="text-[11px] text-text-muted">{counterpart.online ? 'Online' : 'Offline'} · Your support manager</div>
        </div>
      </div>

      {/* Thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-bg-dark">
        {messages.length === 0 && <div className="text-center text-xs text-text-muted py-8">Say hello to your support manager 👋</div>}
        {messages.map((m) => <Bubble key={m._id} m={m} mine={m.senderRole === 'USER'} />)}
        {theyTyping && <div className="text-[11px] text-text-muted px-2">{counterpart.name} is typing…</div>}
      </div>

      {/* Composer */}
      <div className="border-t border-border-subtle bg-white">
        {/* Staged attachments — removable, with read progress */}
        {pending.length > 0 && (
          <div className="px-2.5 pt-2.5 flex flex-wrap gap-2">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center gap-2 max-w-[230px] rounded-lg border border-border-dark bg-bg-card px-2.5 py-1.5">
                <span className="text-base shrink-0">📎</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold text-text-primary truncate">{p.name}</div>
                  <div className="text-[10px] text-text-muted">{(p.sizeBytes / 1024 / 1024).toFixed(2)} MB{p.progress < 100 ? ` · ${p.progress}%` : ''}</div>
                  {p.progress < 100 && <div className="mt-1 h-1 w-full rounded-full bg-bg-hover overflow-hidden"><div className="h-full bg-primary-500 transition-all" style={{ width: `${p.progress}%` }} /></div>}
                </div>
                <button type="button" onClick={() => removePending(p.id)} className="shrink-0 text-text-muted hover:text-bear" title="Remove">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="p-2.5 flex items-end gap-2">
          {uploadCfg?.enabled !== false && (
            <button type="button" onClick={() => fileRef.current?.click()} title={uploadCfg ? `Attach · max ${uploadCfg.maxFileMB} MB/file` : 'Attach'} className="p-2 rounded-lg text-text-muted hover:text-primary-600 hover:bg-bg-hover transition-colors shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>
            </button>
          )}
          <input ref={fileRef} type="file" multiple accept={uploadCfg?.allowedExtensions?.length ? uploadCfg.allowedExtensions.map((e) => '.' + e).join(',') : undefined} className="hidden" onChange={onPickFile} />
          <textarea
            value={text} onChange={(e) => onType(e.target.value)} rows={1} placeholder="Type a message…"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            className="flex-1 resize-none px-3 py-2 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none max-h-28"
          />
          <button onClick={submit} disabled={sending || (!text.trim() && pending.length === 0)} className="shrink-0 px-4 py-2 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors">Send</button>
        </div>
        {uploadCfg && (
          <div className="px-3 pb-2 text-[10px] text-text-muted">
            {uploadCfg.enabled === false
              ? 'File uploads are currently disabled by the administrator.'
              : `Allowed: ${(uploadCfg.allowedExtensions || []).slice(0, 8).join(', ') || 'any (non-executable)'} · Max ${uploadCfg.maxFileMB} MB per file`}
          </div>
        )}
      </div>
    </div>
  );

  // Embedded inside the Helpdesk page's "Live Chat" tab → render the panel
  // only (the page already supplies the heading + tab chrome).
  if (embedded) return <div className="space-y-4">{body}</div>;

  // Standalone /helpdesk/chat route → full page with its own header.
  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl sm:text-2xl font-bold text-text-primary">Support Chat</h1>
        <Link to="/helpdesk" className="text-sm font-semibold text-primary-600 hover:underline">Tickets &amp; FAQ →</Link>
      </div>
      {body}
    </div>
  );
}

function Bubble({ m, mine }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${mine ? 'bg-primary-500 text-white rounded-br-sm' : 'bg-white border border-border-dark text-text-primary rounded-bl-sm'}`}>
        {(m.attachments || []).map((a, i) => (
          <div key={i} className="mb-1.5">
            {a.mimeType?.startsWith('image/')
              ? <a href={a.dataUrl} target="_blank" rel="noreferrer"><img src={a.dataUrl} alt={a.name} className="rounded-lg max-h-48 max-w-full" /></a>
              : <a href={a.dataUrl} download={a.name} className={`inline-flex items-center gap-1.5 underline ${mine ? 'text-white/90' : 'text-primary-600'}`}>📎 {a.name || 'file'}</a>}
          </div>
        ))}
        {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
        <div className={`mt-0.5 text-[10px] flex items-center gap-1 justify-end ${mine ? 'text-white/70' : 'text-text-muted'}`}>
          {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {mine && (m.seenAt ? <span title="Seen">✓✓</span> : <span title="Sent">✓</span>)}
        </div>
      </div>
    </div>
  );
}
