/**
 * Pure geometry helpers for the table: component lookup, entity sizes, stack
 * layouts (pile / row / fan / grid), hit testing and bounds. Everything is in
 * table millimetres unless stated otherwise.
 */
import type {
  CardDef,
  CardInstance,
  Component,
  DeckComponent,
  Entity,
  Game,
  ID,
  StackEntity,
  TableState,
} from '@/shared/types';
import { lookOf, pieceSize } from '../pieces/model';

/** World-layer CSS px per millimetre (entities are laid out at this density, the camera scales it). */
export const K = 4;

export const DEFAULT_CARD = { w: 63.5, h: 88.9, r: 3 };
export const COUNTER_SIZE = { w: 58, h: 30 };
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 14;
/** Cards per line before a spread-out row wraps onto the next line. */
export const ROW_MAX = 12;

export interface Vec {
  x: number;
  y: number;
}
/** Axis-aligned rectangle, top-left based, mm. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type GameLike = Pick<Game, 'components'>;

/* ------------------------------------------------------------------ */
/* Component lookup (cached per components array)                      */
/* ------------------------------------------------------------------ */

const compCache = new WeakMap<Component[], Map<ID, Component>>();
const cardCache = new WeakMap<DeckComponent, Map<ID, CardDef>>();

export function componentMap(game: GameLike): Map<ID, Component> {
  let m = compCache.get(game.components);
  if (!m) {
    m = new Map(game.components.map((c) => [c.id, c]));
    compCache.set(game.components, m);
  }
  return m;
}

export function getComponent(game: GameLike, id: ID | undefined | null): Component | undefined {
  return id ? componentMap(game).get(id) : undefined;
}

export function getDeck(game: GameLike, id: ID | undefined | null): DeckComponent | undefined {
  const c = getComponent(game, id);
  return c?.kind === 'deck' ? c : undefined;
}

export function getCardDef(game: GameLike, card: CardInstance): CardDef | undefined {
  const deck = getDeck(game, card.deckId);
  if (!deck) return undefined;
  let m = cardCache.get(deck);
  if (!m) {
    m = new Map(deck.cards.map((c) => [c.id, c]));
    cardCache.set(deck, m);
  }
  return m.get(card.cardId);
}

export function cardDims(game: GameLike, card: CardInstance | undefined): { w: number; h: number; r: number } {
  const deck = card ? getDeck(game, card.deckId) : undefined;
  if (!deck) return DEFAULT_CARD;
  return { w: deck.width || DEFAULT_CARD.w, h: deck.height || DEFAULT_CARD.h, r: deck.cornerRadius ?? DEFAULT_CARD.r };
}

export function cardName(game: GameLike, card: CardInstance): string {
  return getCardDef(game, card)?.name || getDeck(game, card.deckId)?.name || 'Card';
}

/* ------------------------------------------------------------------ */
/* Sizes & layouts                                                      */
/* ------------------------------------------------------------------ */

/** Base (unrotated, un-spread) size of an entity in mm. */
export function baseSize(game: GameLike, e: Entity): { w: number; h: number } {
  switch (e.kind) {
    case 'stack': {
      const d = cardDims(game, e.cards[e.cards.length - 1]);
      return { w: d.w, h: d.h };
    }
    case 'board': {
      const c = getComponent(game, e.componentId);
      return c?.kind === 'board' ? { w: c.width, h: c.height } : { w: 200, h: 150 };
    }
    case 'token': {
      const c = getComponent(game, e.componentId);
      return c?.kind === 'tokens' ? { w: c.width, h: c.height } : { w: 20, h: 20 };
    }
    case 'die': {
      const c = getComponent(game, e.componentId);
      const s = c?.kind === 'dice' ? c.size : 16;
      return { w: s, h: s };
    }
    case 'piece': {
      const c = getComponent(game, e.componentId);
      const d = pieceSize(lookOf(c?.kind === 'piece' ? c : undefined, e), !!e.infinite);
      return { w: d, h: d };
    }
    case 'counter':
      return COUNTER_SIZE;
    case 'zone':
    case 'note':
      return { w: e.w, h: e.h };
  }
}

export interface CardSlot {
  /** Offset of the card centre from the stack centre (mm, stack-local). */
  dx: number;
  dy: number;
  /** Extra rotation in degrees (fans). */
  rot: number;
}

/** Where each card of a stack sits for its layout. Index 0 = bottom card. */
export function stackSlots(game: GameLike, stack: StackEntity, n = stack.cards.length): CardSlot[] {
  const { w, h } = cardDims(game, stack.cards[stack.cards.length - 1]);
  const out: CardSlot[] = [];
  if (n <= 0) return out;
  switch (stack.layout) {
    case 'row': {
      // A 30-card deck laid out as one unbroken row is metres wide and buries everything
      // beside it. Past a dozen cards the row wraps, like dealing across a real table.
      const per = n <= ROW_MAX ? n : Math.ceil(n / Math.ceil(n / ROW_MAX));
      const rows = Math.ceil(n / per);
      const step = per > 1 ? Math.min(w * 0.34, (w * 5) / (per - 1)) : 0;
      const rowH = h + 4;
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / per);
        const col = i % per;
        const count = Math.min(per, n - row * per);
        const rowTotal = w + step * (count - 1);
        out.push({ dx: -rowTotal / 2 + w / 2 + col * step, dy: (row - (rows - 1) / 2) * rowH, rot: 0 });
      }
      return out;
    }
    case 'fan': {
      const a = n > 1 ? Math.min(7, 76 / (n - 1)) : 0;
      const R = h * 1.9;
      const tMax = (((n - 1) / 2) * a * Math.PI) / 180;
      const lift = (R * (1 - Math.cos(tMax))) / 2;
      for (let i = 0; i < n; i++) {
        const deg = (i - (n - 1) / 2) * a;
        const t = (deg * Math.PI) / 180;
        out.push({ dx: R * Math.sin(t), dy: R * (1 - Math.cos(t)) - lift, rot: deg });
      }
      return out;
    }
    case 'grid': {
      const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.6)));
      const rows = Math.ceil(n / cols);
      const gap = 3;
      for (let i = 0; i < n; i++) {
        // reading order starts with the TOP card (index n-1)
        const r = n - 1 - i;
        const col = r % cols;
        const row = Math.floor(r / cols);
        out.push({ dx: (col - (cols - 1) / 2) * (w + gap), dy: (row - (rows - 1) / 2) * (h + gap), rot: 0 });
      }
      return out;
    }
    default:
      for (let i = 0; i < n; i++) out.push({ dx: 0, dy: 0, rot: 0 });
      return out;
  }
}

