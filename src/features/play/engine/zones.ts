/**
 * Zones beyond "one card area": what a zone takes, grids (limited and endless) and how
 * tokens / pieces / dice arrange inside a zone (stack · pool · free). Pure maths, no DOM.
 *
 * Rules (also in the play README):
 * - A zone takes `accepts` (default: cards). Anything else lands as if on bare table.
 * - GRID: the receiving cell is the one nearest the carried item's CENTRE (never the pointer).
 *   Cards on an occupied cell go on top of the card there (v2-1). A token on a cell holding a
 *   pile of the same token adds to it. Otherwise pieces / dice / tokens take one cell each: an
 *   occupied cell passes the item to the nearest free cell. Only the same category occupies a
 *   cell (a marker may sit on a card). A full limited grid puts the item just beside it.
 * - POOL (and STACK for pieces / dice): items keep their reading order and are laid out in
 *   centred rows without overlapping; a dropped item is inserted where its centre is. Removing
 *   one re-flows the rest (reflowZones). Supplies and other things inside are obstacles and
 *   never move. Full → the new item goes beside the zone.
 * - STACK: a token joins the pile of the same token in the zone (a counted pile).
 * - FREE: where dropped, kept fully inside and nudged off same-category neighbours.
 */
import type { Entity, Game, ID, TableState, ZoneAccept, ZoneEntity, ZoneGrid, ZonePieceMode } from '@/shared/types';
import { baseSize, clamp, rectsIntersect, rotateVec, type Rect, type Vec } from './geometry';
import { bringToFront, mergeTokens, translateEntities } from './ops';

type S = TableState;
type GameLike = Pick<Game, 'components'>;

export const ZONE_ACCEPTS: ZoneAccept[] = ['cards', 'tokens', 'pieces', 'dice'];
/** Margin between a limited grid's outer edge and its cells (mm). */
export const GRID_PAD = 3;
/** Space between pooled items and around them (mm). */
export const POOL_GAP = 3;
export const POOL_PAD = 4;
const MIN_CELL = 4;

/* ------------------------------------------------------------------ */
/* Config & normalisation                                              */
/* ------------------------------------------------------------------ */

export function zoneAccepts(z: ZoneEntity): ZoneAccept[] {
  const a = Array.isArray(z.accepts) ? z.accepts.filter((x) => ZONE_ACCEPTS.includes(x)) : [];
  return a.length ? a : ['cards'];
}

export const zoneTakes = (z: ZoneEntity, c: ZoneAccept) => zoneAccepts(z).includes(c);

export function pieceModeOf(z: ZoneEntity): ZonePieceMode {
  if (z.pieceMode === 'stack' || z.pieceMode === 'pool' || z.pieceMode === 'free') return z.pieceMode;
  const a = zoneAccepts(z);
  if (a.includes('tokens')) return 'stack';
  if (a.includes('pieces')) return 'pool';
  return 'free';
}

export const isEndless = (z: ZoneEntity) => !!z.grid?.endless;

