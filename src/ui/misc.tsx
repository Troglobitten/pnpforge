import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={`ui-spinner ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders "Ctrl+Shift+Z" as keycaps; maps Ctrl->⌘ on macOS. */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  // "+" is itself a key, not a separator — splitting it yields two blank caps.
  const parts = (keys.trim() === '+' ? ['+'] : keys.split('+')).map((k) => {
    const t = k.trim();
    if (isMac && /^(ctrl|mod)$/i.test(t)) return '⌘';
    if (/^mod$/i.test(t)) return 'Ctrl';
    if (isMac && /^alt$/i.test(t)) return '⌥';
    if (isMac && /^shift$/i.test(t)) return '⇧';
    return t;
  });
  return (
    <span className={`ui-kbd-group ${className ?? ''}`}>
      {parts.map((p, i) => (
        <kbd key={i} className="ui-kbd">
          {p}
        </kbd>
      ))}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={`ui-empty ${compact ? 'ui-empty--compact' : ''} ${className ?? ''}`}>
      {Icon && (
        <div className="ui-empty__icon">
          <Icon size={compact ? 22 : 28} strokeWidth={1.6} />
        </div>
      )}
      <div className="ui-empty__title">{title}</div>
      {description && <div className="ui-empty__desc">{description}</div>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  );
}

export function ProgressBar({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={`ui-progress ${value == null ? 'is-indeterminate' : ''} ${className ?? ''}`} role="progressbar"
      aria-valuenow={value == null ? undefined : Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="ui-progress__bar" style={value == null ? undefined : { width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger'; className?: string }) {
  return <span className={`ui-badge ui-badge--${tone} ${className ?? ''}`}>{children}</span>;
}
