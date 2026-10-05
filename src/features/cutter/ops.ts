/**
 * Edits of the cutter document, as plain functions over a (draft) CutterDoc: grids and the frames
 * they lay out, single frames, leaving pieces out, linked grids across same-size flat pages,
 * "same frames as the previous photo". The store wraps them for undo and autosave.
 */
import type { BackFlip, CutBacksRule, CutFrame, CutGrid, CutGroup, CutKind, CutQuad, CutterDoc, Game, ID, PageRef } from '@/shared/types';
import { cellQuad, centredAnchors, cellCount, mirrorAxis, onCentres, reshapeGrid, sizedAnchors, squareAnchors, type GridParams } from '@/shared/cutter/grid';
import { seamsFor } from '@/shared/cutter/pieces';
export { pairsSignature } from '@/shared/cutter/doc';
import { quadBounds, rectQuad } from '@/shared/cutter/geom';
import { newId } from '@/shared/ids';

/* ------------------------------------------------------------------ */
/* pages                                                               */
/* ------------------------------------------------------------------ */

export interface PageDims {
  /** Page size in page units. */
  w: number;
  h: number;
  units: 'mm' | 'px';
  /** A camera photo (perspective handles, no known scale). */
  photo: boolean;
  /** mm per page unit; null on photos. */
  mmPerUnit: number | null;
  /** Paper size key for linking ("210x297"); null on photos. */
  sizeKey: string | null;
}

export function pageDims(game: Pick<Game, 'sources'>, at: PageRef): PageDims | null {
  const s = game.sources.find((x) => x.id === at.sourceId);
  const p = s?.pages[at.page];
  if (!s || !p) return null;
  if (s.kind !== 'images') return { w: p.widthMm, h: p.heightMm, units: 'mm', photo: false, mmPerUnit: 1, sizeKey: `${Math.round(p.widthMm)}x${Math.round(p.heightMm)}` };
  const w = p.px?.w ?? 1000;
  const h = p.px?.h ?? 1000;
  if (p.photo) return { w, h, units: 'px', photo: true, mmPerUnit: null, sizeKey: null };
  const k = 25.4 / (p.dpi || 300);
  return { w, h, units: 'px', photo: false, mmPerUnit: k, sizeKey: `${Math.round(w * k)}x${Math.round(h * k)}` };
}

export const sameRef = (a: PageRef | null | undefined, b: PageRef | null | undefined) => !!a && !!b && a.sourceId === b.sourceId && a.page === b.page;

/** The page's grids (creation order) and frames, numbered as the user sees them. */
export function pageContent(doc: CutterDoc, at: PageRef) {
  const grids = Object.values(doc.grids).filter((g) => sameRef(g.at, at));
  const all = Object.values(doc.frames).filter((f) => sameRef(f.at, at));
  const onGrids = grids.flatMap((g) => all.filter((f) => f.gridId === g.id).sort((a, b) => (a.cell ?? 0) - (b.cell ?? 0)));
  const loose = all.filter((f) => !onGrids.includes(f));
  const frames = [...onGrids, ...loose];
  const numbers = new Map(frames.map((f, i) => [f.id, i + 1]));
  return { grids, frames, numbers };
}

/* ------------------------------------------------------------------ */
/* groups                                                              */
/* ------------------------------------------------------------------ */

export const KIND_LABEL: Record<CutKind, string> = { cards: 'Cards', tokens: 'Tokens', board: 'Board', back: 'Card back', cover: 'Cover' };
export const KIND_NOUN: Record<CutKind, [string, string]> = {
  cards: ['card', 'cards'],
  tokens: ['token', 'tokens'],
  board: ['board', 'boards'],
  back: ['card back', 'card backs'],
  cover: ['cover', 'covers'],
};

/** A group's name without the kind repeated: "Cards — page 3" stays; "Embers" reads "Embers (tokens)". */
export function groupLabel(g: Pick<CutGroup, 'name' | 'kind'>): string {
  const kind = KIND_LABEL[g.kind];
  return g.name.toLowerCase().startsWith(kind.toLowerCase()) ? g.name : `${g.name} (${KIND_NOUN[g.kind][1]})`;
}

/** How a page is called in names and messages: "page 3", or the image's file name. */
export function pageLabel(game: Pick<Game, 'sources'>, at: PageRef): string {
  const s = game.sources.find((x) => x.id === at.sourceId);
  if (!s) return 'a removed file';
  if (s.kind === 'images') return (s.pages[at.page]?.name ?? `image ${at.page + 1}`).replace(/\.[a-z0-9]+$/i, '');
  const pdfs = game.sources.filter((x) => x.kind !== 'images').length;
  return pdfs > 1 ? `${s.name} p. ${at.page + 1}` : `page ${at.page + 1}`;
}

export function newGroup(doc: CutterDoc, kind: CutKind, _photo: boolean, name?: string): CutGroup {
  const base = name ?? KIND_LABEL[kind];
  const names = new Set(doc.groups.map((g) => g.name));
  let unique = base;
  for (let i = 2; names.has(unique); i++) unique = `${base} (${i})`;
  const g: CutGroup = {
    id: newId(),
    name: unique,
    kind,
    size: null,
    // flat pages: no bleed until the user says; photos keep their own finish (group.photo, defaults)
    trimMm: 0,
    cornerMm: 0,
    ...(kind === 'tokens' ? { shape: 'round' as const } : {}),
    order: [],
    backs: { mode: 'none', pairs: {} },
    out: { target: 'new', deckId: null, dpi: 300 },
  };
  doc.groups.push(g);
  return doc.groups[doc.groups.length - 1];
}

/** The last group of this kind, or a new one. */
export function groupFor(doc: CutterDoc, kind: CutKind, photo: boolean): CutGroup {
  for (let i = doc.groups.length - 1; i >= 0; i--) if (doc.groups[i].kind === kind) return doc.groups[i];
  return newGroup(doc, kind, photo);
}

/** Stable tint index of a group (its place in the list). */
export const groupTint = (doc: Pick<CutterDoc, 'groups'>, groupId: ID) => {
  const i = doc.groups.findIndex((g) => g.id === groupId);
  const c = doc.groups[i]?.color;
  return c != null ? c % 6 : Math.max(0, i) % 6;
};

/* ------------------------------------------------------------------ */
/* grids                                                               */
/* ------------------------------------------------------------------ */

const POKER = { w: 63.5, h: 88.9 };