/** Which zone category a table entity belongs to (null: notes, counters, boards, zones). */
export function categoryOf(e: Entity): ZoneAccept | null {
  switch (e.kind) {
    case 'stack':
      return 'cards';
    case 'token':
      return 'tokens';
    case 'piece':
      return 'pieces';
    case 'die':
      return 'dice';
    default:
      return null;
  }
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeGrid(g: Partial<ZoneGrid> | undefined | null): ZoneGrid | undefined {
  if (!g || typeof g !== 'object') return undefined;
  return {
    cellW: num(g.cellW, 63.5, MIN_CELL, 1000),
    cellH: num(g.cellH, 88.9, MIN_CELL, 1000),
    gapX: num(g.gapX, 4, 0, 500),
    gapY: num(g.gapY, 4, 0, 500),
    cols: Math.round(num(g.cols, 3, 1, 60)),
    rows: Math.round(num(g.rows, 2, 1, 60)),
    ...(g.endless ? { endless: true } : {}),
    ...(typeof g.preset === 'string' ? { preset: g.preset } : {}),
  };
}

/** The zone's own w/h for a grid: the cells plus padding (endless: the origin cell). */
export function gridBox(g: ZoneGrid): { w: number; h: number } {
  if (g.endless) return { w: g.cellW, h: g.cellH };
  return { w: g.cols * g.cellW + (g.cols - 1) * g.gapX + 2 * GRID_PAD, h: g.rows * g.cellH + (g.rows - 1) * g.gapY + 2 * GRID_PAD };
}

function sameGrid(a: ZoneGrid, b: ZoneGrid) {
  return a.cellW === b.cellW && a.cellH === b.cellH && a.gapX === b.gapX && a.gapY === b.gapY && a.cols === b.cols && a.rows === b.rows && !!a.endless === !!b.endless && a.preset === b.preset;
}

/**
 * Old or hand-edited zones → valid ones. Every field v2-6 added is optional and its absence
 * means exactly the old behaviour, so a zone from before v2-6 comes back as the SAME object.
 */
export function normalizeZone(z: ZoneEntity): ZoneEntity {
  let out = z;
  const fix = (p: Partial<ZoneEntity>) => (out = { ...out, ...p });
  if (z.snap !== 'pile' && z.snap !== 'row' && z.snap !== 'free') fix({ snap: 'pile' });
  if (!(z.w > 0)) fix({ w: 60 });
  if (!(z.h > 0)) fix({ h: 60 });
  if (z.accepts !== undefined) {
    const a = Array.isArray(z.accepts) ? [...new Set(z.accepts.filter((x) => ZONE_ACCEPTS.includes(x)))] : [];
    if (!Array.isArray(z.accepts) || a.length !== z.accepts.length) fix({ accepts: a.length ? a : undefined });
  }
  if (z.pieceMode !== undefined && z.pieceMode !== 'stack' && z.pieceMode !== 'pool' && z.pieceMode !== 'free') fix({ pieceMode: undefined });
  if (z.grid !== undefined) {
    const g = sanitizeGrid(z.grid);
    if (!g) fix({ grid: undefined });
    else {
      const b = gridBox(g);
      if (!sameGrid(g, z.grid) || Math.abs(out.w - b.w) > 0.01 || Math.abs(out.h - b.h) > 0.01) fix({ grid: g, w: b.w, h: b.h });
    }
  }
  return out;
}

/** Change a zone's grid, keeping its top-left corner where it is (limited grids grow right / down). */
export function withGrid(z: ZoneEntity, grid: ZoneGrid | undefined): ZoneEntity {
  if (!grid) {
    const { grid: _g, ...rest } = z;
    void _g;
    return rest;
  }
  const g = sanitizeGrid(grid)!;
  const b = gridBox(g);
  if (g.endless || z.grid?.endless) return { ...z, grid: g, w: b.w, h: b.h };
  const tl = rotateVec({ x: -z.w / 2, y: -z.h / 2 }, z.rot);
  const c = rotateVec({ x: b.w / 2, y: b.h / 2 }, z.rot);
  return { ...z, grid: g, w: b.w, h: b.h, x: z.x + tl.x + c.x, y: z.y + tl.y + c.y };
}

/* ------------------------------------------------------------------ */
/* Frames & cells                                                      */
/* ------------------------------------------------------------------ */

export const zoneLocal = (z: ZoneEntity, p: Vec): Vec => rotateVec({ x: p.x - z.x, y: p.y - z.y }, -z.rot);
export const zoneWorld = (z: ZoneEntity, l: Vec): Vec => {
  const v = rotateVec(l, z.rot);
  return { x: z.x + v.x, y: z.y + v.y };
};

/** Does the zone cover this world point? An endless grid covers the whole table. */
export function inZone(z: ZoneEntity, p: Vec): boolean {
  if (isEndless(z)) return true;
  const l = zoneLocal(z, p);
  return Math.abs(l.x) <= z.w / 2 && Math.abs(l.y) <= z.h / 2;
}

export interface Cell {
  c: number;
  r: number;
  /** World centre. */
  x: number;
  y: number;
}

function cellLocal(g: ZoneGrid, c: number, r: number): Vec {
  const px = g.cellW + g.gapX;
  const py = g.cellH + g.gapY;
  if (g.endless) return { x: c * px, y: r * py };
  return { x: -((g.cols - 1) * px) / 2 + c * px, y: -((g.rows - 1) * py) / 2 + r * py };
}

export function cellAt(z: ZoneEntity, c: number, r: number): Cell {
  const w = zoneWorld(z, cellLocal(z.grid!, c, r));
  return { c, r, x: w.x, y: w.y };
}

/** The cell whose centre is nearest to a world point (limited grids: clamped to the grid). */
export function nearestCell(z: ZoneEntity, p: Vec): Cell | null {
  const g = z.grid;
  if (!g) return null;
  const l = zoneLocal(z, p);
  const px = g.cellW + g.gapX;
  const py = g.cellH + g.gapY;
  let c: number;
  let r: number;
  if (g.endless) {
    c = Math.round(l.x / px);
    r = Math.round(l.y / py);
  } else {
    c = clamp(Math.round((l.x + ((g.cols - 1) * px) / 2) / px), 0, g.cols - 1);
    r = clamp(Math.round((l.y + ((g.rows - 1) * py) / 2) / py), 0, g.rows - 1);
  }
  return cellAt(z, c, r);
}

/** Cells nearest first, starting at (c0, r0): all of a limited grid, rings of an endless one. */
function cellsAround(z: ZoneEntity, c0: number, r0: number, reach = 14): Cell[] {
  const g = z.grid!;
  const out: { c: number; r: number; d: number }[] = [];
  const px = g.cellW + g.gapX;
  const py = g.cellH + g.gapY;
  const push = (c: number, r: number) => out.push({ c, r, d: Math.hypot((c - c0) * px, (r - r0) * py) });
  if (g.endless) for (let r = r0 - reach; r <= r0 + reach; r++) for (let c = c0 - reach; c <= c0 + reach; c++) push(c, r);
  else for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) push(c, r);
  out.sort((a, b) => a.d - b.d);
  return out.map((o) => cellAt(z, o.c, o.r));
}

