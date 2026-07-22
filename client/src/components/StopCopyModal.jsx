import { useState } from 'react';

/**
 * StopCopyModal — the "Stop copy trading?" dialog. Lets the follower choose
 * whether open copied positions are closed automatically or kept open (manual).
 * The session row is preserved either way, so it can be resumed later.
 * onConfirm(closePositions:boolean) performs the stop.
 */
export default function StopCopyModal({ rel, onClose, onConfirm }) {
  const [choice, setChoice] = useState('keep'); // 'close' | 'keep'
  const [saving, setSaving] = useState(false);
  const openCount = (rel.openMirrors || []).length;

  const confirm = async () => {
    setSaving(true);
    try { await onConfirm(choice === 'close'); }
    finally { setSaving(false); }
  };

  const Option = ({ id, title, desc, danger }) => (
    <button type="button" onClick={() => setChoice(id)}
      className={`w-full text-left rounded-xl border-2 p-3 transition-colors ${
        choice === id
          ? (danger ? 'border-bear bg-bear/5' : 'border-primary-500 bg-primary-500/5')
          : 'border-border-dark hover:border-primary-500/50'}`}>
      <div className="flex items-center gap-2">
        <span className={`w-4 h-4 rounded-full border-2 shrink-0 grid place-items-center ${choice === id ? (danger ? 'border-bear' : 'border-primary-500') : 'border-border-dark'}`}>
          {choice === id && <span className={`w-2 h-2 rounded-full ${danger ? 'bg-bear' : 'bg-primary-500'}`} />}
        </span>
        <span className="font-bold text-text-primary">{title}</span>
      </div>
      <div className="text-[12px] text-text-secondary mt-1 ml-6">{desc}</div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="card max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between">
          <h3 className="font-extrabold text-text-primary">Stop copy trading?</h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          <p className="text-[13px] text-text-secondary">
            {openCount > 0
              ? <>This copy has <span className="font-semibold text-text-primary">{openCount} open position(s)</span>. Choose what happens to them:</>
              : 'New trades will stop being copied. You can resume this session later with the same settings.'}
          </p>
          {openCount > 0 && (
            <div className="space-y-2">
              <Option id="close" title="Close automatically" desc="Market-close all open copied positions now." danger />
              <Option id="keep"  title="Keep open (close manually)" desc="Leave positions open — you'll close them yourself." />
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className="btn-ghost text-sm">Cancel</button>
          <button onClick={confirm} disabled={saving} className="btn-primary text-sm disabled:opacity-50">
            {saving ? 'Stopping…' : 'Confirm stop'}
          </button>
        </div>
      </div>
    </div>
  );
}