/** A kind's first layout on a page. Flat pages use real sizes; photos fill most of the photo. */
function startParams(kind: CutKind, rows: number, cols: number, d: PageDims): { p: GridParams; anchors: CutQuad } {
  const round = kind === 'tokens';
  let cellAspect = kind === 'tokens' ? 1 : POKER.w / POKER.h;
  if (kind === 'board' || kind === 'cover') cellAspect = (d.w * 0.9) / cols / ((d.h * 0.9) / rows);
  const photoGap = kind === 'board' || kind === 'cover' ? 0 : 0.12;
  if (d.photo || d.mmPerUnit == null) {
    const p: GridParams = { rows, cols, gapX: photoGap, gapY: photoGap, round, cellAspect, turn: 0 };
    return { p, anchors: centredAnchors(d.w, d.h, p) };
  }
  const k = 1 / d.mmPerUnit; // units per mm
  const mm = kind === 'tokens' ? { w: 25, h: 25 } : kind === 'board' || kind === 'cover' ? null : POKER;
  const gapMm = kind === 'tokens' ? 3 : 0;
  if (!mm) {
    const p: GridParams = { rows, cols, gapX: 0, gapY: 0, round: false, cellAspect, turn: 0 };
    return { p, anchors: centredAnchors(d.w, d.h, p, 0.9) };
  }
  const p: GridParams = { rows, cols, gapX: gapMm / mm.w, gapY: gapMm / mm.h, round, cellAspect: mm.w / mm.h, turn: 0 };
  const W = cols * mm.w + (cols - 1) * gapMm;
  const H = rows * mm.h + (rows - 1) * gapMm;
  // too big for the page: fit it instead (the user sizes it with the handles)
  if (W * k > d.w * 0.98 || H * k > d.h * 0.98) return { p, anchors: squareAnchors(centredAnchors(d.w, d.h, p, 0.9)) };
  return { p, anchors: sizedAnchors(d.w, d.h, p, mm.w * k, mm.h * k) };
}

/**
 * A new grid. It goes into the group the user picked (`into`), else into a NEW group named from the
 * page ("Cards — page 3") — never silently into a group that lives elsewhere.
 */
export function addGrid(doc: CutterDoc, at: PageRef, d: PageDims, kind: CutKind, rows: number, cols: number, into?: { groupId?: ID; name: string }): CutGrid {
  const picked = into?.groupId ? doc.groups.find((g) => g.id === into.groupId) : undefined;
  const group = picked ?? newGroup(doc, kind, d.photo, into?.name);
  if (picked && picked.kind !== kind) kind = picked.kind;
  const { p, anchors } = startParams(kind, rows, cols, d);
  const g: CutGrid = { id: newId(), at: { ...at }, groupId: group.id, ...p, anchors, square: !d.photo, removed: [], same: kind === 'tokens', fitted: false };
  doc.grids[g.id] = g;
  syncGrid(doc, g.id);
  return doc.grids[g.id];
}

/** Lay the grid's frames out again: on-grid frames follow it; cells get a frame; gone cells lose theirs. */
export function syncGrid(doc: CutterDoc, gridId: ID) {
  const g = doc.grids[gridId];
  if (!g) return;
  const n = cellCount(g);
  const taken = new Set<number>();
  for (const f of Object.values(doc.frames)) {
    if (f.gridId !== gridId) continue;
    if (f.cell == null || f.cell >= n || g.removed.includes(f.cell)) {
      if (f.onGrid) deleteFrameRecord(doc, f.id);
      else {
        delete f.gridId;
        delete f.cell;
      }
      continue;
    }
    taken.add(f.cell);
    if (f.onGrid) {
      f.quad = cellQuad(g, f.cell, f.turn);
      f.shape = g.round ? 'round' : 'rect';
    }
  }
  for (let c = 0; c < n; c++) {
    if (taken.has(c) || g.removed.includes(c)) continue;
    const f: CutFrame = { id: newId(), at: { ...g.at }, groupId: g.groupId, quad: cellQuad(g, c), shape: g.round ? 'round' : 'rect', gridId, cell: c, onGrid: true, turn: 0, side: g.backOf || g.backs ? 'back' : 'front' };
    doc.frames[f.id] = f;
  }
  applySame(doc, g);
}

/** The grid's "all the same piece" switch as frame links (one representative, the lowest cell). */
function applySame(doc: CutterDoc, g: CutGrid) {
  const mine = Object.values(doc.frames)
    .filter((f) => f.gridId === g.id)
    .sort((a, b) => (a.cell ?? 0) - (b.cell ?? 0));
  const ids = new Set(mine.map((f) => f.id));
  const rep = mine[0];
  for (const f of mine) {
    if (g.same) f.same = f === rep ? null : rep.id;
    else if (f.same && ids.has(f.same)) f.same = null;
  }
}

/** Grids that share this grid's layout (itself included). */
export function linkedGrids(doc: CutterDoc, gridId: ID): CutGrid[] {
  const g = doc.grids[gridId];
  if (!g) return [];
  if (!g.linkId) return [g];
  return Object.values(doc.grids).filter((x) => x.linkId === g.linkId);
}

const GEOMETRY = ['rows', 'cols', 'gapX', 'gapY', 'anchors', 'square', 'round', 'cellAspect', 'turn'] as const;

/** Copy this grid's layout onto the grids linked to it and lay them all out again. */
export function propagate(doc: CutterDoc, gridId: ID) {
  const g = doc.grids[gridId];
  if (!g) return;
  for (const o of linkedGrids(doc, gridId)) {
    if (o.id !== gridId) {
      for (const k of GEOMETRY) (o as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(g[k]));
      o.fitted = g.fitted;
      // cells removed on one page stay removed only there
      o.removed = o.removed.filter((c) => c < cellCount(o));
    }
    syncGrid(doc, o.id);
  }
  // back grids turned over from these follow them; the group's pairs follow the grids
  const ids = new Set(linkedGrids(doc, gridId).map((x) => x.id));
  for (const b of Object.values(doc.grids)) if (b.backOf?.linked && ids.has(b.backOf.gridId)) followFront(doc, b.id);
  refillPairs(doc, g.groupId);
  for (const b of Object.values(doc.grids)) if (b.backOf && ids.has(b.backOf.gridId) && b.groupId !== g.groupId) refillPairs(doc, b.groupId);
}

