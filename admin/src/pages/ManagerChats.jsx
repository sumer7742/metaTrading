import { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import PageHero from '../components/PageHero';
import { useAuthStore } from '../store/auth';

/**
 * Support Chats — manager (and SuperAdmin) live chat with assigned users.
 * Two-pane: conversation list + active thread. Realtime via the admin
 * ws client (channel 'user:chat'). Dark theme.
 */
export default function ManagerChats() {
  const { user } = useAuthStore();
  const isSuper = user?.role === 'SUPER_ADMIN';
  const [convs, setConvs] = useState([]);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [theyTyping, setTheyTyping] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);      // older messages may exist
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploadCfg, setUploadCfg] = useState(null);
  const [pending, setPending] = useState([]);
  // "+ New chat" picker — start a conversation with an assigned user who
  // hasn't messaged yet (manager-initiated chat).
  const [picker, setPicker] = useState(false);
  const [pickerUsers, setPickerUsers] = useState([]);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const lastTypingSent = useRef(0);
  const fileRef = useRef(null);
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const active = convs.find((c) => c._id === activeId);

  const scrollToBottom = () => requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; });

  const loadConvs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/chat/conversations', { params: { search, limit: 100 } });
      setConvs(data.data.items || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  }, [search]);

  const openConv = useCallback(async (id) => {
    setActiveId(id);
    try {
      const { data } = await api.get(`/chat/conversations/${id}/messages`, { params: { limit: 60 } });
      const msgs = data.data || [];
      setMessages(msgs);
      setHasMore(msgs.length >= 60);   // a full page back → probably more history
      scrollToBottom();
      api.post(`/chat/conversations/${id}/seen`).catch(() => {});
      setConvs((prev) => prev.map((c) => (c._id === id ? { ...c, unread: 0 } : c)));
    } catch (e) { toast.error(errorMessage(e)); }
  }, []);

  // Load OLDER messages for the active thread — fetch the page before the
  // oldest message and prepend, preserving scroll so the view doesn't jump.
  const loadOlder = useCallback(async () => {
    const cur = messagesRef.current;
    if (loadingMore || !hasMore || !activeId || !cur.length) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const { data } = await api.get(`/chat/conversations/${activeId}/messages`, { params: { before: cur[0].createdAt, limit: 60 } });
      const older = data.data || [];
      if (older.length < 60) setHasMore(false);
      if (older.length) {
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m._id));
          const merged = [...older.filter((m) => !seen.has(m._id)), ...prev];
          merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
          return merged;
        });
        requestAnimationFrame(() => { const e2 = scrollRef.current; if (e2) e2.scrollTop = e2.scrollHeight - prevHeight + prevTop; });
      }
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoadingMore(false); }
  }, [activeId, hasMore, loadingMore]);

  useEffect(() => { loadConvs(); /* eslint-disable-next-line */ }, []);
  const refreshUploadCfg = useCallback(() => api.get('/chat/upload-config').then((r) => setUploadCfg(r.data.data)).catch(() => {}), []);
  useEffect(() => { refreshUploadCfg(); }, [refreshUploadCfg]);

  // Assigned users for the picker — reuses the scoped hierarchy endpoint
  // (manager → own users; SuperAdmin/Admin → their scope).
  const loadPickerUsers = useCallback(async (q) => {
    setPickerLoading(true);
    try {
      const { data } = await api.get('/hierarchy/users', { params: { search: q, limit: 100 } });
      setPickerUsers(data.data.items || data.data || []);
    } catch (e) {
      toast.error(errorMessage(e) || 'Could not load your users');
      setPickerUsers([]);
    } finally { setPickerLoading(false); }
  }, []);

  const openPicker = () => { setPicker(true); setPickerSearch(''); loadPickerUsers(''); };

  const startWith = async (u) => {
    setStarting(true);
    try {
      const { data } = await api.post('/chat/conversations/open', { userId: u._id || u.id });
      const id = data.data?.conversation?._id;
      setPicker(false);
      await loadConvs();
      if (id) openConv(id);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setStarting(false); }
  };

  // Realtime. Managers/admins get events on 'user:chat' (they're a party to
  // their own users' conversations). A SUPER_ADMIN is never a party, so they'd
  // miss live updates for the conversations they browse — they also subscribe
  // to the shared 'admin:chat' fan-out (same payload). They aren't a party, so
  // no event is delivered twice.
  useEffect(() => {
    const onChatEvent = (d) => {
      if (!d) return;
      if (d.event === 'message') {
        // Update the list row (last message + unread).
        setConvs((prev) => prev.map((c) => c._id === d.conversationId
          ? { ...c, lastMessageText: d.message.text || '📎 Attachment', lastMessageAt: d.message.createdAt, lastSenderRole: d.message.senderRole, unread: d.conversationId === activeId ? 0 : (d.message.senderRole === 'USER' ? (c.unread || 0) + 1 : c.unread) }
          : c));
        if (d.conversationId === activeId) {
          setMessages((prev) => (prev.some((m) => m._id === d.message._id) ? prev : [...prev, d.message]));
          scrollToBottom();
          if (d.message.senderRole === 'USER') api.post(`/chat/conversations/${activeId}/seen`).catch(() => {});
        }
      } else if (d.event === 'typing' && d.conversationId === activeId && d.by === 'USER') {
        setTheyTyping(true); clearTimeout(typingTimer.current); typingTimer.current = setTimeout(() => setTheyTyping(false), 3000);
      } else if (d.event === 'seen' && d.conversationId === activeId && d.by === 'USER') {
        setMessages((prev) => prev.map((m) => (m.senderRole !== 'USER' && !m.seenAt ? { ...m, seenAt: new Date().toISOString() } : m)));
      } else if (d.event === 'presence') {
        setConvs((prev) => prev.map((c) => (String(c.userId) === String(d.userId) ? { ...c, online: d.online } : c)));
      }
    };
    const unsub = wsClient.subscribe('user:chat', onChatEvent);
    const unsubAdmin = isSuper ? wsClient.subscribe('admin:chat', onChatEvent) : null;
    return () => { unsub && unsub(); unsubAdmin && unsubAdmin(); clearTimeout(typingTimer.current); };
  }, [activeId, isSuper]);

  const onType = (v) => {
    setText(v);
    const now = Date.now();
    if (activeId && now - lastTypingSent.current > 1500) { lastTypingSent.current = now; api.post(`/chat/conversations/${activeId}/typing`).catch(() => {}); }
  };

  const send = async (attachments) => {
    const body = { text: text.trim(), attachments };
    if (!activeId || (!body.text && !(attachments && attachments.length))) return;
    setSending(true);
    try { await api.post(`/chat/conversations/${activeId}/messages`, body); setText(''); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setSending(false); }
  };

  // ── Attachment staging (validate → read w/ progress → stage → send) ──
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
    const files = Array.from(e.target.files || []); e.target.value = '';
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
  const submit = () => {
    if (sending) return;
    if (pending.some((p) => !p.dataUrl)) { toast.error('Please wait — files are still being read…'); return; }
    const attachments = pending.filter((p) => p.dataUrl).map((p) => ({ name: p.name, mimeType: p.mimeType, dataUrl: p.dataUrl }));
    if (!text.trim() && !attachments.length) return;
    send(attachments);
    setPending([]);
  };

  return (
    <div className="space-y-4 max-w-[1400px]">
      <PageHero
        eyebrow="Support"
        title="Support Chats"
        subtitle="Live chat with your assigned users. Real-time messages, typing, read receipts."
        actions={isSuper ? <UploadLimitControl onChanged={refreshUploadCfg} /> : undefined}
      />

      <div className="card overflow-hidden flex" style={{ height: '72vh' }}>
        {/* Conversation list */}
        <div className="w-72 shrink-0 border-r border-border-dark flex flex-col">
          <div className="p-2 border-b border-border-subtle space-y-2">
            <button type="button" onClick={openPicker} className="btn-primary w-full text-sm py-1.5">+ New chat</button>
            <input className="input text-sm" placeholder="Search conversations…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadConvs()} />
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && convs.length === 0 && <div className="p-4 text-text-muted text-sm">Loading…</div>}
            {!loading && convs.length === 0 && <div className="p-4 text-text-muted text-sm">No conversations yet</div>}
            {convs.map((c) => (
              <button key={c._id} onClick={() => openConv(c._id)} className={`w-full text-left px-3 py-2.5 border-b border-border-subtle flex items-center gap-2.5 transition-colors ${activeId === c._id ? 'bg-bg-hover' : 'hover:bg-bg-hover/50'}`}>
                <div className="relative shrink-0">
                  <span className="w-9 h-9 rounded-full flex items-center justify-center text-bg-dark font-bold text-sm" style={{ background: 'linear-gradient(135deg,#FFE74D,#FCD535)' }}>{(c.user?.name || 'U').slice(0, 1).toUpperCase()}</span>
                  <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-bg-card ${c.online ? 'bg-bull' : 'bg-text-muted'}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-text-primary truncate">{c.user?.name || c.user?.email || 'User'}</span>
                    {c.unread > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-primary-500 text-bg-dark text-[10px] font-bold inline-flex items-center justify-center">{c.unread}</span>}
                  </div>
                  {c.user?.userUid && <div className="text-[10px] font-mono text-primary-500/80 truncate">{c.user.userUid}</div>}
                  <div className="text-[11px] text-text-muted truncate">{c.lastSenderRole === 'USER' ? '' : 'You: '}{c.lastMessageText || 'No messages yet'}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Active thread */}
        <div className="flex-1 flex flex-col min-w-0">
          {!active ? (
            <div className="flex-1 flex items-center justify-center text-text-muted text-sm">Select a conversation</div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-border-dark flex items-center gap-2.5 flex-wrap">
                <span className={`w-2.5 h-2.5 rounded-full ${active.online ? 'bg-bull' : 'bg-text-muted'}`} />
                <span className="text-sm font-bold text-text-primary">{active.user?.name || active.user?.email}</span>
                {active.user?.userUid && <span className="text-[10px] font-mono text-primary-500 bg-primary-500/10 rounded px-1.5 py-0.5">{active.user.userUid}</span>}
                <span className="text-[11px] text-text-muted">{active.online ? 'Online' : 'Offline'}</span>
                <span className="ml-auto flex items-center gap-3">
                  <span className="text-[11px] text-text-muted">Admin: <span className="text-text-secondary font-medium">{active.user?.admin || '—'}</span></span>
                  <span className="text-[11px] text-text-muted">Manager: <span className="text-text-secondary font-medium">{active.user?.manager || '—'}</span></span>
                </span>
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-bg-dark/40">
                {hasMore && (
                  <div className="flex justify-center pb-1">
                    <button type="button" onClick={loadOlder} disabled={loadingMore}
                      className="text-[11px] font-semibold text-primary-500 hover:text-primary-400 disabled:opacity-50 rounded-full border border-border-dark bg-bg-card px-3 py-1 transition-colors">
                      {loadingMore ? 'Loading…' : 'Load older messages'}
                    </button>
                  </div>
                )}
                {renderThread(messages)}
                {theyTyping && <div className="text-[11px] text-text-muted px-2">typing…</div>}
              </div>
              <div className="border-t border-border-dark">
                {pending.length > 0 && (
                  <div className="px-2.5 pt-2.5 flex flex-wrap gap-2">
                    {pending.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 max-w-[230px] rounded-lg border border-border-dark bg-bg-panel px-2.5 py-1.5">
                        <span className="text-base shrink-0">📎</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[11px] font-semibold text-white truncate">{p.name}</div>
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
                    <button type="button" onClick={() => fileRef.current?.click()} title={uploadCfg ? `Attach · max ${uploadCfg.maxFileMB} MB/file` : 'Attach'} className="btn-ghost p-2 shrink-0">📎</button>
                  )}
                  <input ref={fileRef} type="file" multiple accept={uploadCfg?.allowedExtensions?.length ? uploadCfg.allowedExtensions.map((e) => '.' + e).join(',') : undefined} className="hidden" onChange={onPickFile} />
                  <textarea value={text} onChange={(e) => onType(e.target.value)} rows={1} placeholder="Type a reply…"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                    className="input flex-1 resize-none max-h-28" />
                  <button onClick={submit} disabled={sending || (!text.trim() && pending.length === 0)} className="btn-primary text-sm disabled:opacity-50 shrink-0">Send</button>
                </div>
                {uploadCfg && (
                  <div className="px-3 pb-2 text-[10px] text-text-muted">
                    {uploadCfg.enabled === false
                      ? 'File uploads are currently disabled.'
                      : `Allowed: ${(uploadCfg.allowedExtensions || []).slice(0, 8).join(', ') || 'any (non-executable)'} · Max ${uploadCfg.maxFileMB} MB per file`}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* New-chat picker — assigned users (manager-initiated chat) */}
      {picker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPicker(false)}>
          <div className="card w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-border-dark flex items-center justify-between">
              <span className="text-sm font-bold text-text-primary">Start a chat</span>
              <button type="button" onClick={() => setPicker(false)} className="text-text-muted hover:text-text-primary">✕</button>
            </div>
            <div className="p-2 border-b border-border-subtle">
              <input autoFocus className="input text-sm" placeholder="Search your users…" value={pickerSearch}
                onChange={(e) => { setPickerSearch(e.target.value); }}
                onKeyDown={(e) => e.key === 'Enter' && loadPickerUsers(pickerSearch)} />
            </div>
            <div className="flex-1 overflow-y-auto">
              {pickerLoading && <div className="p-4 text-text-muted text-sm">Loading…</div>}
              {!pickerLoading && pickerUsers.length === 0 && <div className="p-4 text-text-muted text-sm">No assigned users found</div>}
              {pickerUsers.map((u) => {
                const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'User';
                return (
                  <button key={u._id || u.id} disabled={starting} onClick={() => startWith(u)}
                    className="w-full text-left px-3 py-2.5 border-b border-border-subtle flex items-center gap-2.5 hover:bg-bg-hover/50 transition-colors disabled:opacity-50">
                    <span className="w-9 h-9 rounded-full flex items-center justify-center text-bg-dark font-bold text-sm shrink-0" style={{ background: 'linear-gradient(135deg,#FFE74D,#FCD535)' }}>{name.slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-text-primary truncate">{name}</div>
                      <div className="text-[11px] text-text-muted truncate">{u.email}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// A centered day chip ("Today" / "Yesterday" / "12 Jun") shown between
// messages whenever the calendar day changes.
function DateDivider({ date }) {
  const d = new Date(date);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  let label;
  if (dd.getTime() === today.getTime()) label = 'Today';
  else if (dd.getTime() === yest.getTime()) label = 'Yesterday';
  else label = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
  return (
    <div className="flex items-center justify-center my-1">
      <span className="text-[10px] font-semibold text-text-muted bg-bg-card border border-border-dark rounded-full px-2.5 py-0.5">{label}</span>
    </div>
  );
}

// Flatten the message list into bubbles interleaved with day dividers.
// Manager side: "mine" = anything NOT sent by the USER.
function renderThread(messages) {
  const out = [];
  let lastDay = null;
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      out.push(<DateDivider key={`day-${day}`} date={m.createdAt} />);
      lastDay = day;
    }
    out.push(<Bubble key={m._id} m={m} mine={m.senderRole !== 'USER'} />);
  }
  return out;
}

function Bubble({ m, mine }) {
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${mine ? 'text-bg-dark rounded-br-sm' : 'bg-bg-panel text-text-primary rounded-bl-sm border border-border-dark'}`} style={mine ? { background: '#FCD535' } : undefined}>
        {(m.attachments || []).map((a, i) => (
          <div key={i} className="mb-1.5">
            {a.mimeType?.startsWith('image/')
              ? <a href={a.dataUrl} target="_blank" rel="noreferrer"><img src={a.dataUrl} alt={a.name} className="rounded-lg max-h-48 max-w-full" /></a>
              : <a href={a.dataUrl} download={a.name} className="underline">📎 {a.name || 'file'}</a>}
          </div>
        ))}
        {m.text && <div className="whitespace-pre-wrap break-words">{m.text}</div>}
        <div className={`mt-0.5 text-[10px] flex items-center gap-1 justify-end ${mine ? 'text-bg-dark/60' : 'text-text-muted'}`}>
          {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {mine && (m.seenAt ? <span title="Seen">✓✓</span> : <span title="Sent">✓</span>)}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact Super-Admin control (top of Support Chats) for the chat upload
 * limit. Reads/writes the same SystemSetting as before — applies instantly.
 * Executable / unsafe types are always blocked server-side.
 */
function UploadLimitControl({ onChanged }) {
  const [enabled, setEnabled] = useState(true);
  const [maxFileMB, setMaxFileMB] = useState('5');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get('/admin/system/settings')
      .then((r) => {
        const s = r.data.data.settings || {};
        setEnabled(s['chat.upload.enabled'] !== false);
        setMaxFileMB(String(s['chat.upload.maxFileMB'] ?? 5));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    const n = Number(maxFileMB);
    if (!Number.isFinite(n) || n < 1 || n > 500) { toast.error('Max file size must be between 1 and 500 MB'); return; }
    setSaving(true);
    try {
      await api.put('/admin/system/settings', { chatUpload: { enabled, maxFileMB: n } });
      toast.success('Chat upload settings saved');
      onChanged && onChanged();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  if (!loaded) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-xl border border-border-dark bg-bg-card px-3 py-2"
         title="Help/Support chat file uploads · executables are always blocked">
      <span className="text-[10px] uppercase tracking-wider font-bold text-text-muted hidden sm:inline">Chat uploads</span>
      <button type="button" onClick={() => setEnabled((v) => !v)}
        className={`text-[10px] uppercase font-bold px-2.5 py-1 rounded transition-colors ${enabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bear/20 text-bear'}`}>
        {enabled ? 'On' : 'Off'}
      </button>
      <span className="text-[11px] text-text-muted font-semibold">Max file</span>
      <input type="number" min="1" max="500" value={maxFileMB} onChange={(e) => setMaxFileMB(e.target.value)}
        className="w-16 px-2 py-1 rounded bg-bg-dark border border-border-dark text-sm font-mono text-white focus:border-primary-500 focus:outline-none" />
      <span className="text-[11px] text-text-muted">MB</span>
      <button type="button" onClick={save} disabled={saving}
        className="px-3 py-1 rounded text-xs font-bold bg-primary-500 text-white disabled:opacity-50 hover:bg-primary-600 transition-colors">
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
