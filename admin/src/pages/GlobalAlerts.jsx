import { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate } from '../utils/format';
import { useConfirm } from '../components/ConfirmProvider';
import PageHero from '../components/PageHero';
import RichTextEditor from '../components/RichTextEditor';

/**
 * Global Alerts — create / edit / enable / disable / delete blocking
 * announcement popups, with targeting, a display window, acknowledgement +
 * repeat rules, and per-alert delivery statistics.
 */
const PRIORITY_META = {
  INFO:     { label: 'Info',     cls: 'bg-sky-500/15 text-sky-400 border-sky-500/30' },
  WARNING:  { label: 'Warning',  cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  CRITICAL: { label: 'Critical', cls: 'bg-bear/15 text-bear border-bear/30' },
};
const TARGET_ROLES = ['USER', 'MANAGER', 'ADMIN'];

const PriorityBadge = ({ p }) => {
  const m = PRIORITY_META[p] || PRIORITY_META.INFO;
  return <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${m.cls}`}>{m.label}</span>;
};

const targetLabel = (a) => {
  if (a.targetType === 'ALL') return 'All Users';
  if (a.targetType === 'ROLE') return `Roles: ${(a.targetRoles || []).join(', ') || '—'}`;
  return `${(a.targetUserIds || []).length} user(s)`;
};

const windowLabel = (a) => {
  const s = a.startAt ? fmtDate(a.startAt) : '—';
  const e = a.endAt ? fmtDate(a.endAt) : '∞';
  return `${s} → ${e}`;
};

export default function GlobalAlerts() {
  const confirm = useConfirm();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [priorityF, setPriorityF] = useState('');
  const [statusF, setStatusF] = useState('');
  const [editing, setEditing] = useState(null);
  const [statsFor, setStatsFor] = useState(null);
  const [notifying, setNotifying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (search) params.q = search;
      if (priorityF) params.priority = priorityF;
      if (statusF) params.status = statusF;
      const { data } = await api.get('/alerts/admin', { params });
      setRows(data.data || []);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  }, [search, priorityF, statusF]);
  useEffect(() => { load(); }, [load]);

  const toggleActive = async (a) => {
    try { await api.patch(`/alerts/admin/${a._id}/active`, { isActive: !a.isActive }); load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };
  const remove = async (a) => {
    if (!(await confirm({ title: 'Delete alert', message: `Delete "${a.title}"? Acknowledgements will also be removed.`, danger: true, confirmText: 'Delete' }))) return;
    try { await api.delete(`/alerts/admin/${a._id}`); toast.success('Alert deleted'); load(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-4 max-w-[1400px]">
      <PageHero
        eyebrow="Communications"
        title="Global Alerts"
        subtitle="Push blocking announcement popups to users — targeted, scheduled, with acknowledgement tracking."
        actions={(
          <div className="flex items-center gap-2">
            <button onClick={() => setNotifying(true)} className="btn-secondary text-sm">🔔 Send Notification</button>
            <button onClick={() => setEditing({})} className="btn-primary text-sm">+ New Alert</button>
          </div>
        )}
      />

      <form onSubmit={(e) => { e.preventDefault(); setSearch(q); }} className="card p-3 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[180px]"><label className="label">Search</label><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="title or message" /></div>
        <div><label className="label">Priority</label><select className="input w-36" value={priorityF} onChange={(e) => setPriorityF(e.target.value)}><option value="">All</option><option value="CRITICAL">Critical</option><option value="WARNING">Warning</option><option value="INFO">Info</option></select></div>
        <div><label className="label">Status</label><select className="input w-32" value={statusF} onChange={(e) => setStatusF(e.target.value)}><option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
        <button className="btn-primary text-sm">Search</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[11px] text-text-muted uppercase border-b border-border-dark">
            <tr>
              <th className="p-2.5 text-left">Title</th>
              <th className="p-2.5 text-left">Priority</th>
              <th className="p-2.5 text-left">Audience</th>
              <th className="p-2.5 text-left">Window</th>
              <th className="p-2.5 text-center">Ack / Repeat</th>
              <th className="p-2.5 text-right">Acks</th>
              <th className="p-2.5 text-center">Status</th>
              <th className="p-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0, 1, 2].map((i) => <tr key={i} className="border-t border-border-dark/50"><td colSpan={8} className="p-3"><div className="h-4 bg-bg-hover rounded animate-pulse" /></td></tr>)
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="p-10 text-center text-text-muted">No alerts yet.</td></tr>
            ) : rows.map((a) => (
              <tr key={a._id} className="table-row align-middle">
                <td className="p-2.5 font-semibold text-white max-w-[260px] truncate" title={a.title}>{a.title}</td>
                <td className="p-2.5"><PriorityBadge p={a.priority} /></td>
                <td className="p-2.5 text-text-secondary text-xs">{targetLabel(a)}</td>
                <td className="p-2.5 text-text-muted text-xs whitespace-nowrap">{windowLabel(a)}</td>
                <td className="p-2.5 text-center text-xs">
                  <span className={a.requireAcknowledgement ? 'text-emerald-400' : 'text-text-muted'}>{a.requireAcknowledgement ? 'Ack' : '—'}</span>
                  <span className="text-text-muted"> / </span>
                  <span className={a.repeatDisplay ? 'text-amber-400' : 'text-text-muted'}>{a.repeatDisplay ? 'Repeat' : 'Once'}</span>
                </td>
                <td className="p-2.5 text-right text-text-secondary">{a.ackCount ?? 0}</td>
                <td className="p-2.5 text-center">
                  <button onClick={() => toggleActive(a)} className={`px-2 py-0.5 rounded text-[10px] font-bold border ${a.isActive ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-bg-hover text-text-muted border-border-dark'}`}>
                    {a.isActive ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="p-2.5 text-right">
                  <div className="inline-flex gap-1">
                    <button onClick={() => setStatsFor(a)} className="btn-ghost text-[11px] px-2 py-1">Stats</button>
                    <button onClick={() => setEditing(a)} className="btn-ghost text-[11px] px-2 py-1">Edit</button>
                    <button onClick={() => remove(a)} className="text-[11px] px-2 py-1 rounded text-bear hover:bg-bear/10">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <AlertEditor alert={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {statsFor && <StatsModal alert={statsFor} onClose={() => setStatsFor(null)} />}
      {notifying && <NotifyModal onClose={() => setNotifying(false)} />}
    </div>
  );
}

// Compose + send an in-app BELL notification (non-blocking) to targeted users.
function NotifyModal({ onClose }) {
  const [f, setF] = useState({
    targetType: 'ALL', targetRoles: ['USER'], targetUsers: '',
    title: '', message: '', link: '', status: 'info',
  });
  const [sending, setSending] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const toggleRole = (r) => setF((s) => ({ ...s, targetRoles: s.targetRoles.includes(r) ? s.targetRoles.filter((x) => x !== r) : [...s.targetRoles, r] }));

  const send = async () => {
    if (!f.title.trim()) { toast.error('Title is required'); return; }
    if (!f.message.trim()) { toast.error('Message is required'); return; }
    if (f.targetType === 'ROLE' && !f.targetRoles.length) { toast.error('Select at least one role'); return; }
    if (f.targetType === 'USER' && !f.targetUsers.trim()) { toast.error('Enter target user emails or IDs'); return; }
    setSending(true);
    try {
      const body = {
        targetType: f.targetType,
        targetRoles: f.targetType === 'ROLE' ? f.targetRoles : [],
        targetUsers: f.targetType === 'USER' ? f.targetUsers : '',
        title: f.title, message: f.message, link: f.link || null, status: f.status,
      };
      const { data } = await api.post('/alerts/admin/notify', body);
      toast.success(`Sent to ${data?.data?.sent ?? 0} user(s)`);
      onClose();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-dark rounded-xl w-full max-w-lg max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-card border-b border-border-dark p-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">Send Notification</h2>
            <p className="text-xs text-text-muted">Delivered to the user's notification bell (not a popup).</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div><label className="label">Title *</label><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Account update" /></div>
          <div><label className="label">Message *</label><textarea className="input min-h-[80px]" value={f.message} onChange={(e) => set('message', e.target.value)} placeholder="Short message shown in the bell" /></div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Audience</label>
              <select className="input" value={f.targetType} onChange={(e) => set('targetType', e.target.value)}>
                <option value="ALL">All Users</option><option value="ROLE">Specific Role</option><option value="USER">Specific Users</option>
              </select>
            </div>
            <div><label className="label">Style</label>
              <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
                <option value="info">Info</option><option value="success">Success</option><option value="warning">Warning</option><option value="error">Critical</option>
              </select>
            </div>
          </div>

          {f.targetType === 'ROLE' && (
            <div><label className="label">Roles</label>
              <div className="flex flex-wrap gap-2">
                {TARGET_ROLES.map((r) => (
                  <button type="button" key={r} onClick={() => toggleRole(r)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border ${f.targetRoles.includes(r) ? 'bg-primary-500/15 text-primary-500 border-primary-500/40' : 'bg-bg-hover text-text-muted border-border-dark'}`}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
          )}

          {f.targetType === 'USER' && (
            <div><label className="label">Target Users</label>
              <textarea className="input min-h-[60px]" value={f.targetUsers} onChange={(e) => set('targetUsers', e.target.value)}
                placeholder="Emails or user IDs — comma / newline separated" />
            </div>
          )}

          <div><label className="label">Link <span className="text-text-muted">(optional)</span></label><input className="input" value={f.link} onChange={(e) => set('link', e.target.value)} placeholder="/wallet" /></div>
        </div>
        <div className="sticky bottom-0 bg-bg-card border-t border-border-dark p-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={send} disabled={sending} className="btn-primary text-sm">{sending ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}

// datetime-local <-> Date helpers (local time, minute precision).
const toLocalInput = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
};

function AlertEditor({ alert, onClose, onSaved }) {
  const isNew = !alert._id;
  const [f, setF] = useState({
    title: alert.title || '',
    message: alert.message || '',
    priority: alert.priority || 'INFO',
    targetType: alert.targetType || 'ALL',
    targetRoles: alert.targetRoles || ['USER'],
    targetUsers: '', // emails / IDs textarea (specific users)
    startAt: toLocalInput(alert.startAt),
    endAt: toLocalInput(alert.endAt),
    requireAcknowledgement: alert.requireAcknowledgement !== false,
    repeatDisplay: !!alert.repeatDisplay,
    isActive: alert.isActive !== false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const toggleRole = (r) => setF((s) => ({ ...s, targetRoles: s.targetRoles.includes(r) ? s.targetRoles.filter((x) => x !== r) : [...s.targetRoles, r] }));

  const save = async () => {
    if (!f.title.trim()) { toast.error('Title is required'); return; }
    if (!f.message.trim() || f.message === '<p></p>') { toast.error('Message is required'); return; }
    if (f.targetType === 'ROLE' && !f.targetRoles.length) { toast.error('Select at least one role'); return; }
    if (f.targetType === 'USER' && !f.targetUsers.trim()) { toast.error('Enter target user emails or IDs'); return; }
    setSaving(true);
    try {
      const body = {
        title: f.title, message: f.message, priority: f.priority,
        targetType: f.targetType,
        targetRoles: f.targetType === 'ROLE' ? f.targetRoles : [],
        targetUsers: f.targetType === 'USER' ? f.targetUsers : '',
        startAt: f.startAt || null, endAt: f.endAt || null,
        requireAcknowledgement: f.requireAcknowledgement, repeatDisplay: f.repeatDisplay, isActive: f.isActive,
      };
      if (isNew) await api.post('/alerts/admin', body);
      else await api.put(`/alerts/admin/${alert._id}`, body);
      toast.success(isNew ? 'Alert created' : 'Alert saved');
      onSaved();
    } catch (e) { toast.error(errorMessage(e)); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex justify-end" onClick={onClose}>
      <div className="w-full max-w-2xl h-full bg-bg-card border-l border-border-dark overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-card border-b border-border-dark p-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-bold text-white">{isNew ? 'New Alert' : 'Edit Alert'}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-4 space-y-4">
          <div><label className="label">Title *</label><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Scheduled maintenance" /></div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Priority</label>
              <select className="input" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
                <option value="INFO">Info</option><option value="WARNING">Warning</option><option value="CRITICAL">Critical</option>
              </select>
            </div>
            <div><label className="label">Target Audience</label>
              <select className="input" value={f.targetType} onChange={(e) => set('targetType', e.target.value)}>
                <option value="ALL">All Users</option><option value="ROLE">Specific Role</option><option value="USER">Specific Users</option>
              </select>
            </div>
          </div>

          {f.targetType === 'ROLE' && (
            <div><label className="label">Roles</label>
              <div className="flex flex-wrap gap-2">
                {TARGET_ROLES.map((r) => (
                  <button type="button" key={r} onClick={() => toggleRole(r)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border ${f.targetRoles.includes(r) ? 'bg-primary-500/15 text-primary-500 border-primary-500/40' : 'bg-bg-hover text-text-muted border-border-dark'}`}>
                    {r}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-text-muted mt-1">Admins can target their own Users & Managers only.</p>
            </div>
          )}

          {f.targetType === 'USER' && (
            <div><label className="label">Target Users</label>
              <textarea className="input min-h-[70px]" value={f.targetUsers} onChange={(e) => set('targetUsers', e.target.value)}
                placeholder="Emails or user IDs — comma / newline separated" />
              <p className="text-[11px] text-text-muted mt-1">Resolved server-side; only users in your scope are matched.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Start (optional)</label><input type="datetime-local" className="input" value={f.startAt} onChange={(e) => set('startAt', e.target.value)} /></div>
            <div><label className="label">End (optional)</label><input type="datetime-local" className="input" value={f.endAt} onChange={(e) => set('endAt', e.target.value)} /></div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.requireAcknowledgement} onChange={(e) => set('requireAcknowledgement', e.target.checked)} /> Require acknowledgement</label>
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.repeatDisplay} onChange={(e) => set('repeatDisplay', e.target.checked)} /> Repeat every session</label>
            <label className="flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active</label>
          </div>

          <div><label className="label">Message *</label><RichTextEditor value={f.message} onChange={(html) => set('message', html)} /></div>
        </div>
        <div className="sticky bottom-0 bg-bg-card border-t border-border-dark p-4 flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : (isNew ? 'Create Alert' : 'Save Changes')}</button>
        </div>
      </div>
    </div>
  );
}

function StatsModal({ alert, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try { const { data } = await api.get(`/alerts/admin/${alert._id}/stats`); setData(data.data); }
      catch (e) { toast.error(errorMessage(e)); }
      finally { setLoading(false); }
    })();
  }, [alert._id]);

  const Stat = ({ label, value, accent }) => (
    <div className="card p-3 text-center">
      <div className={`text-2xl font-extrabold ${accent || 'text-white'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-text-muted mt-0.5">{label}</div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card border border-border-dark rounded-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-bg-card border-b border-border-dark p-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white truncate max-w-[420px]">{alert.title}</h2>
            <p className="text-xs text-text-muted">Delivery statistics</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-white text-xl">✕</button>
        </div>
        <div className="p-4 space-y-4">
          {loading ? (
            <div className="h-24 bg-bg-hover rounded animate-pulse" />
          ) : !data ? (
            <div className="text-center text-text-muted py-8">No data.</div>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Targeted" value={data.targeted} />
                <Stat label="Acknowledged" value={data.acknowledged} accent="text-emerald-400" />
                <Stat label="Pending" value={data.pending} accent="text-amber-400" />
                <Stat label="Ack Rate" value={`${data.ackRate}%`} accent="text-primary-500" />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wider text-text-muted mb-2">Acknowledged by</div>
                <div className="card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="text-[11px] text-text-muted uppercase border-b border-border-dark">
                      <tr><th className="p-2.5 text-left">User</th><th className="p-2.5 text-left">Email</th><th className="p-2.5 text-right">When</th></tr>
                    </thead>
                    <tbody>
                      {data.acknowledgers.length === 0 ? (
                        <tr><td colSpan={3} className="p-6 text-center text-text-muted">No acknowledgements yet.</td></tr>
                      ) : data.acknowledgers.map((k, i) => (
                        <tr key={i} className="table-row">
                          <td className="p-2.5 text-white">{k.name}</td>
                          <td className="p-2.5 text-text-secondary">{k.email}</td>
                          <td className="p-2.5 text-right text-text-muted text-xs">{fmtDate(k.acknowledgedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.acknowledgers.length >= 500 && <p className="text-[11px] text-text-muted mt-1">Showing the latest 500 acknowledgements.</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
