import { useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';

const SUGGESTIONS = ['solo', 'card game', 'dice', 'roll & write', 'campaign', 'wallet game', 'puzzle', 'dungeon crawl', 'deck builder', 'short'];

/** Chip input: Enter / comma adds, Backspace on empty removes the last chip. */
export function TagInput({ value, onChange, id }: { value: string[]; onChange: (tags: string[]) => void; id?: string }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((t) => t.trim().replace(/\s+/g, ' ').slice(0, 32))
      .filter(Boolean);
    const next = [...value];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    if (next.length !== value.length) onChange(next);
    setText('');
  };

  const unused = SUGGESTIONS.filter((s) => !value.some((v) => v.toLowerCase() === s)).slice(0, 6);

  return (
    <div className="ov-tagfield">
      <div className="ov-tags" onClick={() => inputRef.current?.focus()}>
        {value.map((t) => (
          <span key={t} className="ov-tag">
            {t}
            <button
              type="button"
              className="ov-tag__x"
              aria-label={`Remove tag ${t}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((x) => x !== t));
              }}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          className="ov-tags__input"
          value={text}
          placeholder={value.length ? 'Add a tag…' : 'Type a tag and press Enter'}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(',')) add(v);
            else setText(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => text.trim() && add(text)}
        />
      </div>
      {unused.length > 0 && (
        <div className="ov-tagsugg">
          {unused.map((s) => (
            <button key={s} type="button" className="ov-tagsugg__btn" onClick={() => onChange([...value, s])}>
              <Plus size={11} strokeWidth={2.6} />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
