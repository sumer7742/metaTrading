import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import AssetIcon from '../components/AssetIcon';
import Modal from '../components/Modal';
import { Z } from '../components/modalLayers';
import { useInstruments } from '../hooks/useInstruments';
import { useWatchlists } from '../hooks/useWatchlists';
import { wsClient } from '../services/ws';
import { fmtNum } from '../utils/format';
import { buildShareLink, exportWatchlistFile, parseImport, decodeWatchlist } from '../utils/watchlistShare';

// ─── Small helpers ───────────────────────────────────────────────────
const EMOJI_CHOICES = ['⭐', '📈', '🔥', '💎', '🚀', '📊', '⚡', '🌙', '🐂', '🐻'];
// Color tags — '' = none. Hex values double as the accent dot/strip color.
const COLOR_CHOICES = ['', '#3B82F6', '#22C55E', '#EF4444', '#F59E0B', '#A855F7', '#EC4899', '#14B8A6'];

const fmtPrice = (raw, prec) => {
  const v = Number(raw);
  if (!Number.isFinite(v)) return '—';
  return fmtNum(v, Math.min(Number(prec) || 2, 6));
};

const moveInArray = (arr, from, to) => {
  const c = [...arr];
  const [x] = c.splice(from, 1);
  c.splice(to, 0, x);
  return c;
};

function sparkPath(change24h) {
  const W = 84, H = 30, mid = H / 2;
  const positive = !Number.isFinite(change24h) || change24h >= 0;
  const tone = !Number.isFinite(change24h) ? '#9CA3AF' : positive ? '#16A34A' : '#DC2626';
  const start = mid + (positive ? 6 : -6);
  const end = mid + (positive ? -6 : 6);
  const points = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = t * W;
    const noise = ((i % 2 === 0) ? 1 : -1) * (5 - i * 0.35);
    const y = start + (end - start) * t + noise * 0.6;
    points.push([x.toFixed(1), y.toFixed(1)]);
  }
  const d = points.map(([x, y], i) => (i === 0 ? `M${x} ${y}` : `L${x} ${y}`)).join(' ');
  return { d, tone, W, H };
}

// ─── Empty-state illustration (reused) ───────────────────────────────
function WatchlistIllustration() {
  return (
    <svg width="200" height="128" viewBox="0 0 220 140" fill="none" className="mx-auto">
      <line x1="10" y1="40" x2="210" y2="40" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="10" y1="70" x2="210" y2="70" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <line x1="10" y1="100" x2="210" y2="100" stroke="#E5E7EB" strokeWidth="1" strokeDasharray="2 3" />
      <path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22" stroke="#3B82F6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M20 90 L50 80 L80 65 L110 55 L140 38 L170 28 L200 22 L200 120 L20 120 Z" fill="url(#wishGrad)" opacity="0.18" />
      <defs>
        <linearGradient id="wishGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="200" cy="22" r="13" fill="#FFFFFF" stroke="#3B82F6" strokeWidth="2" />
      <polygon points="200,14 202.2,19.7 208.5,20.1 203.5,24.1 205.2,30 200,26.6 194.8,30 196.5,24.1 191.5,20.1 197.8,19.7" fill="#3B82F6" />
    </svg>
  );
}

// The generic modal shell now lives in components/Modal.jsx (shared,
// hardened: portal, scroll-lock, focus-trap, safe-area, z-scale).