/** Is the world point within this cell's pitch (the cell plus half the gap around it)? */
export function inCell(z: ZoneEntity, cell: Cell, p: Vec) {
  const g = z.grid!;
  const l = rotateVec({ x: p.x - cell.x, y: p.y - cell.y }, -z.rot);
  return Math.abs(l.x) <= (g.cellW + g.gapX) / 2 && Math.abs(l.y) <= (g.cellH + g.gapY) / 2;
}

/* ------------------------------------------------------------------ */
/* Items inside a zone                                                  */
/* ------------------------------------------------------------------ */

const isSupply = (e: Entity) => (e.kind === 'token' || e.kind === 'piece') && !!e.infinite;

/** The item's extents in the zone's frame. */
function boxIn(game: GameLike, z: ZoneEntity, e: Entity): { w: number; h: number } {
  const b = baseSize(game, e);
  if (e.kind === 'piece' || e.kind === 'die') return b;
  const t = (((e.rot - z.rot) % 180) + 180) % 180;
  const q = t > 45 && t < 135;
  return q ? { w: b.h, h: b.w } : b;
}

/** Items a pool / stack zone arranges: accepted tokens, pieces and dice (not supplies) centred in it. */
export function poolMembers(game: GameLike, s: S, z: ZoneEntity, exclude: Set<ID>): Entity[] {
  void game;
  const out: Entity[] = [];
  for (const id of s.order) {
    const e = s.entities[id];
    if (!e || exclude.has(id) || e.locked || isSupply(e)) continue;
    const cat = categoryOf(e);
    if (!cat || cat === 'cards' || !zoneTakes(z, cat)) continue;
    if (inZone(z, e)) out.push(e);
  }
  return out;
}