export function setAnchors(doc: CutterDoc, gridId: ID, anchors: CutQuad) {
  const g = doc.grids[gridId];
  if (!g) return;
  if (g.backOf?.linked && g.backOf.page) {
    // a linked back grid follows its front: dragging it moves the printed offset
    const f = doc.grids[g.backOf.gridId];
    if (f) {
      const { w, h } = g.backOf.page;
      const mir = mirrorAnchors(f.anchors, w, h, mirrorAxis(w, h, g.backOf.flip));
      const c = (q: CutQuad) => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
      const [ax, ay] = c(anchors);
      const [mx, my] = c(mir);
      setBackOffset(doc, gridId, ax - mx, ay - my);
      return;
    }
  }
  g.anchors = anchors;
  g.fitted = true;
  propagate(doc, gridId);
}

export function setGridParams(doc: CutterDoc, gridId: ID, next: Partial<GridParams> & { square?: boolean }, d: PageDims) {
  const g = doc.grids[gridId];
  if (!g) return;
  const { square, ...params } = next;
  const n = reshapeGrid(g, params, d.w, d.h);
  Object.assign(g, n);
  if (square !== undefined) g.square = square;
  if (g.square) g.anchors = squareAnchors(g.anchors);
  propagate(doc, gridId);
}

export function deleteGrid(doc: CutterDoc, gridId: ID) {
  // its turned-over backs: a linked one goes with it; one with its own handles stays, as backs
  for (const b of Object.values(doc.grids)) {
    if (b.backOf?.gridId !== gridId) continue;
    if (b.backOf.linked) deleteGrid(doc, b.id);
    else {
      delete b.backOf;
      b.backs = true;
    }
  }
  for (const f of Object.values(doc.frames)) if (f.gridId === gridId) deleteFrameRecord(doc, f.id);
  const g = doc.grids[gridId];
  delete doc.grids[gridId];
  if (g?.linkId) {
    const rest = Object.values(doc.grids).filter((x) => x.linkId === g.linkId);
    if (rest.length === 1) delete rest[0].linkId;
  }
}

/** "Use this grid on…": linked copies on every page given (they must be the same paper size). */
export function useGridOn(doc: CutterDoc, gridId: ID, pages: PageRef[]): number {
  const g = doc.grids[gridId];
  if (!g) return 0;
  g.linkId ??= newId();
  let n = 0;
  for (const at of pages) {
    if (sameRef(at, g.at)) continue;
    const c: CutGrid = { ...JSON.parse(JSON.stringify(g)), id: newId(), at: { ...at }, removed: [] };
    doc.grids[c.id] = c;
    syncGrid(doc, c.id);
    n++;
  }
  return n;
}

export function unlinkGrid(doc: CutterDoc, gridId: ID) {
  const g = doc.grids[gridId];
  if (!g?.linkId) return;
  const link = g.linkId;
  delete g.linkId;
  const rest = Object.values(doc.grids).filter((x) => x.linkId === link);
  if (rest.length === 1) delete rest[0].linkId;
}

/**
 * Photos: the previous photo's grids and frames, copied (never linked — every photo has its own
 * perspective), scaled to this photo's size. Replaces what this page had.
 */
export function copyPage(doc: CutterDoc, from: PageRef, fd: PageDims, to: PageRef, td: PageDims) {
  clearPage(doc, to);
  const kx = td.w / fd.w;
  const ky = td.h / fd.h;
  const scale = (q: CutQuad) => q.map((p) => [p[0] * kx, p[1] * ky]) as CutQuad;
  const src = pageContent(doc, from);
  const gridMap = new Map<ID, ID>();
  for (const g of src.grids) {
    const c: CutGrid = { ...JSON.parse(JSON.stringify(g)), id: newId(), at: { ...to }, anchors: scale(g.anchors) };
    delete c.linkId;
    delete c.backOf;
    doc.grids[c.id] = c;
    gridMap.set(g.id, c.id);
  }
  for (const f of src.frames) {
    // frames moved off their grid come along as they are; on-grid ones are laid out by the copy
    if (f.onGrid && f.gridId) continue;
    const c: CutFrame = { ...JSON.parse(JSON.stringify(f)), id: newId(), at: { ...to }, quad: scale(f.quad), excluded: false, side: 'front', same: null, name: undefined };
    if (f.gridId && gridMap.has(f.gridId)) c.gridId = gridMap.get(f.gridId);
    else {
      delete c.gridId;
      delete c.cell;
    }
    doc.frames[c.id] = c;
  }
  for (const id of gridMap.values()) syncGrid(doc, id);
}

export function clearPage(doc: CutterDoc, at: PageRef) {
  for (const g of Object.values(doc.grids)) if (sameRef(g.at, at)) deleteGrid(doc, g.id);
  for (const f of Object.values(doc.frames)) if (sameRef(f.at, at)) deleteFrameRecord(doc, f.id);
}

/* ------------------------------------------------------------------ */
/* frames                                                              */
/* ------------------------------------------------------------------ */

/** Remove a frame and every reference to it. */
function deleteFrameRecord(doc: CutterDoc, id: ID) {
  delete doc.frames[id];
  for (const g of doc.groups) {
    g.order = g.order.filter((x) => x !== id);
    if (id in g.backs.pairs) delete g.backs.pairs[id];
    for (const [k, v] of Object.entries(g.backs.pairs)) if (v === id) g.backs.pairs[k] = null;
    if (g.backs.sharedFrameId === id) g.backs.sharedFrameId = null;
  }
  // frames that were "the same as" it now point at the first of them
  const followers = Object.values(doc.frames).filter((f) => f.same === id);
  if (followers.length) {
    const rep = followers[0];
    for (const f of followers) f.same = f === rep ? null : rep.id;
  }
}

/** Delete a frame. A grid cell stays empty until "Put the frame back". */
export function removeFrame(doc: CutterDoc, id: ID) {
  const f = doc.frames[id];
  if (!f) return;
  const g = f.gridId ? doc.grids[f.gridId] : undefined;
  if (g && f.cell != null && !g.removed.includes(f.cell)) g.removed.push(f.cell);
  deleteFrameRecord(doc, id);
}

/** Put a grid's removed cells back. */
export function restoreCells(doc: CutterDoc, gridId: ID) {
  const g = doc.grids[gridId];
  if (!g) return;
  g.removed = [];
  syncGrid(doc, gridId);
}

export function toggleExcluded(doc: CutterDoc, id: ID) {
  const f = doc.frames[id];
  if (f) f.excluded = !f.excluded || undefined;
}

