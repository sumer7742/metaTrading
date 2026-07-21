import { useState } from 'react';
import toast from 'react-hot-toast';
import { api, errorMessage } from '../services/api';

/**
 * Edit a staff member's name and/or email.
 *   - SuperAdmin can edit any admin/manager.
 *   - Admin can edit only their own managers (server-enforced).
 * Name → PATCH /hierarchy/staff/:id · Email → PATCH /hierarchy/staff/:id/email.
 * Only the fields the actor actually changed are sent.
 *
 * Props: { staff:{_id,firstName,lastName,email,role}, onClose, onSaved }
 */
export default function EditStaffModal({ staff, onClose, onSaved }) {
  const [form, setForm] = useState({
    firstName: staff.firstName || '',
    lastName: staff.lastName || '',
    email: staff.email || '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const roleLabel = staff.role === 'ADMIN' ? 'Admin' : staff.role === 'MANAGER' ? 'Manager' : staff.role;

  const submit = async () => {
    const nameChanged =
      form.firstName !== (staff.firstName || '') || form.lastName !== (staff.lastName || '');
    const email = form.email.trim();
    const emailChanged = email.toLowerCase() !== String(staff.email || '').toLowerCase();
    if (emailChanged && !email) return toast.error('Email cannot be empty');
    if (!nameChanged && !emailChanged) { onClose(); return; }
    setBusy(true);
    try {
      // Name first, then email (email can 409 on a duplicate — do it last so a
      // name change still lands even if the email is taken).
      if (nameChanged) await api.patch(`/hierarchy/staff/${staff._id}`, { firstName: form.firstName, lastName: form.lastName });
      if (emailChanged) await api.patch(`/hierarchy/staff/${staff._id}/email`, { email });
      toast.success('Saved');
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl border border-border-dark max-w-md w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between">
          <h3 className="text-base font-bold text-text-primary">Edit {roleLabel}</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><div className="label mb-1">First name</div><input className="input" value={form.firstName} onChange={set('firstName')} autoFocus /></label>
            <label className="block"><div className="label mb-1">Last name</div><input className="input" value={form.lastName} onChange={set('lastName')} /></label>
          </div>
          <label className="block"><div className="label mb-1">Email</div><input className="input" type="email" value={form.email} onChange={set('email')} placeholder="name@company.com" /></label>
          <p className="text-[12px] text-text-muted">Changing the email updates the login identity. The password is unchanged.</p>
        </div>
        <div className="px-5 py-3 border-t border-border-dark flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary text-sm disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
