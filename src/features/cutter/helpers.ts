/**
 * The flat-page helpers (owner ruling Q1): find the card sheet, find the grid from crop marks / gaps
 * / cut lines, find a board's artwork, skip empty spaces, and measure a joined board's seams. They
 * read ONLY flat pages — PDF pages and images marked as flat scans. A photo page has no analysis
 * bitmap at all (`PageSource.flatGray` answers null) and every helper refuses it, whatever the UI
 * shows. Each helper only proposes: the caller shows what was found and applies it as one undo step.
 *
 * Nothing here compares pieces by look (Q5): identity is only the user's "same as" and ×N.
 */
import type { CutGrid, CutKind, CutQuad, RectMm } from '@/shared/types';
import { contentBounds, detectBlockGrid, detectGrid, detectSeamOverlap, edgeFlap, type DetectSource, type GrayImage } from '@/lib/pdfDetect';
import { rectGrid } from '@/shared/cutter/grid';
import { quadBounds, rectQuad } from '@/shared/cutter/geom';
import type { PageSource } from './pageSource';

export class FlatOnlyError extends Error {
  constructor() {
    super('The page helpers work on flat pages only — never on a photo.');
  }
}

/** Every helper run, for the record (and the tests): which page, and that it was flat. */
export interface HelperRun {
  helper: string;
  sourceId: string;
  page: number;
  at: number;
}
// one record per page load (shared by every copy of this module)
export const helperLog: HelperRun[] = typeof window !== 'undefined' ? ((window as unknown as { __pnpHelperLog?: HelperRun[] }).__pnpHelperLog ??= []) : [];

/** The page's analysis bitmap — or a refusal if it is a photo. The one gate every helper passes. */
async function flat(ps: PageSource, page: number, helper: string): Promise<{ gray: GrayImage; k: number }> {
  if (ps.isPhoto(page)) throw new FlatOnlyError();
  const k = ps.mmPerUnit(page);
  const gray = await ps.flatGray(page);
  if (!gray || k == null) throw new FlatOnlyError();
  helperLog.push({ helper, sourceId: ps.source.id, page, at: Date.now() });
  return { gray, k };
}