function rotExtents(w: number, h: number, deg: number) {
  const t = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { w: w * c + h * s, h: w * s + h * c };
}

/** Bounds relative to the entity centre, in the entity's own (unrotated) frame. */
export function localBounds(game: GameLike, e: Entity): Rect {
  const b = baseSize(game, e);
  if (e.kind === 'stack' && e.layout !== 'pile' && e.cards.length > 1) {
    const { w, h } = cardDims(game, e.cards[e.cards.length - 1]);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of stackSlots(game, e)) {
      const ex = rotExtents(w, h, s.rot);
      x0 = Math.min(x0, s.dx - ex.w / 2);
      x1 = Math.max(x1, s.dx + ex.w / 2);
      y0 = Math.min(y0, s.dy - ex.h / 2);
      y1 = Math.max(y1, s.dy + ex.h / 2);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return { x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h };
}

export function rotateVec(v: Vec, deg: number): Vec {
  if (!deg) return v;
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** World-space axis-aligned bounds (accounts for rotation). */
export function worldAABB(game: GameLike, e: Entity): Rect {
  const lb = localBounds(game, e);
  const corners = [
    { x: lb.x, y: lb.y },
    { x: lb.x + lb.w, y: lb.y },
    { x: lb.x, y: lb.y + lb.h },
    { x: lb.x + lb.w, y: lb.y + lb.h },
  ].map((p) => rotateVec(p, e.rot));
  const xs = corners.map((p) => p.x + e.x);
  const ys = corners.map((p) => p.y + e.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Is the world point inside the entity (rotation aware)? */
export function pointInEntity(game: GameLike, e: Entity, p: Vec): boolean {
  const l = rotateVec({ x: p.x - e.x, y: p.y - e.y }, -e.rot);
  const b = localBounds(game, e);
  return l.x >= b.x && l.x <= b.x + b.w && l.y >= b.y && l.y <= b.y + b.h;
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Bounds of everything on the table (or of the given ids). */
export function stateBounds(game: GameLike, s: TableState, ids?: ID[]): Rect | null {
  const list = (ids ?? s.order).map((id) => s.entities[id]).filter(Boolean) as Entity[];
  return unionRects(list.map((e) => worldAABB(game, e)));
}

/* ------------------------------------------------------------------ */
/* Z-order                                                              */
/* ------------------------------------------------------------------ */

/** Boards always sit at the bottom, zones above them, everything else above that. */
export function renderLayer(e: Entity): number {
  return e.kind === 'board' ? 0 : e.kind === 'zone' ? 1 : 2;
}

const orderCache = new WeakMap<TableState['order'], WeakMap<TableState['entities'], ID[]>>();

/** Back -> front draw order (memoised per state). */
export function renderOrder(s: TableState): ID[] {
  let inner = orderCache.get(s.order);
  if (!inner) {
    inner = new WeakMap();
    orderCache.set(s.order, inner);
  }
  let out = inner.get(s.entities);
  if (!out) {
    const layers: ID[][] = [[], [], []];
    for (const id of s.order) {
      const e = s.entities[id];
      if (e) layers[renderLayer(e)].push(id);
    }
    out = layers.flat();
    inner.set(s.entities, out);
  }
  return out;
}

/** Topmost entity under a world point (front first), optionally filtered. */
export function entityAt(game: GameLike, s: TableState, p: Vec, filter?: (e: Entity) => boolean): Entity | null {
  const order = renderOrder(s);
  for (let i = order.length - 1; i >= 0; i--) {
    const e = s.entities[order[i]];
    if (e && (!filter || filter(e)) && pointInEntity(game, e, p)) return e;
  }
  return null;
}

/** Index of the card hit in a spread stack (top-most first). Null for piles. */
export function hitCardIndex(game: GameLike, stack: StackEntity, p: Vec): number | null {
  if (stack.layout === 'pile') return null;
  const l = rotateVec({ x: p.x - stack.x, y: p.y - stack.y }, -stack.rot);
  const { w, h } = cardDims(game, stack.cards[stack.cards.length - 1]);
  const slots = stackSlots(game, stack);
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    const q = rotateVec({ x: l.x - s.dx, y: l.y - s.dy }, -s.rot);
    if (Math.abs(q.x) <= w / 2 && Math.abs(q.y) <= h / 2) return i;
  }
  return null;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