export function setFrameQuad(doc: CutterDoc, id: ID, quad: CutQuad) {
  const f = doc.frames[id];
  if (!f) return;
  f.quad = quad;
  f.onGrid = false;
}

/** Back on its grid: it follows the grid again. */
export function putBack(doc: CutterDoc, id: ID) {
  const f = doc.frames[id];
  if (!f?.gridId || f.cell == null) return;
  f.onGrid = true;
  syncGrid(doc, f.gridId);
}

export function turnFrame(doc: CutterDoc, id: ID, by: number) {
  const f = doc.frames[id];
  if (!f) return;
  f.turn = (((f.turn + by) % 4) + 4) % 4;
  if (f.onGrid && f.gridId) return syncGrid(doc, f.gridId);
  // quarter turn of the corner order: the picture turns, the outline stays
  const k = ((by % 4) + 4) % 4;
  f.quad = [0, 1, 2, 3].map((i) => f.quad[(i - k + 4) % 4]) as CutQuad;
}

export function setFrameShape(doc: CutterDoc, id: ID, shape: 'rect' | 'round') {
  const f = doc.frames[id];
  if (f) f.shape = shape;
}

/** A frame drawn by hand (or added in the middle of the page), in the page's last group of cards. */
export function addFrame(doc: CutterDoc, at: PageRef, d: PageDims, quad: CutQuad | null, kind?: CutKind, name?: string): CutFrame {
  const page = pageContent(doc, at);
  const lastGroup = page.frames.length ? page.frames[page.frames.length - 1].groupId : undefined;
  // into this page's group; a page with nothing yet gets a new group of its own
  const group = lastGroup && doc.groups.some((g) => g.id === lastGroup) ? doc.groups.find((g) => g.id === lastGroup)! : newGroup(doc, kind ?? 'cards', d.photo, name);
  let q = quad;
  if (!q) {
    const k = d.mmPerUnit ? 1 / d.mmPerUnit : null;
    const w = k ? POKER.w * k : Math.min(d.w, d.h) * 0.3;
    const h = k ? POKER.h * k : w / (POKER.w / POKER.h);
    // offset each new one a little so they don't stack exactly
    const off = (page.frames.filter((f) => !f.gridId).length % 6) * Math.min(d.w, d.h) * 0.03;
    q = rectQuad((d.w - w) / 2 + off, (d.h - h) / 2 + off, w, h) as CutQuad;
  }
  const f: CutFrame = { id: newId(), at: { ...at }, groupId: group.id, quad: q, shape: group.kind === 'tokens' ? 'round' : 'rect', onGrid: false, turn: 0, side: 'front' };
  doc.frames[f.id] = f;
  return doc.frames[f.id];
}

/** Move a group's page to another kind: the frames on this page go into the last group of that kind. */
export function setPageKind(doc: CutterDoc, at: PageRef, kind: CutKind, photo: boolean) {
  const group = groupFor(doc, kind, photo);
  for (const g of Object.values(doc.grids)) if (sameRef(g.at, at)) g.groupId = group.id;
  for (const f of Object.values(doc.frames)) if (sameRef(f.at, at)) f.groupId = group.id;
  pruneGroups(doc);
  return group;
}

/** Groups with no frames and nothing made are dropped (they come back when a page uses the kind). */
export function pruneGroups(doc: CutterDoc) {
  const used = new Set(Object.values(doc.frames).map((f) => f.groupId));
  for (const g of Object.values(doc.grids)) used.add(g.groupId);
  doc.groups = doc.groups.filter((g) => used.has(g.id) || g.made);
}

/* ------------------------------------------------------------------ */
/* groups (stage 4)                                                    */
/* ------------------------------------------------------------------ */

/** Change what a whole group makes. Tokens get round pieces by default; other kinds square ones. */
export function setGroupKind(doc: CutterDoc, groupId: ID, kind: CutKind, dims: (at: PageRef) => PageDims | null) {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g || g.kind === kind) return;
  const wasTokens = g.kind === 'tokens';
  g.kind = kind;
  if (kind === 'tokens') {
    g.shape ??= 'round';
    g.cornerMm = 0;
  } else delete g.shape;
  if (kind !== 'cards' && kind !== 'tokens') g.backs = { mode: 'none', pairs: {} };
  // the size of a card is not the size of a token: a set size no longer applies
  if (g.size && (wasTokens || kind === 'tokens') && g.size.from !== 'page') g.size = null;
  applyGroupShape(doc, groupId, dims);
}

/** Round tokens are round frames (and round grids, handles on the corner pieces' centres). */
export function applyGroupShape(doc: CutterDoc, groupId: ID, dims: (at: PageRef) => PageDims | null) {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  const round = g.kind === 'tokens' && g.shape === 'round';
  for (const grid of Object.values(doc.grids)) {
    if (grid.groupId !== groupId || grid.round === round) continue;
    const d = dims(grid.at);
    if (d) setGridParams(doc, grid.id, { round }, d);
  }
  for (const f of Object.values(doc.frames)) if (f.groupId === groupId && !f.onGrid) f.shape = round ? 'round' : 'rect';
}

/** Move a grid (with its frames) or a single frame into a group (an existing one, or a new one of a kind). */
export function moveToGroup(doc: CutterDoc, what: { gridId?: ID; frameId?: ID }, target: ID | { kind: CutKind; photo: boolean; name?: string }, dims: (at: PageRef) => PageDims | null): ID {
  const group = typeof target === 'string' ? doc.groups.find((g) => g.id === target) : newGroup(doc, target.kind, target.photo, target.name);
  if (!group) return '';
  if (what.gridId) {
    const grid = doc.grids[what.gridId];
    if (grid) {
      const moved = linkedGrids(doc, grid.id);
      const ids = new Set(moved.map((g) => g.id));
      // the backs of these grids go along with them
      for (const b of Object.values(doc.grids)) if (b.backOf && ids.has(b.backOf.gridId)) moved.push(b);
      for (const g of moved) {
        g.groupId = group.id;
        for (const f of Object.values(doc.frames)) if (f.gridId === g.id) f.groupId = group.id;
      }
    }
  } else if (what.frameId) {
    const f = doc.frames[what.frameId];
    if (f) {
      f.groupId = group.id;
      // a frame that leaves its grid's group is on its own
      if (f.gridId && doc.grids[f.gridId]?.groupId !== group.id) f.onGrid = false;
      if (f.same) f.same = null;
    }
  }
  // links to pieces in another group mean nothing
  for (const f of Object.values(doc.frames)) if (f.same && doc.frames[f.same]?.groupId !== f.groupId) f.same = null;
  applyGroupShape(doc, group.id, dims);
  pruneGroups(doc);
  return group.id;
}

