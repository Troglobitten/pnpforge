/**
 * The unified grid: rows × columns of equal pieces with even gaps, seen through one
 * perspective (a homography from a unit layout onto the four handles). On a flat page with
 * "keep it square" the handles form an axis-aligned rectangle and the mapping is exact.
 * Pure. The maths is the photo import's (src/features/photos/grid.ts), so frames migrated from
 * a photo draft come out identical; the rest generalises the slicer's rectangle grid.
 */
import type { BackFlip, CutGrid, CutQuad } from '../types.js';
import { applyH, homography, rectQuad, turnQuad, type Mat3, type Quad } from './geom.js';

/** The fields that decide where a grid's cells are. */
export type GridGeom = Pick<CutGrid, 'rows' | 'cols' | 'gapX' | 'gapY' | 'anchors' | 'round' | 'cellAspect' | 'turn'>;

export const GRID_MAX = 12;

export const cellCount = (g: Pick<CutGrid, 'rows' | 'cols'>) => g.rows * g.cols;

function unit(g: Omit<GridGeom, 'anchors' | 'turn'>) {
  const cw = g.round ? 1 : g.cellAspect;
  const ch = 1;
  const gx = g.gapX * cw;
  const gy = g.gapY * ch;
  return { cw, ch, gx, gy, W: g.cols * cw + (g.cols - 1) * gx, H: g.rows * ch + (g.rows - 1) * gy };
}

/** Handles on the pieces' centres need a round grid of 2 × 2 at least; otherwise the outer corners. */
export const onCentres = (g: Pick<CutGrid, 'round' | 'rows' | 'cols'>) => g.round && g.rows >= 2 && g.cols >= 2;

/** Where the handles sit in the unit layout. */
export function unitAnchors(g: Omit<GridGeom, 'anchors' | 'turn'>): Quad {
  const u = unit(g);
  if (!onCentres(g)) return rectQuad(0, 0, u.W, u.H);
  const cx = (c: number) => c * (u.cw + u.gx) + u.cw / 2;
  const cy = (r: number) => r * (u.ch + u.gy) + u.ch / 2;
  return [
    [cx(0), cy(0)],
    [cx(g.cols - 1), cy(0)],
    [cx(g.cols - 1), cy(g.rows - 1)],
    [cx(0), cy(g.rows - 1)],
  ];
}

const gridH = (g: GridGeom): Mat3 => homography(unitAnchors(g), g.anchors);

/** The frame of one cell, turned so its first corner is the piece's top-left. */
export function cellQuad(g: GridGeom, cell: number, extraTurn = 0): Quad {
  const u = unit(g);
  const r = Math.floor(cell / g.cols);
  const c = cell % g.cols;
  const x = c * (u.cw + u.gx);
  const y = r * (u.ch + u.gy);
  const H = gridH(g);
  const q: Quad = [applyH(H, x, y), applyH(H, x + u.cw, y), applyH(H, x + u.cw, y + u.ch), applyH(H, x, y + u.ch)];
  return turnQuad(q, g.turn + extraTurn);
}

/** The outline of the whole grid. */
export function gridOutline(g: GridGeom): Quad {
  const u = unit(g);
  const H = gridH(g);
  return [applyH(H, 0, 0), applyH(H, u.W, 0), applyH(H, u.W, u.H), applyH(H, 0, u.H)];
}

/**
 * A "keep it square" grid from a rectangle layout in page units: the top-left of the first
 * cell, the cell (outer) size and the gaps between cells — the slicer's GridLayout, where the
 * outer box includes the bleed.
 */
export function rectGrid(L: { x: number; y: number; cols: number; rows: number; cellW: number; cellH: number; gapX: number; gapY: number }): Pick<
  CutGrid,
  'rows' | 'cols' | 'gapX' | 'gapY' | 'anchors' | 'square' | 'round' | 'cellAspect' | 'turn'
