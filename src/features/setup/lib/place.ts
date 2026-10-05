/**
 * Pure setup-only operations on a TableState: turning components into table pieces,
 * arranging them automatically, z-order, duplication, alignment and grid snapping.
 * Everything else (move / flip / rotate / lock / delete) is the play engine's.
 */
import type { CardInstance, Component, Entity, Game, ID, StackEntity, TableState, ZoneEntity } from '@/shared/types';
import { CARD_PRESETS } from '@/shared/types';
import { gridBox, sanitizeGrid } from '@/features/play/engine/zones';
import { lookOf, pieceSize } from '@/features/play/pieces/model';
import { baseSize, newId, ops, stateBounds, worldAABB, type Rect, type Vec } from '@/features/play/engine';

type S = TableState;
type GameLike = Pick<Game, 'components'>;

/** Every physical card of a deck, in definition order, face down. */
export function deckCards(c: Extract<Component, { kind: 'deck' }>): CardInstance[] {
  const out: CardInstance[] = [];
  for (const def of c.cards) for (let i = 0; i < Math.max(0, def.count ?? 1); i++) out.push({ uid: newId(), deckId: c.id, cardId: def.id, faceUp: false });
  return out;
}

/** Can this component be put on the table at all? (A deck needs at least one card.) */
export function placeable(c: Component): boolean {
  return c.kind !== 'deck' || c.cards.some((d) => (d.count ?? 1) > 0);
}

/** A new table piece for a component, centred at `at`. Null when it can't be placed. */
export function entityFromComponent(c: Component, at: Vec): Entity | null {
  const base = { id: newId(), x: at.x, y: at.y, rot: 0 };
  switch (c.kind) {
    case 'deck': {
      const cards = deckCards(c);
      if (!cards.length) return null;
      return { ...base, kind: 'stack', cards, layout: 'pile', name: c.name, shuffleOnStart: cards.length > 1 };
    }
    case 'board':
      return { ...base, kind: 'board', componentId: c.id, locked: true };
    case 'tokens':
      return { ...base, kind: 'token', componentId: c.id, faceUp: true, count: 1, infinite: true };
    case 'dice':
      return { ...base, kind: 'die', componentId: c.id, face: 0 };
    case 'piece':
      return { ...base, kind: 'piece', componentId: c.id };
    case 'counter':
      return {
        ...base,
        kind: 'counter',
        componentId: c.id,
        label: c.label || c.name,
        value: c.initial,
        min: c.min,
        max: c.max,
        step: c.step || 1,
        color: c.color,
      };
  }
}

/** Which components does an entity represent? (A stack can mix decks.) */
export function componentIdsOf(e: Entity): ID[] {
  if (e.kind === 'stack') return [...new Set(e.cards.map((c) => c.deckId))];
  if ('componentId' in e && e.componentId) return [e.componentId];
  return [];
}

/** How many table pieces use each component. */
export function placedCounts(s: S): Map<ID, number> {
  const m = new Map<ID, number>();
  for (const id of s.order) {
    const e = s.entities[id];
    if (!e) continue;
    for (const cid of componentIdsOf(e)) m.set(cid, (m.get(cid) ?? 0) + 1);
  }
  for (const c of s.hand ?? []) if (!m.has(c.deckId)) m.set(c.deckId, 1);
  return m;
}

/* ------------------------------------------------------------------ */
/* Arrange automatically                                                */
/* ------------------------------------------------------------------ */

const GAP = 14;

/**
 * Lay out every component that isn't on the table yet: a board in the middle, decks in
 * columns to its left, tokens / dice / counters in columns to its right. Pieces already
 * on the table are never moved.
 */