/** Everything else inside the zone that the arrangement must keep clear of (local rects). */
function poolObstacles(game: GameLike, s: S, z: ZoneEntity, skip: Set<ID>): Rect[] {
  const out: Rect[] = [];
  for (const id of s.order) {
    const e = s.entities[id];
    if (!e || skip.has(id) || e.kind === 'board' || e.kind === 'zone') continue;
    const l = zoneLocal(z, e);
    const b = boxIn(game, z, e);
    const r = { x: l.x - b.w / 2, y: l.y - b.h / 2, w: b.w, h: b.h };
    if (rectsIntersect(r, { x: -z.w / 2, y: -z.h / 2, w: z.w, h: z.h })) out.push(r);
  }
  return out;
}

/** Reading order: top row first, left to right. */
function readingOrder(z: ZoneEntity, ents: Entity[]): Entity[] {
  const withL = ents.map((e) => ({ e, l: zoneLocal(z, e) })).sort((a, b) => a.l.y - b.l.y);
  const rows: (typeof withL)[] = [];
  for (const it of withL) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.l.y - row[0].l.y) <= 2) row.push(it);
    else rows.push([it]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.l.x - b.l.x).map((it) => it.e));
}

/**
 * Lay items out inside the zone (local centres). No obstacles: greedy rows, each row centred and
 * the block centred. With obstacles: rows from the top-left, skipping past anything in the way.
 * Always returns a spot for every item — `fits` says whether they all stay inside.
 */
export function poolLayout(z: ZoneEntity, items: { w: number; h: number }[], obstacles: Rect[] = []): { pos: Vec[]; fits: boolean } {
  const left = -z.w / 2 + POOL_PAD;
  const right = z.w / 2 - POOL_PAD;
  const top = -z.h / 2 + POOL_PAD;
  const bottom = z.h / 2 - POOL_PAD;
  const availW = Math.max(0, right - left);
  const availH = Math.max(0, bottom - top);
  const pos: Vec[] = new Array(items.length);
  if (!obstacles.length) {
    const rows: { idx: number[]; w: number; h: number }[] = [];
    items.forEach((it, i) => {
      const row = rows[rows.length - 1];
      if (row && row.w + POOL_GAP + it.w > availW + 1e-6) rows.push({ idx: [i], w: it.w, h: it.h });
      else if (row) {
        row.idx.push(i);
        row.w += POOL_GAP + it.w;
        row.h = Math.max(row.h, it.h);
      } else rows.push({ idx: [i], w: it.w, h: it.h });
    });
    const totalH = rows.reduce((a, r) => a + r.h, 0) + POOL_GAP * Math.max(0, rows.length - 1);
    let y = totalH <= availH ? -totalH / 2 : top;
    let fits = totalH <= availH + 1e-6;
    for (const row of rows) {
      if (row.w > availW + 1e-6) fits = false;
      let x = row.w <= availW ? -row.w / 2 : left;
      for (const i of row.idx) {
        pos[i] = { x: x + items[i].w / 2, y: y + row.h / 2 };
        x += items[i].w + POOL_GAP;
      }
      y += row.h + POOL_GAP;
    }
    return { pos, fits };
  }
  // with obstacles
  const rowOf: number[] = [];
  const rowTops: number[] = [top];
  const rowHs: number[] = [0];
  let x = left;
  let row = 0;
  const hit = (r: Rect) => obstacles.find((o) => rectsIntersect({ x: r.x - POOL_GAP / 2, y: r.y - POOL_GAP / 2, w: r.w + POOL_GAP, h: r.h + POOL_GAP }, o));
  items.forEach((it, i) => {
    for (let guard = 0; guard < 400; guard++) {
      if (x + it.w > right + 1e-6 && x > left + 1e-6) {
        row++;
        rowTops[row] = rowTops[row - 1] + Math.max(rowHs[row - 1], MIN_CELL) + POOL_GAP;
        rowHs[row] = 0;
        x = left;
      }
      const r = { x, y: rowTops[row], w: it.w, h: it.h };
      const o = hit(r);
      if (o && guard < 399) {
        x = Math.max(x + 1, o.x + o.w + POOL_GAP);
        continue;
      }
      pos[i] = { x: x + it.w / 2, y: 0 };
      rowOf[i] = row;
      rowHs[row] = Math.max(rowHs[row], it.h);
      x += it.w + POOL_GAP;
      break;
    }
  });
  items.forEach((_, i) => (pos[i].y = rowTops[rowOf[i]] + rowHs[rowOf[i]] / 2));
  const fits = rowTops[row] + rowHs[row] <= bottom + 1e-6;
  return { pos, fits };
}