> {
  const W = L.cols * L.cellW + (L.cols - 1) * L.gapX;
  const H = L.rows * L.cellH + (L.rows - 1) * L.gapY;
  return {
    rows: L.rows,
    cols: L.cols,
    gapX: L.gapX / L.cellW,
    gapY: L.gapY / L.cellH,
    anchors: rectQuad(L.x, L.y, W, H) as CutQuad,
    square: true,
    round: false,
    cellAspect: L.cellW / L.cellH,
    turn: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Turned-over sheets                                                    */
/* ------------------------------------------------------------------ */

/** Which axis a sheet turned over its `flip` edge mirrors, for a page of this shape. */
export function mirrorAxis(pageW: number, pageH: number, flip: BackFlip): 'x' | 'y' | null {
  if (flip === 'none') return null;
  const portrait = pageH >= pageW;
  if (flip === 'long') return portrait ? 'x' : 'y';
  return portrait ? 'y' : 'x';
}

/** The cell a piece lands in once the sheet is turned over (same rows × columns). */
export function mirrorCell(g: Pick<CutGrid, 'rows' | 'cols'>, cell: number, axis: 'x' | 'y' | null): number {
  const r = Math.floor(cell / g.cols);
  const c = cell % g.cols;
  if (axis === 'x') return r * g.cols + (g.cols - 1 - c);
  if (axis === 'y') return (g.rows - 1 - r) * g.cols + c;
  return cell;
}

/* ------------------------------------------------------------------ */
/* Laying out and reshaping (photo import's rules, for every page)      */
/* ------------------------------------------------------------------ */

export type GridParams = Pick<CutGrid, 'rows' | 'cols' | 'gapX' | 'gapY' | 'round' | 'cellAspect' | 'turn'>;

/** Anchors for a grid centred in a W × H page, as large as fits in `fill` of it. */
export function centredAnchors(W: number, H: number, p: GridParams, fill = 0.84): CutQuad {
  const u = unit(p);
  const k = Math.min((W * fill) / u.W, (H * fill) / u.H);
  const ox = (W - u.W * k) / 2;
  const oy = (H - u.H * k) / 2;
  return unitAnchors(p).map((pt) => [ox + pt[0] * k, oy + pt[1] * k]) as CutQuad;
}

/**
 * Anchors for a grid whose pieces are `cellW × cellH` page units with `gapW × gapH` between
 * them, centred on the page (flat pages: real sizes).
 */
export function sizedAnchors(W: number, H: number, p: GridParams, cellW: number, cellH: number): CutQuad {
  const u = unit(p);
  const k = cellH / 1; // unit piece height is 1
  const kx = cellW / (p.round ? 1 : p.cellAspect);
  const w = u.W * kx;
  const h = u.H * k;
  const ox = (W - w) / 2;
  const oy = (H - h) / 2;
  return unitAnchors(p).map((pt) => [ox + pt[0] * kx, oy + pt[1] * k]) as CutQuad;
}

/** Remap a cell index after the rows/columns changed; null when the cell is gone. */
export function remapCell(cell: number, from: Pick<CutGrid, 'cols'>, to: Pick<CutGrid, 'rows' | 'cols'>): number | null {
  const r = Math.floor(cell / from.cols);
  const c = cell % from.cols;
  return r < to.rows && c < to.cols ? r * to.cols + c : null;
}

/**
 * The same grid with different parameters. The top-left piece stays where it is and the grid
 * grows or shrinks through the same perspective (on a square grid: to the right and down);
 * gaps and the piece shape keep the handles where they are. A grid that would grow off the page
 * is laid out again, centred.
 */
export function reshapeGrid<G extends GridGeom & Pick<CutGrid, 'removed'>>(g: G, next: Partial<GridParams>, W: number, H: number): G {
  const n = { ...g, ...next, anchors: g.anchors, removed: g.removed } as G;
  const resized = (next.rows !== undefined && next.rows !== g.rows) || (next.cols !== undefined && next.cols !== g.cols);
  if (resized) n.removed = g.removed.map((i) => remapCell(i, g, n)).filter((i): i is number => i != null);
  if (resized || onCentres(n) !== onCentres(g)) {
    const Hold = gridH(g);
    n.anchors = unitAnchors({ ...n, gapX: g.gapX, gapY: g.gapY, cellAspect: g.cellAspect }).map((pt) => applyH(Hold, pt[0], pt[1])) as CutQuad;
    const out = gridOutline(n).some((p) => !(p[0] > -0.08 * W && p[0] < 1.08 * W && p[1] > -0.08 * H && p[1] < 1.08 * H) || !Number.isFinite(p[0] + p[1]));
    if (resized && out) n.anchors = centredAnchors(W, H, n);
  }
  return n;
}

/** Make a grid's handles an axis-aligned rectangle (turning "Keep it square" on). */
export function squareAnchors(q: CutQuad): CutQuad {
  // average opposite edges, so the grid stays where it was (and never turns inside out)
  const x0 = (q[0][0] + q[3][0]) / 2;
  const x1 = (q[1][0] + q[2][0]) / 2;
  const y0 = (q[0][1] + q[1][1]) / 2;
  const y1 = (q[3][1] + q[2][1]) / 2;
  return rectQuad(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || 1, Math.abs(y1 - y0) || 1) as CutQuad;
}
