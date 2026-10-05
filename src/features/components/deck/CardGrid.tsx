import { memo, useCallback, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Check, MoreHorizontal, SquareStack } from 'lucide-react';
import { Spinner } from '@/ui';
import type { CardDef, ID } from '@/shared/types';
import { CardBack, CardFront, type Box } from '../previews';

interface GridProps {
  cards: CardDef[];
  box: Box;
  frontUrl: (card: CardDef) => string | undefined;
  backUrl: (card: CardDef) => string | undefined;
  backColor: string;
  showBacks: boolean;
  selected: Set<ID>;
  focusId: ID | null;
  busy: Set<ID>;
  selectMode: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onTileClick: (id: ID, e: ReactMouseEvent) => void;
  onTileDoubleClick: (id: ID) => void;
  onTileContext: (id: ID, x: number, y: number) => void;
  onDragBegin: (id: ID) => void;
  onReorder: (activeId: ID, overId: ID) => void;
  onSelectSet: (ids: Set<ID>) => void;
  onBackgroundClick: () => void;
}

export function CardGrid(props: GridProps) {
  const { cards, box, selected, scrollRef } = props;
  const [activeId, setActiveId] = useState<ID | null>(null);
  const dragEndAt = useRef(0);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 8 } }),
  );

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    props.onDragBegin(id);
    navigator.vibrate?.(8);
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null);
    dragEndAt.current = Date.now();
    if (e.over && e.active.id !== e.over.id) props.onReorder(String(e.active.id), String(e.over.id));
  };

  const click = useCallback(
    (id: ID, e: ReactMouseEvent) => {
      if (Date.now() - dragEndAt.current < 250) return;
      props.onTileClick(id, e);
    },
    [props.onTileClick],
  );

  /* ---- marquee (mouse only) ---- */
  const mq = useRef<{ x0: number; y0: number; base: Set<ID>; active: boolean } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const local = (el: HTMLElement, cx: number, cy: number) => {
    const r = el.getBoundingClientRect();
    return { x: cx - r.left + el.scrollLeft, y: cy - r.top + el.scrollTop };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || e.pointerType !== 'mouse' || e.button !== 0) return;
    if ((e.target as Element).closest('[data-card-id], button, input, a')) return;
    const r = el.getBoundingClientRect();
    if (e.clientX - r.left > el.clientWidth || e.clientY - r.top > el.clientHeight) return; // scrollbar
    const p = local(el, e.clientX, e.clientY);
    mq.current = { x0: p.x, y0: p.y, base: e.shiftKey || e.ctrlKey || e.metaKey ? new Set(selected) : new Set(), active: false };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = mq.current;
    const el = scrollRef.current;
    if (!m || !el) return;
    const p = local(el, e.clientX, e.clientY);
    if (!m.active && Math.hypot(p.x - m.x0, p.y - m.y0) < 5) return;
    m.active = true;
    const box = { x: Math.min(m.x0, p.x), y: Math.min(m.y0, p.y), w: Math.abs(p.x - m.x0), h: Math.abs(p.y - m.y0) };
    setRect(box);
    const hits = new Set(m.base);
    el.querySelectorAll<HTMLElement>('[data-card-id]').forEach((tile) => {
      const tr = tile.getBoundingClientRect();
      const t = local(el, tr.left, tr.top);
      if (t.x < box.x + box.w && t.x + tr.width > box.x && t.y < box.y + box.h && t.y + tr.height > box.y) hits.add(tile.dataset.cardId!);
    });
    props.onSelectSet(hits);
    // Scroll when dragging near the top/bottom edge.
    const r = el.getBoundingClientRect();
    if (e.clientY > r.bottom - 30) el.scrollTop += 12;
    else if (e.clientY < r.top + 30) el.scrollTop -= 12;
  };
  const onPointerUp = () => {
    const m = mq.current;
    mq.current = null;
    setRect(null);
    if (m && !m.active) props.onBackgroundClick();
  };

  const multi = activeId != null && selected.size > 1 && selected.has(activeId);
  const active = activeId ? cards.find((c) => c.id === activeId) : undefined;
  const activeIndex = active ? cards.indexOf(active) : -1;

  return (
    <div
      ref={scrollRef}
      className={`cmp-grid-scroll ${props.selectMode ? 'is-selectmode' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={rectSortingStrategy}>
          <div
            className={`cmp-grid ${cards.length > 120 ? 'is-dense' : ''}`}
            role="listbox"
            aria-multiselectable
            aria-label="Cards"
            style={{
              gridTemplateColumns: `repeat(auto-fill, ${Math.round(box.width)}px)`,
              // Lets big decks skip rendering off-screen tiles without the grid resizing.
              ['--ctile-h' as string]: `${Math.round(box.height + 30)}px`,
            }}
          >
            {cards.map((c, i) => (
              <Tile
                key={c.id}
                card={c}
                index={i}
                box={box}
                url={props.showBacks ? props.backUrl(c) : props.frontUrl(c)}
                back={props.showBacks}
                backColor={props.backColor}
                selected={selected.has(c.id)}
                focused={props.focusId === c.id}
                dimmed={multi && selected.has(c.id) && c.id !== activeId}
                busy={props.busy.has(c.id)}
                onClick={click}
                onDoubleClick={props.onTileDoubleClick}
                onContext={props.onTileContext}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }} zIndex={1500}>
          {active ? (
            <div className="cmp-ghost" style={{ width: box.width, height: box.height }}>
              {multi && (
                <>
                  <div className="cmp-ghost__layer" style={{ borderRadius: box.radius, transform: 'rotate(-7deg) translate(-6px, 4px)' }} />
                  <div className="cmp-ghost__layer" style={{ borderRadius: box.radius, transform: 'rotate(5deg) translate(6px, 2px)' }} />
                </>
              )}
              {props.showBacks ? (
                <CardBack url={props.backUrl(active)} color={props.backColor} {...box} className="cmp-ghost__card" />
              ) : (
                <CardFront url={props.frontUrl(active)} {...box} className="cmp-ghost__card" />
              )}
              {multi ? (
                <span className="cmp-ghost__badge">
                  <SquareStack size={13} /> {selected.size}
                </span>
              ) : (
                <span className="cmp-ghost__badge">#{activeIndex + 1}</span>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {rect && <div className="cmp-marquee" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
    </div>
  );
}

interface TileProps {
  card: CardDef;
  index: number;
  box: Box;
  url?: string;
  back: boolean;
  backColor: string;
  selected: boolean;
  focused: boolean;
  dimmed: boolean;
  busy: boolean;
  onClick: (id: ID, e: ReactMouseEvent) => void;
  onDoubleClick: (id: ID) => void;
  onContext: (id: ID, x: number, y: number) => void;
}

const Tile = memo(function Tile({ card, index, box, url, back, backColor, selected, focused, dimmed, busy, onClick, onDoubleClick, onContext }: TileProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    width: box.width,
    // Lets overlays sit against the bottom of the art rather than the caption.
    ['--cface-h' as string]: `${box.height}px`,
  };
  const name = card.name?.trim();
  // A press "arms" the card for the ~260 ms before the drag sensor fires, so
  // the hold has visible progress instead of 260 ms of nothing.
  const [arming, setArming] = useState(false);
  const disarm = () => setArming(false);
  return (
    <div
      ref={setNodeRef}
      data-card-id={card.id}
      {...attributes}
      {...listeners}
      role="option"
      aria-selected={selected}
      aria-label={`${name || `Card ${index + 1}`}${card.count > 1 ? `, ${card.count} copies` : ''}`}
      tabIndex={focused ? 0 : -1}
      className={`cmp-ctile ${selected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''} ${dimmed ? 'is-dimmed' : ''} ${
        arming && !isDragging ? 'is-arming' : ''
      }`}
      style={style}
      onClick={(e) => onClick(card.id, e)}
      onDoubleClick={() => onDoubleClick(card.id)}
      onPointerDown={(e) => e.pointerType !== 'mouse' && setArming(true)}
      onPointerUp={disarm}
      onPointerCancel={disarm}
      onPointerLeave={disarm}
      onContextMenu={(e) => {
        e.preventDefault();
        if ((e.nativeEvent as PointerEvent).pointerType === 'touch') return;
        onContext(card.id, e.clientX, e.clientY);
      }}
    >
      {back ? (
        <CardBack url={url} color={backColor} {...box} lazy className="cmp-ctile__face">
          {card.back && <span className="cmp-ctile__tag">Own back</span>}
        </CardBack>
      ) : (
        <CardFront url={url} {...box} lazy className="cmp-ctile__face">
          {card.back && <span className="cmp-ctile__tag">Own back</span>}
        </CardFront>
      )}
      {card.count > 1 && <span className="cmp-ctile__count">×{card.count}</span>}
      <span className="cmp-ctile__check" aria-hidden>
        <Check size={13} strokeWidth={3} />
      </span>
      {/* Touch equivalent of right-click: opens the same card menu. */}
      <button
        type="button"
        className="cmp-ctile__more"
        aria-label={`Actions for ${name || `card ${index + 1}`}`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onContext(card.id, r.left + r.width / 2, r.bottom);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {busy && (
        <span className="cmp-ctile__busy" style={{ height: box.height, borderRadius: box.radius }}>
          <Spinner size={20} />
        </span>
      )}
      <div className="cmp-ctile__name">
        <span className="cmp-ctile__num">{index + 1}</span>
        <span className="cmp-ctile__label">{name || 'Untitled'}</span>
      </div>
    </div>
  );
});
