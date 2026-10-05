/**
 * Drag & drop semantics, as pure functions. A drag has a SOURCE (what the hand
 * picked up) and ends on a TARGET, decided from the carried piece's centre by
 * `tableDropTarget` (or the hand tray under the pointer). `applyDrop` turns that
 * into a new TableState.
 */
import type { CardInstance, Entity, Game, ID, StackEntity, TableState, ZoneAccept, ZoneEntity } from '@/shared/types';
import { baseSize, cardDims, getComponent, pointInEntity, renderOrder, rotateVec, stackSlots, type Vec } from './geometry';
import { categoryOf, inCell, inZone, isEndless, nearestCell, placeInZone, zoneTakes } from './zones';
import {
  addEntity,
  bringToFront,
  handInsert,
  handMove,
  handRemove,
  mergeTokens,
  newStack,
  putCards,
  removeCards,
  removeEntities,
  removeTop,
  takePiece,
  takeToken,
  translateEntities,
} from './ops';

type S = TableState;
type GameLike = Pick<Game, 'components'>;

export type DragSource =
  /** Whole pieces (a single entity or a multi-selection). `ids[0]` is the one under the pointer. */
  | { type: 'entities'; ids: ID[] }
  /** The top `count` cards slid off a stack. */
  | { type: 'stackTop'; stackId: ID; count: number }
  /** One specific card picked out of a spread / fan / grid. */
  | { type: 'stackCard'; stackId: ID; uid: ID }
  /** One token taken from a token pile or an infinite supply. */
  | { type: 'tokenOne'; tokenId: ID }
  /** A card dragged out of the hand. */
  | { type: 'hand'; uid: ID }
  /** A new game piece taken out of an infinite supply. */
  | { type: 'pieceOne'; supplyId: ID };

export type DropTarget =
  | { type: 'table' }
  | { type: 'stack'; id: ID }
  /** `land`: exactly where the carried thing will come to rest (shown before release). */
  | { type: 'zone'; id: ID; land?: ZoneLand }
  | { type: 'token'; id: ID }
  /** The bowl of an infinite piece supply (same component): the piece goes back in. */
  | { type: 'pieceSupply'; id: ID }
  | { type: 'hand'; index: number };

export type Payload = 'cards' | 'token' | 'piece' | 'other';

/** Where a drop into a zone lands (world mm): a grid cell, a pool slot, the pile, or beside a full zone. */
export interface ZoneLand {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  round: boolean;
  /** The receiving grid cell (w/h = the cell). */
  cell: boolean;
  /** The zone is full: it goes just beside it. */
  beside: boolean;
  /** Joins this existing stack / token pile. */
  merge: ID | null;
}

export function sameTarget(a: DropTarget | null, b: DropTarget | null) {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'hand' && b.type === 'hand') return a.index === b.index;
  if (a.type === 'zone' && b.type === 'zone') {
    if (a.id !== b.id) return false;
    const la = a.land;
    const lb = b.land;
    if (!la || !lb) return la === lb;
    return Math.abs(la.x - lb.x) < 0.01 && Math.abs(la.y - lb.y) < 0.01 && la.w === lb.w && la.beside === lb.beside && la.merge === lb.merge;
  }
  return (a as any).id === (b as any).id;
}

/** The zone categories of what is carried; null for things no zone takes (notes, counters, cards mixed with pieces). */
export function carriedCategories(s: S, src: DragSource): ZoneAccept[] | null {
  switch (src.type) {
    case 'stackTop':
    case 'stackCard':
    case 'hand':
      return ['cards'];
    case 'tokenOne':
      return ['tokens'];
    case 'pieceOne':
      return ['pieces'];
    case 'entities': {
      const cats = new Set<ZoneAccept>();
      for (const id of src.ids) {
        const e = s.entities[id];
        const c = e ? categoryOf(e) : null;
        if (!c) return null;
        cats.add(c);
      }
      if (!cats.size || (cats.has('cards') && cats.size > 1)) return null;
      return [...cats];
    }
  }
}

