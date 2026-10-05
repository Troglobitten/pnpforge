import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { Portal, clampToViewport, computePosition, type Placement } from './floating';
import { Kbd } from './misc';

export type MenuItem =
  | {
      type?: 'item';
      label: ReactNode;
      icon?: LucideIcon;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      /** Secondary text shown under the label. */
      hint?: ReactNode;
      onSelect?: () => void;
      submenu?: MenuItem[];
    }
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode };

interface MenuProps {
  items: MenuItem[];
  onClose: () => void;
  /** Screen position (context menu) … */
  x?: number;
  y?: number;
  /** … or an anchor rect (dropdown). */
  anchor?: DOMRect;
  placement?: Placement;
  minWidth?: number;
  className?: string;
  /** Nested menus: the pointer arrived on this menu (cancels the parent's pending close). */
  onPointerEnterMenu?: () => void;
  /** Nested menus: this menu's element, so the parent can aim a safe triangle at it. */
  menuRef?: (el: HTMLDivElement | null) => void;
}

/** Is `p` inside triangle abc? */
function inTriangle(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const s = (u: typeof p, v: typeof p, w: typeof p) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
  const d1 = s(p, a, b);
  const d2 = s(p, b, c);
  const d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function isActionable(it: MenuItem) {
  return (it.type === undefined || it.type === 'item') && !it.disabled;
}

/**
 * A floating menu. Keyboard: ↑/↓ to move, Enter to choose, → opens submenus,
 * ←/Esc closes. Closes on outside pointer-down.
 */
export function Menu({ items, onClose, x = 0, y = 0, anchor, placement = 'bottom-start', minWidth = 200, className, onPointerEnterMenu, menuRef }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Hover intent: moving diagonally from a parent item toward its open submenu crosses other items.
  // Switching (or closing) the submenu waits a moment — longer while the pointer is still heading
  // into the submenu (inside the triangle from where it was to the submenu's near edge) — and
  // arriving on the submenu cancels the switch. Touch and keyboard switch immediately.
  const subEl = useRef<HTMLDivElement | null>(null);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef(0);
  const cancelPending = () => {
    window.clearTimeout(pending.current);
    pending.current = 0;
  };
  useEffect(() => cancelPending, []);
  const headingToSub = (px: number, py: number) => {
    const r = subEl.current?.getBoundingClientRect();
    const from = lastPt.current;
    if (!r || !from) return false;
    const edge = r.left >= from.x - 1 ? r.left : r.right;
    return inTriangle({ x: px, y: py }, { x: from.x - (edge > from.x ? 4 : -4), y: from.y }, { x: edge, y: r.top - 12 }, { x: edge, y: r.bottom + 12 });
  };
  const [pos, setPos] = useState<{ x: number; y: number; side?: string } | null>(null);
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    // offsetWidth/Height, not getBoundingClientRect(): the open animation starts at
    // scale(.98), so a rect measured on mount is 2 % short and the menu is placed too
    // low — a long menu then runs off the bottom of a short window.
    const size = { width: ref.current.offsetWidth, height: ref.current.offsetHeight };
    if (anchor) setPos(computePosition(anchor, size, placement, 6));
    else setPos(clampToViewport(x, y, size));
  }, [x, y, anchor, placement]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.('.ui-menu')) return; // submenu
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (sub) return;
      if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let i = active;
        for (let n = 0; n < items.length; n++) {
          i = (i + dir + items.length) % items.length;
          if (isActionable(items[i])) break;
        }
        setActive(i);
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
        const it = items[active];
        if (!it || !isActionable(it) || it.type === 'separator' || it.type === 'label') return;
        e.preventDefault();
        if (it.submenu) {
          const el = ref.current?.querySelectorAll<HTMLElement>('.ui-menu__item')[active];
          if (el) setSub({ index: active, rect: el.getBoundingClientRect() });
        } else if (e.key !== 'ArrowRight') {
          onClose();
          it.onSelect?.();
        }
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [items, active, onClose, sub]);

  return (
    <Portal>
      <div
        ref={(el) => {
          ref.current = el;
          menuRef?.(el);
        }}
        role="menu"
        className={`ui-menu ${className ?? ''}`}
        style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, minWidth, opacity: pos ? 1 : 0 }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={() => onPointerEnterMenu?.()}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' || e.pointerType === 'pen') lastPt.current = { x: e.clientX, y: e.clientY };
        }}
      >
        {items.map((it, i) => {
          if (it.type === 'separator') return <div key={i} className="ui-menu__sep" role="separator" />;
          if (it.type === 'label')
            return (
              <div key={i} className="ui-menu__label">
                {it.label}
              </div>
            );
          const Icon = it.icon;
          return (
            <button
              key={i}
              role="menuitem"
              className={`ui-menu__item ${it.danger ? 'is-danger' : ''} ${i === active ? 'is-active' : ''}`}
              disabled={it.disabled}
              onPointerEnter={(e) => {
                setActive(i);
                const rect = e.currentTarget.getBoundingClientRect();
                const next = () => (it.submenu ? setSub({ index: i, rect }) : setSub(null));
                cancelPending();
                if (sub?.index === i) return;
                if (!sub || e.pointerType === 'touch') return next();
                pending.current = window.setTimeout(() => {
                  pending.current = 0;
                  next();
                }, headingToSub(e.clientX, e.clientY) ? 420 : 140);
              }}
              onClick={(e) => {
                cancelPending();
                if (it.submenu) {
                  setSub({ index: i, rect: e.currentTarget.getBoundingClientRect() });
                  return;
                }
                onClose();
                it.onSelect?.();
              }}
            >
              <span className="ui-menu__icon">
                {it.checked ? <Check size={15} /> : Icon ? <Icon size={15} strokeWidth={2} /> : null}
              </span>
              <span className="ui-menu__text">
                <span>{it.label}</span>
                {it.hint && <span className="ui-menu__hint">{it.hint}</span>}
              </span>
              {it.shortcut && <Kbd keys={it.shortcut} className="ui-menu__kbd" />}
              {it.submenu && <ChevronRight size={14} className="ui-menu__chev" />}
            </button>
          );
        })}
      </div>
      {sub && items[sub.index] && 'submenu' in items[sub.index] && (items[sub.index] as any).submenu && (
        <Menu
          items={(items[sub.index] as any).submenu}
          anchor={sub.rect}
          // keep cascading the way this menu had to open, so a nested list never covers its parents
          placement={pos?.side === 'left' ? 'left-start' : 'right-start'}
          onClose={() => {
            setSub(null);
            onClose();
          }}
          minWidth={180}
          onPointerEnterMenu={() => {
            cancelPending();
            setActive(sub.index);
          }}
          menuRef={(el) => void (subEl.current = el)}
        />
      )}
    </Portal>
  );
}

/** A trigger that opens a dropdown Menu anchored beneath it. */
export function MenuButton({
  items,
  children,
  placement = 'bottom-end',
  minWidth,
}: {
  items: MenuItem[] | (() => MenuItem[]);
  children: ReactNode;
  placement?: Placement;
  minWidth?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <span
        ref={ref}
        className="ui-menubutton"
        onClick={(e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : ref.current!.getBoundingClientRect());
        }}
      >
        {children}
      </span>
      {anchor && (
        <Menu
          items={typeof items === 'function' ? items() : items}
          anchor={anchor}
          placement={placement}
          minWidth={minWidth}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