export function arrangeUnplaced(game: GameLike, s: S): { state: S; ids: ID[] } {
  const placed = placedCounts(s);
  const todo = game.components.filter((c) => !placed.has(c.id) && placeable(c));
  let state = s;
  const ids: ID[] = [];
  const add = (e: Entity | null) => {
    if (!e) return;
    state = ops.addEntity(state, e);
    ids.push(e.id);
  };

  // boards: the first in the middle (if the table has no board yet), the rest below
  const hasBoard = s.order.some((id) => s.entities[id]?.kind === 'board');
  for (const c of todo.filter((c) => c.kind === 'board')) {
    const b = stateBounds(game, state);
    if (!b || (!hasBoard && ids.length === 0)) {
      add(entityFromComponent(c, b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: 0, y: 0 }));
    } else {
      const probe = entityFromComponent(c, { x: 0, y: 0 })!;
      const sz = baseSize(game, probe);
      add({ ...probe, x: b.x + b.w / 2, y: b.y + b.h + GAP + sz.h / 2 });
    }
  }

  const area: Rect = stateBounds(game, state) ?? { x: -70, y: -50, w: 140, h: 100 };
  const column = (list: Component[], side: 'left' | 'right') => {
    let edge = side === 'left' ? area.x - GAP : area.x + area.w + GAP;
    let y = area.y;
    let colW = 0;
    for (const c of list) {
      const probe = entityFromComponent(c, { x: 0, y: 0 });
      if (!probe) continue;
      const sz = baseSize(game, probe);
      const w = sz.w + (probe.kind === 'token' && probe.infinite ? sz.w * 0.6 : 0);
      if (y > area.y && y + sz.h > area.y + Math.max(area.h, 180)) {
        edge = side === 'left' ? edge - colW - GAP : edge + colW + GAP;
        y = area.y;
        colW = 0;
      }
      const cx = side === 'left' ? edge - w / 2 : edge + w / 2;
      add({ ...probe, x: cx, y: y + sz.h / 2 });
      y += sz.h + GAP + (probe.kind === 'token' || probe.kind === 'die' || probe.kind === 'piece' ? 6 : 0);
      colW = Math.max(colW, w);
    }
  };
  column(todo.filter((c) => c.kind === 'deck'), 'left');
  column(todo.filter((c) => c.kind === 'tokens' || c.kind === 'piece' || c.kind === 'dice' || c.kind === 'counter'), 'right');
  return { state, ids };
}

/* ------------------------------------------------------------------ */
/* Z-order (within the render layer the engine enforces)                */
/* ------------------------------------------------------------------ */

export function sendToBack(s: S, ids: ID[]): S {
  const set = new Set(ids);
  const head = s.order.slice(0, set.size);
  if (head.length === set.size && head.every((id) => set.has(id))) return s;
  return { ...s, order: [...s.order.filter((id) => set.has(id)), ...s.order.filter((id) => !set.has(id))] };
}

