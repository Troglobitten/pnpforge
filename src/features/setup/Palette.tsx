/**
 * The pieces palette: every component of the game, split into "not on the table yet" and
 * "on the table". Tap/click a row (or press Enter) to add it; drag it onto the table to
 * put it exactly there. On touch, a sideways drag picks a piece up and a vertical swipe
 * scrolls the list.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Box, ChessPawn, CircleDot, Gauge, GripVertical, Hexagon, Infinity as InfinityIcon, Layers, LayoutGrid, Map as MapIcon, Plus, Search, SquareDashed, StickyNote, Dices, type LucideIcon } from 'lucide-react';
import type { Component, Game, ID, TableState } from '@/shared/types';
import { assetUrlById } from '@/api/client';
import { placeable, placedCounts, type ZoneVariant } from './lib/place';
import { DieView } from '@/features/play/dice/DieView';
import { PieceView } from '@/features/play/pieces/PieceView';
import { PIECE_MATERIALS, PIECE_SHAPES, colorName, lookOf, pieceFrame } from '@/features/play/pieces/model';

export type PaletteItem = { type: 'component'; c: Component } | { type: 'note' } | { type: 'zone'; variant?: ZoneVariant } | { type: 'counter' };

interface Props {
  game: Game;
  state: TableState;
  /** Tap / click / Enter. */
  onAdd: (item: PaletteItem) => void;
  /** Released over the table at a client point. */
  onDrop: (item: PaletteItem, clientX: number, clientY: number) => void;
  /** A deck / board that is already placed: find it on the table instead of adding a copy. */
  onFind: (componentId: ID) => void;
  isOverTable: (clientX: number, clientY: number) => boolean;
  onDragging?: (dragging: boolean) => void;
}

const KIND_ICON: Record<Component['kind'], LucideIcon> = { deck: Layers, board: MapIcon, tokens: Hexagon, dice: Dices, counter: Gauge, piece: ChessPawn };
const KIND_ORDER: Component['kind'][] = ['board', 'deck', 'tokens', 'piece', 'dice', 'counter'];

function describe(c: Component): string {
  switch (c.kind) {
    case 'deck': {
      const n = c.cards.reduce((a, d) => a + Math.max(0, d.count ?? 1), 0);
      return n ? `Deck · ${n} card${n === 1 ? '' : 's'}` : 'Deck · no cards yet';
    }
    case 'board':
      return `Board · ${Math.round(c.width)}×${Math.round(c.height)} mm`;
    case 'tokens':
      return 'Tokens';
    case 'dice':
      return `Die · ${c.faces.length || 6} faces`;
    case 'counter':
      return `Counter · starts at ${c.initial}`;
    case 'piece': {
      const m = PIECE_MATERIALS.find((x) => x.id === c.material)?.label ?? 'Wood';
      const s = PIECE_SHAPES.find((x) => x.id === c.shape)?.label.toLowerCase() ?? 'piece';
      return `${m} ${s} · ${colorName(c.color) ?? 'custom colour'}`;
    }
  }
}

export function Thumb({ game, c }: { game: Game; c: Component }) {
  let url: string | undefined;
  let style: CSSProperties = {};
  let cls = '';
  let text = '';
  switch (c.kind) {
    case 'deck': {
      const first = c.cards.find((d) => d.front);
      url = assetUrlById(game, first?.front) ?? assetUrlById(game, c.back);
      style = { backgroundColor: c.backColor || '#2b3440', aspectRatio: `${c.width} / ${c.height}` };
      cls = 'is-card';
      break;
    }
    case 'board':
      url = assetUrlById(game, c.image);
      style = { aspectRatio: `${c.width} / ${c.height}` };
      cls = 'is-board';
      break;
    case 'tokens':
      url = assetUrlById(game, c.front);
      style = { backgroundColor: c.color };
      cls = c.shape === 'round' ? 'is-round' : 'is-token';
      text = url ? '' : (c.label ?? '').slice(0, 3);
      break;
    case 'dice':
      // the same solid the table draws, so a d20 in the palette is a d20
      return (
        <span className="setup-thumb" aria-hidden>
          <span className="setup-thumb__art is-die">
            <DieView look={c} face={0} size={26} resolve={(id) => assetUrlById(game, id ?? null)} />
          </span>
        </span>
      );
    case 'piece': {
      const look = lookOf(c);
      return (
        <span className="setup-thumb" aria-hidden>
          <span className="setup-thumb__art is-die">
            <PieceView look={look} scale={30 / pieceFrame(look, false).D} />
          </span>
        </span>
      );
    }
    case 'counter':
      style = { borderColor: c.color, color: c.color };
      cls = 'is-counter';
      text = String(c.initial);
      break;
  }
  return (
    <span className="setup-thumb" aria-hidden>
      <span className={`setup-thumb__art ${cls}`} style={style}>
        {url ? <img src={url} alt="" draggable={false} loading="lazy" /> : text}
      </span>
    </span>
  );
}

