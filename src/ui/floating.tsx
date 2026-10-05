import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}

export type Placement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'right-start'
  | 'left-start';

const OPPOSITE: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Compute a viewport-clamped position for a floating element next to an anchor.
 * Flips to the opposite side when there is not enough room.
 */
export function computePosition(
  anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  size: { width: number; height: number },
  placement: Placement = 'bottom',
  gap = 8,
  pad = 8,
): { x: number; y: number; side: string } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let [side, align] = placement.split('-') as [string, string | undefined];

  const fits = (s: string) => {
    if (s === 'top') return anchor.top - gap - size.height >= pad;
    if (s === 'bottom') return anchor.bottom + gap + size.height <= vh - pad;
    if (s === 'left') return anchor.left - gap - size.width >= pad;
    return anchor.right + gap + size.width <= vw - pad;
  };
  if (!fits(side) && fits(OPPOSITE[side])) side = OPPOSITE[side];

  let x = 0;
  let y = 0;
  if (side === 'top' || side === 'bottom') {
    y = side === 'top' ? anchor.top - gap - size.height : anchor.bottom + gap;
    if (align === 'start') x = anchor.left;
    else if (align === 'end') x = anchor.right - size.width;
    else x = anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    x = side === 'left' ? anchor.left - gap - size.width : anchor.right + gap;
    if (align === 'start') y = anchor.top;
    else y = anchor.top + anchor.height / 2 - size.height / 2;
  }
  x = Math.max(pad, Math.min(x, vw - size.width - pad));
  y = Math.max(pad, Math.min(y, vh - size.height - pad));
  return { x, y, side };
}

/** Anchor-less position (e.g. a context menu at the pointer). */
export function clampToViewport(x: number, y: number, size: { width: number; height: number }, pad = 8) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + size.width > vw - pad) x = Math.max(pad, x - size.width);
  if (y + size.height > vh - pad) y = Math.max(pad, vh - size.height - pad);
  return { x: Math.max(pad, x), y: Math.max(pad, y) };
}
