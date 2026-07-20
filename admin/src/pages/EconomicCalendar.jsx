import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

// Admin-managed economic calendar. These events are MERGED with the app's
// built-in generated global schedule on the client, so turning an event off
// here only removes YOUR events — the global schedule keeps showing unless the
// whole calendar is hidden via the toggle. Config lives in systemSettings
// ('economic.config') and is saved as a whole { enabled, events } blob.

const IMPACTS = ['high', 'medium', 'low'];
const blankEvent = () => ({
  id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  date: '', country: '', currency: '', impact: 'high', event: '',
  previous: '', consensus: '', forecast: '', actual: '', unit: '',
});

// Backend stores UTC ISO; <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm".
const toLocalInput = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');
const fromConfig = (arr) => (arr || []).map((e) => ({ ...blankEvent(), ...e, date: toLocalInput(e.date) }));

export default function EconomicCalendar() {
  const [enabled, setEnabled] = useState(true);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/cms/economic-config');
      setEnabled(data.data?.enabled !== false);
      setEvents(fromConfig(data.data?.events));
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const update = (id, k, v) => setEvents((arr) => arr.map((e) => (e.id === id ? { ...e, [k]: v } : e)));
  const addRow = () => setEvents((arr) => [blankEvent(), ...arr]);
  const removeRow = (id) => setEvents((arr) => arr.filter((e) => e.id !== id));

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        enabled,
        events: events
          .filter((e) => e.date && String(e.event).trim())
          .map((e) => ({
            id: e.id, country: e.country, currency: e.currency, impact: e.impact,
            event: e.event, unit: e.unit,
            previous: e.previous, consensus: e.consensus, forecast: e.forecast, actual: e.actual,
            date: new Date(e.date).toISOString(),
          })),
      };
      const { data } = await api.put('/admin/cms/economic-config', payload);
      setEnabled(data.data?.enabled !== false);
      setEvents(fromConfig(data.data?.events));
      toast.success('Economic calendar saved');
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Economic Calendar</h1>
          <p className="text-sm text-text-muted mt-0.5 max-w-2xl">
            Add your own macro events and show/hide the calendar app-wide. Your events appear
            <b> alongside</b> the built-in global schedule (they don’t replace it).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-primary-600 w-4 h-4" />
            {enabled ? 'Calendar visible' : 'Calendar hidden'}
          </label>
          <button onClick={addRow} className="btn-secondary text-sm">+ Add event</button>
          <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      {!enabled && (
        <div className="rounded-lg border p-3 text-xs leading-snug" style={{ background: '#F59E0B14', borderColor: '#F59E0B55', color: '#FCD34D' }}>
          ⚠ The economic calendar is currently <b>hidden</b> from users (Explore page + sidebar). Toggle “Calendar visible” above and Save to show it again.
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm min-w-[920px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-border-dark">
              <th className="p-2">Date / time (UTC)</th>
              <th className="p-2">Country</th>
              <th className="p-2">Ccy</th>
              <th className="p-2">Impact</th>
              <th className="p-2">Event</th>
              <th className="p-2">Prev</th>
              <th className="p-2">Cons</th>
              <th className="p-2">Fcast</th>
              <th className="p-2">Actual</th>
              <th className="p-2">Unit</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={11} className="p-4 text-center text-text-muted">Loading…</td></tr>}
            {!loading && events.length === 0 && (
              <tr><td colSpan={11} className="p-4 text-center text-text-muted">No custom events yet — click “+ Add event”. The built-in global schedule still shows to users.</td></tr>
            )}
            {events.map((e) => (
              <tr key={e.id} className="border-b border-border-subtle align-middle">
                <td className="p-1.5"><input type="datetime-local" className="input !py-1 text-xs" value={e.date} onChange={(ev) => update(e.id, 'date', ev.target.value)} /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-14 uppercase" value={e.country} onChange={(ev) => update(e.id, 'country', ev.target.value)} placeholder="US" /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-16 uppercase" value={e.currency} onChange={(ev) => update(e.id, 'currency', ev.target.value)} placeholder="USD" /></td>
                <td className="p-1.5"><select className="input !py-1 text-xs" value={e.impact} onChange={(ev) => update(e.id, 'impact', ev.target.value)}>{IMPACTS.map((i) => <option key={i} value={i}>{i}</option>)}</select></td>
                <td className="p-1.5"><input className="input !py-1 text-xs min-w-[170px]" value={e.event} onChange={(ev) => update(e.id, 'event', ev.target.value)} placeholder="Non-Farm Payrolls" /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-16 font-mono" value={e.previous ?? ''} onChange={(ev) => update(e.id, 'previous', ev.target.value)} /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-16 font-mono" value={e.consensus ?? ''} onChange={(ev) => update(e.id, 'consensus', ev.target.value)} /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-16 font-mono" value={e.forecast ?? ''} onChange={(ev) => update(e.id, 'forecast', ev.target.value)} /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-16 font-mono" value={e.actual ?? ''} onChange={(ev) => update(e.id, 'actual', ev.target.value)} /></td>
                <td className="p-1.5"><input className="input !py-1 text-xs w-14" value={e.unit} onChange={(ev) => update(e.id, 'unit', ev.target.value)} placeholder="K, %" /></td>
                <td className="p-1.5"><button onClick={() => removeRow(e.id)} className="text-bear hover:bg-bear/10 rounded px-2 py-1 text-xs">Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-text-muted">
        Tip: leave a value blank to omit it. “Actual” shows once the event has passed. Times are UTC.
      </p>
    </div>
  );
}