/** Tokens: every piece of the grid is the same token (one piece × the count), or each its own. */
export function setGridSame(doc: CutterDoc, gridId: ID, same: boolean) {
  const g = doc.grids[gridId];
  if (!g) return;
  g.same = same;
  // the links follow the switch (frames made "the same" by hand elsewhere are left alone)
  const mine = Object.values(doc.frames)
    .filter((f) => f.gridId === gridId)
    .sort((a, b) => (a.cell ?? 0) - (b.cell ?? 0));
  const ids = new Set(mine.map((f) => f.id));
  const rep = mine[0];
  for (const f of mine) {
    if (same) f.same = f === rep ? null : rep.id;
    else if (f.same && ids.has(f.same)) f.same = null;
  }
}

/** "Same piece as frame X" (null = its own piece). */
export function setFrameSame(doc: CutterDoc, id: ID, same: ID | null) {
  const f = doc.frames[id];
  if (!f || same === id) return;
  if (!same) {
    // frames that pointed at this one now point at the next of them
    const followers = Object.values(doc.frames).filter((x) => x.same === id);
    f.same = null;
    if (followers.length) {
      const rep = followers[0];
      for (const x of followers) x.same = x === rep ? null : rep.id;
    }
    return;
  }
  const target = doc.frames[same];
  const rep = target?.same ?? same;
  for (const x of Object.values(doc.frames)) if (x.same === id) x.same = rep;
  f.same = rep;
}

/**
 * Flat pages: a set size resizes the group's square grids — every piece becomes `wMm × hMm` (plus the
 * trim on each side), growing from the grid's top-left corner, gaps kept.
 */
export function fitGridsToSize(doc: CutterDoc, groupId: ID, wMm: number, hMm: number, dims: (at: PageRef) => PageDims | null) {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  const done = new Set<string>();
  for (const grid of Object.values(doc.grids)) {
    if (grid.groupId !== groupId || !grid.square || onCentres(grid) || grid.backOf?.linked || done.has(grid.linkId ?? grid.id)) continue;
    const d = dims(grid.at);
    if (!d || d.photo || d.mmPerUnit == null) continue;
    done.add(grid.linkId ?? grid.id);
    const k = 1 / d.mmPerUnit;
    const cw = (wMm + 2 * g.trimMm) * k;
    const ch = (hMm + 2 * g.trimMm) * k;
    // keep the gaps as a length, not a share of the old piece
    const oldW = Math.abs(grid.anchors[1][0] - grid.anchors[0][0]);
    const oldH = Math.abs(grid.anchors[3][1] - grid.anchors[0][1]);
    const ocw = oldW / (grid.cols + (grid.cols - 1) * grid.gapX);
    const och = oldH / (grid.rows + (grid.rows - 1) * grid.gapY);
    const gx = grid.gapX * ocw;
    const gy = grid.gapY * och;
    // about the grid's centre: the pieces stay under it
    const cx = (grid.anchors[0][0] + grid.anchors[1][0] + grid.anchors[2][0] + grid.anchors[3][0]) / 4;
    const cy = (grid.anchors[0][1] + grid.anchors[1][1] + grid.anchors[2][1] + grid.anchors[3][1]) / 4;
    const W = grid.cols * cw + (grid.cols - 1) * gx;
    const H = grid.rows * ch + (grid.rows - 1) * gy;
    const x0 = cx - W / 2;
    const y0 = cy - H / 2;
    grid.gapX = gx / cw;
    grid.gapY = gy / ch;
    grid.cellAspect = cw / ch;
    grid.anchors = rectQuad(x0, y0, W, H) as CutQuad;
    propagate(doc, grid.id);
  }
}

/* ------------------------------------------------------------------ */
/* what a change touched                                               */
/* ------------------------------------------------------------------ */

export const pageKey = (at: PageRef) => `${at.sourceId}:${at.page}`;

/** Pages whose grids or frames differ between two versions of the document (immer shares the rest). */
export function changedPages(before: CutterDoc, after: CutterDoc): PageRef[] {
  const out = new Map<string, PageRef>();
  const note = (at: PageRef | undefined) => at && out.set(pageKey(at), at);
  for (const id of new Set([...Object.keys(before.grids), ...Object.keys(after.grids)])) if (before.grids[id] !== after.grids[id]) note(after.grids[id]?.at ?? before.grids[id]?.at);
  for (const id of new Set([...Object.keys(before.frames), ...Object.keys(after.frames)])) if (before.frames[id] !== after.frames[id]) note(after.frames[id]?.at ?? before.frames[id]?.at);
  return [...out.values()];
}

/** Pages that feed a group. */
export function groupPages(doc: CutterDoc, groupId: ID, game?: Pick<Game, 'sources'>): PageRef[] {
  const out = new Map<string, PageRef>();
  for (const f of Object.values(doc.frames)) if (f.groupId === groupId) out.set(pageKey(f.at), f.at);
  // in the strip's order (the game's files), when the game is known
  const rank = (id: ID) => game?.sources.findIndex((x) => x.id === id) ?? -1;
  return [...out.values()].sort((a, b) => rank(a.sourceId) - rank(b.sourceId) || a.sourceId.localeCompare(b.sourceId) || a.page - b.page);
}

/* ------------------------------------------------------------------ */
/* backs (stage 5): rules fill the pairs — never the looks (Q5)         */
/* ------------------------------------------------------------------ */

type Axis = 'x' | 'y' | null;

/** A grid's handles seen from the other side of the sheet: mirrored across the page, corners in reading order. */
export function mirrorAnchors(q: CutQuad, W: number, H: number, axis: Axis): CutQuad {
  const m = (p: [number, number]): [number, number] => (axis === 'x' ? [W - p[0], p[1]] : axis === 'y' ? [p[0], H - p[1]] : [p[0], p[1]]);
  if (axis === 'x') return [m(q[1]), m(q[0]), m(q[3]), m(q[2])];
  if (axis === 'y') return [m(q[3]), m(q[2]), m(q[1]), m(q[0])];
  return q.map((p) => m(p as [number, number])) as CutQuad;
}

const BACK_GEOMETRY = ['rows', 'cols', 'gapX', 'gapY', 'square', 'round', 'cellAspect', 'turn'] as const;

