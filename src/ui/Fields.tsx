import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from 'react';
import { Minus, Plus, type LucideIcon } from 'lucide-react';

export function Field({
  label,
  hint,
  error,
  children,
  inline,
  className,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  inline?: boolean;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={`ui-field ${inline ? 'ui-field--inline' : ''} ${className ?? ''}`}>
      {label && (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <div className="ui-field__control">{children}</div>
      {error ? <div className="ui-field__error">{error}</div> : hint ? <div className="ui-field__hint">{hint}</div> : null}
    </div>
  );
}

export function TextInput({
  className,
  icon: Icon,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon; ref?: Ref<HTMLInputElement> }) {
  if (Icon)
    return (
      <div className={`ui-input-wrap ${className ?? ''}`}>
        <Icon size={16} className="ui-input-wrap__icon" />
        <input ref={ref} className="ui-input ui-input--with-icon" {...rest} />
      </div>
    );
  return <input ref={ref} className={`ui-input ${className ?? ''}`} {...rest} />;
}

export function TextArea({ className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={`ui-input ui-textarea ${className ?? ''}`} {...rest} />;
}

/**
 * Numeric input with −/+ steppers and optional unit. Typing is free-form and
 * committed on blur/Enter; ↑/↓ step (Shift ×10).
 */
export function NumberField({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  precision,
  unit,
  size = 'md',
  disabled,
  className,
  id,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}) {
  const decimals = precision ?? (String(step).split('.')[1]?.length ?? 0);
  const fmt = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(decimals))) : '');
  const [draft, setDraft] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(fmt(value));
  }, [value, decimals]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (raw: string) => {
    const v = parseFloat(raw.replace(',', '.'));
    if (Number.isFinite(v)) {
      const c = clamp(Number(v.toFixed(decimals)));
      onChange(c);
      setDraft(fmt(c));
    } else setDraft(fmt(value));
  };
  const nudge = (dir: number, mult = 1) => {
    const c = clamp(Number((value + dir * step * mult).toFixed(decimals)));
    onChange(c);
    setDraft(fmt(c));
  };

  return (
    <div className={`ui-number ui-number--${size} ${disabled ? 'is-disabled' : ''} ${className ?? ''}`}>
      <button type="button" tabIndex={-1} aria-label="Decrease" disabled={disabled || value <= min} onClick={() => nudge(-1)}>
        <Minus size={14} />
      </button>
      <input
        id={id}
        aria-label={ariaLabel}
        inputMode="decimal"
        disabled={disabled}
        value={draft}
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={(e) => {
          focused.current = false;
          commit(e.currentTarget.value);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          else if (e.key === 'ArrowUp') {
            e.preventDefault();
            nudge(1, e.shiftKey ? 10 : 1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(-1, e.shiftKey ? 10 : 1);
          }
        }}
      />
      {unit && <span className="ui-number__unit">{unit}</span>}
      <button type="button" tabIndex={-1} aria-label="Increase" disabled={disabled || value >= max} onClick={() => nudge(1)}>
        <Plus size={14} />
      </button>
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  disabled,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select id={id} className={`ui-input ui-select ${className ?? ''}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={`ui-switch ${disabled ? 'is-disabled' : ''} ${className ?? ''}`} htmlFor={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-switch__track">
        <span className="ui-switch__thumb" />
      </span>
      {label && <span className="ui-switch__label">{label}</span>}
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const pct = ((value - min) / (max - min || 1)) * 100;
  return (
    <input
      type="range"
      aria-label={ariaLabel}
      className={`ui-slider ${className ?? ''}`}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ ['--pct' as any]: `${pct}%` }}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label?: ReactNode; icon?: LucideIcon; title?: string }[];
  size?: 'sm' | 'md';
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`ui-seg ui-seg--${size} ${className ?? ''}`}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            title={o.title}
            className={`ui-seg__opt ${value === o.value ? 'is-on' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {Icon && <Icon size={15} />}
            {o.label != null && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

export const SWATCHES = ['#b8412f', '#d9822b', '#e6b94a', '#5f9b56', '#3f8f8a', '#3f6fb0', '#6b58b3', '#a4508b', '#2b2a31', '#f1ebdd'];

export function ColorField({ value, onChange, swatches = SWATCHES }: { value: string; onChange: (v: string) => void; swatches?: string[] }) {
  return (
    <div className="ui-colors">
      {swatches.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          className={`ui-colors__sw ${value.toLowerCase() === c.toLowerCase() ? 'is-on' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="ui-colors__custom" title="Custom colour">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <span style={{ background: value }} />
      </label>
    </div>
  );
}