/** What kind of thing is being carried? Cards can merge / go to hand, tokens can pile up. */
export function payloadOf(s: S, src: DragSource): Payload {
  switch (src.type) {
    case 'stackTop':
    case 'stackCard':
    case 'hand':
      return 'cards';
    case 'tokenOne':
      return 'token';
    case 'pieceOne':
      return 'piece';
    case 'entities': {
      const ents = src.ids.map((id) => s.entities[id]).filter(Boolean) as Entity[];
      if (ents.length && ents.every((e) => e.kind === 'stack')) return 'cards';
      if (ents.length === 1 && ents[0].kind === 'token') return 'token';
      if (ents.length === 1 && ents[0].kind === 'piece' && !ents[0].infinite) return 'piece';
      return 'other';
    }
  }
}

/** The component of the piece being carried (single piece or one taken from a supply). */
function carriedPiece(s: S, src: DragSource): Extract<Entity, { kind: 'piece' }> | null {
  const e = src.type === 'pieceOne' ? s.entities[src.supplyId] : src.type === 'entities' && src.ids.length === 1 ? s.entities[src.ids[0]] : null;
  return e?.kind === 'piece' ? e : null;
}

/** Entity ids that cannot be a target because they are being carried. */
export function carriedIds(src: DragSource): ID[] {
  return src.type === 'entities' ? src.ids : [];
}

/** Can the carried thing be dropped on this entity? */
export function acceptsDrop(s: S, src: DragSource, target: Entity): DropTarget | null {
  const payload = payloadOf(s, src);
  if (carriedIds(src).includes(target.id)) return null;
  if (target.kind === 'stack' && payload === 'cards') {
    // dropping the top card back onto its own stack = cancel, handled by caller
    return { type: 'stack', id: target.id };
  }
  if (target.kind === 'token' && payload === 'token') {
    const tokId = src.type === 'tokenOne' ? src.tokenId : src.type === 'entities' ? src.ids[0] : null;
    const tok = tokId ? s.entities[tokId] : null;
    if (tok?.kind === 'token' && tok.componentId === target.componentId && tokId !== target.id) return { type: 'token', id: target.id };
    return null;
  }
  if (target.kind === 'piece' && target.infinite && payload === 'piece') {
    const p = carriedPiece(s, src);
    if (p && p.componentId === target.componentId && (p.color ?? '') === (target.color ?? '') && (p.material ?? '') === (target.material ?? '')) return { type: 'pieceSupply', id: target.id };
    return null;
  }
  if (target.kind === 'zone') {
    const cats = carriedCategories(s, src);
    if (!cats || !cats.every((c) => zoneTakes(target, c))) return null;
    // an endless grid under the whole table must not merge a multi-selection of stacks into one
    if (isEndless(target) && cats[0] === 'cards' && src.type === 'entities' && src.ids.length > 1) return null;
    return { type: 'zone', id: target.id };
  }
  return null;
}