const HOW: Record<DetectSource, string> = {
  marks: 'the crop marks',
  gaps: 'the gaps between them',
  lines: 'the printed cut lines',
  size: 'the card size',
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface FoundGrid {
  /** The grid's geometry in page units (for `Object.assign(grid, …)`). */
  geom: Pick<CutGrid, 'rows' | 'cols' | 'gapX' | 'gapY' | 'anchors' | 'square' | 'round' | 'cellAspect' | 'turn'>;
  /** The printed bleed around each piece (mm) — the group's trim. */
  bleedMm: number;
  /** The piece size (mm, without bleed). */
  sizeMm: { w: number; h: number };
  note: NonNullable<CutGrid['note']>;
}

/**
 * Find the grid of cards or tokens on a flat page (the slicer's autoLayout). A token sheet often
 * holds several groups; then one block with real evidence is proposed. Returns null when nothing
 * convincing is there — the caller keeps the user's own grid.
 */
export async function findGrid(ps: PageSource, page: number, kind: CutKind, hint?: { w: number; h: number }): Promise<FoundGrid | null> {
  const { gray, k } = await flat(ps, page, 'find-grid');
  const h = hint ? { cardW: hint.w, cardH: hint.h } : kind === 'tokens' ? { cardW: 25, cardH: 25 } : { cardW: 63.5, cardH: 88.9 };
  let found = detectGrid(gray, h);
  let block = false;
  if (!found || found.source === 'size') {
    const b = detectBlockGrid(gray, h);
    if (b) {
      found = b;
      block = true;
    }
  }
  // "using the card size" is not evidence; for tokens it only gives junk cells
  const plausible = !!found && found.cols * found.rows >= 1 && found.cardW >= 8 && found.cardH >= 8 && found.source !== 'size';
  if (!found || !plausible) return null;
  const b = found.bleed;
  const u = (mm: number) => mm / k; // mm → page units
  const g = rectGrid({ x: u(found.x), y: u(found.y), cols: found.cols, rows: found.rows, cellW: u(found.cardW + 2 * b), cellH: u(found.cardH + 2 * b), gapX: u(found.gapX), gapY: u(found.gapY) });
  const noun = kind === 'tokens' ? 'tokens' : 'cards';
  const bleed = b > 0 ? `, ${b} mm bleed` : '';
  return {
    geom: g,
    bleedMm: b,
    sizeMm: { w: r2(found.cardW), h: r2(found.cardH) },
    note: {
      tone: 'success',
      text: block
        ? `Found ${found.cols} × ${found.rows} ${noun} (${r1(found.cardW)} × ${r1(found.cardH)} mm${bleed}) using ${HOW[found.source]}. This page holds more than one group — frame the others with another grid.`
        : `Found ${found.cols} × ${found.rows} ${noun} (${r1(found.cardW)} × ${r1(found.cardH)} mm${bleed}) using ${HOW[found.source]}. Check the lines sit on the cut marks.`,
    },
  };
}

/** The first page of a PDF that really is a card sheet (crop marks, gaps or cut lines; 4+ cards). */
export async function findCardSheet(ps: PageSource, limit = 12): Promise<number | null> {
  if (ps.source.kind !== 'pdf') return null;
  for (let p = 0; p < Math.min(ps.source.pageCount, limit); p++) {
    try {
      const { gray } = await flat(ps, p, 'find-card-sheet');
      const g = detectGrid(gray, { cardW: 63.5, cardH: 88.9 });
      if (g && g.source !== 'size' && g.cols * g.rows >= 4 && g.cardW >= 20 && g.cardH >= 20) return p;
    } catch {
      /* unreadable page — keep looking */
    }
  }
  return null;
}

/** The printed artwork on a flat page (a board, a cover): its largest block, in page units. */
export async function findArtwork(ps: PageSource, page: number): Promise<CutQuad | null> {
  const { gray, k } = await flat(ps, page, 'find-artwork');
  const b = contentBounds(gray, { largest: true });
  if (!b || b.w < 20 || b.h < 20) return null;
  return rectQuad(b.x / k, b.y / k, b.w / k, b.h / k) as CutQuad;
}

/** Snap a frame to the artwork under it (flat pages): the largest block within a little around the frame. */
export async function snapToArtwork(ps: PageSource, page: number, quad: CutQuad): Promise<CutQuad | null> {
  const { gray, k } = await flat(ps, page, 'snap-to-artwork');
  const q = quadBounds(quad);
  const pad = 6; // mm around the frame
  const rect: RectMm = { x: Math.max(0, q.x * k - pad), y: Math.max(0, q.y * k - pad), w: q.w * k + 2 * pad, h: q.h * k + 2 * pad };
  const sub = crop(gray, rect);
  const b = contentBounds(sub, { largest: true });
  if (!b || b.w < 5 || b.h < 5) return null;
  return rectQuad((rect.x + b.x) / k, (rect.y + b.y) / k, b.w / k, b.h / k) as CutQuad;
}

/** Which frames of a list are empty spaces (no ink) on a flat page; photos: none, ever. */
export async function emptySpaces(ps: PageSource, page: number, frames: { id: string; quad: CutQuad }[], trimMm: number): Promise<Set<string>> {
  const out = new Set<string>();
  if (ps.isPhoto(page)) return out;
  await flat(ps, page, 'skip-empty');
  for (const f of frames) if (await ps.isBlank(page, f.quad, trimMm)) out.add(f.id);
  return out;
}

export interface SeamPart {
  page: number;
  ps: PageSource;
  quad: CutQuad;
}
export interface MeasuredSeams {
  /** New frame rectangles (the glue tab / margin shaved off the edges that meet), page units. */
  quads: CutQuad[];
  joins: { overlap: number; shift: number; auto: boolean; score: number; line: { a: number; b: number } }[];
}

/**
 * A thin printed line (a dashed cut guide, a keyline) lying on the very edge of a part, in mm — read
 * at 600 dpi across the last 1.5 mm of that edge. 0 when the edge is just artwork.
 */
async function edgeLine(ps: PageSource, page: number, rectMm: RectMm, k: number, side: 'left' | 'right' | 'top' | 'bottom'): Promise<number> {
  const band = 1.5;
  const horiz = side === 'left' || side === 'right';
  const r: RectMm = side === 'right' ? { ...rectMm, x: rectMm.x + rectMm.w - band, w: band } : side === 'left' ? { ...rectMm, w: band } : side === 'bottom' ? { ...rectMm, y: rectMm.y + rectMm.h - band, h: band } : { ...rectMm, h: band };
  const dpi = 600;
  const c = (await ps.renderFrame({ page, quad: rectQuad(r.x / k, r.y / k, r.w / k, r.h / k) as CutQuad, mm: { w: r.w, h: r.h }, trimMm: 0, dpi })).canvas;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const n = horiz ? c.width : c.height;
  const m = n ? new Float64Array(n) : new Float64Array(0);
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      m[horiz ? x : y] += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
  const per = horiz ? Math.ceil(c.height / 2) : c.width;
  for (let i = 0; i < n; i++) m[i] /= per;
  c.width = c.height = 0;
  const pxPerMm = dpi / 25.4;
  // the body: the inner half of the band; the line: columns at the edge that stand out from it
  const inner = side === 'right' || side === 'bottom' ? [...m.slice(0, Math.floor(n / 2))] : [...m.slice(Math.ceil(n / 2))];
  inner.sort((a, b) => a - b);
  const body = inner[Math.floor(inner.length / 2)] ?? 0;
  const spread = (inner[Math.floor(inner.length * 0.9)] ?? 0) - (inner[Math.floor(inner.length * 0.1)] ?? 0);
  const tol = Math.max(6, spread * 1.5);
  const limit = Math.round(0.6 * pxPerMm); // a guide line is thin: never more than 0.6 mm
  let count = 0;
  for (let s = 0; s < limit; s++) {
    const i = side === 'right' || side === 'bottom' ? n - 1 - s : s;
    if (Math.abs(m[i] - body) > tol) count = s + 1;
    else if (count && s - count > 2) break;
  }
  return count ? Math.round(((count + 1) / pxPerMm) * 100) / 100 : 0;
}

/**
 * Measure a joined board's seams (the slicer's autoSeams): shave the printed glue tab off the edges
 * that meet, then find how much the two edges still repeat. Flat pages only (Q6): a photo part
 * refuses — its seams are the user's overlap and shift.
 */
export async function measureSeams(parts: SeamPart[], dir: 'h' | 'v'): Promise<MeasuredSeams> {
  const horiz = dir === 'h';
  const grays: { gray: GrayImage; k: number }[] = [];
  for (const p of parts) grays.push(await flat(p.ps, p.page, 'measure-seams'));
  // work in mm on each page
  const rects: RectMm[] = parts.map((p, i) => {
    const b = quadBounds(p.quad);
    const k = grays[i].k;
    return { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
  });
  for (let i = 0; i < parts.length; i++) {
    const sides: ('left' | 'right' | 'top' | 'bottom')[] = [];
    if (i > 0) sides.push(horiz ? 'left' : 'top');
    if (i < parts.length - 1) sides.push(horiz ? 'right' : 'bottom');
    for (const side of sides) {
      const f = edgeFlap(grays[i].gray, rects[i], side);
      if (f <= 0) continue;
      const r = rects[i];
      if (side === 'left') {
        r.x = r2(r.x + f);
        r.w = r2(r.w - f);
      } else if (side === 'right') r.w = r2(r.w - f);
      else if (side === 'top') {
        r.y = r2(r.y + f);
        r.h = r2(r.h - f);
      } else r.h = r2(r.h - f);
    }
  }
  const joins: MeasuredSeams['joins'] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const m = detectSeamOverlap(grays[i].gray, rects[i], grays[i + 1].gray, rects[i + 1], dir, { maxMm: 25 });
    const a = await edgeLine(parts[i].ps, parts[i].page, rects[i], grays[i].k, horiz ? 'right' : 'bottom');
    const b = await edgeLine(parts[i + 1].ps, parts[i + 1].page, rects[i + 1], grays[i + 1].k, horiz ? 'left' : 'top');
    joins.push({ overlap: m?.overlap ?? 0, shift: m?.shift ?? 0, auto: true, score: m?.score ?? 0, line: { a, b } });
  }
  return { quads: rects.map((r, i) => rectQuad(r.x / grays[i].k, r.y / grays[i].k, r.w / grays[i].k, r.h / grays[i].k) as CutQuad), joins };
}

/** A part of a grey image (mm rect), for local analysis. */
function crop(img: GrayImage, rect: RectMm): GrayImage {
  const k = img.pxPerMm;
  const x0 = Math.max(0, Math.round(rect.x * k));
  const y0 = Math.max(0, Math.round(rect.y * k));
  const x1 = Math.min(img.w, Math.round((rect.x + rect.w) * k));
  const y1 = Math.min(img.h, Math.round((rect.y + rect.h) * k));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(img.data.subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + w), y * w);
  return { ...img, w, h, data } as GrayImage;
}
