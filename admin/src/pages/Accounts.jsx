import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import { fmtDate, fmtNum } from '../utils/format';
import PageHero from '../components/PageHero';

const ACCOUNT_TYPES = ['STANDARD', 'STANDARD_IC', 'PRO', 'PRO_IC', 'FREE', 'FREE_IC', 'REAL', 'VIRTUAL', 'DEMO'];
const isDemo = (t) => ['DEMO', 'VIRTUAL'].includes(t);

const STATUS_BADGE = {
  ACTIVE:    'bg-emerald-500/15 text-emerald-400',
  BLOCKED:   'bg-rose-500/15 text-rose-400',
  SUSPENDED: 'bg-amber-500/15 text-amber-400',
};
function StatusBadge({ status }) {
  const s = status || 'ACTIVE';
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${STATUS_BADGE[s] || STATUS_BADGE.ACTIVE}`}>{s}</span>;
}

export default function Accounts() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  // filters
  const [search, setSearch] = useState('');
  const [fType, setFType] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fGroup, setFGroup] = useState('');
  const [fFrom, setFFrom] = useState('');
  const [fTo, setFTo] = useState('');

  // expand + lazy children
  const [expanded, setExpanded] = useState({});      // userId -> bool
  const [children, setChildren] = useState({});       // userId -> accounts[]
  const [childLoading, setChildLoading] = useState({});

  // selections
  const [selUsers, setSelUsers] = useState({});       // userId -> bool (all accounts)
  const [selAccts, setSelAccts] = useState({});       // accountId -> bool

  const [detail, setDetail] = useState(null);         // accountId for modal

  const childParams = () => ({ type: fType, status: fStatus, group: fGroup });

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/accounts/users', {
        params: { search, type: fType, status: fStatus, group: fGroup, from: fFrom, to: fTo, page, limit: 25 },
      });
      setUsers(data.data.items || []);
      setTotal(data.data.total || 0);
      setChildren({}); setExpanded({});
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [page, fType, fStatus, fGroup, fFrom, fTo]);

  const onSearch = (e) => { e.preventDefault(); setPage(1); load(); };

  const loadChildren = async (userId) => {
    setChildLoading((s) => ({ ...s, [userId]: true }));
    try {
      const { data } = await api.get(`/admin/accounts/users/${userId}/accounts`, { params: childParams() });
      setChildren((s) => ({ ...s, [userId]: data.data || [] }));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setChildLoading((s) => ({ ...s, [userId]: false })); }
  };

  const toggleExpand = (userId) => {
    setExpanded((s) => {
      const next = !s[userId];
      if (next && !children[userId]) loadChildren(userId); // lazy: only on first open
      return { ...s, [userId]: next };
    });
  };

  const refreshChild = (userId) => loadChildren(userId);

  // ── selection ──
  const selectedUserIds = Object.keys(selUsers).filter((k) => selUsers[k]);
  const selectedAcctIds = Object.keys(selAccts).filter((k) => selAccts[k]);
  const selCount = selectedUserIds.length + selectedAcctIds.length;
  const clearSel = () => { setSelUsers({}); setSelAccts({}); };

  const bulk = async (action, value) => {
    if (!selCount) return;
    try {
      const { data } = await api.post('/admin/accounts/bulk', { userIds: selectedUserIds, accountIds: selectedAcctIds, action, value });
      toast.success(`Updated ${data.data.updated} account(s)`);
      clearSel();
      // refresh visible children + the list
      const openUsers = Object.keys(expanded).filter((u) => expanded[u]);
      await load();
      for (const u of openUsers) { setExpanded((s) => ({ ...s, [u]: true })); loadChildren(u); }
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const doBulk = (action) => {
    if (action === 'leverage') {
      const v = window.prompt('Set leverage (1:N) for selected accounts:', '100');
      if (!v) return; bulk('leverage', v);
    } else if (action === 'group') {
      const v = window.prompt('Set account group for selected accounts:', 'default');
      if (!v) return; bulk('group', v);
    } else bulk(action);
  };

  return (
    <div className="space-y-4 max-w-[1600px]">
      <PageHero
        eyebrow="Operations"
        title="Accounts Management"
        subtitle={`${total.toLocaleString()} users with accounts · expand a user to manage their trading accounts.`}
      />

      <form onSubmit={onSearch} className="card p-3 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[220px]">
          <label className="label">Search</label>
          <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="User name, email, user ID, or account #" />
        </div>
        <div>
          <label className="label">Type</label>
          <select className="input w-36" value={fType} onChange={(e) => { setFType(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="LIVE">Live</option>
            <option value="DEMO">Demo</option>
            {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Status</label>
          <select className="input w-32" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPage(1); }}>
            <option value="">All</option>
            <option value="ACTIVE">Active</option>
            <option value="BLOCKED">Blocked</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
        </div>
        <div>
          <label className="label">Group</label>
          <input className="input w-28" value={fGroup} onChange={(e) => setFGroup(e.target.value)} placeholder="any" />
        </div>
        <div>
          <label className="label">From</label>
          <input type="date" className="input w-36" value={fFrom} onChange={(e) => { setFFrom(e.target.value); setPage(1); }} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input w-36" value={fTo} onChange={(e) => { setFTo(e.target.value); setPage(1); }} />
        </div>
        <button type="submit" className="btn-primary">Search</button>
      </form>

      {/* Bulk action bar */}
      {selCount > 0 && (
        <div className="card p-2.5 flex flex-wrap items-center gap-2 border border-primary-500/40 bg-primary-500/5 sticky top-2 z-20">
          <span className="text-sm font-semibold text-white px-2">{selCount} selected</span>
          <span className="text-[11px] text-text-muted">({selectedUserIds.length} users · {selectedAcctIds.length} accounts)</span>
          <div className="flex-1" />
          <button onClick={() => doBulk('enable')} className="btn-ghost text-xs text-emerald-400">Enable</button>
          <button onClick={() => doBulk('suspend')} className="btn-ghost text-xs text-amber-400">Suspend</button>
          <button onClick={() => doBulk('block')} className="btn-ghost text-xs text-rose-400">Block</button>
          <button onClick={() => doBulk('leverage')} className="btn-ghost text-xs text-primary-400">Set Leverage</button>
          <button onClick={() => doBulk('group')} className="btn-ghost text-xs text-primary-400">Set Group</button>
          <button onClick={clearSel} className="btn-ghost text-xs">Clear</button>
        </div>
      )}

      <div className="card overflow-auto max-h-[72vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-bg-card">
            <tr className="text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle">
              <th className="w-8 py-2.5 px-2"></th>
              <th className="w-8 py-2.5 px-2"></th>
              <th className="text-left py-2.5 px-3">User</th>
              <th className="text-center py-2.5 px-3">Accounts</th>
              <th className="text-right py-2.5 px-3">Total Balance</th>
              <th className="text-right py-2.5 px-3">Total Equity</th>
              <th className="text-center py-2.5 px-3">Status</th>
              <th className="text-left py-2.5 px-3">Registered</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-text-muted">Loading…</td></tr>}
            {!loading && users.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-text-muted">No users found</td></tr>}
            {users.map((u) => {
              const open = !!expanded[u.userId];
              return (
                <ExpandableUser
                  key={u.userId}
                  u={u} open={open}
                  onToggle={() => toggleExpand(u.userId)}
                  selectedUser={!!selUsers[u.userId]}
                  onSelectUser={(v) => setSelUsers((s) => ({ ...s, [u.userId]: v }))}
                  childLoading={!!childLoading[u.userId]}
                  accounts={children[u.userId]}
                  selAccts={selAccts}
                  onSelectAcct={(id, v) => setSelAccts((s) => ({ ...s, [id]: v }))}
                  onView={(id) => setDetail(id)}
                  onChanged={() => { refreshChild(u.userId); load(); }}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-400">
        <span>Showing {users.length} of {total} users</span>
        <div className="space-x-2">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="btn-ghost text-xs disabled:opacity-30">Prev</button>
          <span>Page {page}</span>
          <button disabled={users.length < 25} onClick={() => setPage(page + 1)} className="btn-ghost text-xs disabled:opacity-30">Next</button>
        </div>
      </div>

      {detail && <AccountDetailModal accountId={detail} onClose={() => setDetail(null)} onChanged={load} />}
    </div>
  );
}

// ── One user (parent row) + lazy nested account table ────────────────
function ExpandableUser({ u, open, onToggle, selectedUser, onSelectUser, childLoading, accounts, selAccts, onSelectAcct, onView, onChanged }) {
  const setStatus = async (acc, next) => {
    try { await api.patch(`/admin/accounts/${acc._id}/status`, { status: next }); toast.success(`Account ${next.toLowerCase()}`); onChanged(); }
    catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <>
      <tr className={`table-row ${open ? 'bg-bg-hover/40' : ''}`}>
        <td className="px-2 text-center">
          <input type="checkbox" className="accent-primary-500" checked={selectedUser} onChange={(e) => onSelectUser(e.target.checked)} title="Select all of this user's accounts" />
        </td>
        <td className="px-2 text-center">
          <button onClick={onToggle} className="text-text-muted hover:text-white transition-transform inline-block" style={{ transform: open ? 'rotate(90deg)' : 'none' }}>▶</button>
        </td>
        <td className="py-2 px-3 cursor-pointer" onClick={onToggle}>
          <div className="text-text-primary font-semibold truncate max-w-[260px]">{u.name}</div>
          <div className="text-[10px] text-text-muted truncate max-w-[260px]">{u.email}{u.userUid ? ` · ${u.userUid}` : ''}</div>
        </td>
        <td className="py-2 px-3 text-center">
          <span className="font-mono font-bold">{u.totalAccounts}</span>
          <span className="text-[10px] text-text-muted ml-1.5">{u.liveAccounts} live · {u.demoAccounts} demo</span>
        </td>
        <td className="py-2 px-3 text-right font-mono">{fmtNum(u.totalBalance, 2)}</td>
        <td className="py-2 px-3 text-right font-mono">{fmtNum(u.totalEquity, 2)}</td>
        <td className="py-2 px-3 text-center"><StatusBadge status={u.overallStatus} /></td>
        <td className="py-2 px-3 text-xs text-text-muted">{fmtDate(u.registeredAt)}</td>
      </tr>

      {open && (
        <tr>
          <td colSpan={8} className="p-0">
            <div className="bg-bg-dark/60 px-4 py-3 border-y border-border-dark animate-[fadeIn_.15s_ease]">
              {childLoading && !accounts ? (
                <div className="text-text-muted text-xs py-3 text-center">Loading accounts…</div>
              ) : !accounts || accounts.length === 0 ? (
                <div className="text-text-muted text-xs py-3 text-center">No accounts match the current filters.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] text-text-muted uppercase">
                      <tr>
                        <th className="w-8 p-2"></th>
                        <th className="text-left p-2">Account ID</th>
                        <th className="text-left p-2">Type</th>
                        <th className="text-left p-2">Group</th>
                        <th className="text-right p-2">Balance</th>
                        <th className="text-right p-2">Equity</th>
                        <th className="text-right p-2">Margin</th>
                        <th className="text-center p-2">Leverage</th>
                        <th className="text-center p-2">Status</th>
                        <th className="text-left p-2">Created</th>
                        <th className="text-right p-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts.map((a) => (
                        <tr key={a._id} className="border-t border-border-dark/60 hover:bg-bg-hover/40">
                          <td className="p-2 text-center">
                            <input type="checkbox" className="accent-primary-500" checked={!!selAccts[a._id]} onChange={(e) => onSelectAcct(a._id, e.target.checked)} />
                          </td>
                          <td className="p-2 font-mono text-primary-400">{a.accountNumber}</td>
                          <td className="p-2">
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${isDemo(a.accountType) ? 'bg-bg-hover text-text-muted' : 'bg-blue-500/15 text-blue-400'}`}>{isDemo(a.accountType) ? 'Demo' : 'Live'}</span>
                            <span className="text-text-muted ml-1.5">{a.accountType}</span>
                          </td>
                          <td className="p-2 text-text-secondary">{a.group}</td>
                          <td className="p-2 text-right font-mono">{fmtNum(a.balance, 2)}</td>
                          <td className="p-2 text-right font-mono">{fmtNum(a.equity, 2)}</td>
                          <td className="p-2 text-right font-mono text-text-muted">{fmtNum(a.margin, 2)}</td>
                          <td className="p-2 text-center font-mono">1:{a.leverage}</td>
                          <td className="p-2 text-center"><StatusBadge status={a.status} /></td>
                          <td className="p-2 text-text-muted">{fmtDate(a.createdAt)}</td>
                          <td className="p-2 text-right whitespace-nowrap space-x-1">
                            <button onClick={() => onView(a._id)} className="btn-ghost text-[11px] text-primary-400">View</button>
                            <button onClick={() => onView(a._id)} className="btn-ghost text-[11px] text-text-secondary">Edit</button>
                            {a.status === 'ACTIVE' ? (
                              <>
                                <button onClick={() => setStatus(a, 'SUSPENDED')} className="btn-ghost text-[11px] text-amber-400">Suspend</button>
                                <button onClick={() => setStatus(a, 'BLOCKED')} className="btn-ghost text-[11px] text-rose-400">Block</button>
                              </>
                            ) : (
                              <button onClick={() => setStatus(a, 'ACTIVE')} className="btn-ghost text-[11px] text-emerald-400">Unblock</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Account detail / edit modal ──────────────────────────────────────
function AccountDetailModal({ accountId, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [positions, setPositions] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [lev, setLev] = useState('');
  const [grp, setGrp] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [d, p] = await Promise.all([
        api.get(`/admin/accounts/${accountId}`),
        api.get(`/admin/accounts/${accountId}/positions`),
      ]);
      setData(d.data.data);
      setPositions(p.data.data || []);
      setLev(String(d.data.data.account.leverage ?? ''));
      setGrp(d.data.data.account.group || 'default');
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [accountId]);

  const setStatus = async (next) => {
    setBusy(true);
    try { await api.patch(`/admin/accounts/${accountId}/status`, { status: next }); toast.success(`Account ${next.toLowerCase()}`); await load(); onChanged?.(); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const saveEdit = async () => {
    setBusy(true);
    try {
      const a = data.account;
      if (String(lev) && Number(lev) !== Number(a.leverage)) await api.post('/admin/accounts/bulk', { accountIds: [accountId], action: 'leverage', value: lev });
      if (grp && grp !== (a.group || 'default')) await api.post('/admin/accounts/bulk', { accountIds: [accountId], action: 'group', value: grp });
      toast.success('Account updated'); await load(); onChanged?.();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const addNote = async () => {
    const n = noteText.trim(); if (!n) return;
    setBusy(true);
    try { const { data: r } = await api.post(`/admin/accounts/${accountId}/notes`, { note: n }); setData((d) => ({ ...d, notes: r.data.notes })); setNoteText(''); toast.success('Note added'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  };

  const acc = data?.account;
  const user = data?.user;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <h2 className="text-base font-bold text-white font-mono">{acc?.accountNumber || '…'}</h2>
            {acc && <StatusBadge status={acc.status} />}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>

        {!data ? <div className="p-8 text-center text-text-muted text-sm">Loading…</div> : (
          <div className="p-5 space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Field label="User" value={user ? ([user.firstName, user.lastName].filter(Boolean).join(' ') || user.email) : '—'} />
              <Field label="Email" value={user?.email} />
              <Field label="Type" value={`${acc.accountType} · ${isDemo(acc.accountType) ? 'Demo' : 'Live'}`} />
              <Field label="Base Currency" value={acc.baseCurrency} />
              <Field label="Created" value={fmtDate(acc.createdAt)} />
              <Field label="Trading" value={acc.isTradingEnabled === false ? 'Disabled' : 'Enabled'} />
            </div>

            {/* Edit: leverage + group */}
            <div className="bg-bg-dark rounded p-3">
              <h3 className="text-sm font-semibold text-white mb-2">Edit</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Leverage (1:N)</label><input className="input font-mono" value={lev} onChange={(e) => setLev(e.target.value)} /></div>
                <div><label className="label">Account Group</label><input className="input" value={grp} onChange={(e) => setGrp(e.target.value)} /></div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <button disabled={busy} onClick={saveEdit} className="btn-primary text-xs">Save changes</button>
                {acc.status === 'ACTIVE' ? (
                  <>
                    <button disabled={busy} onClick={() => setStatus('SUSPENDED')} className="btn-ghost text-xs text-amber-400">Suspend</button>
                    <button disabled={busy} onClick={() => setStatus('BLOCKED')} className="btn-ghost text-xs text-rose-400">Block</button>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => setStatus('ACTIVE')} className="btn-ghost text-xs text-emerald-400">Unblock</button>
                )}
              </div>
            </div>

            {data.wallets?.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-white mb-2">Wallets</h3>
                <div className="space-y-1">
                  {data.wallets.map((w) => (
                    <div key={w._id} className="flex items-center justify-between text-xs bg-bg-dark rounded px-3 py-1.5">
                      <span className="text-text-muted">{w.currency}</span>
                      <span className="font-mono">Balance {fmtNum(w.balance, 2)} · Locked {fmtNum(w.locked, 2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-sm font-semibold text-white mb-2">Open Positions ({positions?.length || 0})</h3>
              {positions === null ? <div className="text-text-muted text-xs">Loading…</div>
                : positions.length === 0 ? <div className="text-text-muted text-xs py-2">No open positions.</div>
                : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-[10px] text-text-muted uppercase"><tr>
                        <th className="text-left p-2">Symbol</th><th className="text-left p-2">Side</th>
                        <th className="text-right p-2">Qty</th><th className="text-right p-2">Entry</th>
                        <th className="text-center p-2">Lev</th><th className="text-right p-2">uPnL</th>
                      </tr></thead>
                      <tbody>
                        {positions.map((p) => (
                          <tr key={p._id} className="border-t border-border-dark/60">
                            <td className="p-2 font-mono text-gray-200">{p.symbol}</td>
                            <td className="p-2"><span className={p.positionSide === 'SHORT' || p.side === 'SELL' ? 'text-bear' : 'text-bull'}>{p.positionSide || p.side}</span></td>
                            <td className="p-2 text-right font-mono">{p.quantity}</td>
                            <td className="p-2 text-right font-mono">{p.entryPrice}</td>
                            <td className="p-2 text-center font-mono">1:{p.leverage}</td>
                            <td className={`p-2 text-right font-mono ${Number(p.unrealizedPnl) >= 0 ? 'text-bull' : 'text-bear'}`}>{fmtNum(p.unrealizedPnl, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>

            <div>
              <h3 className="text-sm font-semibold text-white mb-2">Internal Notes</h3>
              <div className="flex gap-2 mb-3">
                <input className="input flex-1" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add an internal note (admin-only)…" onKeyDown={(e) => e.key === 'Enter' && addNote()} />
                <button disabled={busy || !noteText.trim()} onClick={addNote} className="btn-primary text-xs disabled:opacity-40">Add</button>
              </div>
              {(data.notes || []).length === 0 ? <div className="text-text-muted text-xs">No notes yet.</div> : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {[...(data.notes || [])].reverse().map((n, i) => (
                    <div key={i} className="bg-bg-dark rounded px-3 py-2 text-xs">
                      <div className="text-gray-200">{n.note}</div>
                      <div className="text-[10px] text-text-muted mt-0.5">{n.byName || 'Admin'} · {fmtDate(n.at)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-gray-200 mt-0.5 truncate" title={value}>{value || '—'}</div>
    </div>
  );
}