/* ------------------------------------------------------------------ */
/* Placing                                                              */
/* ------------------------------------------------------------------ */

export interface ZonePlacement {
  state: S;
  /** The ids that now hold what was dropped (a merged token = the pile it joined). */
  landed: ID[];
  /** Zone full: something was put beside it instead. */
  beside: boolean;
  /** Joined an existing pile. */
  merged: boolean;
}

function moveTo(s: S, id: ID, p: Vec): S {
  const e = s.entities[id];
  return e ? translateEntities(s, [id], p.x - e.x, p.y - e.y) : s;
}

/** A spot just outside the zone, nearest to where it was dropped and clear of other pieces. */
function besideZone(game: GameLike, s: S, z: ZoneEntity, e: Entity, skip: Set<ID>): Vec {
  const b = baseSize(game, e);
  const r = Math.max(b.w, b.h) / 2;
  const l = zoneLocal(z, e);
  const hw = z.w / 2 + r + 4;
  const hh = z.h / 2 + r + 4;
  const step = r * 2 + 2;
  // spill on one side so overflow reads as a spill: below first, then right, left, above
  const sides: Vec[][] = [[], [], [], []];
  for (let x = -hw; x <= hw + 1e-6; x += step) sides[0].push({ x, y: hh }), sides[3].push({ x, y: -hh });
  for (let y = -hh + step; y < hh - 1e-6; y += step) sides[1].push({ x: hw, y }), sides[2].push({ x: -hw, y });
  // further rows below keep spilling on the same side
  for (let x = -hw; x <= hw + 1e-6; x += step) sides[0].push({ x, y: hh + step });
  const dist = (a: Vec) => Math.hypot(a.x - l.x, a.y - l.y);
  const cands = sides.flatMap((side) => side.sort((a, c) => dist(a) - dist(c)));
  const others = Object.values(s.entities)
    .filter((o) => o.id !== e.id && !skip.has(o.id) && o.kind !== 'board' && o.kind !== 'zone')
    .map((o) => {
      const ob = baseSize(game, o);
      return { x: o.x, y: o.y, r: Math.max(ob.w, ob.h) / 2 };
    });
  for (const c of cands) {
    const w = zoneWorld(z, c);
    if (others.every((o) => Math.hypot(o.x - w.x, o.y - w.y) >= (o.r + r) * 0.95)) return w;
  }
  return zoneWorld(z, cands[0] ?? { x: hw, y: 0 });
}

function placeInGrid(game: GameLike, s: S, z: ZoneEntity, e: Entity, skip: Set<ID>): { state: S; id: ID; beside?: boolean; merged?: boolean } {
  const c0 = nearestCell(z, e)!;
  // One group per cell: tokens, pieces and dice each need a cell of their own (whatever their kind) —
  // only cards are an underlay a marker may sit on, and then it is lifted above them.
  const occupants = (cell: Cell) =>
    s.order
      .map((id) => s.entities[id])
      .filter((o): o is Entity => {
        if (!o || o.id === e.id || skip.has(o.id)) return false;
        const c = categoryOf(o);
        return !!c && c !== 'cards' && inCell(z, cell, o);
      });
  for (const cell of cellsAround(z, c0.c, c0.r)) {
    const occ = occupants(cell);
    if (cell.c === c0.c && cell.r === c0.r && e.kind === 'token' && occ.length === 1) {
      const pile = occ[0];
      // the same token joins the pile there
      if (pile.kind === 'token' && !pile.infinite && pile.componentId === e.componentId) return { state: bringToFront(mergeTokens(s, e.id, pile.id), [pile.id]), id: pile.id, merged: true };
    }
    if (!occ.length) return { state: bringToFront(moveTo(s, e.id, cell), [e.id]), id: e.id };
  }
  return { state: moveTo(s, e.id, besideZone(game, s, z, e, skip)), id: e.id, beside: true };
}

