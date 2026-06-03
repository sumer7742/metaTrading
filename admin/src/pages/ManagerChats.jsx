import { useEffect, useRef, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { wsClient } from '../services/ws';
import PageHero from '../components/PageHero';

/**
 * Support Chats — manager (and SuperAdmin) live chat with assigned users.
 * Two-pane: conversation list + active thread. Realtime via the admin
 * ws client (channel 'user:chat'). Dark theme.
 */
const MAX_ATTACH_BYTES = 1024 * 1024;

export default function ManagerChats() {
  const [convs, setConvs] = useState([]);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [theyTyping, setTheyTyping] = useState(false);
  const [loading, setLoading] = useState(false);
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
      setMessages(data.data || []);
      scrollToBottom();
      api.post(`/chat/conversations/${id}/seen`).catch(() => {});
      setConvs((prev) => prev.map((c) => (c._id === id ? { ...c, unread: 0 } : c)));
    } catch (e) { toast.error(errorMessage(e)); }
  }, []);

  useEffect(() => { loadConvs(); /* eslint-disable-next-line */ }, []);

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

  // Realtime — the manager's own chat channel covers all their conversations.
  useEffect(() => {
    const unsub = wsClient.subscribe('user:chat', (d) => {
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
    });
    return () => { unsub && unsub(); clearTimeout(typingTimer.current); };
  }, [activeId]);

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

  const onPickFile = (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    if (file.size > MAX_ATTACH_BYTES) { toast.error('File must be ≤ 1MB'); return; }
    const reader = new FileReader();
    reader.onload = () => send([{ name: file.name, mimeType: file.type, dataUrl: String(reader.result) }]);
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-4 max-w-[1400px]">
      <PageHero eyebrow="Support" title="Support Chats" subtitle="Live chat with your assigned users. Real-time messages, typing, read receipts." />

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
              <div className="px-4 py-3 border-b border-border-dark flex items-center gap-2.5">
                <span className={`w-2.5 h-2.5 rounded-full ${active.online ? 'bg-bull' : 'bg-text-muted'}`} />
                <span className="text-sm font-bold text-text-primary">{active.user?.name || active.user?.email}</span>
                {active.user?.userUid && <span className="text-[10px] font-mono text-primary-500 bg-primary-500/10 rounded px-1.5 py-0.5">{active.user.userUid}</span>}
                <span className="text-[11px] text-text-muted">{active.online ? 'Online' : 'Offline'}</span>
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-bg-dark/40">
                {messages.map((m) => <Bubble key={m._id} m={m} mine={m.senderRole !== 'USER'} />)}
                {theyTyping && <div className="text-[11px] text-text-muted px-2">typing…</div>}
              </div>
              <div className="border-t border-border-dark p-2.5 flex items-end gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} title="Attach (≤1MB)" className="btn-ghost p-2 shrink-0">📎</button>
                <input ref={fileRef} type="file" accept="image/*,.pdf" className="hidden" onChange={onPickFile} />
                <textarea value={text} onChange={(e) => onType(e.target.value)} rows={1} placeholder="Type a reply…"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                  className="input flex-1 resize-none max-h-28" />
                <button onClick={() => send()} disabled={sending || !text.trim()} className="btn-primary text-sm disabled:opacity-50 shrink-0">Send</button>
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