// ─── Create / rename list modal ──────────────────────────────────────
function ListFormModal({ open, onClose, initial, onSubmit }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('⭐');
  const [color, setColor] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) { setName(initial?.name || ''); setEmoji(initial?.emoji || '⭐'); setColor(initial?.color || ''); }
  }, [open, initial]);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try { await onSubmit({ name: trimmed, emoji, color }); onClose(); }
    catch (_) { /* toast handled upstream */ }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Rename watchlist' : 'New watchlist'}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-text-muted uppercase tracking-wider">Icon</label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {EMOJI_CHOICES.map((em) => (
              <button
                key={em} type="button" onClick={() => setEmoji(em)}
                className={`w-9 h-9 rounded-lg text-lg flex items-center justify-center border transition-all ${emoji === em ? 'border-primary-500 bg-primary-500/10 scale-105' : 'border-border-dark hover:border-primary-500/40'}`}
              >{em}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-text-muted uppercase tracking-wider">Color tag</label>
          <div className="mt-2 flex flex-wrap gap-2">
            {COLOR_CHOICES.map((c) => (
              <button
                key={c || 'none'} type="button" onClick={() => setColor(c)}
                title={c || 'None'}
                className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${color === c ? 'ring-2 ring-offset-2 ring-primary-500 scale-105' : 'border-transparent'}`}
                style={{ background: c || 'transparent', borderColor: c ? 'transparent' : 'rgb(var(--color-border-dark))' }}
              >
                {!c && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-text-muted"><path d="M18 6 6 18M6 6l12 12" /></svg>}
                {color === c && c && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><path d="M20 6 9 17l-5-5" /></svg>}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-semibold text-text-muted uppercase tracking-wider">Name</label>
          <input
            autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
            placeholder="e.g. Scalping, Futures, Long Term"
            className="mt-2 w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors">
            {busy ? 'Saving…' : initial ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Confirm-delete modal ────────────────────────────────────────────
function ConfirmDeleteModal({ open, onClose, list, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title="Delete watchlist">
      <p className="text-sm text-text-secondary">
        Delete <span className="font-bold text-text-primary">{list?.emoji} {list?.name}</span> and its {list?.items?.length || 0} symbol{(list?.items?.length || 0) === 1 ? '' : 's'}? This can't be undone.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
        <button
          disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (_) {} finally { setBusy(false); } }}
          className="flex-1 py-2.5 rounded-xl bg-bear hover:opacity-90 disabled:opacity-50 text-white text-sm font-bold transition-opacity"
        >{busy ? 'Deleting…' : 'Delete'}</button>
      </div>
    </Modal>
  );
}

// ─── Add-symbols modal (search + multi-select bulk add) ──────────────
function AddSymbolsModal({ open, onClose, instruments, existingSymbols, onAdd }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setQ(''); setPicked(new Set()); } }, [open]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    const existing = new Set(existingSymbols);
    let rows = instruments.filter((r) => !existing.has(r.symbol));
    if (term) rows = rows.filter((r) => r.symbol.toLowerCase().includes(term) || (r.name || '').toLowerCase().includes(term));
    return rows.slice(0, 60);
  }, [q, instruments, existingSymbols]);

  const toggle = (sym) => setPicked((prev) => { const n = new Set(prev); n.has(sym) ? n.delete(sym) : n.add(sym); return n; });

  return (
    <Modal open={open} onClose={onClose} title="Add symbols" maxW="max-w-lg">
      <div className="relative">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol or name…" className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none" />
      </div>
      <div className="mt-3 max-h-[46vh] overflow-y-auto divide-y divide-border-subtle rounded-xl border border-border-dark">
        {results.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-text-muted">No symbols match "{q}"</div>
        ) : results.map((r) => {
          const on = picked.has(r.symbol);
          return (
            <button key={r.symbol} type="button" onClick={() => toggle(r.symbol)} className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${on ? 'bg-primary-500/5' : 'hover:bg-bg-hover'}`}>
              <AssetIcon row={r} size={30} round />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-text-primary truncate">{r.symbol}</div>
                <div className="text-[11px] text-text-muted truncate">{r.name || `${r.baseCurrency}/${r.quoteCurrency}`}</div>
              </div>
              <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${on ? 'bg-primary-500 border-primary-500' : 'border-border-dark'}`}>
                {on && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><path d="M20 6 9 17l-5-5" /></svg>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button onClick={onClose} className="py-2.5 px-4 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
        <button
          disabled={busy || picked.size === 0}
          onClick={async () => { setBusy(true); try { await onAdd([...picked]); onClose(); } catch (_) {} finally { setBusy(false); } }}
          className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors"
        >{busy ? 'Adding…' : `Add ${picked.size || ''} symbol${picked.size === 1 ? '' : 's'}`}</button>
      </div>
    </Modal>
  );
}

// ─── List picker (move / copy target) ────────────────────────────────
function ListPickerModal({ open, onClose, title, lists, excludeId, onPick }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-1.5">
        {lists.filter((l) => l._id !== excludeId).map((l) => (
          <button key={l._id} onClick={() => { onPick(l._id); onClose(); }} className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-border-dark hover:border-primary-500/40 hover:bg-primary-500/5 transition-all text-left">
            <span className="text-lg">{l.emoji || '📋'}</span>
            <span className="flex-1 text-sm font-semibold text-text-primary truncate">{l.name}</span>
            <span className="text-xs text-text-muted">{l.items?.length || 0}</span>
          </button>
        ))}
        {lists.filter((l) => l._id !== excludeId).length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-text-muted">No other watchlists. Create one first.</div>
        )}
      </div>
    </Modal>
  );
}

// ─── Import modal (file upload + paste, with symbol validation) ──────
function ImportModal({ open, onClose, instruments, initial, onImport }) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const validSet = useMemo(() => new Set(instruments.map((r) => r.symbol)), [instruments]);

  // Reparse whenever the text (or an incoming shared payload) changes.
  const apply = (raw, prefillName) => {
    setErr('');
    if (!raw && !prefillName) { setParsed(null); return; }
    try {
      const p = raw ? parseImport(raw) : { name: prefillName, emoji: '', color: '', symbols: [] };
      const known = p.symbols.filter((s) => validSet.has(s));
      setParsed({ ...p, known, skipped: p.symbols.length - known.length });
    } catch (e) { setParsed(null); setErr(e.message || 'Could not parse import'); }
  };

  useEffect(() => {
    if (!open) return;
    if (initial) {
      // Shared link payload — prefill directly.
      const known = (initial.symbols || []).filter((s) => validSet.has(s));
      setText('');
      setParsed({ ...initial, known, skipped: (initial.symbols || []).length - known.length });
      setErr('');
    } else {
      setText(''); setParsed(null); setErr('');
    }
  }, [open, initial, validSet]);

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { const v = String(reader.result || ''); setText(v); apply(v); };
    reader.readAsText(file);
  };

  return (
    <Modal open={open} onClose={onClose} title="Import watchlist" maxW="max-w-lg">
      {!initial && (
        <>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>
              Upload file
            </button>
            <input ref={fileRef} type="file" accept=".json,.txt,application/json,text/plain" onChange={onFile} className="hidden" />
            <span className="text-xs text-text-muted">JSON export, share code, or symbol list</span>
          </div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); apply(e.target.value); }}
            rows={5}
            placeholder="…or paste a share code or symbols (BTCUSDT, ETHUSDT, SOLUSDT)"
            className="mt-3 w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-mono text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none resize-none"
          />
        </>
      )}

      {err && <p className="mt-3 text-sm text-bear">{err}</p>}

      {parsed && (
        <div className="mt-3 p-3 rounded-xl border border-border-dark bg-bg-hover">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-lg">{parsed.emoji || '📋'}</span>
            <span className="font-bold text-text-primary">{parsed.name}</span>
          </div>
          <div className="mt-1.5 text-xs text-text-secondary">
            <span className="font-semibold text-bull">{parsed.known.length}</span> symbol{parsed.known.length === 1 ? '' : 's'} ready to import
            {parsed.skipped > 0 && <span className="text-text-muted"> · {parsed.skipped} unknown skipped</span>}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button onClick={onClose} className="py-2.5 px-4 rounded-xl border border-border-dark text-sm font-semibold text-text-primary hover:bg-bg-hover transition-colors">Cancel</button>
        <button
          disabled={busy || !parsed}
          onClick={async () => {
            setBusy(true);
            try { await onImport({ name: parsed.name, emoji: parsed.emoji, color: parsed.color, symbols: parsed.known }); onClose(); }
            catch (_) { /* toast upstream */ }
            finally { setBusy(false); }
          }}
          className="flex-1 py-2.5 rounded-xl bg-primary-500 hover:bg-primary-600 disabled:opacity-50 text-white text-sm font-bold transition-colors"
        >{busy ? 'Importing…' : 'Import as new list'}</button>
      </div>
    </Modal>
  );
}

// ─── Keyboard shortcuts help overlay ─────────────────────────────────
const SHORTCUTS = [
  ['N', 'New watchlist'], ['A', 'Add symbols'], ['I', 'Import'],
  ['R', 'Rename current'], ['E', 'Export current'], ['S', 'Share current'],
  ['D', 'Delete current'], ['/', 'Focus filter'],
  ['1 – 9', 'Jump to list'], ['[  ]', 'Prev / next list'], ['?', 'This help'],
];
function ShortcutsHelp({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {SHORTCUTS.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-3 py-1">
            <span className="text-sm text-text-secondary">{label}</span>
            <kbd className="px-2 py-0.5 rounded-md border border-border-dark bg-bg-hover text-xs font-mono font-semibold text-text-primary">{k}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ─── Mobile list-actions bottom sheet ────────────────────────────────
// On phones the watchlist tabs have no hover ⋯ menu, so per-list actions
// live in a large-touch-target bottom sheet (the Modal already docks to
// the bottom on small screens).
function ListActionsSheet({ list, onClose, onRename, onDuplicate, onShare, onExport, onDelete, canDelete }) {
  const Action = ({ onClick, danger, icon, children }) => (
    <button
      onClick={() => { onClose(); onClick(); }}
      className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-[15px] font-semibold text-left transition-colors ${danger ? 'text-bear hover:bg-bear/5' : 'text-text-primary hover:bg-bg-hover'}`}
    >{icon}{children}</button>
  );
  return (
    <Modal open={!!list} onClose={onClose} title={list ? `${list.emoji || '📋'} ${list.name}` : ''}>
      <div className="space-y-0.5 -mx-1">
        <Action onClick={onRename} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>}>Rename</Action>
        <Action onClick={onDuplicate} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}>Duplicate</Action>
        <Action onClick={onShare} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></svg>}>Share link</Action>
        <Action onClick={onExport} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg>}>Export</Action>
        {canDelete && <>
          <div className="my-1 h-px bg-border-subtle" />
          <Action onClick={onDelete} danger icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>}>Delete</Action>
        </>}
      </div>
    </Modal>
  );
}