/** Move each piece one step past the nearest overlapping piece above (+1) or below (−1). */
export function stepOrder(game: GameLike, s: S, ids: ID[], dir: 1 | -1): S {
  const order = s.order.slice();
  const set = new Set(ids);
  const seq = dir === 1 ? [...ids].sort((a, b) => order.indexOf(b) - order.indexOf(a)) : [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  let changed = false;
  for (const id of seq) {
    const e = s.entities[id];
    const i = order.indexOf(id);
    if (!e || i < 0) continue;
    const box = worldAABB(game, e);
    let j = i + dir;
    // skip past pieces that don't overlap (reordering those changes nothing visible)
    while (j >= 0 && j < order.length) {
      const o = s.entities[order[j]];
      if (o && !set.has(o.id) && intersects(box, worldAABB(game, o))) break;
      j += dir;
    }
    if (j < 0 || j >= order.length) continue;
    order.splice(i, 1);
    order.splice(j, 0, id);
    changed = true;
  }
  return changed ? { ...s, order } : s;
}

function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/* ------------------------------------------------------------------ */
/* Duplicate / align / snap                                            */
/* ------------------------------------------------------------------ */

/** Copies of the pieces, offset a little. Stacks are never copied (their cards would be duplicated). */
export function duplicateEntities(s: S, ids: ID[], offset = 12): { state: S; ids: ID[] } {
  let state = s;
  const out: ID[] = [];
  for (const id of s.order.filter((i) => ids.includes(i))) {
    const e = s.entities[id];
    if (!e || e.kind === 'stack') continue;
    const copy = { ...e, id: newId(), x: e.x + offset, y: e.y + offset } as Entity;
    if (copy.kind === 'die') delete copy.rollSeq;
    state = ops.addEntity(state, copy);
    out.push(copy.id);
  }
  return { state, ids: out };
}

export type Align = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignEntities(game: GameLike, s: S, ids: ID[], how: Align): S {
  const ents = ids.map((id) => s.entities[id]).filter(Boolean) as Entity[];
  if (ents.length < 2) return s;
  const boxes = ents.map((e) => worldAABB(game, e));
  const all = boxes.reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), r: Math.max(a.r, b.x + b.w), b: Math.max(a.b, b.y + b.h) }), {
    x: Infinity,
    y: Infinity,
    r: -Infinity,
    b: -Infinity,
  });
  let state = s;
  ents.forEach((e, i) => {
    const b = boxes[i];
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = all.x - b.x;
    if (how === 'right') dx = all.r - (b.x + b.w);
    if (how === 'hcenter') dx = (all.x + all.r) / 2 - (b.x + b.w / 2);
    if (how === 'top') dy = all.y - b.y;
    if (how === 'bottom') dy = all.b - (b.y + b.h);
    if (how === 'vcenter') dy = (all.y + all.b) / 2 - (b.y + b.h / 2);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) state = ops.translateEntities(state, [e.id], dx, dy);
  });
  return state;
}

/** Spread 3+ pieces evenly between the outermost two along an axis. */
export function distributeEntities(game: GameLike, s: S, ids: ID[], axis: 'x' | 'y'): S {
  const ents = (ids.map((id) => s.entities[id]).filter(Boolean) as Entity[]).map((e) => ({ e, b: worldAABB(game, e) }));
  if (ents.length < 3) return s;
  const key = (r: Rect) => (axis === 'x' ? r.x + r.w / 2 : r.y + r.h / 2);
  ents.sort((a, b) => key(a.b) - key(b.b));
  const first = key(ents[0].b);
  const step = (key(ents[ents.length - 1].b) - first) / (ents.length - 1);
  let state = s;
  ents.forEach(({ e, b }, i) => {
    const d = first + step * i - key(b);
    if (Math.abs(d) > 0.01) state = ops.translateEntities(state, [e.id], axis === 'x' ? d : 0, axis === 'y' ? d : 0);
  });
  return state;
}

/**
 * Snap pieces that just moved so their top-left corner lands on the grid. Only entities
 * whose position changed between `prev` and `next` are touched, and the whole moved
 * group shifts together so a multi-selection keeps its shape.
 */
export function snapMoved(game: GameLike, prev: S, next: S, grid: number): S {
  const moved = next.order.filter((id) => {
    const a = prev.entities[id];
    const b = next.entities[id];
    return a && b && (a.x !== b.x || a.y !== b.y);
  });
  if (!moved.length) return next;
  const lead = next.entities[moved[0]];
  const b = worldAABB(game, lead);
  const dx = Math.round(b.x / grid) * grid - b.x;
  const dy = Math.round(b.y / grid) * grid - b.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return next;
  return ops.translateEntities(next, moved, dx, dy);
}

/* ------------------------------------------------------------------ */
/* Zones & sizing                                                       */
/* ------------------------------------------------------------------ */

export const ZONE_COLORS = ['#e6a756', '#72b4db', '#7cc59b', '#e8715f', '#b79ce0', '#f1ebdd'];

export function newZone(rect: Rect, label = 'Zone'): ZoneEntity {
  return {
    id: newId(),
    kind: 'zone',
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
    rot: 0,
    w: rect.w,
    h: rect.h,
    label,
    color: ZONE_COLORS[0],
    snap: 'pile',
  };
}

export type ZoneVariant = 'area' | 'grid' | 'endless' | 'pieces' | 'dice';

