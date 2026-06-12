import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';
import PageHero from '../components/PageHero';
import CopySetupModal from '../components/CopySetupModal';
import { useConfirm } from '../components/ConfirmProvider';

/**
 * Copy Trading hub — three sections in one page:
 *   1. Leaderboard grid       — pick a trader, click Copy
 *   2. Live trade feed        — Instagram-style activity stream
 *   3. My copies dashboard    — active relations + pause/stop controls
 *
 * Tabs let the user jump between them on mobile; on desktop they sit
 * side-by-side. Feed auto-refreshes on focus and every 30s.
 */
export default function CopyTrade() {
  const [tab, setTab] = useState('discover'); // 'discover' | 'feed' | 'mine'
  const [leaders, setLeaders] = useState([]);
  const [feed, setFeed] = useState([]);
  const [mine, setMine] = useState([]);
  const [myProfile, setMyProfile] = useState(null);
  const [myBoxes, setMyBoxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [copyTarget, setCopyTarget] = useState(null);
  const [becomeMaster, setBecomeMaster] = useState(false);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [riskFilter, setRiskFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('roi');

  const badges = useMemo(() => computeBadges(leaders), [leaders]);
  const visibleLeaders = useMemo(() => {
    let list = leaders;
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((t) => (t.displayName || '').toLowerCase().includes(s) || (t.bio || '').toLowerCase().includes(s));
    if (riskFilter !== 'ALL') list = list.filter((t) => (t.riskBadge || 'MEDIUM') === riskFilter);
    const sorters = {
      roi:       (a, b) => Number(b.roiPct || 0) - Number(a.roiPct || 0),
      followers: (a, b) => Number(b.followers || 0) - Number(a.followers || 0),
      winRate:   (a, b) => Number(b.winRate || 0) - Number(a.winRate || 0),
      trades:    (a, b) => Number(b.totalTrades || 0) - Number(a.totalTrades || 0),
    };
    return [...list].sort(sorters[sortBy] || sorters.roi);
  }, [leaders, q, riskFilter, sortBy]);

  const refresh = async () => {
    try {
      const [lb, fd, mc, mp, bx] = await Promise.allSettled([
        api.get('/copy-trading/leaderboard?limit=50'),
        api.get('/copy-trading/feed?limit=50'),
        api.get('/copy-trading/my-copies'),
        api.get('/copy-trading/profile/me'),
        api.get('/copy-trading/boxes/me'),
      ]);
      if (lb.status === 'fulfilled') setLeaders(lb.value.data.data || []);
      if (fd.status === 'fulfilled') setFeed(fd.value.data.data || []);
      if (mc.status === 'fulfilled') setMine(mc.value.data.data || []);
      if (mp.status === 'fulfilled') setMyProfile(mp.value.data.data || null);
      if (bx.status === 'fulfilled') setMyBoxes(bx.value.data.data || []);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    const interval = setInterval(refresh, 30000);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, []);

  const setStatus = async (relationId, route) => {
    try {
      await api.post(`/copy-trading/${route}`, { relationId });
      toast.success({ pause: 'Paused', resume: 'Resumed', stop: 'Stopped copying' }[route] || 'Updated');
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  const toggleBoxPublic = async (box) => {
    try {
      await api.put(`/copy-trading/boxes/${box._id}`, { isPublic: !box.isPublic });
      toast.success(box.isPublic ? 'Box hidden from leaderboard' : 'Box is now live on the leaderboard');
      refresh();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <div className="space-y-6 max-w-[1600px]">
      <PageHero
        eyebrow="Social"
        title="Copy Trading"
        subtitle="Mirror the trades of top performers automatically. Pick a trader, set your investment, and the system copies their entries, closes and SL/TP for you."
        actions={
          <button onClick={() => setBecomeMaster(true)} className="btn-primary text-sm inline-flex items-center gap-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            Become a master trader
          </button>
        }
      />

      {/* My copy boxes — one per source trading account. */}
      <MyBoxesSection boxes={myBoxes} onCreate={() => setBecomeMaster(true)} onToggle={toggleBoxPublic} />

      {/* Tab strip — mobile drives section, desktop shows all 3 in grid */}
      <div className="card p-1 inline-flex md:hidden">
        {[
          { id: 'discover', label: 'Discover' },
          { id: 'feed',     label: 'Feed' },
          { id: 'mine',     label: 'My Copies' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-all ${
              tab === t.id
                ? 'bg-primary-500/10 text-primary-600'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-text-muted px-2 py-8">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
          {/* Leaderboard — 7/12 on desktop */}
          <section className={`md:col-span-7 ${tab === 'discover' ? '' : 'hidden md:block'}`}>
            <SectionHeader title="Top traders" count={leaders.length} />
            {leaders.length === 0 ? (
              <div className="card p-10 text-center text-text-muted">No public copy boxes yet — create one from your trading account to get listed.</div>
            ) : (
              <>
                {/* Search + filters + sort */}
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <input
                    value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search traders…"
                    className="flex-1 min-w-[160px] px-3 py-2 rounded-xl border border-border-dark bg-white text-sm focus:outline-none focus:border-primary-500"
                  />
                  <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}
                    className="px-3 py-2 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-secondary focus:outline-none focus:border-primary-500">
                    <option value="ALL">All risk</option>
                    <option value="LOW">Low risk</option>
                    <option value="MEDIUM">Medium risk</option>
                    <option value="HIGH">High risk</option>
                  </select>
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                    className="px-3 py-2 rounded-xl border border-border-dark bg-white text-sm font-semibold text-text-secondary focus:outline-none focus:border-primary-500">
                    <option value="roi">Sort: ROI</option>
                    <option value="followers">Sort: Followers</option>
                    <option value="winRate">Sort: Win rate</option>
                    <option value="trades">Sort: Trades</option>
                  </select>
                </div>
                {visibleLeaders.length === 0 ? (
                  <div className="card p-8 text-center text-text-muted text-sm">No traders match your filters.</div>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-4">
                    {visibleLeaders.map((t) => (
                      <TraderCard
                        key={t._id}
                        trader={t}
                        badge={badges[t._id]}
                        onView={() => navigate(`/copy-trading/trader/${t.userId}?account=${t.accountId}`)}
                        onCopy={() => setCopyTarget(t)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Right column — feed + my copies stacked */}
          <aside className={`md:col-span-5 space-y-5 ${tab === 'discover' ? 'hidden md:block' : ''}`}>
            <section className={tab === 'feed' || tab === 'discover' ? '' : 'hidden md:block'}>
              <SectionHeader title="Live feed" count={feed.length} />
              <div className="card divide-y divide-border-subtle max-h-[480px] overflow-y-auto">
                {feed.length === 0 && (
                  <div className="px-4 py-10 text-center text-[12px] text-text-muted">No activity yet</div>
                )}
                {feed.map((e) => (
                  <FeedRow key={e._id} event={e} />
                ))}
              </div>
            </section>

            <section className={tab === 'mine' || tab === 'discover' ? '' : 'hidden md:block'}>
              <SectionHeader title="My copies" count={mine.length} />
              {mine.length === 0 ? (
                <div className="card p-10 text-center text-[12px] text-text-muted">
                  You aren't copying anyone yet — pick a trader on the left to start.
                </div>
              ) : (
                <div className="space-y-3">
                  {mine.map((rel) => (
                    <MyCopyRow key={rel._id} rel={rel} onAction={setStatus} />
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      )}

      {copyTarget && (
        <CopySetupModal
          trader={copyTarget}
          onClose={() => setCopyTarget(null)}
          onStarted={() => {
            setCopyTarget(null);
            refresh();
            setTab('mine');
          }}
        />
      )}

      {becomeMaster && (
        <BecomeMasterModal
          initialFee={myProfile?.performanceFeePercent ?? ''}
          onClose={() => setBecomeMaster(false)}
          onCreated={() => { setBecomeMaster(false); refresh(); setTab('mine'); }}
        />
      )}
    </div>
  );
}

/* ── Copy boxes (one per source trading account) ────────────────────── */
function MyBoxesSection({ boxes, onCreate, onToggle }) {
  if (!boxes.length) {
    return (
      <div className="card p-4 flex items-center gap-4 flex-wrap border-2 border-dashed border-border-dark">
        <span className="shrink-0 w-12 h-12 rounded-full bg-primary-500/15 text-primary-600 flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-extrabold text-text-primary">Become a master trader</div>
          <p className="text-[12px] text-text-muted mt-0.5">
            Create a copy box from one of your trading accounts. Only that account's trades are copied to your followers.
          </p>
        </div>
        <button onClick={onCreate} className="btn-primary text-sm">Create a copy box</button>
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-base font-extrabold text-text-primary tracking-tight">My copy boxes</h2>
        <button onClick={onCreate} className="btn-ghost text-xs">+ New box</button>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {boxes.map((b) => (
          <div key={b._id} className={`card p-4 border-2 ${b.isPublic ? 'border-emerald-300' : 'border-border-dark'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-extrabold text-text-primary truncate">{b.displayName || b.accountNumber}</div>
                <div className="text-[11px] text-text-secondary mt-0.5">
                  <span className="font-semibold">{b.accountType}</span> · {b.accountNumber}
                </div>
              </div>
              <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${b.isPublic ? 'bg-emerald-500/15 text-emerald-700' : 'bg-text-muted/15 text-text-muted'}`}>
                {b.isPublic ? 'Live' : 'Private'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center mt-3">
              <Stat label="ROI" value={`${Number(b.roiPct || 0) >= 0 ? '+' : ''}${Number(b.roiPct || 0).toFixed(1)}%`} tone={Number(b.roiPct || 0) >= 0 ? 'bull' : 'bear'} />
              <Stat label="Win" value={`${Number(b.winRate || 0).toFixed(0)}%`} />
              <Stat label="Followers" value={Number(b.followers || 0)} />
            </div>
            {!b.acceptsFollowers && (
              <div className="mt-2 text-[11px] text-bear bg-bear/10 rounded-lg px-2 py-1">
                Source account disabled — not accepting new followers.
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <button onClick={() => onToggle(b)} className="btn-ghost text-xs">
                {b.isPublic ? 'Make private' : 'Go public'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BecomeMasterModal({ onClose, onCreated, initialFee = '' }) {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [riskBadge, setRiskBadge] = useState('MEDIUM');
  const [isPublic, setIsPublic] = useState(true);
  const [feePct, setFeePct] = useState(initialFee === null || initialFee === undefined ? '' : String(initialFee));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get('/copy-trading/eligible-accounts');
        const list = r.data.data || [];
        setAccounts(list);
        const first = list.find((a) => !a.hasBox) || list[0];
        if (first) setAccountId(first.accountId);
      } catch (e) { toast.error(errorMessage(e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const create = async () => {
    if (!accountId) { toast.error('Select a trading account'); return; }
    setSaving(true);
    try {
      await api.post('/copy-trading/boxes', { accountId, displayName: displayName.trim(), riskBadge, isPublic });
      // Performance fee is owner-level (applies to all your boxes). Blank → platform default.
      await api.put('/copy-trading/profile/me', {
        performanceFeePercent: feePct === '' ? null : Number(feePct),
      }).catch(() => {});
      toast.success('Copy box created');
      onCreated?.();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-base font-extrabold text-text-primary">Become a master trader</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Source trading account</label>
            <p className="text-[11px] text-text-muted mb-2 leading-snug">Pick the account to copy from. <span className="font-semibold text-text-secondary">Only this account's trades</span> are mirrored to followers.</p>
            {loading ? (
              <div className="text-text-muted text-sm py-4">Loading accounts…</div>
            ) : accounts.length === 0 ? (
              <div className="text-text-muted text-sm py-4">No active trading accounts found.</div>
            ) : (
              <div className="space-y-2">
                {accounts.map((a) => (
                  <label key={a.accountId}
                    className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition-all ${
                      accountId === a.accountId ? 'border-primary-500 bg-primary-500/5' : 'border-border-dark hover:border-primary-500/50'}`}>
                    <input type="radio" name="srcAcc" checked={accountId === a.accountId} onChange={() => setAccountId(a.accountId)} className="accent-primary-500" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-text-primary">{a.accountNumber} <span className="text-text-muted font-semibold">({a.accountType})</span></div>
                      <div className="text-[11px] text-text-muted">
                        {a.baseCurrency}
                        {a.hasBox ? ' · box exists (will update)' : ''}
                        {!a.acceptsFollowers ? ' · inactive' : ''}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Box name</label>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Aggressive FX Scalper" maxLength={40}
              className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15" />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Risk badge</label>
            <div className="grid grid-cols-3 gap-2">
              {[{ id: 'LOW', label: 'Low' }, { id: 'MEDIUM', label: 'Medium' }, { id: 'HIGH', label: 'High' }].map((r) => (
                <button key={r.id} type="button" onClick={() => setRiskBadge(r.id)}
                  className={`rounded-xl border-2 p-2 text-center text-sm font-extrabold transition-all ${
                    riskBadge === r.id ? 'border-primary-500 bg-primary-500/5 text-primary-600' : 'border-border-dark text-text-secondary hover:border-primary-500'}`}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center justify-between gap-3 rounded-xl border border-border-dark px-3 py-2.5 cursor-pointer">
            <div className="min-w-0">
              <div className="text-sm font-bold text-text-primary">List on the leaderboard</div>
              <div className="text-[11px] text-text-muted mt-0.5">Others can discover this box and copy it.</div>
            </div>
            <button type="button" onClick={() => setIsPublic((v) => !v)}
              className={`shrink-0 relative w-11 h-6 rounded-full transition ${isPublic ? 'bg-emerald-500' : 'bg-border-dark'}`}>
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition ${isPublic ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </label>

          {/* Performance fee — owner-level (applies to all your boxes). */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Performance fee</label>
            <div className="relative">
              <input type="number" min="0" step="1" value={feePct} onChange={(e) => setFeePct(e.target.value)} placeholder="Platform default"
                className="w-full pl-3 pr-8 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-mono font-bold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">%</span>
            </div>
            <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
              Your cut of each follower's <span className="font-semibold text-text-secondary">profit</span> on winning copied trades — credited to your Main Wallet. No fee on losses. Blank = platform default. Applies to all your boxes.
            </p>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="btn-ghost text-sm">Cancel</button>
          <button onClick={create} disabled={saving || !accountId} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Creating…' : 'Create copy box'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Master-trader banner ───────────────────────────────────────────── */
function MyProfileBanner({ profile, onEdit }) {
  const isLive = !!profile.isPublic;
  return (
    <div
      className={`card p-4 flex items-center gap-4 flex-wrap border-2 ${
        isLive ? 'border-emerald-300' : 'border-border-dark'
      }`}
    >
      <span className="shrink-0 w-12 h-12 rounded-full bg-primary-500/15 text-primary-600 flex items-center justify-center text-base font-extrabold">
        {(profile.displayName || 'You').slice(0, 2).toUpperCase()}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-extrabold text-text-primary">{profile.displayName || 'Set a display name'}</span>
          {isLive ? (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live on leaderboard
            </span>
          ) : (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-text-muted/15 text-text-muted">
              Private
            </span>
          )}
        </div>
        <p className="text-[12px] text-text-muted mt-0.5">
          {isLive
            ? `${Number(profile.followers || 0)} follower${profile.followers === 1 ? '' : 's'} · ROI ${Number(profile.roiPct || 0).toFixed(1)}% · ${profile.totalTrades || 0} trades`
            : 'Go public to let others copy your trades. Your stats are tracked automatically.'}
        </p>
      </div>
      <button onClick={onEdit} className="btn-primary text-sm">
        {isLive ? 'Edit profile' : 'Become a master trader'}
      </button>
    </div>
  );
}

/* ── Profile editor modal ───────────────────────────────────────────── */
function ProfileEditorModal({ profile, onClose, onSaved }) {
  const [form, setForm] = useState({
    displayName: profile?.displayName || '',
    bio:         profile?.bio || '',
    riskBadge:   profile?.riskBadge || 'MEDIUM',
    isPublic:    !!profile?.isPublic,
    performanceFeePercent: profile?.performanceFeePercent ?? '', // '' → platform default
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (form.isPublic && !form.displayName.trim()) {
      toast.error('Display name required to go public');
      return;
    }
    setSaving(true);
    try {
      const r = await api.put('/copy-trading/profile/me', {
        displayName: form.displayName.trim(),
        bio:         form.bio.trim(),
        riskBadge:   form.riskBadge,
        isPublic:    form.isPublic,
        performanceFeePercent:
          form.performanceFeePercent === '' ? null : Number(form.performanceFeePercent),
      });
      toast.success('Profile saved');
      onSaved?.(r.data.data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <h3 className="text-base font-extrabold text-text-primary">Master trader profile</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Public toggle — front and centre. */}
          <label className="flex items-center justify-between gap-3 rounded-xl border border-border-dark px-3 py-2.5 cursor-pointer">
            <div className="min-w-0">
              <div className="text-sm font-bold text-text-primary">List me on the leaderboard</div>
              <div className="text-[11px] text-text-muted mt-0.5 leading-snug">
                Other users can find your profile, see your ROI/win rate, and copy your trades.
              </div>
            </div>
            <button
              type="button"
              onClick={() => set('isPublic', !form.isPublic)}
              className={`shrink-0 relative w-11 h-6 rounded-full transition ${
                form.isPublic ? 'bg-emerald-500' : 'bg-border-dark'
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition ${
                  form.isPublic ? 'left-[22px]' : 'left-0.5'
                }`}
              />
            </button>
          </label>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">
              Display name <span className="text-bear">*</span>
            </label>
            <input
              value={form.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              placeholder="e.g. AlexFX"
              maxLength={32}
              className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-semibold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Bio</label>
            <textarea
              value={form.bio}
              onChange={(e) => set('bio', e.target.value)}
              placeholder="Short pitch — your style, markets, edge."
              maxLength={160}
              rows={3}
              className="w-full px-3 py-2.5 rounded-xl border border-border-dark bg-white text-sm focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15 resize-none"
            />
            <div className="text-[10px] text-text-muted mt-1 text-right">{form.bio.length}/160</div>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">Risk badge</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'LOW',    label: 'Low',    note: 'Conservative',  tone: 'bg-emerald-50 text-emerald-700 border-emerald-300' },
                { id: 'MEDIUM', label: 'Medium', note: 'Balanced',      tone: 'bg-amber-50 text-amber-700 border-amber-300' },
                { id: 'HIGH',   label: 'High',   note: 'Aggressive',    tone: 'bg-rose-50 text-rose-700 border-rose-300' },
              ].map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => set('riskBadge', r.id)}
                  className={`rounded-xl border-2 p-2.5 text-left transition-all ${
                    form.riskBadge === r.id
                      ? `${r.tone} border-current shadow-sm`
                      : 'border-border-dark bg-white text-text-secondary hover:border-primary-500'
                  }`}
                >
                  <div className="text-sm font-extrabold">{r.label}</div>
                  <div className="text-[10px] mt-0.5 opacity-80">{r.note}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Performance fee the master earns on profitable copied trades. */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-text-muted mb-1.5">
              Performance fee
            </label>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="1"
                value={form.performanceFeePercent}
                onChange={(e) => set('performanceFeePercent', e.target.value)}
                placeholder="Platform default"
                className="w-full pl-3 pr-8 py-2.5 rounded-xl border border-border-dark bg-white text-sm font-mono font-bold focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/15"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">%</span>
            </div>
            <p className="text-[11px] text-text-muted mt-1.5 leading-snug">
              Your cut of each follower's <span className="font-semibold text-text-secondary">profit</span> on winning copied trades — credited to your Bonus Wallet. No fee on losses or breakeven. Leave blank to use the platform default.
            </p>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="btn-ghost text-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, count }) {
  return (
    <div className="flex items-baseline justify-between mb-3 px-1">
      <h2 className="text-base font-extrabold text-text-primary tracking-tight">{title}</h2>
      {count !== undefined && (
        <span className="text-[11px] text-text-muted">{count}</span>
      )}
    </div>
  );
}

function TraderCard({ trader, onCopy, onView, badge }) {
  const roi = Number(trader.roiPct || 0);
  const win = Number(trader.winRate || 0);
  const riskTone = {
    LOW:    'bg-emerald-50 text-emerald-700',
    MEDIUM: 'bg-amber-50 text-amber-700',
    HIGH:   'bg-rose-50 text-rose-700',
  }[trader.riskBadge] || 'bg-text-muted/10 text-text-muted';

  return (
    <div className="card p-4 flex flex-col gap-3 hover:shadow-elevated transition-shadow">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onView} className="shrink-0 w-12 h-12 rounded-full bg-primary-500/15 text-primary-600 flex items-center justify-center text-sm font-extrabold hover:ring-2 hover:ring-primary-500/40 transition">
          {(trader.displayName || 'T').slice(0, 2).toUpperCase()}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={onView} className="font-extrabold text-text-primary truncate hover:text-primary-600 transition-colors text-left">
              {trader.displayName || 'Trader'}
            </button>
            {badge && (
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-primary-500/10 text-primary-600" title={badge.label}>
                {badge.icon} {badge.label}
              </span>
            )}
            <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${riskTone}`}>
              {trader.riskBadge || 'MED'}
            </span>
          </div>
          {(trader.accountType || trader.ownerName) && (
            <p className="text-[10px] text-text-secondary mt-0.5 truncate">
              {trader.accountType && <span className="font-semibold">{trader.accountType}</span>}
              {trader.accountType && trader.ownerName ? ' · ' : ''}
              {trader.ownerName || ''}
            </p>
          )}
          <p className="text-[11px] text-text-muted line-clamp-2 mt-0.5">{trader.bio || 'Active trader on the platform.'}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="ROI" value={`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`} tone={roi >= 0 ? 'bull' : 'bear'} />
        <Stat label="Win" value={`${win.toFixed(0)}%`} />
        <Stat label="Followers" value={Number(trader.followers || 0).toLocaleString()} />
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onView} className="btn-ghost text-sm flex-1">View profile</button>
        <button type="button" onClick={onCopy} className="btn-primary text-sm flex-1">Copy</button>
      </div>
    </div>
  );
}

// Award leaderboard badges to standout traders (top ROI / most followed /
// rising star / elite). Keyed by profile _id; at most one badge per trader.
function computeBadges(leaders) {
  const map = {};
  if (!leaders.length) return map;
  const add = (t, badge) => { if (t && !map[t._id]) map[t._id] = badge; };
  const byRoi = [...leaders].sort((a, b) => Number(b.roiPct || 0) - Number(a.roiPct || 0));
  const byFollowers = [...leaders].sort((a, b) => Number(b.followers || 0) - Number(a.followers || 0));
  const byWin = [...leaders].sort((a, b) => Number(b.winRate || 0) - Number(a.winRate || 0));
  add(byRoi[0], { icon: '🏆', label: 'Top Trader' });
  add(byFollowers[0], { icon: '🔥', label: 'Most Followed' });
  add(byRoi.find((t) => Number(t.followers || 0) >= 100 && Number(t.roiPct || 0) >= 50), { icon: '💎', label: 'Elite' });
  add(byWin.find((t) => Number(t.winRate || 0) >= 55 && Number(t.followers || 0) < 50), { icon: '⭐', label: 'Rising Star' });
  return map;
}

function Stat({ label, value, tone }) {
  const cls = tone === 'bull' ? 'text-bull' : tone === 'bear' ? 'text-bear' : 'text-text-primary';
  return (
    <div className="rounded-lg bg-bg-hover/40 py-1.5">
      <div className="text-[9px] uppercase tracking-wider font-bold text-text-muted">{label}</div>
      <div className={`text-sm font-extrabold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function FeedRow({ event }) {
  const ts = new Date(event.createdAt);
  const elapsed = formatElapsed(Date.now() - ts.getTime());
  const dot = {
    OPEN:   'bg-blue-500',
    CLOSE:  'bg-emerald-500',
    TP_HIT: 'bg-emerald-500',
    SL_HIT: 'bg-rose-500',
    FOLLOWED: 'bg-violet-500',
  }[event.type] || 'bg-text-muted';
  const pnlNum = Number(event.pnl);
  const showPnl = Number.isFinite(pnlNum) && (event.type === 'CLOSE' || event.type === 'TP_HIT' || event.type === 'SL_HIT');
  return (
    <div className="px-4 py-2.5 flex items-start gap-3 hover:bg-bg-hover/30 transition-colors">
      <span className={`shrink-0 w-2 h-2 rounded-full mt-1.5 ${dot}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-text-primary font-medium leading-snug">
          {event.note || `${event.masterName} ${event.type.toLowerCase()} ${event.symbol}`}
        </div>
        <div className="text-[10px] text-text-muted mt-0.5 flex items-center gap-2">
          <span>{elapsed}</span>
          {event.symbol && <span>· {event.symbol}</span>}
          {showPnl && (
            <span className={pnlNum >= 0 ? 'text-bull font-semibold' : 'text-bear font-semibold'}>
              · {pnlNum >= 0 ? '+' : ''}{pnlNum.toFixed(2)} USD
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MyCopyRow({ rel, onAction }) {
  const confirm = useConfirm();
  const m = rel.master || {};
  const running = Number(rel.runningPnl || 0);
  const tone = rel.status === 'ACTIVE' ? 'bg-bull/15 text-bull'
            : rel.status === 'PAUSED' ? 'bg-warn/15 text-warn'
            : 'bg-text-muted/15 text-text-muted';
  return (
    <div className="card p-3">
      <div className="flex items-start gap-3">
        <span className="shrink-0 w-10 h-10 rounded-full bg-primary-500/15 text-primary-600 flex items-center justify-center text-xs font-extrabold">
          {(m.displayName || 'T').slice(0, 2).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-extrabold text-text-primary truncate">{m.displayName || 'Trader'}</span>
            <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${tone}`}>{rel.status}</span>
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 flex items-center gap-2 flex-wrap">
            <span>${Number(rel.investment).toFixed(2)} · {rel.riskLevel}</span>
            <span>· {rel.tradesCopied || 0} copies</span>
            <span>· {(rel.openMirrors || []).length} open</span>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-sm font-extrabold tabular-nums ${running >= 0 ? 'text-bull' : 'text-bear'}`}>
            {running >= 0 ? '+' : ''}{running.toFixed(2)} USD
          </div>
          <div className="text-[10px] text-text-muted">Running PnL</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {rel.status === 'ACTIVE' && (
          <button onClick={() => onAction(rel._id, 'pause')} className="btn-ghost text-xs">Pause</button>
        )}
        {rel.status !== 'ACTIVE' && rel.status !== 'STOPPED' && (
          <button onClick={() => onAction(rel._id, 'resume')} className="btn-ghost text-xs">Resume</button>
        )}
        {rel.status !== 'STOPPED' && (
          <button
            onClick={async () => {
              if (await confirm('Stop copying this trader? Open mirrored trades stay open until they close on their own.')) {
                onAction(rel._id, 'stop');
              }
            }}
            className="text-xs font-bold px-2.5 py-1 rounded text-bear hover:bg-bear/10 transition-colors"
          >
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

function formatElapsed(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
