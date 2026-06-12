import { useRef, useEffect } from 'react';

/**
 * Dependency-free rich-text editor (contentEditable + execCommand). Emits HTML
 * via onChange. Uncontrolled body to keep the caret stable — the parent value
 * is only pushed in when it differs from what's already rendered.
 */
const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'Bold', style: { fontWeight: 700 } },
  { cmd: 'italic', label: 'I', title: 'Italic', style: { fontStyle: 'italic' } },
  { cmd: 'underline', label: 'U', title: 'Underline', style: { textDecoration: 'underline' } },
  { block: 'H2', label: 'H2', title: 'Heading 2' },
  { block: 'H3', label: 'H3', title: 'Heading 3' },
  { block: 'P', label: 'P', title: 'Paragraph' },
  { cmd: 'insertUnorderedList', label: '• List', title: 'Bullet list' },
  { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  { block: 'BLOCKQUOTE', label: '❝', title: 'Quote' },
  { link: true, label: '🔗', title: 'Insert link' },
  { cmd: 'removeFormat', label: '⨯', title: 'Clear formatting' },
];

export default function RichTextEditor({ value = '', onChange, placeholder = 'Write content…' }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || '')) {
      ref.current.innerHTML = value || '';
    }
  }, [value]);

  const exec = (e, tool) => {
    e.preventDefault();
    ref.current?.focus();
    if (tool.link) {
      const url = window.prompt('Link URL (https://…)');
      if (url) document.execCommand('createLink', false, url);
    } else if (tool.block) {
      document.execCommand('formatBlock', false, tool.block);
    } else {
      document.execCommand(tool.cmd, false, null);
    }
    emit();
  };
  const emit = () => onChange?.(ref.current?.innerHTML || '');

  return (
    <div className="border border-border-dark rounded-lg overflow-hidden bg-bg-dark">
      <div className="flex flex-wrap gap-0.5 p-1.5 border-b border-border-dark bg-bg-card">
        {TOOLS.map((t, i) => (
          <button key={i} type="button" title={t.title} onMouseDown={(e) => exec(e, t)}
            className="min-w-[30px] px-2 py-1 text-xs font-semibold text-text-secondary hover:text-white hover:bg-bg-hover rounded transition-colors"
            style={t.style}>{t.label}</button>
        ))}
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        data-placeholder={placeholder}
        className="cms-editor min-h-[220px] max-h-[460px] overflow-y-auto p-3 text-sm text-text-primary focus:outline-none"
      />
    </div>
  );
}
