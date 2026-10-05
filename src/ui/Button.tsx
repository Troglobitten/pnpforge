import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip } from './Tooltip';
import type { Placement } from './floating';
import { Spinner } from './misc';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  loading,
  block,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'lg' ? 18 : size === 'sm' ? 14 : 16;
  return (
    <button
      type={type}
      className={`ui-btn ui-btn--${variant} ui-btn--${size} ${block ? 'ui-btn--block' : ''} ${className ?? ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : Icon ? <Icon size={iconSize} strokeWidth={2} aria-hidden /> : null}
      {children != null && <span className="ui-btn__label">{children}</span>}
      {IconRight && !loading && <IconRight size={iconSize} strokeWidth={2} aria-hidden />}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Accessible label; also shown as tooltip. */
  label: string;
  shortcut?: string;
  variant?: 'ghost' | 'secondary' | 'primary' | 'danger' | 'glass';
  size?: ButtonSize;
  active?: boolean;
  tooltip?: boolean;
  tooltipPlacement?: Placement;
  badge?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon: Icon,
  label,
  shortcut,
  variant = 'ghost',
  size = 'md',
  active,
  tooltip = true,
  tooltipPlacement = 'top',
  badge,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const iconSize = size === 'lg' ? 20 : size === 'sm' ? 15 : 18;
  const btn = (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={`ui-iconbtn ui-iconbtn--${variant} ui-iconbtn--${size} ${active ? 'is-active' : ''} ${className ?? ''}`}
      {...rest}
    >
      <Icon size={iconSize} strokeWidth={2} aria-hidden />
      {badge != null && <span className="ui-iconbtn__badge">{badge}</span>}
    </button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip label={label} shortcut={shortcut} placement={tooltipPlacement}>
      {btn}
    </Tooltip>
  );
}