/** A linked back grid (flat duplex): the front grid, mirrored, shifted by the printed offset. */
export function followFront(doc: CutterDoc, backId: ID) {
  const b = doc.grids[backId];
  const f = b?.backOf ? doc.grids[b.backOf.gridId] : undefined;
  if (!b?.backOf || !f || !b.backOf.page) return;
  for (const k of BACK_GEOMETRY) (b as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(f[k]));
  const { w, h } = b.backOf.page;
  const mir = mirrorAnchors(f.anchors, w, h, mirrorAxis(w, h, b.backOf.flip));
  b.anchors = mir.map((p) => [p[0] + b.backOf!.dx, p[1] + b.backOf!.dy]) as CutQuad;
  b.removed = b.removed.filter((c) => c < cellCount(b));
  syncGrid(doc, backId);
}

/** The cell a front cell lands on once turned over onto `back` (null = outside it). */
function turnedCell(front: CutGrid, cell: number, back: CutGrid, axis: Axis): number | null {
  const r = Math.floor(cell / front.cols);
  const c = cell % front.cols;
  const br = axis === 'y' ? back.rows - 1 - r : r;
  const bc = axis === 'x' ? back.cols - 1 - c : c;
  if (br < 0 || bc < 0 || br >= back.rows || bc >= back.cols) return null;
  return br * back.cols + bc;
}

const frameAt = (doc: CutterDoc, gridId: ID, cell: number) => Object.values(doc.frames).find((f) => f.gridId === gridId && f.cell === cell && !f.excluded);

/** The group's fronts in make order. */
const frontsOf = (doc: CutterDoc, g: CutGroup) =>
  Object.values(doc.frames)
    .filter((f) => f.groupId === g.id && f.side === 'front')
    .sort((a, b) => a.at.sourceId.localeCompare(b.at.sourceId) || a.at.page - b.at.page || (a.cell ?? 1e9) - (b.cell ?? 1e9));

/** Backs-page rule: the backs page of a front page (older documents: one page for all). */
export function backsPageFor(rule: Extract<CutBacksRule, { kind: 'backs-page' }>, front: PageRef): PageRef | null {
  if (!rule.map) return rule.page;
  return rule.map[pageKey(front)] ?? null;
}

/**
 * One back, one piece. A back frame is paired with at most one front — except when the user
 * explicitly gave several front pages the same page of backs (then one front per front page).
 * Hand pairs win: a back a hand pair uses is taken for everyone else. Returns the fronts that lost
 * their back to a hand pair.
 */
export function enforceOneBack(doc: CutterDoc, g: CutGroup): ID[] {
  const hand = new Set(g.backs.handPaired ?? []);
  const reuse = g.backs.rule?.kind === 'backs-page' && !!g.backs.rule.map;
  const key = (front: ID, back: ID) => (reuse ? `${back}|${pageKey(doc.frames[front]?.at ?? { sourceId: '', page: -1 })}` : back);
  const handBacks = new Set(Object.entries(g.backs.pairs).filter(([f, b]) => hand.has(f) && b).map(([, b]) => b as ID));
  const used = new Set<string>();
  const lost: ID[] = [];
  const order = [...frontsOf(doc, g).filter((f) => hand.has(f.id)), ...frontsOf(doc, g).filter((f) => !hand.has(f.id))];
  for (const f of order) {
    const b = g.backs.pairs[f.id];
    if (!b) continue;
    if (!doc.frames[b]) {
      g.backs.pairs[f.id] = null;
      continue;
    }
    const k = key(f.id, b);
    if (used.has(k) || (!hand.has(f.id) && handBacks.has(b))) {
      g.backs.pairs[f.id] = null;
      lost.push(f.id);
      continue;
    }
    used.add(k);
  }
  return lost;
}

/** What is wrong with a group's pairs (empty = fine): the invariant, for tests and the dev console. */
export function pairProblems(doc: CutterDoc, g: CutGroup): string[] {
  const out: string[] = [];
  const reuse = g.backs.rule?.kind === 'backs-page' && !!g.backs.rule.map;
  const seen = new Map<string, ID>();
  for (const [f, b] of Object.entries(g.backs.pairs)) {
    if (!b) continue;
    if (!doc.frames[f]) out.push(`pair for a missing front ${f}`);
    if (!doc.frames[b]) out.push(`front ${f} → missing back ${b}`);
    else if (doc.frames[b].side !== 'back' && g.backs.mode === 'each') out.push(`front ${f} → ${b}, which is not a back`);
    const k = reuse ? `${b}|${pageKey(doc.frames[f]?.at ?? { sourceId: '', page: -1 })}` : b;
    if (seen.has(k)) out.push(`back ${b} is on two pieces (${seen.get(k)} and ${f})`);
    seen.set(k, f);
  }
  return out;
}

/** Fill the group's pairs from its rule. Hand pairs stay, and the backs they use are taken. */
export function refillPairs(doc: CutterDoc, groupId: ID): { lost: ID[] } {
  const g = doc.groups.find((x) => x.id === groupId);
  const rule = g?.backs.rule;
  if (!g || g.backs.mode !== 'each' || !rule || rule.kind === 'hand') {
    if (g) enforceOneBack(doc, g);
    return { lost: [] };
  }
  const hand = new Set(g.backs.handPaired ?? []);
  const fronts = frontsOf(doc, g);
  const next: Record<ID, ID | null> = {};
  if (rule.kind === 'turned-over') {
    for (const f of fronts) {
      const fg = f.gridId ? doc.grids[f.gridId] : undefined;
      const back = fg && f.cell != null ? Object.values(doc.grids).find((b) => b.backOf?.gridId === fg.id) : undefined;
      if (!fg || !back || f.cell == null) {
        next[f.id] = null;
        continue;
      }
      const size = back.backOf?.page;
      const axis = size ? mirrorAxis(size.w, size.h, rule.flip) : null;
      const cell = turnedCell(fg, f.cell, back, axis);
      next[f.id] = cell == null ? null : (frameAt(doc, back.id, cell)?.id ?? null);
    }
  } else {
    // each front page with its own backs page: cells mirrored (or in order) when the grids match,
    // otherwise in reading order until the backs run out — never round again
    const byPage = new Map<string, CutFrame[]>();
    for (const f of fronts) byPage.set(pageKey(f.at), [...(byPage.get(pageKey(f.at)) ?? []), f]);
    for (const list of byPage.values()) {
      const at = backsPageFor(rule, list[0].at);
      const back = at ? Object.values(doc.grids).find((b) => b.groupId === groupId && b.backs && sameRef(b.at, at)) : undefined;
      const backs = back ? Object.values(doc.frames).filter((f) => f.gridId === back.id && !f.excluded).sort((a, b) => (a.cell ?? 0) - (b.cell ?? 0)) : [];
      const size = back ? pageSizeOf(doc, back) : null;
      const axis = size ? mirrorAxis(size.w, size.h, rule.flip) : null;
      let k = 0;
      for (const f of list) {
        const fg = f.gridId ? doc.grids[f.gridId] : undefined;
        if (!back) next[f.id] = null;
        else if (fg && f.cell != null && fg.rows === back.rows && fg.cols === back.cols) next[f.id] = frameAt(doc, back.id, turnedCell(fg, f.cell, back, axis) ?? -1)?.id ?? null;
        else next[f.id] = backs[k++]?.id ?? null;
      }
    }
  }
  for (const [front, back] of Object.entries(next)) if (!hand.has(front)) g.backs.pairs[front] = back;
  for (const id of Object.keys(g.backs.pairs)) if (!doc.frames[id]) delete g.backs.pairs[id];
  return { lost: enforceOneBack(doc, g) };
}