/** The cell a new grid starts with: the game's first deck (else a poker card). */
function defaultCell(game: GameLike): { cellW: number; cellH: number; preset: string } {
  const deck = game.components.find((c) => c.kind === 'deck');
  if (deck?.kind === 'deck') return { cellW: deck.width, cellH: deck.height, preset: `deck:${deck.id}` };
  return { cellW: 63.5, cellH: 88.9, preset: 'card:poker' };
}

/** A new zone of one of the palette's kinds, centred on `at`. */
export function newZoneOf(game: GameLike, variant: ZoneVariant, at: Vec): ZoneEntity {
  const centred = (w: number, h: number, label: string) => newZone({ x: at.x - w / 2, y: at.y - h / 2, w, h }, label);
  switch (variant) {
    case 'grid': {
      const g = sanitizeGrid({ ...defaultCell(game), gapX: 4, gapY: 4, cols: 3, rows: 2 })!;
      const b = gridBox(g);
      return { ...centred(b.w, b.h, 'Grid'), grid: g };
    }
    case 'endless': {
      const g = sanitizeGrid({ ...defaultCell(game), gapX: 6, gapY: 6, cols: 1, rows: 1, endless: true })!;
      return { ...centred(g.cellW, g.cellH, 'Table grid'), grid: g, color: ZONE_COLORS[5] };
    }
    case 'pieces':
      return { ...centred(100, 64, 'Pieces'), accepts: ['tokens', 'pieces'], color: ZONE_COLORS[2] };
    case 'dice':
      return { ...centred(90, 70, 'Dice tray'), accepts: ['dice'], pieceMode: 'free', color: ZONE_COLORS[1] };
    default: {
      const sz = defaultZoneSize(game);
      return centred(sz.w, sz.h, 'Zone');
    }
  }
}

/** Cell sizes a grid can take from the game's own pieces and the standard card sizes. */
export function cellPresets(game: GameLike): { value: string; label: string; w: number; h: number }[] {
  const out: { value: string; label: string; w: number; h: number }[] = [];
  const mm = (v: number) => (Math.round(v * 10) / 10).toString();
  for (const c of game.components) {
    if (c.kind === 'deck') out.push({ value: `deck:${c.id}`, label: `${c.name || 'Deck'} · ${mm(c.width)} × ${mm(c.height)} mm`, w: c.width, h: c.height });
  }
  for (const c of game.components) {
    if (c.kind === 'tokens') out.push({ value: `tokens:${c.id}`, label: `${c.name || 'Token'} · ${mm(c.width)} × ${mm(c.height)} mm`, w: c.width, h: c.height });
    else if (c.kind === 'piece') {
      const d = pieceSize(lookOf(c), false);
      out.push({ value: `piece:${c.id}`, label: `${c.name || 'Piece'} · ${mm(d)} mm`, w: d, h: d });
    } else if (c.kind === 'dice') out.push({ value: `dice:${c.id}`, label: `${c.name || 'Die'} · ${mm(c.size)} mm`, w: c.size, h: c.size });
  }
  for (const p of CARD_PRESETS) out.push({ value: `card:${p.id}`, label: `${p.label}${/card$/i.test(p.label) ? '' : ' card'} ·${mm(p.width)} × ${mm(p.height)} mm`, w: p.width, h: p.height });
  return out;
}

/** A zone big enough for one card of the game's first deck, with a margin. */
export function defaultZoneSize(game: GameLike): { w: number; h: number } {
  const deck = game.components.find((c) => c.kind === 'deck');
  const w = deck?.kind === 'deck' ? deck.width : 63.5;
  const h = deck?.kind === 'deck' ? deck.height : 88.9;
  return { w: Math.round(w + 12), h: Math.round(h + 12) };
}

/** Stacks fully face up / down, or mixed. */
export function stackFace(st: StackEntity): 'up' | 'down' | 'mixed' {
  const up = st.cards.filter((c) => c.faceUp).length;
  return up === 0 ? 'down' : up === st.cards.length ? 'up' : 'mixed';
}