function placeInPool(game: GameLike, s: S, z: ZoneEntity, e: Entity, skip: Set<ID>, mode: ZonePieceMode): { state: S; id: ID; beside?: boolean; merged?: boolean } {
  const noSelf = new Set([...skip, e.id]);
  const members = poolMembers(game, s, z, noSelf);
  if (mode === 'stack' && e.kind === 'token') {
    const pile = members.find((m) => m.kind === 'token' && m.componentId === e.componentId);
    if (pile) return { state: bringToFront(mergeTokens(s, e.id, pile.id), [pile.id]), id: pile.id, merged: true };
  }
  const ordered = readingOrder(z, members);
  const obstacles = poolObstacles(game, s, z, new Set([...noSelf, ...members.map((m) => m.id)]));
  const boxes = ordered.map((m) => boxIn(game, z, m));
  const mine = boxIn(game, z, e);
  const target = zoneLocal(z, e);
  let best: { i: number; pos: Vec[] } | null = null;
  let bestD = Infinity;
  for (let i = 0; i <= ordered.length; i++) {
    const items = [...boxes];
    items.splice(i, 0, mine);
    const lay = poolLayout(z, items, obstacles);
    if (!lay.fits) continue;
    const d = Math.hypot(lay.pos[i].x - target.x, lay.pos[i].y - target.y);
    if (d < bestD - 1e-6) {
      bestD = d;
      best = { i, pos: lay.pos };
    }
  }
  if (!best) return { state: moveTo(s, e.id, besideZone(game, s, z, e, skip)), id: e.id, beside: true };
  const list = [...ordered];
  list.splice(best.i, 0, e);
  let state = s;
  list.forEach((m, i) => (state = moveTo(state, m.id, zoneWorld(z, best!.pos[i]))));
  return { state, id: e.id };
}

function placeFree(game: GameLike, s: S, z: ZoneEntity, e: Entity, skip: Set<ID>): { state: S; id: ID } {
  const b = boxIn(game, z, e);
  const l = zoneLocal(z, e);
  const cx = Math.max(0, z.w / 2 - b.w / 2 - 2);
  const cy = Math.max(0, z.h / 2 - b.h / 2 - 2);
  const keepIn = () => {
    l.x = clamp(l.x, -cx, cx);
    l.y = clamp(l.y, -cy, cy);
  };
  keepIn();
  const cat = categoryOf(e);
  const r = Math.max(b.w, b.h) / 2;
  const others = s.order
    .map((id) => s.entities[id])
    .filter((o): o is Entity => !!o && o.id !== e.id && !skip.has(o.id) && categoryOf(o) === cat && cat !== 'tokens' && inZone(z, o))
    .map((o) => {
      const ob = baseSize(game, o);
      return { ...zoneLocal(z, o), r: Math.max(ob.w, ob.h) / 2 };
    });
  for (let it = 0; it < 24; it++) {
    let moved = false;
    for (const o of others) {
      const dx = l.x - o.x;
      const dy = l.y - o.y;
      const d = Math.hypot(dx, dy);
      const min = (o.r + r) * 0.98;
      if (d >= min) continue;
      const ux = d < 1e-4 ? 1 : dx / d;
      const uy = d < 1e-4 ? 0 : dy / d;
      l.x += ux * (min - d + 0.05);
      l.y += uy * (min - d + 0.05);
      moved = true;
    }
    keepIn();
    if (!moved) break;
  }
  return { state: moveTo(s, e.id, zoneWorld(z, l)), id: e.id };
}

