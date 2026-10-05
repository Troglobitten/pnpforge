import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Portal, computePosition, type Placement } from './floating';
import { Kbd } from './misc';

interface TooltipProps {
  label: ReactNode;
  /** e.g. "F" or "Ctrl+Z" — rendered as keycaps. */
  shortcut?: string;
  placement?: Placement;
  disabled?: boolean;
  delay?: number;
  children: ReactNode;
  className?: string;
}

/**
 * Hover/keyboard-focus tooltip. Never shows for touch input (tablets get
 * labels via long-press menus or visible text instead).
 */
export function Tooltip({ label, shortcut, placement = 'top', disabled, delay = 380, children, className }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: string } | null>(null);

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  };

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    setPos(computePosition(a, t, placement, 8));
  }, [open, placement, label]);

  return (
    <span
      ref={anchorRef}
      className={`ui-tip-anchor ${className ?? ''}`}
      onPointerEnter={(e) => e.pointerType !== 'touch' && !disabled && show()}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(e) => {
        if (!disabled && (e.target as HTMLElement).matches?.(':focus-visible')) show();
      }}
      onBlur={hide}
    >
      {children}
      {open && !disabled && (
        <Portal>
          <div
            ref={tipRef}
            role="tooltip"
            className="ui-tooltip"
            data-side={pos?.side}
            style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, opacity: pos ? 1 : 0 }}
          >
            <span>{label}</span>
            {shortcut && <Kbd keys={shortcut} />}
          </div>
        </Portal>
      )}
    </span>
  );
}
