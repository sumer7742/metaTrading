import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Limits & Permissions editor for one user (admin / manager / user).
 * Shows Assigned / Used / Remaining per limit and lets the caller set new
 * values — the server validates each ≤ the caller's own granted limit and
 * audits every change. A blank value means "unlimited".
 */
export default function LimitsModal({ userId, onClose }) {
  const [view, setView] = useState(null);
  const [form, setForm] = useState({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get(`/hierarchy/limits/${userId}`);
      setView(data.data);
      const f = {};
      (data.data.rows || []).forEach((r) => { f[r.key] = r.assigned == null ? '' : String(r.assigned); });
      setForm(f);
    } catch (e) { toast.error(errorMessage(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [userId]);

  const fmt = (v, kind) => {
    if (v == null) return '∞';
    if (kind === 'money') return `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    if (kind === 'percent') return `${v}%`;
    if (kind === 'value') return `1:${v}`;
    return Number(v).toLocaleString('en-US');
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = { reason };
      Object.keys(form).forEach((k) => { payload[k] = form[k] === '' ? null : Number(form[k]); });
      const { data } = await api.put(`/hierarchy/limits/${userId}`, payload);
      setView(data.data);
      const f = {};
      (data.data.rows || []).forEach((r) => { f[r.key] = r.assigned == null ? '' : String(r.assigned); });
      setForm(f);
      toast.success('Limits updated');
      onClose?.(true);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => onClose?.(false)}>
      <div className="card max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Limits &amp; Permissions</h2>
            {view && <p className="text-[11px] text-gray-500 mt-0.5">{view.target.email} · <span className="uppercase">{view.target.role}</span></p>}
          </div>
          <button onClick={() => onClose?.(false)} className="text-gray-400 hover:text-white text-xl">×</button>
        </div>

        {!view ? (
          <div className="p-8 text-center text-gray-500 text-sm">Loading…</div>
        ) : (
          <>
            <div className="p-5">
              <table className="w-full text-sm">
                <thead className="text-[10px] text-gray-500 uppercase">
                  <tr>
                    <th className="text-left p-2">Limit</th>
                    <th className="text-right p-2">Used / Assigned</th>
                    <th className="text-right p-2">Remaining</th>
                    <th className="text-right p-2 w-44">Set (blank = ∞)</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((r) => {
                    const overParent = r.parentCap != null && form[r.key] !== '' && Number(form[r.key]) > r.parentCap;
                    return (
                      <tr key={r.key} className="border-b border-border-dark/50">
                        <td className="p-2 text-gray-300">{r.label}</td>
                        <td className="p-2 text-right font-mono text-xs">
                          <span className={r.assigned != null && r.used >= r.assigned ? 'text-bear' : 'text-gray-200'}>{fmt(r.used, r.kind)}</span>
                          <span className="text-gray-600"> / {fmt(r.assigned, r.kind)}</span>
                        </td>
                        <td className="p-2 text-right font-mono text-xs text-gray-400">{r.assigned == null ? '∞' : fmt(r.remaining, r.kind)}</td>
                        <td className="p-2">
                          <input
                            type="number" min="0" step="any"
                            className={`input font-mono text-right py-1 ${overParent ? 'border-bear' : ''}`}
                            value={form[r.key] ?? ''}
                            onChange={(e) => setForm((f) => ({ ...f, [r.key]: e.target.value }))}
                            placeholder="∞"
                            title={r.parentCap != null ? `Max allowed: ${r.parentCap}` : 'No parent limit'}
                          />
                          {r.parentCap != null && (
                            <div className={`text-[9px] text-right mt-0.5 ${overParent ? 'text-bear' : 'text-gray-600'}`}>≤ {fmt(r.parentCap, r.kind)}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="mt-3">
                <label className="label">Reason (audited)</label>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Onboarding tier, risk review" />
              </div>
            </div>

            <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
              <button onClick={() => onClose?.(false)} className="btn-ghost text-sm">Cancel</button>
              <button onClick={save} disabled={saving} className="btn-primary text-sm">{saving ? 'Saving…' : 'Save limits'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