/** The page size a grid sits on (from its back-of record or the rule), for mirroring. */
function pageSizeOf(doc: CutterDoc, grid: CutGrid): { w: number; h: number } | null {
  if (grid.backOf?.page) return grid.backOf.page;
  const g = doc.groups.find((x) => x.id === grid.groupId);
  const r = g?.backs.rule;
  if (r?.kind === 'backs-page' && r.size) return r.size;
  // the grid's own extent is a fair stand-in for orientation
  const b = quadBounds(grid.anchors);
  return { w: Math.max(b.x + b.w, 1), h: Math.max(b.y + b.h, 1) };
}

export interface PageSizeOf {
  (at: PageRef): PageDims | null;
}

/** Remove what a rule made that is not used any more: turned-over back grids / backs-page grids on unmapped pages. */
export function dropRuleGrids(doc: CutterDoc, groupId: ID, keep: 'turned-over' | 'backs-page' | null) {
  const g = doc.groups.find((x) => x.id === groupId);
  const rule = g?.backs.rule;
  const mapped = new Set<string>();
  if (rule?.kind === 'backs-page' && keep === 'backs-page') {
    if (rule.map) for (const at of Object.values(rule.map)) at && mapped.add(pageKey(at));
    else mapped.add(pageKey(rule.page));
  }
  for (const grid of Object.values(doc.grids)) {
    if (grid.groupId !== groupId) continue;
    if (grid.backOf && keep !== 'turned-over') deleteGrid(doc, grid.id);
    else if (grid.byRule === 'backs-page' && !mapped.has(pageKey(grid.at))) deleteGrid(doc, grid.id);
  }
}

/**
 * "Turned over on the next page": every front grid of the group gets a back grid on the page after
 * it. Flat pages: LINKED (the front mirrored, plus a printed offset to drag). Photos: its own grid,
 * laid out mirrored to start with — the user drags its handles onto the backs.
 */
export function applyTurnedOver(doc: CutterDoc, groupId: ID, flip: BackFlip, dims: PageSizeOf, pageCount: (sourceId: ID) => number): { made: number; skipped: string[]; lost: ID[] } {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g) return { made: 0, skipped: [], lost: [] };
  dropRuleGrids(doc, groupId, 'turned-over');
  g.backs.mode = 'each';
  g.backs.rule = { kind: 'turned-over', flip };
  const skipped: string[] = [];
  let made = 0;
  const fronts = Object.values(doc.grids).filter((x) => x.groupId === groupId && !x.backOf && !x.backs);
  const frontPages = new Set(fronts.map((x) => pageKey(x.at)));
  for (const f of fronts) {
    const at = { sourceId: f.at.sourceId, page: f.at.page + 1 };
    const fd = dims(f.at);
    const bd = dims(at);
    if (at.page >= pageCount(f.at.sourceId) || !bd || !fd || frontPages.has(pageKey(at))) {
      skipped.push(`page ${f.at.page + 1}`);
      continue;
    }
    let b = Object.values(doc.grids).find((x) => x.backOf?.gridId === f.id);
    const linked = !fd.photo && !bd.photo;
    const fresh = !b;
    if (!b) {
      b = { ...(JSON.parse(JSON.stringify(f)) as CutGrid), id: newId(), at, groupId, removed: [], backOf: { gridId: f.id, flip, linked, dx: 0, dy: 0, page: { w: bd.w, h: bd.h } } };
      delete b.linkId;
      delete b.backs;
      delete b.byRule;
      doc.grids[b.id] = b;
      made++;
    }
    b.backOf = { ...b.backOf!, flip, page: { w: bd.w, h: bd.h } };
    if (b.backOf.linked) followFront(doc, b.id);
    else if (fresh) {
      // photos: the front grid's layout on the back photo, turned over, as a starting point (only
      // when it is made: a back grid the user has placed keeps its handles when the flip changes)
      const kx = bd.w / fd.w;
      const ky = bd.h / fd.h;
      const scaled = f.anchors.map((p) => [p[0] * kx, p[1] * ky]) as CutQuad;
      b.anchors = mirrorAnchors(scaled, bd.w, bd.h, mirrorAxis(bd.w, bd.h, flip));
      for (const k of BACK_GEOMETRY) (b as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(f[k]));
      b.square = f.square && !bd.photo;
      syncGrid(doc, b.id);
    }
  }
  const { lost } = refillPairs(doc, groupId);
  return { made, skipped, lost };
}

/** The group's front pages (where its front frames are), in order. */
export function frontPagesOf(doc: CutterDoc, groupId: ID): PageRef[] {
  const out = new Map<string, PageRef>();
  for (const f of Object.values(doc.frames)) if (f.groupId === groupId && f.side === 'front') out.set(pageKey(f.at), f.at);
  return [...out.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.page - b.page);
}