// ─── Row quick-actions dropdown ──────────────────────────────────────
function RowMenu({ pinned, onPin, onMove, onCopy, onRemove }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const Item = ({ onClick, danger, children }) => (
    <button onClick={() => { setOpen(false); onClick(); }} className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${danger ? 'text-bear hover:bg-bear/5' : 'text-text-primary hover:bg-bg-hover'}`}>{children}</button>
  );
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((v) => !v)} className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Actions">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white border border-border-dark rounded-xl shadow-xl py-1" style={{ zIndex: Z.menu }}>
          <Item onClick={onPin}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M12 17v5" /><path d="M9 10.76V5h6v5.76l3 2.24v3H6v-3z" /></svg>
            {pinned ? 'Unpin' : 'Pin to top'}
          </Item>
          <Item onClick={onMove}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
            Move to…
          </Item>
          <Item onClick={onCopy}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            Copy to…
          </Item>
          <div className="my-1 h-px bg-border-subtle" />
          <Item onClick={onRemove} danger>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
            Remove
          </Item>
        </div>
      )}
    </div>
  );
}

// ─── Symbol row (draggable card) ─────────────────────────────────────
function SymbolRow({ item, row, onDragStart, onDragOver, onDrop, isDragging, ...actions }) {
  const change = Number(row?.change24h);
  const positive = !Number.isFinite(change) ? null : change >= 0;
  const tone = positive == null ? '#9CA3AF' : positive ? '#16A34A' : '#DC2626';
  const spark = sparkPath(change);
  return (
    <div
      draggable
      onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}
      className={`group flex items-center gap-3 px-3 py-3 bg-white border border-border-dark rounded-xl transition-all ${isDragging ? 'opacity-40' : 'hover:border-primary-500/40 hover:shadow-sm'}`}
    >
      <span className="cursor-grab active:cursor-grabbing text-text-muted/60 hover:text-text-muted shrink-0 touch-none" title="Drag to reorder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
      </span>
      <AssetIcon row={row || { symbol: item.symbol }} size={36} round />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-text-primary truncate">{item.symbol}</span>
          {item.pinned && <svg width="11" height="11" viewBox="0 0 24 24" fill="#3B82F6" className="shrink-0"><path d="M9 10.76V5h6v5.76l3 2.24v3H6v-3z" /></svg>}
        </div>
        <div className="text-[11px] text-text-muted truncate">{row?.name || ''}</div>
      </div>
      <svg width={spark.W} height={spark.H} viewBox={`0 0 ${spark.W} ${spark.H}`} className="shrink-0 hidden sm:block">
        <path d={`${spark.d} L${spark.W} ${spark.H} L0 ${spark.H} Z`} fill={spark.tone} opacity="0.12" />
        <path d={spark.d} stroke={spark.tone} strokeWidth="1.5" fill="none" />
      </svg>
      <div className="text-right shrink-0 w-[92px]">
        <div className="text-sm font-bold font-mono tabular-nums text-text-primary">{fmtPrice(row?.lastPrice, row?.pricePrecision)}</div>
        <div className="text-[11px] font-bold font-mono tabular-nums" style={{ color: tone }}>
          {positive == null ? '—' : `${positive ? '+' : ''}${change.toFixed(2)}%`}
        </div>
      </div>
      <Link to={`/trade?symbol=${encodeURIComponent(item.symbol)}`} className="hidden sm:inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-primary-500 hover:bg-primary-600 text-white text-xs font-bold transition-colors shrink-0">Trade</Link>
      <RowMenu pinned={item.pinned} {...actions} />
    </div>
  );
}

// ─── Sidebar / tab list item ─────────────────────────────────────────
function ListMenu({ onRename, onDuplicate, onExport, onShare, onDelete, canDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const Item = ({ onClick, danger, children }) => (
    <button onClick={(e) => { e.stopPropagation(); setOpen(false); onClick(); }} className={`w-full px-3 py-2 text-sm text-left ${danger ? 'text-bear hover:bg-bear/5' : 'text-text-primary hover:bg-bg-hover'}`}>{children}</button>
  );
  return (
    <div className="relative" ref={ref}>
      <button onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover opacity-0 group-hover:opacity-100 transition-opacity">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-40 bg-white border border-border-dark rounded-xl shadow-xl py-1" style={{ zIndex: Z.menu }}>
          <Item onClick={onRename}>Rename</Item>
          <Item onClick={onDuplicate}>Duplicate</Item>
          <Item onClick={onShare}>Share link</Item>
          <Item onClick={onExport}>Export</Item>
          {canDelete && <><div className="my-1 h-px bg-border-subtle" /><Item onClick={onDelete} danger>Delete</Item></>}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────
export default function Watchlist() {
  const { rows: instruments } = useInstruments();
  const wl = useWatchlists();
  const {
    watchlists, activeId, activeList, loading, setActiveId,
    createList, renameList, deleteList, duplicateList, reorderLists, importWatchlist,
    bulkAddSymbols, removeSymbol, reorderSymbols, pinSymbol, moveSymbol, copySymbol,
  } = wl;

  const instrBySymbol = useMemo(() => new Map(instruments.map((r) => [r.symbol, r])), [instruments]);

  // ── Live prices: subscribe ONLY to the active list's symbols, and
  //    resubscribe when the active list changes (bandwidth optimization).
  const [priceMap, setPriceMap] = useState({});
  const activeSymbols = useMemo(() => (activeList?.items || []).map((it) => it.symbol), [activeList]);
  useEffect(() => {
    if (!activeSymbols.length) return;
    const unsubs = activeSymbols.map((sym) =>
      wsClient.subscribe(`ticker:${sym}`, (msg) => {
        const px = Number(msg?.price ?? msg?.last ?? msg?.lastPrice);
        if (Number.isFinite(px)) setPriceMap((m) => (m[sym] === px ? m : { ...m, [sym]: px }));
      })
    );
    return () => { unsubs.forEach((u) => u && u()); };
  }, [activeSymbols.join(',')]);

  // ── UI state ───────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [transfer, setTransfer] = useState(null); // { mode:'move'|'copy', itemId }
  const [showImport, setShowImport] = useState(false);
  const [shareInitial, setShareInitial] = useState(null); // payload from ?share= link
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [mobileActions, setMobileActions] = useState(null); // list whose action sheet is open (mobile)
  const dragList = useRef(null);
  const dragItem = useRef(null);
  const filterRef = useRef(null);
  const [dragInfo, setDragInfo] = useState({ kind: null, id: null });

  // ── Shared-link handler: ?share=<code> → open import prefilled, then
  //    strip the param so a refresh doesn't reopen it.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('share');
    if (!code) return;
    try {
      setShareInitial(decodeWatchlist(code));
      setShowImport(true);
    } catch (_) { toast.error('That shared watchlist link is invalid'); }
    const url = new URL(window.location.href);
    url.searchParams.delete('share');
    window.history.replaceState({}, '', url.pathname + url.search);
  }, []);

  // ── Active-list rows (server already sorts pinned-first) ───────────
  const visibleItems = useMemo(() => {
    const items = activeList?.items || [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const r = instrBySymbol.get(it.symbol);
      return it.symbol.toLowerCase().includes(q) || (r?.name || '').toLowerCase().includes(q);
    });
  }, [activeList, search, instrBySymbol]);

  const rowFor = (sym) => {
    const base = instrBySymbol.get(sym);
    if (!base) return null;
    return priceMap[sym] ? { ...base, lastPrice: priceMap[sym] } : base;
  };

  // ── List drag-reorder (sidebar + mobile tabs) ─────────────────────
  const onListDrop = (targetId) => {
    const fromId = dragList.current;
    dragList.current = null;
    setDragInfo({ kind: null, id: null });
    if (!fromId || fromId === targetId) return;
    const ids = watchlists.map((w) => w._id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    reorderLists(moveInArray(ids, from, to)).catch(() => {});
  };

  // ── Item drag-reorder within active list ──────────────────────────
  const onItemDrop = (targetItemId) => {
    const fromId = dragItem.current;
    dragItem.current = null;
    setDragInfo({ kind: null, id: null });
    if (!fromId || fromId === targetItemId || !activeList) return;
    const ids = activeList.items.map((it) => it._id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(targetItemId);
    if (from < 0 || to < 0) return;
    reorderSymbols(activeList._id, moveInArray(ids, from, to)).catch(() => {});
  };

  // ── Handlers ──────────────────────────────────────────────────────
  const handleCreate = ({ name, emoji, color }) => createList({ name, emoji, color }).then((l) => { toast.success(`Created ${emoji} ${name}`); return l; });
  const handleRename = ({ name, emoji, color }) => renameList(renameTarget._id, { name, emoji, color });
  const handleDuplicate = (id) => duplicateList(id).then(() => toast.success('Watchlist duplicated'));
  const handleDelete = () => deleteList(deleteTarget._id).then(() => toast.success('Watchlist deleted'));
  const handleBulkAdd = (symbols) => bulkAddSymbols(activeList._id, symbols).then(() => toast.success(`Added ${symbols.length} symbol${symbols.length === 1 ? '' : 's'}`));
  const handleTransfer = (targetId) => {
    if (!transfer || !activeList) return;
    const fn = transfer.mode === 'move' ? moveSymbol : copySymbol;
    fn(activeList._id, transfer.itemId, targetId)
      .then(() => toast.success(transfer.mode === 'move' ? 'Symbol moved' : 'Symbol copied'))
      .catch(() => {});
    setTransfer(null);
  };
  const handleExport = (l) => { exportWatchlistFile(l); toast.success(`Exported ${l.name}`); };
  const handleShare = async (l) => {
    const link = buildShareLink(l);
    try { await navigator.clipboard.writeText(link); toast.success('Share link copied to clipboard'); }
    catch (_) { window.prompt('Copy this share link:', link); }
  };
  const handleImport = ({ name, emoji, color, symbols }) =>
    importWatchlist({ name, emoji, color, symbols })
      .then(() => { setShareInitial(null); toast.success(`Imported ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} into ${name}`); });

  const canDelete = watchlists.length > 1;

  // ── Keyboard shortcuts (ignored while typing or a modal is open) ──
  const anyModalOpen = showCreate || !!renameTarget || !!deleteTarget || showAdd || !!transfer || showImport || showShortcuts;
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') { setShowShortcuts((v) => !v); return; }
      if (anyModalOpen) return;
      const idx = watchlists.findIndex((w) => w._id === activeId);
      switch (e.key) {
        case 'n': setShowCreate(true); break;
        case 'a': if (activeList) setShowAdd(true); break;
        case 'i': setShowImport(true); break;
        case 'r': if (activeList) setRenameTarget(activeList); break;
        case 'e': if (activeList) handleExport(activeList); break;
        case 's': if (activeList) handleShare(activeList); break;
        case 'd': if (activeList && watchlists.length > 1) setDeleteTarget(activeList); break;
        case '/': e.preventDefault(); filterRef.current?.focus(); break;
        case '[': if (idx > 0) setActiveId(watchlists[idx - 1]._id); break;
        case ']': if (idx >= 0 && idx < watchlists.length - 1) setActiveId(watchlists[idx + 1]._id); break;
        default:
          if (/^[1-9]$/.test(e.key)) { const n = Number(e.key) - 1; if (watchlists[n]) setActiveId(watchlists[n]._id); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anyModalOpen, watchlists, activeId, activeList]);

  // ─── Render ──────────────────────────────────────────────────────
  if (loading && watchlists.length === 0) {
    return <div className="max-w-[1400px] mx-auto px-4 py-10 text-center text-sm text-text-muted">Loading your watchlists…</div>;
  }

  // First-run: no lists at all (migration produced nothing) → invite create
  if (!loading && watchlists.length === 0) {
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center">
        <WatchlistIllustration />
        <h2 className="mt-4 text-lg font-bold text-text-primary">Create your first watchlist</h2>
        <p className="mt-1 text-sm text-text-secondary">Organize trading pairs into custom lists like Favorites, Scalping, or Futures.</p>
        <button onClick={() => setShowCreate(true)} className="mt-5 inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white text-sm font-bold px-5 py-2.5 rounded-xl transition-colors">+ New Watchlist</button>
        <ListFormModal open={showCreate} onClose={() => setShowCreate(false)} onSubmit={handleCreate} />
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-4 sm:py-6">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-text-primary">My Watchlists</h1>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center gap-1.5 bg-primary-500 hover:bg-primary-600 text-white text-sm font-bold px-3.5 py-2 rounded-xl transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            <span className="hidden sm:inline">New List</span>
          </button>
        </div>
      </header>

      {/* Mobile: horizontal scrollable sticky tabs (≤5 visible) */}
      <div className="lg:hidden sticky top-0 z-20 -mx-3 px-3 py-2 bg-bg-dark/80 backdrop-blur border-b border-border-subtle mb-3">
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          {watchlists.map((l) => {
            const active = l._id === activeId;
            return (
              <div
                key={l._id}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={() => { dragList.current = l._id; setDragInfo({ kind: 'list', id: l._id }); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onListDrop(l._id)}
                onClick={() => (active ? setMobileActions(l) : setActiveId(l._id))}
                className={`inline-flex items-center gap-1.5 pl-3.5 pr-2.5 py-2.5 rounded-full text-sm font-semibold whitespace-nowrap transition-all shrink-0 cursor-pointer select-none ${active ? 'bg-primary-500 text-white shadow-sm' : 'bg-white border border-border-dark text-text-secondary'}`}
                title={active ? 'Tap for list actions' : 'Open list'}
              >
                {l.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: l.color }} />}
                <span>{l.emoji}</span>{l.name}
                <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold inline-flex items-center justify-center ${active ? 'bg-white/25 keep-white' : 'bg-bg-hover text-text-muted'}`}>{l.items?.length || 0}</span>
                {active && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 opacity-90"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-12 gap-4 lg:gap-5">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block col-span-3">
          <div className="bg-white border border-border-dark rounded-2xl overflow-hidden shadow-sm sticky top-4">
            <div className="px-4 py-3 border-b border-border-subtle text-xs font-bold uppercase tracking-wider text-text-muted">Lists ({watchlists.length})</div>
            <div className="p-2 space-y-0.5">
              {watchlists.map((l) => {
                const active = l._id === activeId;
                return (
                  <div
                    key={l._id}
                    draggable
                    onDragStart={() => { dragList.current = l._id; setDragInfo({ kind: 'list', id: l._id }); }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onListDrop(l._id)}
                    onClick={() => setActiveId(l._id)}
                    className={`group relative flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl cursor-pointer transition-all ${active ? 'bg-primary-500/10 ring-1 ring-inset ring-primary-500/30' : 'hover:bg-bg-hover'} ${dragInfo.kind === 'list' && dragInfo.id === l._id ? 'opacity-40' : ''}`}
                  >
                    {l.color && <span className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-full" style={{ background: l.color }} />}
                    <span className="text-lg shrink-0">{l.emoji || '📋'}</span>
                    <span className={`flex-1 text-sm font-semibold truncate ${active ? 'text-primary-600' : 'text-text-primary'}`}>{l.name}</span>
                    <span className="text-xs font-bold text-text-muted tabular-nums">{l.items?.length || 0}</span>
                    <ListMenu
                      canDelete={canDelete}
                      onRename={() => setRenameTarget(l)}
                      onDuplicate={() => handleDuplicate(l._id)}
                      onExport={() => handleExport(l)}
                      onShare={() => handleShare(l)}
                      onDelete={() => setDeleteTarget(l)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        {/* Main panel */}
        <main className="col-span-12 lg:col-span-9">
          {/* Active list header + search + add */}
          <div className="flex items-center gap-2 mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-2xl">{activeList?.emoji}</span>
              <h2 className="text-lg font-bold text-text-primary truncate">{activeList?.name}</h2>
              <span className="text-xs font-bold text-text-muted">{activeList?.items?.length || 0}</span>
            </div>
            <div className="relative flex-1 min-w-0 ml-auto max-w-xs">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" /></svg>
              <input ref={filterRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter… ( / )" className="w-full pl-9 pr-3 py-2 rounded-xl border border-border-dark bg-white text-sm text-text-primary placeholder:text-text-muted focus:border-primary-500 focus:outline-none" />
            </div>
            <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1.5 border border-primary-500/50 text-primary-600 hover:bg-primary-500/5 text-sm font-bold px-3 py-2 rounded-xl transition-colors shrink-0">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              <span className="hidden sm:inline">Add Symbol</span>
            </button>
          </div>

          {/* Symbol list / empty states */}
          {(activeList?.items?.length || 0) === 0 ? (
            <div className="bg-white border border-border-dark rounded-2xl p-10 flex flex-col items-center text-center shadow-sm">
              <WatchlistIllustration />
              <h3 className="mt-3 text-base font-bold text-text-primary">This watchlist is empty</h3>
              <p className="mt-1 text-sm text-text-secondary max-w-sm">Add trading pairs to track prices, set up quick trades, and organize your strategy.</p>
              <button onClick={() => setShowAdd(true)} className="mt-4 inline-flex items-center gap-2 bg-primary-500 hover:bg-primary-600 text-white text-sm font-bold px-4 py-2.5 rounded-xl transition-colors">+ Add Symbols</button>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="bg-white border border-border-dark rounded-2xl p-10 text-center shadow-sm">
              <p className="text-sm text-text-muted">No symbols match "{search}".</p>
              <button onClick={() => setSearch('')} className="mt-2 text-xs font-semibold text-primary-600 hover:underline">Clear filter</button>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleItems.map((item) => (
                <SymbolRow
                  key={item._id}
                  item={item}
                  row={rowFor(item.symbol)}
                  isDragging={dragInfo.kind === 'item' && dragInfo.id === item._id}
                  onDragStart={() => { dragItem.current = item._id; setDragInfo({ kind: 'item', id: item._id }); }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onItemDrop(item._id)}
                  onPin={() => pinSymbol(activeList._id, item._id, !item.pinned).catch(() => {})}
                  onMove={() => setTransfer({ mode: 'move', itemId: item._id })}
                  onCopy={() => setTransfer({ mode: 'copy', itemId: item._id })}
                  onRemove={() => removeSymbol(activeList._id, item._id).catch(() => {})}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Modals */}
      <ListFormModal open={showCreate} onClose={() => setShowCreate(false)} onSubmit={handleCreate} />
      <ListFormModal open={!!renameTarget} onClose={() => setRenameTarget(null)} initial={renameTarget} onSubmit={handleRename} />
      <ConfirmDeleteModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} list={deleteTarget} onConfirm={handleDelete} />
      <AddSymbolsModal
        open={showAdd} onClose={() => setShowAdd(false)}
        instruments={instruments}
        existingSymbols={(activeList?.items || []).map((it) => it.symbol)}
        onAdd={handleBulkAdd}
      />
      <ListPickerModal
        open={!!transfer} onClose={() => setTransfer(null)}
        title={transfer?.mode === 'move' ? 'Move to watchlist' : 'Copy to watchlist'}
        lists={watchlists} excludeId={activeList?._id} onPick={handleTransfer}
      />
      <ImportModal
        open={showImport} onClose={() => { setShowImport(false); setShareInitial(null); }}
        instruments={instruments} initial={shareInitial} onImport={handleImport}
      />
      <ShortcutsHelp open={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <ListActionsSheet
        list={mobileActions}
        canDelete={canDelete}
        onClose={() => setMobileActions(null)}
        onRename={() => setRenameTarget(mobileActions)}
        onDuplicate={() => handleDuplicate(mobileActions._id)}
        onShare={() => handleShare(mobileActions)}
        onExport={() => handleExport(mobileActions)}
        onDelete={() => setDeleteTarget(mobileActions)}
      />
    </div>
  );
}