interface DragState {
  item: PaletteItem;
  label: string;
  x: number;
  y: number;
  over: boolean;
}

export function Palette({ game, state, onAdd, onDrop, onFind, isOverTable, onDragging }: Props) {
  const placed = placedCounts(state);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [query, setQuery] = useState('');
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const startPress = (e: React.PointerEvent, item: PaletteItem, label: string, draggable: boolean) => {
    if (!draggable || e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const id = e.pointerId;
    const touch = e.pointerType !== 'mouse';
    let active = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!active) {
        const far = Math.hypot(dx, dy) > (touch ? 10 : 5);
        // on touch only a sideways pull picks it up — up/down scrolls the list
        if (!far || (touch && Math.abs(dy) > Math.abs(dx) * 2.2)) return;
        active = true;
        onDragging?.(true);
      }
      ev.preventDefault();
      setDrag({ item, label, x: ev.clientX, y: ev.clientY, over: isOverTable(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      end();
      if (!active) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      if (ev.type === 'pointerup' && isOverTable(ev.clientX, ev.clientY)) onDrop(item, ev.clientX, ev.clientY);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      cleanup.current = null;
      setDrag(null);
      if (active) onDragging?.(false);
    };
    cleanup.current?.();
    cleanup.current = end;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const q = query.trim().toLowerCase();
  const comps = game.components
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const todo = comps.filter((c) => !placed.has(c.id));
  const done = comps.filter((c) => placed.has(c.id));

  const row = (c: Component) => {
    const n = placed.get(c.id) ?? 0;
    const can = placeable(c);
    // one copy of a deck or board is the norm — tapping a placed one finds it instead
    const single = c.kind === 'deck' || c.kind === 'board';
    const find = n > 0 && single;
    const Icon = KIND_ICON[c.kind];
    const label = c.name || 'Untitled';
    return (
      <li key={c.id}>
        <button
          type="button"
          className={`setup-pal__item ${n ? 'is-placed' : ''} ${can ? '' : 'is-disabled'} ${drag?.item.type === 'component' && drag.item.c.id === c.id ? 'is-dragging' : ''}`}
          disabled={!can}
          onPointerDown={(e) => startPress(e, { type: 'component', c }, label, can && !find)}
          onClick={() => {
            if (suppressClick.current) return;
            if (find) onFind(c.id);
            else onAdd({ type: 'component', c });
          }}
          title={!can ? 'Add cards to this deck in Components first' : find ? 'Show it on the table' : 'Tap to add, or drag onto the table'}
        >
          <Thumb game={game} c={c} />
          <span className="setup-pal__text">
            <span className="setup-pal__name">{label}</span>
            <span className="setup-pal__meta">
              <Icon size={12} aria-hidden /> {describe(c)}
            </span>
          </span>
          <span className="setup-pal__end">
            {find ? (
              <span className="setup-pal__status is-on">
                <Search size={14} aria-hidden /> Find
              </span>
            ) : can ? (
              <>
                {n > 0 && <span className="setup-pal__count">×{n}</span>}
                <span className="setup-pal__add" aria-hidden>
                  <Plus size={16} />
                </span>
              </>
            ) : null}
            {can && !find && <GripVertical size={14} className="setup-pal__grip" aria-hidden />}
          </span>
        </button>
      </li>
    );
  };

  const extra = (item: PaletteItem, Icon: LucideIcon, label: string, meta: string) => (
    <li key={item.type === 'zone' ? `zone-${item.variant ?? 'area'}` : item.type}>
      <button
        type="button"
        className="setup-pal__item is-extra"
        onPointerDown={(e) => startPress(e, item, label, true)}
        onClick={() => !suppressClick.current && onAdd(item)}
        title="Tap to add, or drag onto the table"
      >
        <span className="setup-thumb" aria-hidden>
          <span className="setup-thumb__art is-extra">
            <Icon size={18} />
          </span>
        </span>
        <span className="setup-pal__text">
          <span className="setup-pal__name">{label}</span>
          <span className="setup-pal__meta">{meta}</span>
        </span>
        <span className="setup-pal__end">
          <span className="setup-pal__add" aria-hidden>
            <Plus size={16} />
          </span>
        </span>
      </button>
    </li>
  );

  const total = game.components.length;
  const placedN = game.components.filter((c) => placed.has(c.id)).length;

  return (
    <div className="setup-pal" data-ui>
      <div className="setup-pal__head">
        <div className="setup-pal__title">
          Pieces
          {total > 0 && (
            <span className={`setup-pal__progress ${placedN === total ? 'is-done' : ''}`}>
              {placedN} of {total} on the table
            </span>
          )}
        </div>
        <p className="setup-pal__hint">Tap a piece to add it, or drag it onto the table.</p>
        {total > 6 && (
          <label className="setup-pal__search">
            <Search size={14} aria-hidden />
            <input type="search" placeholder="Find a piece" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
      </div>
      <div className="setup-pal__scroll">
        {total === 0 ? (
          <p className="setup-pal__empty">This game has no components yet. Cut cards, boards and tokens out of your PnP files in Components first.</p>
        ) : (
          <>
            {todo.length > 0 && (
              <section>
                <h3 className="setup-pal__group">
                  <CircleDot size={12} aria-hidden /> Not on the table yet · {todo.length}
                </h3>
                <ul className="setup-pal__list">{todo.map(row)}</ul>
              </section>
            )}
            {done.length > 0 && (
              <section>
                <h3 className="setup-pal__group is-done">On the table · {done.length}</h3>
                <ul className="setup-pal__list">{done.map(row)}</ul>
              </section>
            )}
            {q && !todo.length && !done.length && <p className="setup-pal__empty">No piece is called “{query}”.</p>}
          </>
        )}
        <section>
          <h3 className="setup-pal__group">Table extras</h3>
          <ul className="setup-pal__list">
            {extra({ type: 'zone' }, SquareDashed, 'Zone', 'An area cards snap into')}
            {extra({ type: 'zone', variant: 'grid' }, LayoutGrid, 'Grid', 'Rows and columns of cells')}
            {extra({ type: 'zone', variant: 'endless' }, InfinityIcon, 'Table grid', 'Cells across the whole table')}
            {extra({ type: 'zone', variant: 'pieces' }, Box, 'Piece tray', 'Tokens stack, pieces line up')}
            {extra({ type: 'zone', variant: 'dice' }, Dices, 'Dice tray', 'Dice thrown at it land inside')}
            {extra({ type: 'note' }, StickyNote, 'Sticky note', 'A reminder on the table')}
            {extra({ type: 'counter' }, Gauge, 'Counter', 'A number to track')}
          </ul>
        </section>
      </div>
      {drag &&
        createPortal(
          <div className={`setup-dragghost ${drag.over ? 'is-over' : ''}`} style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }} aria-hidden>
            {drag.item.type === 'component' ? <Thumb game={game} c={drag.item.c} /> : null}
            <span>{drag.over ? `Drop to place ${drag.label}` : drag.label}</span>
          </div>,
          document.body,
        )}
    </div>
  );
}