/**
 * Settle tokens / pieces / dice that were just put down at their release spots (`ids`) into the
 * zone. Cards are handled by applyDrop; supplies and categories the zone doesn't take stay put.
 */
export function placeInZone(game: GameLike, s: S, zoneId: ID, ids: ID[]): ZonePlacement {
  const z = s.entities[zoneId];
  if (z?.kind !== 'zone') return { state: s, landed: ids, beside: false, merged: false };
  const mode = pieceModeOf(z);
  let state = s;
  const landed: ID[] = [];
  let beside = false;
  let merged = false;
  ids.forEach((id, k) => {
    const e = state.entities[id];
    if (!e) return;
    const cat = categoryOf(e);
    if (!cat || cat === 'cards' || !zoneTakes(z, cat) || isSupply(e) || e.locked) {
      landed.push(id);
      return;
    }
    // items of the same drop that are not placed yet are not neighbours at their temporary spots
    const skip = new Set(ids.slice(k + 1));
    const r = z.grid ? placeInGrid(game, state, z, e, skip) : mode === 'free' ? placeFree(game, state, z, e, skip) : placeInPool(game, state, z, e, skip, mode);
    state = r.state;
    if (!landed.includes(r.id)) landed.push(r.id);
    beside ||= !!(r as { beside?: boolean }).beside;
    merged ||= !!(r as { merged?: boolean }).merged;
  });
  return { state, landed, beside, merged };
}

/**
 * Keep every pool / stack zone neatly laid out after any change (an item taken out, a supply put in):
 * members keep their reading order. Returns the moved ids with where they were.
 */
export function reflowZones(game: GameLike, next: S): { state: S; moved: Map<ID, Vec> } {
  const moved = new Map<ID, Vec>();
  let state = next;
  for (const zid of next.order) {
    const z = next.entities[zid];
    if (z?.kind !== 'zone' || z.grid || pieceModeOf(z) === 'free') continue;
    if (!zoneAccepts(z).some((a) => a !== 'cards')) continue;
    const members = readingOrder(z, poolMembers(game, state, z, new Set()));
    if (!members.length) continue;
    const obstacles = poolObstacles(game, state, z, new Set(members.map((m) => m.id)));
    const lay = poolLayout(
      z,
      members.map((m) => boxIn(game, z, m)),
      obstacles,
    );
    members.forEach((m, i) => {
      const w = zoneWorld(z, lay.pos[i]);
      if (Math.hypot(w.x - m.x, w.y - m.y) <= 0.3) return;
      if (!moved.has(m.id)) moved.set(m.id, { x: m.x, y: m.y });
      state = moveTo(state, m.id, w);
    });
  }
  return { state, moved };
}

/** One line saying what a zone is and does ("Grid · 4 × 3 cells · cards and tokens"). */
export function describeZone(z: ZoneEntity): string {
  const a = zoneAccepts(z);
  const takes = a.length === 4 ? 'anything' : a.join(', ');
  if (z.grid?.endless) return `Endless grid · ${takes}`;
  if (z.grid) return `Grid · ${z.grid.cols} × ${z.grid.rows} cells · ${takes}`;
  const bits = [a.includes('cards') ? `cards ${z.snap === 'pile' ? 'pile up' : z.snap === 'row' ? 'line up' : 'stay put'}` : null];
  if (a.some((x) => x !== 'cards')) {
    const m = pieceModeOf(z);
    bits.push(m === 'stack' ? 'tokens stack, pieces line up' : m === 'pool' ? 'pieces gather in rows' : 'pieces stay where dropped');
  }
  return `Takes ${takes} · ${bits.filter(Boolean).join(' · ')}`;
}

/** What a zone takes, for the "not here" pill shown while carrying something else. */
export function zoneLabelFor(z: ZoneEntity): string {
  const a = zoneAccepts(z);
  const words: Record<ZoneAccept, string> = { cards: 'cards', tokens: 'tokens', pieces: 'pieces', dice: 'dice' };
  const list = a.map((x) => words[x]);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  return `Takes ${joined} only`;
}