/** The top-most bounded zone under the carried centre when it would NOT take what is carried. */
export function refusingZoneAt(s: S, src: DragSource, centre: Vec): ZoneEntity | null {
  const order = renderOrder(s);
  const cats = carriedCategories(s, src);
  for (let i = order.length - 1; i >= 0; i--) {
    const e = s.entities[order[i]];
    if (e?.kind !== 'zone' || isEndless(e) || !inZone(e, centre)) continue;
    return cats && cats.every((c) => zoneTakes(e, c)) ? null : e;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Coverage: when does a drop merge?                                   */
/* ------------------------------------------------------------------ */

/**
 * A carried card / stack / token merges into a target only when it covers the target
 * by at least this fraction. Decided purely from the two CENTRES — never from where
 * the pointer is, so where you grabbed the piece cannot change the outcome.
 */
export const STACK_COVERAGE = 0.95;
/**
 * 95 % of a 20 mm token is 1 mm — a couple of screen pixels, unhittable. So the allowed
 * centre offset per axis never drops below this many SCREEN px (converted with the zoom),
 * a little more for a finger than a mouse. Large cards at normal zoom are unaffected.
 */
export const STACK_MIN_SLACK_PX = { mouse: 8, touch: 12 } as const;
/** …but zoomed far out that floor would be many mm: it never exceeds this fraction of the piece. */
export const STACK_MAX_SLACK = 0.25;

/** A rectangle on the table: centre, size and rotation (mm, degrees). */
export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

/**
 * How much `a` (carried) covers `b` (target), 0…1, from the centre offset measured in
 * `b`'s rotated frame:
 *
 *   coverage = (1 − |dx| / w) · (1 − |dy| / h),   w = min(a.w, b.w), h = min(a.h, b.h)
 *
 * For two same-sized, aligned cards this IS the overlapping area fraction. When the
 * sizes differ (a mini card over a poker card) the offset is measured against the
 * SMALLER piece on each axis, i.e. "how centred is it": the smaller card must sit
 * within 5 % of its own size of the other's centre. A quarter turn between the two
 * swaps the carried piece's width and height; small angle differences are ignored.
 *
 * `minSlack` (mm, from STACK_MIN_SLACK_PX / zoom) floors the offset a single axis may have
 * at the threshold, capped at STACK_MAX_SLACK of the piece: the axis is measured against
 * max(w, min(minSlack, STACK_MAX_SLACK·w) / (1 − STACK_COVERAGE)) instead of w.
 */
export function coverage(a: Footprint, b: Footprint, minSlack = 0): number {
  const l = rotateVec({ x: a.x - b.x, y: a.y - b.y }, -b.rot);
  const rel = (((a.rot - b.rot) % 180) + 180) % 180;
  const quarter = rel > 45 && rel < 135;
  const w = Math.min(quarter ? a.h : a.w, b.w);
  const h = Math.min(quarter ? a.w : a.h, b.h);
  if (w <= 0 || h <= 0) return 0;
  const scale = (size: number) => Math.max(size, Math.min(minSlack, STACK_MAX_SLACK * size) / (1 - STACK_COVERAGE));
  return Math.max(0, 1 - Math.abs(l.x) / scale(w)) * Math.max(0, 1 - Math.abs(l.y) / scale(h));
}

/** Footprint of the carried piece when its centre is at `centre`. */
export function carriedFootprint(game: GameLike, s: S, src: DragSource, centre: Vec): Footprint | null {
  const card = (c: CardInstance | undefined, rot: number): Footprint | null => {
    if (!c) return null;
    const d = cardDims(game, c);
    return { x: centre.x, y: centre.y, w: d.w, h: d.h, rot };
  };
  switch (src.type) {
    case 'stackTop': {
      const st = s.entities[src.stackId];
      return st?.kind === 'stack' ? card(st.cards[st.cards.length - 1], st.rot) : null;
    }
    case 'stackCard': {
      const st = s.entities[src.stackId];
      if (st?.kind !== 'stack') return null;
      const i = st.cards.findIndex((c) => c.uid === src.uid);
      return card(st.cards[i], st.rot + (stackSlots(game, st)[i]?.rot ?? 0));
    }
    case 'hand':
      return card(
        s.hand.find((c) => c.uid === src.uid),
        0,
      );
    case 'pieceOne': {
      const e = s.entities[src.supplyId];
      if (e?.kind !== 'piece') return null;
      const b = baseSize(game, { ...e, infinite: false });
      return { x: centre.x, y: centre.y, w: b.w, h: b.h, rot: e.rot };
    }
    case 'tokenOne':
    case 'entities': {
      const e = s.entities[src.type === 'tokenOne' ? src.tokenId : src.ids[0]];
      if (!e) return null;
      const b = baseSize(game, e);
      return { x: centre.x, y: centre.y, w: b.w, h: b.h, rot: e.rot };
    }
  }
}

/**
 * The part of a target you have to cover. A stack is its TOP card (in a spread that is the
 * card lying on top); dropping a lifted card back on its own stack measures against the
 * slot it came from. Tokens are the token itself.
 */
export function targetFootprint(game: GameLike, e: Entity, src?: DragSource): Footprint {
  if (e.kind === 'stack' && e.cards.length) {
    let i = e.cards.length - 1;
    if (src?.type === 'stackCard' && src.stackId === e.id) i = Math.max(0, e.cards.findIndex((c) => c.uid === src.uid));
    const slot = stackSlots(game, e)[i] ?? { dx: 0, dy: 0, rot: 0 };
    const off = rotateVec({ x: slot.dx, y: slot.dy }, e.rot);
    const d = cardDims(game, e.cards[i]);
    return { x: e.x + off.x, y: e.y + off.y, w: d.w, h: d.h, rot: e.rot + slot.rot };
  }
  const b = baseSize(game, e);
  return { x: e.x, y: e.y, w: b.w, h: b.h, rot: e.rot };
}

/**
 * Where a carried piece whose centre is at `centre` would land on the table:
 * the best-covered stack / token pile at ≥ STACK_COVERAGE (front-most wins a tie),
 * else the front-most zone containing the centre, else the bare table.
 * The hand tray is UI and stays pointer-based — the caller checks it first.
 */
export function tableDropTarget(game: GameLike, s: S, src: DragSource, centre: Vec, minSlack = 0): DropTarget {
  const me = carriedFootprint(game, s, src, centre);
  if (!me) return { type: 'table' };
  const order = renderOrder(s);
  let best: DropTarget | null = null;
  let bestCov = STACK_COVERAGE;
  let zone: DropTarget | null = null;
  let endless: DropTarget | null = null;
  // a bounded zone that won't take it covers the endless grid below: it lands as on bare table
  let refusedAbove = false;
  for (let i = order.length - 1; i >= 0; i--) {
    const e = s.entities[order[i]];
    if (!e) continue;
    const t = acceptsDrop(s, src, e);
    if (!t) {
      if (e.kind === 'zone' && !zone && !isEndless(e) && !carriedIds(src).includes(e.id) && inZone(e, centre)) refusedAbove = true;
      continue;
    }
    if (t.type === 'pieceSupply') {
      // a piece goes back in when it is let go over the bowl
      const r = baseSize(game, e).w * 0.42;
      if (!best && Math.hypot(centre.x - e.x, centre.y - e.y) <= r) best = t;
      continue;
    }
    if (t.type === 'zone') {
      const z = e as ZoneEntity;
      // an endless grid lies under everything: any bounded zone above it wins
      if (isEndless(z)) endless ??= t;
      else if (!zone && inZone(z, centre)) zone = t;
      continue;
    }
    const cov = coverage(me, targetFootprint(game, e, src), minSlack);
    if (cov > bestCov || (!best && cov >= STACK_COVERAGE)) {
      best = t;
      bestCov = cov;
    }
  }
  if (best) return best;
  const zt = zone ?? (refusedAbove ? null : endless);
  if (zt?.type === 'zone') {
    const land = zoneLanding(game, s, src, zt, centre);
    return land ? { ...zt, land } : zt;
  }
  return { type: 'table' };
}

/** Run the drop for real (it is pure) and report where the carried thing comes to rest. */
function zoneLanding(game: GameLike, s: S, src: DragSource, t: Extract<DropTarget, { type: 'zone' }>, centre: Vec): ZoneLand | undefined {
  const r = applyDrop(game, s, src, t, centre);
  const id = r.landed[0];
  if (r.kind === 'none' || !id) return undefined;
  const en = r.state.entities[id];
  if (!en) return undefined;
  let f = targetFootprint(game, en);
  const merge = s.entities[id] && !carriedIds(src).includes(id) ? id : null;
  const z = s.entities[t.id];
  if (z?.kind === 'zone' && z.grid && !merge && !r.beside) {
    // a grid shows the receiving cell itself
    const c = nearestCell(z, en)!;
    return { x: c.x, y: c.y, w: z.grid.cellW, h: z.grid.cellH, rot: z.rot, round: false, cell: true, beside: false, merge: null };
  }
  const comp = 'componentId' in en ? getComponent(game, en.componentId) : undefined;
  // the item's own footprint: round only for round things
  const round = (comp?.kind === 'tokens' && comp.shape === 'round') || (comp?.kind === 'piece' && (comp.shape === 'disc' || comp.shape === 'pawn'));
  if (en.kind === 'piece' || en.kind === 'die') f = { ...f, rot: en.rot };
  return { x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot, round, cell: false, beside: !!r.beside, merge };
}

/**
 * A near miss must never look like a sloppy stack. A piece that lands covering a same-kind
 * target (stack on stack, token on a pile of the same tokens) by more than this — but did
 * not merge — is slid outward along its own offset until coverage is exactly this, so a
 * clear band of the target (its edge, its count) shows. Smaller overlaps are left alone.
 * Round tokens read as "a pile" at far less overlap than cards read as "a deck".
 */
export const ASIDE_COVERAGE = { stack: 0.7, token: 0.2 } as const;

/**
 * Where a just-landed piece should settle so it reads as "placed beside", not "stacked".
 * Uses the same `coverage()` as the merge rule (without the screen-px floor: this is about
 * what the table looks like, not how precise a hand is). Returns null when nothing is
 * covered more than ASIDE_COVERAGE.
 */
export function asidePosition(game: GameLike, s: S, id: ID): Vec | null {
  const me = s.entities[id];
  if (!me || (me.kind !== 'stack' && me.kind !== 'token')) return null;
  const mine = targetFootprint(game, me);
  const aside = ASIDE_COVERAGE[me.kind];
  let best: Entity | null = null;
  let bestCov: number = aside;
  for (const oid of s.order) {
    const o = s.entities[oid];
    if (!o || o.id === id || o.kind !== me.kind) continue;
    if (me.kind === 'token' && (o as typeof me).componentId !== me.componentId) continue;
    const cov = coverage(mine, targetFootprint(game, o));
    if (cov > bestCov) {
      bestCov = cov;
      best = o;
    }
  }
  if (!best) return null;
  const t = targetFootprint(game, best);
  const rel = (((mine.rot - t.rot) % 180) + 180) % 180;
  const quarter = rel > 45 && rel < 135;
  const w = Math.min(quarter ? mine.h : mine.w, t.w);
  const h = Math.min(quarter ? mine.w : mine.h, t.h);
  // offset in the target's frame, in units of the (smaller) piece size
  const l = rotateVec({ x: mine.x - t.x, y: mine.y - t.y }, -t.rot);
  let ux = l.x / w;
  let uy = l.y / h;
  const n = Math.max(Math.abs(ux), Math.abs(uy));
  if (n < 1e-6) {
    ux = 1;
    uy = 0;
  } else {
    ux /= n;
    uy /= n;
  }
  // scale k so (1 − k|ux|)(1 − k|uy|) = the aside coverage
  const a = Math.abs(ux);
  const b = Math.abs(uy);
  const c = 1 - aside;
  const k = a * b < 1e-9 ? c / (a + b) : (a + b - Math.sqrt((a + b) ** 2 - 4 * a * b * c)) / (2 * a * b);
  const off = rotateVec({ x: k * ux * w, y: k * uy * h }, t.rot);
  return { x: me.x + (t.x + off.x - mine.x), y: me.y + (t.y + off.y - mine.y) };
}

export interface DropResult {
  state: S;
  /** Entities that just landed (for the settle animation). */
  landed: ID[];
  /** Where the carried thing ended up (for FLIP animations). */
  landedAt?: Vec;
  kind: 'move' | 'merge' | 'zone' | 'hand' | 'token' | 'supply' | 'none';
  /** A zone drop that did not fit: put beside the zone. */
  beside?: boolean;
}

function zoneRowSlot(game: GameLike, s: S, zone: ZoneEntity, cardW: number): Vec {
  const inside = Object.values(s.entities).filter(
    (e) => e.kind === 'stack' && pointInEntity(game, zone, { x: e.x, y: e.y }),
  ).length;
  const margin = 4;
  const usable = zone.w - margin * 2 - cardW;
  const step = Math.min(cardW + 3, inside > 0 ? Math.max(4, usable / inside) : cardW + 3);
  return { x: zone.x - zone.w / 2 + margin + cardW / 2 + Math.min(inside * step, Math.max(0, usable)), y: zone.y };
}

/** Topmost stack whose centre lies inside the zone. */
export function stackInZone(game: GameLike, s: S, zone: ZoneEntity, exclude: ID[] = []): StackEntity | null {
  for (let i = s.order.length - 1; i >= 0; i--) {
    const e = s.entities[s.order[i]];
    if (e?.kind === 'stack' && !exclude.includes(e.id) && pointInEntity(game, zone, { x: e.x, y: e.y })) return e;
  }
  return null;
}

/** Pull the carried cards out of the state. */
function extractCards(s: S, src: DragSource): { state: S; cards: CardInstance[]; rot: number } {
  switch (src.type) {
    case 'stackTop': {
      const st = s.entities[src.stackId];
      const r = removeTop(s, src.stackId, src.count);
      return { ...r, rot: st?.rot ?? 0 };
    }
    case 'stackCard': {
      const st = s.entities[src.stackId];
      const r = removeCards(s, src.stackId, [src.uid]);
      return { ...r, rot: st?.rot ?? 0 };
    }
    case 'hand': {
      const r = handRemove(s, [src.uid]);
      return { ...r, rot: 0 };
    }
    case 'entities': {
      const stacks = s.order.filter((id) => src.ids.includes(id)).map((id) => s.entities[id]) as StackEntity[];
      const cards = stacks.flatMap((st) => st.cards);
      return { state: removeEntities(s, src.ids), cards, rot: (s.entities[src.ids[0]] as Entity | undefined)?.rot ?? 0 };
    }
    default:
      return { state: s, cards: [], rot: 0 };
  }
}

/**
 * Apply a finished drag. `at` is where the carried piece's centre was released
 * (world mm); for multi-entity drags it is the new centre of `ids[0]`.
 */
export function applyDrop(game: GameLike, s: S, src: DragSource, target: DropTarget, at: Vec): DropResult {
  const none: DropResult = { state: s, landed: [], kind: 'none' };

  /* ---- reorder inside the hand ---- */
  if (src.type === 'hand' && target.type === 'hand') {
    const from = s.hand.findIndex((c) => c.uid === src.uid);
    return { state: handMove(s, from, target.index), landed: [], kind: 'hand' };
  }

  /* ---- tokens / pieces / dice into a zone: put down, then settled by the zone's rules ---- */
  if (target.type === 'zone') {
    const cats = carriedCategories(s, src);
    if (cats && !cats.includes('cards')) {
      const r = applyDrop(game, s, src, { type: 'table' }, at);
      if (r.kind === 'none') return r;
      const p = placeInZone(game, r.state, target.id, r.landed);
      const first = p.state.entities[p.landed[0]];
      return { state: p.state, landed: p.landed, landedAt: first ? { x: first.x, y: first.y } : at, kind: 'zone', beside: p.beside };
    }
  }

  /* ---- game pieces ---- */
  if (src.type === 'pieceOne') {
    // let go over a matching supply: it was never taken
    if (target.type === 'pieceSupply') return none;
    const r = takePiece(s, src.supplyId, at);
    return r ? { state: r.state, landed: [r.id], landedAt: at, kind: 'move' } : none;
  }
  if (src.type === 'entities' && target.type === 'pieceSupply') {
    const tgt = s.entities[target.id];
    if (tgt?.kind !== 'piece') return none;
    return { state: removeEntities(s, src.ids), landed: [target.id], landedAt: { x: tgt.x, y: tgt.y }, kind: 'supply' };
  }

  /* ---- tokens ---- */
  if (src.type === 'tokenOne') {
    const tok = s.entities[src.tokenId];
    if (tok?.kind !== 'token') return none;
    if (target.type === 'token') {
      const tgt = s.entities[target.id];
      if (tgt?.kind !== 'token') return none;
      return { state: bringToFront(mergeTokens(s, src.tokenId, target.id, 1), [target.id]), landed: [target.id], landedAt: { x: tgt.x, y: tgt.y }, kind: tgt.infinite ? 'supply' : 'token' };
    }
    const r = takeToken(s, src.tokenId, at);
    return r ? { state: r.state, landed: [r.id], landedAt: at, kind: 'move' } : none;
  }
  if (src.type === 'entities' && target.type === 'token') {
    const tgt = s.entities[target.id];
    if (tgt?.kind !== 'token') return none;
    return { state: bringToFront(mergeTokens(s, src.ids[0], target.id), [target.id]), landed: [target.id], landedAt: { x: tgt.x, y: tgt.y }, kind: tgt.infinite ? 'supply' : 'token' };
  }

  /* ---- plain move of whole pieces ---- */
  const payload = payloadOf(s, src);
  if (src.type === 'entities' && (target.type === 'table' || payload !== 'cards')) {
    const primary = s.entities[src.ids[0]];
    if (!primary) return none;
    const moved = translateEntities(s, src.ids, at.x - primary.x, at.y - primary.y);
    return { state: bringToFront(moved, src.ids), landed: src.ids, landedAt: at, kind: 'move' };
  }

  /* ---- cards ---- */
  const ex = extractCards(s, src);
  if (!ex.cards.length) return none;
  let state = ex.state;
  let cards = ex.cards;
  const fromHand = src.type === 'hand';

  switch (target.type) {
    case 'hand':
      return { state: handInsert(state, cards, target.index), landed: [], kind: 'hand' };

    case 'stack': {
      const tgt = state.entities[target.id];
      if (tgt?.kind !== 'stack') break;
      if (fromHand) {
        const faceUp = tgt.cards[tgt.cards.length - 1]?.faceUp ?? true;
        cards = cards.map((c) => ({ ...c, faceUp }));
      }
      state = bringToFront(putCards(state, target.id, cards), [target.id]);
      return { state, landed: [target.id], landedAt: { x: tgt.x, y: tgt.y }, kind: 'merge' };
    }

    case 'zone': {
      const zone = state.entities[target.id];
      if (zone?.kind !== 'zone') break;
      if (zone.forceFace) cards = cards.map((c) => ({ ...c, faceUp: zone.forceFace === 'up' }));
      else if (fromHand) cards = cards.map((c) => ({ ...c, faceUp: true }));
      if (zone.grid) {
        // the cell nearest the carried centre; a card already there takes these on top
        const cell = nearestCell(zone, at)!;
        // markers sitting in the cell stay on top of the cards put there (visible and grabbable)
        const lift = (st: S) =>
          bringToFront(
            st,
            st.order.filter((id) => {
              const o = st.entities[id];
              const c = o ? categoryOf(o) : null;
              return !!c && c !== 'cards' && inCell(zone, cell, o!);
            }),
          );
        let existing: StackEntity | null = null;
        for (let i = state.order.length - 1; i >= 0 && !existing; i--) {
          const e = state.entities[state.order[i]];
          if (e?.kind === 'stack' && inCell(zone, cell, e)) existing = e;
        }
        if (existing) {
          state = lift(bringToFront(putCards(state, existing.id, cards), [existing.id]));
          return { state, landed: [existing.id], landedAt: { x: existing.x, y: existing.y }, kind: 'zone' };
        }
        if (src.type === 'entities' && src.ids.length === 1 && !zone.forceFace) {
          // a whole stack keeps its identity (name, layout) on its new cell
          const orig = s.entities[src.ids[0]] as StackEntity;
          const e: StackEntity = { ...orig, x: cell.x, y: cell.y, rot: zone.rot };
          return { state: lift(addEntity(state, e)), landed: [e.id], landedAt: { x: cell.x, y: cell.y }, kind: 'zone' };
        }
        const r = newStack(state, cards, cell, { rot: zone.rot });
        return { state: lift(r.state), landed: [r.id], landedAt: { x: cell.x, y: cell.y }, kind: 'zone' };
      }
      if (zone.snap === 'pile') {
        const existing = stackInZone(game, state, zone);
        if (existing) {
          state = bringToFront(putCards(state, existing.id, cards), [existing.id]);
          return { state, landed: [existing.id], landedAt: { x: existing.x, y: existing.y }, kind: 'zone' };
        }
        const r = newStack(state, cards, { x: zone.x, y: zone.y }, { rot: zone.rot });
        return { state: r.state, landed: [r.id], landedAt: { x: zone.x, y: zone.y }, kind: 'zone' };
      }
      if (zone.snap === 'row') {
        const { w } = cardDims(game, cards[cards.length - 1]);
        const slot = zoneRowSlot(game, state, zone, w);
        const r = newStack(state, cards, slot, { rot: zone.rot });
        return { state: r.state, landed: [r.id], landedAt: slot, kind: 'zone' };
      }
      const r = newStack(state, cards, at, { rot: ex.rot });
      return { state: r.state, landed: [r.id], landedAt: at, kind: 'zone' };
    }
  }

  // table (or a target that vanished): a new stack where it was released
  if (fromHand) cards = cards.map((c) => ({ ...c, faceUp: true }));
  if (src.type === 'entities' && src.ids.length === 1) {
    // a whole stack keeps its identity (and name) when simply moved
    const orig = s.entities[src.ids[0]] as StackEntity;
    const e: StackEntity = { ...orig, x: at.x, y: at.y };
    return { state: addEntity(state, e), landed: [e.id], landedAt: at, kind: 'move' };
  }
  const r = newStack(state, cards, at, { rot: ex.rot });
  return { state: r.state, landed: [r.id], landedAt: at, kind: 'move' };
}