/** Make sure a page holds a grid of this group's backs (the user's own backs grid, or a new one like the fronts'). */
function ensureBacksGrid(doc: CutterDoc, groupId: ID, at: PageRef, dims: PageSizeOf) {
  const d = dims(at);
  if (!d) return;
  let b = Object.values(doc.grids).find((x) => sameRef(x.at, at) && x.groupId === groupId && x.backs);
  if (b) return;
  const front = Object.values(doc.grids).find((x) => x.groupId === groupId && !x.backOf && !x.backs);
  if (!front) return;
  const fd = dims(front.at);
  b = { ...(JSON.parse(JSON.stringify(front)) as CutGrid), id: newId(), at: { ...at }, groupId, removed: [], backs: true, byRule: 'backs-page' };
  delete b.linkId;
  delete b.backOf;
  if (fd && (fd.w !== d.w || fd.h !== d.h || fd.photo !== d.photo)) b.anchors = centredAnchors(d.w, d.h, b);
  doc.grids[b.id] = b;
  syncGrid(doc, b.id);
}

/**
 * "A page of backs". `map`: each front page's backs page (null = none). A page given to several
 * front pages is the user's explicit choice; nothing is repeated on its own.
 */
export function applyBacksPage(doc: CutterDoc, groupId: ID, map: Record<string, PageRef | null>, flip: BackFlip, dims: PageSizeOf): { lost: ID[] } {
  const g = doc.groups.find((x) => x.id === groupId);
  const first = Object.values(map).find(Boolean) ?? null;
  if (!g) return { lost: [] };
  const d = first ? dims(first) : null;
  g.backs.mode = 'each';
  g.backs.rule = { kind: 'backs-page', page: first ? { ...first } : (g.backs.rule?.kind === 'backs-page' ? g.backs.rule.page : frontPagesOf(doc, groupId)[0]), flip, ...(d ? { size: { w: d.w, h: d.h } } : {}), map: JSON.parse(JSON.stringify(map)) };
  dropRuleGrids(doc, groupId, 'backs-page');
  for (const at of Object.values(map)) if (at) ensureBacksGrid(doc, groupId, at, dims);
  return refillPairs(doc, groupId);
}

/** How the backs are used: distinct fronts with a back, backs pages used for more than one front page. */
export function backsReport(doc: CutterDoc, g: CutGroup) {
  const fronts = frontsOf(doc, g).filter((f) => !f.excluded);
  const pairs = fronts.map((f) => g.backs.pairs[f.id]).filter((b): b is ID => !!b && !!doc.frames[b]);
  const count = new Map<ID, number>();
  for (const b of pairs) count.set(b, (count.get(b) ?? 0) + 1);
  const distinct = fronts.filter((f) => {
    const b = g.backs.pairs[f.id];
    return b && doc.frames[b] && count.get(b) === 1;
  }).length;
  const reused: { at: PageRef; pages: number }[] = [];
  const rule = g.backs.rule;
  if (rule?.kind === 'backs-page' && rule.map) {
    const uses = new Map<string, { at: PageRef; pages: number }>();
    for (const at of Object.values(rule.map)) if (at) uses.set(pageKey(at), { at, pages: (uses.get(pageKey(at))?.pages ?? 0) + 1 });
    for (const u of uses.values()) if (u.pages > 1) reused.push(u);
  }
  const used = new Set(pairs);
  const unused = Object.values(doc.frames).filter((f) => f.groupId === g.id && f.side === 'back' && !f.excluded && !used.has(f.id) && g.backs.sharedFrameId !== f.id).length;
  return { fronts: fronts.length, withBack: pairs.length, distinct, shared: pairs.length - distinct, reused, unused };
}

/** "By hand": the user pairs each front with a back in the Pieces view. */
export function setHandRule(doc: CutterDoc, groupId: ID) {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  g.backs.mode = 'each';
  g.backs.rule = { kind: 'hand' };
}

export function setBacksMode(doc: CutterDoc, groupId: ID, mode: 'none' | 'same' | 'each') {
  const g = doc.groups.find((x) => x.id === groupId);
  if (g) g.backs.mode = mode;
}

/** The user pairs a front with a back (or with none). A back belongs to one front. */
export function pairByHand(doc: CutterDoc, groupId: ID, frontId: ID, backId: ID | null) {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g) return;
  if (backId) for (const [f, b] of Object.entries(g.backs.pairs)) if (b === backId && f !== frontId) g.backs.pairs[f] = null;
  g.backs.pairs[frontId] = backId;
  g.backs.handPaired = [...new Set([...(g.backs.handPaired ?? []), frontId])];
  enforceOneBack(doc, g);
}

/** A frame (any page, any group) becomes the one back every piece of the group gets. */
export function useAsSharedBack(doc: CutterDoc, groupId: ID, frameId: ID) {
  const g = doc.groups.find((x) => x.id === groupId);
  const f = doc.frames[frameId];
  if (!g || !f) return;
  // a frame taken from another group's grid is on its own now
  if (f.gridId && doc.grids[f.gridId]?.groupId !== groupId) f.onGrid = false;
  f.groupId = groupId;
  f.side = 'back';
  f.excluded = undefined;
  if (f.same) f.same = null;
  g.backs.mode = 'same';
  g.backs.sharedFrameId = frameId;
  g.backs.assetId = null;
}

/** A grid's frames are backs (or fronts again). */
export function setGridBacks(doc: CutterDoc, gridId: ID, backs: boolean) {
  const b = doc.grids[gridId];
  if (!b) return;
  b.backs = backs || undefined;
  if (!backs) delete b.byRule;
  for (const f of Object.values(doc.frames)) if (f.gridId === gridId) f.side = backs ? 'back' : 'front';
  refillPairs(doc, b.groupId);
}

/** The printed offset of a linked back grid (duplex misregistration). */
export function setBackOffset(doc: CutterDoc, backId: ID, dx: number, dy: number) {
  const b = doc.grids[backId];
  if (!b?.backOf) return;
  b.backOf.dx = dx;
  b.backOf.dy = dy;
  followFront(doc, backId);
}

/**
 * Every joined board's seam list follows its parts: one seam per neighbouring pair, keyed by that
 * pair. Run after every edit (store.patchDoc), so a part added, removed or reordered can never
 * leave a stale or phantom seam behind — whichever panel happens to be open.
 */
export function syncJoins(doc: CutterDoc) {
  for (const g of doc.groups) {
    if (!g.join) continue;
    const next = seamsFor(doc, g);
    const cur = g.join.joins;
    const same = cur.length === next.length && cur.every((j, i) => j.key === next[i].key && j.overlap === next[i].overlap && j.shift === next[i].shift && !!j.pending === !!next[i].pending && !!j.auto === !!next[i].auto);
    if (!same) g.join.joins = next;
  }
}

