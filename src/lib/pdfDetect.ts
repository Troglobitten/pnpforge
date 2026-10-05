/**
 * Image analysis for print-and-play sheets: finds the card grid on a rendered
 * page (crop marks → gaps between cards → printed cut lines → known card size),
 * detects blank cells and the bounds of printed content.
 *
 * Everything works on a greyscale bitmap of the page (typically ~100 DPI) and
 * returns millimetres with the page's top-left as origin.
 */
import type { RectMm } from '@/shared/types';

export interface GrayImage {
  data: Uint8Array;
  w: number;
  h: number;
  /** Bitmap pixels per page millimetre. */
  pxPerMm: number;
}

/** Luminance below this counts as "ink". */
const INK = 238;

export function canvasToGray(canvas: HTMLCanvasElement, pxPerMm: number): GrayImage {
  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    // Saturated colours count as darker so pale-but-coloured art is still "ink".
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    out[j] = Math.max(0, Math.min(255, lum - sat * 0.6));
  }
  return { data: out, w: canvas.width, h: canvas.height, pxPerMm };
}

type Axis = 'x' | 'y';
type Range = [number, number];

/** Ink count per position along `axis`, summed over the given ranges of the other axis. */
function profile(img: GrayImage, axis: Axis, ranges: Range[] | null): Float64Array {
  const { data, w, h } = img;
  const out = new Float64Array(axis === 'x' ? w : h);
  const rs = ranges ?? [[0, axis === 'x' ? h : w]];
  if (axis === 'x') {
    for (const [a, b] of rs)
      for (let y = Math.max(0, a); y < Math.min(h, b); y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) if (data[row + x] < INK) out[x]++;
      }
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let n = 0;
      for (const [a, b] of rs) for (let x = Math.max(0, a); x < Math.min(w, b); x++) if (data[row + x] < INK) n++;
      out[y] = n;
    }
  }
  return out;
}

function findRuns(prof: Float64Array, thr: number, mergeGap: number, minLen: number): Range[] {
  const runs: Range[] = [];
  let start = -1;
  for (let i = 0; i <= prof.length; i++) {
    const on = i < prof.length && prof[i] >= thr;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  const merged: Range[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= mergeGap) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged.filter((r) => r[1] - r[0] >= minLen);
}

const span = (rs: Range[]) => rs.reduce((n, r) => n + (r[1] - r[0]), 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * Positions (px along `axis`) of isolated thin marks inside the `strips`
 * (ranges of the other axis) — i.e. crop marks in the page margins.
 */
function markPositions(img: GrayImage, axis: Axis, strips: Range[]): number[] {
  const k = img.pxPerMm;
  if (!strips.length || span(strips) < 0.6 * k) return [];
  const prof = profile(img, axis, strips);
  const minLen = Math.max(3, 0.7 * k);
  const out: number[] = [];
  let i = 0;
  while (i < prof.length) {
    if (prof[i] < minLen) {
      i++;
      continue;
    }
    let j = i;
    let peak = 0;
    let wsum = 0;
    let sum = 0;
    while (j < prof.length && prof[j] >= minLen * 0.5) {
      peak = Math.max(peak, prof[j]);
      wsum += prof[j] * j;
      sum += prof[j];
      j++;
    }
    const width = j - i;
    const c = wsum / sum;
    // thin (≤ 1 mm) and isolated (nothing substantial within 0.7–2.2 mm on either side)
    let flank = 0;
    const f0 = Math.round(0.7 * k);
    const f1 = Math.round(2.2 * k);
    for (let d = f0; d <= f1; d++) {
      const l = Math.round(c) - d;
      const r = Math.round(c) + d;
      if (l >= 0) flank = Math.max(flank, prof[l]);
      if (r < prof.length) flank = Math.max(flank, prof[r]);
    }
    if (width <= 1.1 * k && flank <= peak * 0.3) out.push(c);
    i = j;
  }
  return out;
}

/** Positions of long thin printed lines along `axis` inside the block (card borders / cut lines). */
function linePositions(img: GrayImage, axis: Axis, block: { a: number; b: number; oa: number; ob: number }): number[] {
  const { data, w } = img;
  const k = img.pxPerMm;
  const len = block.b - block.a;
  const longest = new Float64Array(axis === 'x' ? img.w : img.h);
  for (let u = block.a; u < block.b; u++) {
    let best = 0;
    let cur = 0;
    let miss = 0;
    for (let v = block.oa; v < block.ob; v++) {
      const px = axis === 'x' ? data[v * w + u] : data[u * w + v];
      if (px < INK - 40) {
        cur += 1 + miss;
        miss = 0;
      } else if (cur > 0 && miss < 1) miss++;
      else {
        best = Math.max(best, cur);
        cur = 0;
        miss = 0;
      }
    }
    longest[u] = Math.max(best, cur);
  }
  const need = Math.max(20 * k, 0.3 * (block.ob - block.oa));
  const out: number[] = [];
  const side = Math.max(2, Math.round(0.9 * k));
  let i = block.a;
  while (i < block.b) {
    if (longest[i] < need) {
      i++;
      continue;
    }
    let j = i;
    while (j < block.b && longest[j] >= need) j++;
    const width = j - i;
    const left = i - side >= 0 ? longest[i - side] : 0;
    const right = j - 1 + side < longest.length ? longest[j - 1 + side] : 0;
    if (width <= 1.2 * k && left < need * 0.5 && right < need * 0.5) out.push((i + j - 1) / 2);
    i = j;
  }
  void len;
  return out;
}

interface TrimFit {
  trimStart: number;
  w: number;
  gap: number;
  n: number;
}

/**
 * Given sorted cut-line positions (mm), find the regular sequence of card
 * trims [a, a+w], [a+w+g, …] that explains the most positions.
 */
function fitTrims(pos: number[], hint?: number): TrimFit | null {
  const P = [...pos].sort((a, b) => a - b).filter((p, i, arr) => i === 0 || p - arr[i - 1] > 0.6);
  if (P.length < 2) return null;
  const cands = new Set<number>();
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const d = P[j] - P[i];
    if (d >= 15 && d <= 250) cands.add(Math.round(d * 4) / 4);
  }
  let best: (TrimFit & { score: number }) | null = null;
  for (const w of cands) {
    const tol = Math.max(0.8, w * 0.012);
    // greedy left-to-right pairing
    const trims: Range[] = [];
    let i = 0;
    while (i < P.length) {
      const j = P.findIndex((p, jj) => jj > i && Math.abs(p - P[i] - w) <= tol);
      if (j > 0) {
        trims.push([P[i], P[j]]);
        // the end of one trim may also be the start of the next (shared cut lines)
        i = j;
      } else i++;
    }
    if (!trims.length) continue;
    // keep the longest run with a consistent gap
    const gaps = trims.slice(1).map((t, n) => t[0] - trims[n][1]);
    const g = gaps.length ? median(gaps) : 0;
    let runStart = 0;
    let bestRun: [number, number] = [0, 1];
    for (let n = 1; n <= trims.length; n++) {
      if (n === trims.length || Math.abs(trims[n][0] - trims[n - 1][1] - g) > 1.2 || g < -0.5) {
        if (n - runStart > bestRun[1] - bestRun[0]) bestRun = [runStart, n];
        runStart = n;
      }
    }
    const run = trims.slice(bestRun[0], bestRun[1]);
    const n = run.length;
    const meanW = run.reduce((s, t) => s + t[1] - t[0], 0) / n;
    let score = n * 10 + (hint ? -Math.abs(meanW - hint) / hint * 8 : 0);
    if (n === 1) score -= 5;
    if (!best || score > best.score) best = { trimStart: run[0][0], w: meanW, gap: n > 1 ? g : 0, n, score };
  }
  return best && best.n >= 1 ? best : null;
}

interface AxisFit {
  start: number; // mm, outer box start (including bleed if known)
  outer: number;
  gap: number;
  count: number;
  /** Bleed measured on this axis (null = unknown: extents are printed content). */
  bleed: number | null;
  source: DetectSource;
}

export type DetectSource = 'marks' | 'gaps' | 'lines' | 'size';

export interface DetectedGrid {
  x: number;
  y: number;
  cols: number;
  rows: number;
  cardW: number;
  cardH: number;
  bleed: number;
  gapX: number;
  gapY: number;
  source: DetectSource;
}

function fitFromTrims(t: TrimFit, blockStart: number): AxisFit {
  let bleed = t.trimStart - blockStart;
  if (bleed < 0.4) bleed = 0;
  bleed = Math.min(bleed, 6);
  if (t.n > 1) bleed = Math.min(bleed, t.gap / 2);
  if (t.gap <= 0.3) bleed = 0; // shared cut lines: outer bleed only, nothing to model
  bleed = Math.round(bleed * 4) / 4;
  return { start: t.trimStart - bleed, outer: t.w + 2 * bleed, gap: Math.max(0, t.gap - 2 * bleed), count: t.n, bleed, source: 'marks' };
}

/**
 * Propose a card grid for a rendered sheet. `hint` is the card size the user
 * has picked (used when the sheet has no marks and cards touch each other).
 */
export function detectGrid(img: GrayImage, hint?: { cardW: number; cardH: number }): DetectedGrid | null {
  const k = img.pxPerMm;
  const mm = (px: number) => px / k;

  // 1. Rows/columns that carry substantial printed content (ignores thin marks & short text lines).
  let runsY = findRuns(profile(img, 'y', null), 0.06 * img.w, 1.2 * k, 12 * k);
  if (!runsY.length) return null;
  let runsX = findRuns(profile(img, 'x', runsY), 0.06 * span(runsY), 1.2 * k, 12 * k);
  if (!runsX.length) return null;
  runsY = findRuns(profile(img, 'y', runsX), 0.06 * span(runsX), 1.2 * k, 12 * k);
  if (!runsY.length) return null;
  runsX = findRuns(profile(img, 'x', runsY), 0.06 * span(runsY), 1.2 * k, 12 * k);
  if (!runsX.length) return null;

  const bx0 = runsX[0][0];
  const bx1 = runsX[runsX.length - 1][1];
  const by0 = runsY[0][0];
  const by1 = runsY[runsY.length - 1][1];
  const m = Math.round(0.5 * k);

  const axisFit = (axis: Axis): AxisFit | null => {
    const runs = axis === 'x' ? runsX : runsY;
    const [a, b] = axis === 'x' ? [bx0, bx1] : [by0, by1];
    const [oa, ob] = axis === 'x' ? [by0, by1] : [bx0, bx1];
    const total = axis === 'x' ? img.h : img.w;
    const hintSize = hint ? (axis === 'x' ? hint.cardW : hint.cardH) : undefined;
    const blockLen = mm(b - a);

    const accept = (t: TrimFit | null) => {
      if (!t) return false;
      const end = t.trimStart + t.n * t.w + (t.n - 1) * t.gap;
      const inside = t.trimStart >= mm(a) - 1.5 && end <= mm(b) + 1.5;
      const covers = end - t.trimStart >= 0.75 * blockLen;
      return inside && covers && t.w >= 12;
    };

    // a) crop marks in the margins
    const strips: Range[] = [];
    if (oa - m > 0) strips.push([0, oa - m]);
    if (ob + m < total) strips.push([ob + m, total]);
    const marks = markPositions(img, axis, strips).map(mm);
    const tm = fitTrims(marks, hintSize);
    if (accept(tm)) return fitFromTrims(tm!, mm(a));

    // b) white gaps between cards
    if (runs.length >= 2) {
      const widths = runs.map((r) => mm(r[1] - r[0]));
      const outer = median(widths);
      const pitch = mm(runs[runs.length - 1][0] - runs[0][0]) / (runs.length - 1);
      const ok = runs.every((r, i) => Math.abs(mm(r[0] - runs[0][0]) - i * pitch) < 2.5) && widths.every((wd) => Math.abs(wd - outer) < outer * 0.1);
      if (ok && pitch > outer)
        return { start: mm(runs[0][0]), outer, gap: pitch - outer, count: runs.length, bleed: null, source: 'gaps' };
    }

    // c) printed card borders / cut lines inside the block
    const lines = linePositions(img, axis, { a, b, oa, ob }).map(mm);
    const tl = fitTrims([mm(a), mm(b), ...lines], hintSize);
    if (accept(tl) && tl!.n >= 2) return { ...fitFromTrims(tl!, mm(a)), source: 'lines' };

    // d) the card size the user picked
    if (hintSize) {
      const n = Math.max(1, Math.round(blockLen / hintSize));
      const outer = blockLen / n;
      if (Math.abs(outer - hintSize) / hintSize < 0.14) return { start: mm(a), outer, gap: 0, count: n, bleed: null, source: 'size' };
    }
    if (runs.length === 1) return { start: mm(a), outer: blockLen, gap: 0, count: 1, bleed: null, source: 'size' };
    return null;
  };

  const fx = axisFit('x');
  const fy = axisFit('y');
  if (!fx || !fy) return null;

  const known = [fx.bleed, fy.bleed].filter((b): b is number => b != null);
  const bleed = known.length ? Math.min(...known) : 0;
  const resolve = (f: AxisFit) => {
    if (f.bleed != null) {
      const trimStart = f.start + f.bleed;
      const trim = f.outer - 2 * f.bleed;
      return { start: trimStart - bleed, card: trim, gap: Math.max(0, f.gap + 2 * f.bleed - 2 * bleed), count: f.count };
    }
    return { start: f.start, card: f.outer - 2 * bleed, gap: f.gap, count: f.count };
  };
  const rx = resolve(fx);
  const ry = resolve(fy);
  if (rx.card < 10 || ry.card < 10) return null;
  const order: DetectSource[] = ['marks', 'lines', 'gaps', 'size'];
  const source = order[Math.max(order.indexOf(fx.source), order.indexOf(fy.source))];
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    x: r2(rx.start),
    y: r2(ry.start),
    cols: rx.count,
    rows: ry.count,
    cardW: r2(rx.card),
    cardH: r2(ry.card),
    bleed: r2(bleed),
    gapX: r2(rx.gap),
    gapY: r2(ry.gap),
    source,
  };
}

/** Copy a rectangle of a greyscale image into a new one (mm in, px out). */
function cropGray(img: GrayImage, rect: RectMm): GrayImage {
  const k = img.pxPerMm;
  const x0 = Math.max(0, Math.round(rect.x * k));
  const y0 = Math.max(0, Math.round(rect.y * k));
  const w = Math.max(1, Math.min(img.w - x0, Math.round(rect.w * k)));
  const h = Math.max(1, Math.min(img.h - y0, Math.round(rect.h * k)));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(img.data.subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + w), y * w);
  return { data, w, h, pxPerMm: k };
}

/**
 * A grid inside one block of the page, for sheets that hold several unrelated
 * groups — 24 round tokens above two markers and a fold-up die net, say. One
 * regular grid cannot describe such a page, and stretching one over all of it
 * offers the user nothing but junk cells. So split the page into bands of
 * printed content and detect within each; the biggest grid found from real
 * evidence (marks, gaps or cut lines) wins, and the user can drag it onto the
 * next block afterwards.
 *
 * Returns `null` when no band yields a grid better than a guess.
 */
export function detectBlockGrid(img: GrayImage, hint?: { cardW: number; cardH: number }): (DetectedGrid & { block: RectMm }) | null {
  const k = img.pxPerMm;
  const bands = findRuns(profile(img, 'y', null), Math.max(2, 0.015 * img.w), 8 * k, 8 * k);
  if (bands.length < 2) return null; // a single block is what detectGrid already saw
  let best: (DetectedGrid & { block: RectMm }) | null = null;
  for (const [a, b] of bands) {
    const block: RectMm = { x: 0, y: a / k, w: img.w / k, h: (b - a) / k };
    let g: DetectedGrid | null = null;
    try {
      g = detectGrid(cropGray(img, block), hint);
    } catch {
      continue;
    }
    if (!g || g.source === 'size' || g.cols * g.rows < 2) continue;
    const cand = { ...g, y: g.y + block.y, block };
    if (!best || cand.cols * cand.rows > best.cols * best.rows) best = cand;
  }
  return best;
}

/** True when a region carries (almost) no ink — ignores a thin border of the region. */
export function isBlankRegion(img: GrayImage, rect: RectMm, inset = 0.14): boolean {
  const k = img.pxPerMm;
  const x0 = Math.max(0, Math.round((rect.x + rect.w * inset) * k));
  const y0 = Math.max(0, Math.round((rect.y + rect.h * inset) * k));
  const x1 = Math.min(img.w, Math.round((rect.x + rect.w * (1 - inset)) * k));
  const y1 = Math.min(img.h, Math.round((rect.y + rect.h * (1 - inset)) * k));
  if (x1 <= x0 || y1 <= y0) return true;
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * img.w;
    for (let x = x0; x < x1; x++) if (img.data[row + x] < INK - 10) ink++;
  }
  return ink / ((x1 - x0) * (y1 - y0)) < 0.004;
}

/**
 * Bounding box (mm) of substantial printed content, ignoring thin marks near the edges.
 * `largest` keeps only the biggest block (e.g. a board without its page caption).
 */
export function contentBounds(img: GrayImage, opts: { largest?: boolean } = {}): RectMm | null {
  const k = img.pxPerMm;
  const biggest = (rs: Range[]) => [rs.reduce((a, r) => (r[1] - r[0] > a[1] - a[0] ? r : a))];
  let rows = findRuns(profile(img, 'y', null), Math.max(2, 0.015 * img.w), 3 * k, 2 * k);
  if (!rows.length) return null;
  if (opts.largest) rows = biggest(rows);
  let cols = findRuns(profile(img, 'x', rows), Math.max(2, 0.015 * span(rows)), 3 * k, 2 * k);
  if (!cols.length) return null;
  if (opts.largest) cols = biggest(cols);
  const x0 = cols[0][0];
  const x1 = cols[cols.length - 1][1];
  const y0 = rows[0][0];
  const y1 = rows[rows.length - 1][1];
  return { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k };
}

/* ------------------------------------------------------------------ */
/* Seams: how far two halves of a board repeat each other               */
/* ------------------------------------------------------------------ */

export interface SeamMatch {
  /** How much of the second part sits on top of the first, in mm. */
  overlap: number;
  /** How far the second part slides along the seam, in mm. */
  shift: number;
  /** Normalised cross-correlation of the matched strips, 0…1. */
  score: number;
}

/** Bilinear-ish sample of a rect into a `cols × rows` grid of luminance. */
function sampleRect(img: GrayImage, rect: RectMm, cols: number, rows: number): Float64Array {
  const k = img.pxPerMm;
  const out = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const sy = Math.min(img.h - 1, Math.max(0, Math.round((rect.y + ((r + 0.5) / rows) * rect.h) * k)));
    const row = sy * img.w;
    for (let c = 0; c < cols; c++) {
      const sx = Math.min(img.w - 1, Math.max(0, Math.round((rect.x + ((c + 0.5) / cols) * rect.w) * k)));
      out[r * cols + c] = img.data[row + sx];
    }
  }
  return out;
}

/** As `sampleRect`, but transposed: `cols` runs down the rect and `rows` across. */
function sampleRectT(img: GrayImage, rect: RectMm, cols: number, rows: number): Float64Array {
  const k = img.pxPerMm;
  const out = new Float64Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    const sy = Math.min(img.h - 1, Math.max(0, Math.round((rect.y + ((c + 0.5) / cols) * rect.h) * k)));
    const row = sy * img.w;
    for (let r = 0; r < rows; r++) {
      const sx = Math.min(img.w - 1, Math.max(0, Math.round((rect.x + ((r + 0.5) / rows) * rect.w) * k)));
      out[r * cols + c] = img.data[row + sx];
    }
  }
  return out;
}

const r2mm = (v: number) => Math.round(v * 100) / 100;

/**
 * Mean luminance of each line of `rect` perpendicular to `axis`, one line per
 * bitmap pixel. Anything coarser rounds the edge of a flap to the sample grid
 * and leaves a sliver of it behind, so the lines are pinned to whole pixels:
 * line `i` is bitmap pixel `u0 + i`, and `pad0`/`pad1` are the sub-pixel slivers
 * of the rect that fall outside `u0 … u1` (in mm), so a caller can express a cut
 * on a pixel boundary as a distance from the rect's own edge.
 */
function lineMeans(img: GrayImage, rect: RectMm, axis: Axis): { m: Float64Array; step: number; pad0: number; pad1: number } {
  const k = img.pxPerMm;
  const step = 1 / k;
  const other = axis === 'x' ? rect.h : rect.w;
  const lo = (axis === 'x' ? rect.x : rect.y) * k;
  const hi = lo + (axis === 'x' ? rect.w : rect.h) * k;
  const u0 = Math.max(0, Math.round(lo));
  const u1 = Math.min(axis === 'x' ? img.w : img.h, Math.round(hi));
  const n = u1 - u0;
  const samples = 200;
  const m = new Float64Array(Math.max(0, n));
  for (let i = 0; i < n; i++) {
    const uPx = u0 + i;
    let sum = 0;
    for (let s = 0; s < samples; s++) {
      const v = (axis === 'x' ? rect.y : rect.x) + ((s + 0.5) / samples) * other;
      const vPx = Math.min((axis === 'x' ? img.h : img.w) - 1, Math.max(0, Math.round(v * k)));
      sum += axis === 'x' ? img.data[vPx * img.w + uPx] : img.data[uPx * img.w + vPx];
    }
    m[i] = sum / samples;
  }
  return { m, step, pad0: (u0 - lo) * step, pad1: (hi - u1) * step };
}

/**
 * How much of one edge of `rect` is a flap rather than artwork — the printed
 * glue tab a print-and-play board tells you to lay the other half over, a
 * caption band, or an unprinted margin. Measured as the strip whose lines look
 * nothing like the body of the piece; returns millimetres to shave off `side`.
 *
 * Conservative by design: it gives up (returns 0) when the "flap" would be more
 * than `maxFrac` of the piece, so a board that simply changes tone near an edge
 * is left alone.
 */
export function edgeFlap(img: GrayImage, rect: RectMm, side: 'left' | 'right' | 'top' | 'bottom', maxFrac = 0.25): number {
  const axis: Axis = side === 'left' || side === 'right' ? 'x' : 'y';
  const len = axis === 'x' ? rect.w : rect.h;
  if (!(len > 4)) return 0;
  const { m, step, pad0, pad1 } = lineMeans(img, rect, axis);
  const n = m.length;
  if (n < 8) return 0;
  const body = [...m.slice(Math.floor(n * 0.3), Math.ceil(n * 0.7))].sort((a, b) => a - b);
  if (!body.length) return 0;
  const M = body[Math.floor(body.length / 2)];
  const dev = body.map((v) => Math.abs(v - M)).sort((a, b) => a - b);
  const mad = dev[Math.floor(dev.length / 2)];
  const tol = Math.max(20, 3.5 * mad);
  const near = side === 'left' || side === 'top';
  const runNeeded = Math.max(2, Math.ceil(2 / step)); // 2 mm of "looks like the body" ends the flap
  const limit = Math.floor((n * maxFrac) | 0);
  const at = (s: number) => (near ? s : n - 1 - s);
  let run = 0;
  for (let s = 0; s <= limit + runNeeded; s++) {
    const i = at(s);
    if (i < 0 || i >= n) break;
    if (Math.abs(m[i] - M) <= tol) {
      if (++run >= runNeeded) {
        // `s0` is the first line that looks like the body, so the flap is
        // everything outside it — cut on that line's outer pixel boundary.
        const s0 = s - runNeeded + 1;
        const flap = (near ? pad0 : pad1) + (s0 + edgeBias(m, at, s0, n)) * step;
        return flap >= 0.2 ? r2mm(Math.min(flap, len * maxFrac)) : 0;
      }
    } else run = 0;
  }
  return 0;
}

/**
 * Fraction of the boundary line that still belongs to the flap. The line where
 * the body starts is usually a blend of the two, and at analysis resolution one
 * pixel is ~0.25 mm — enough to leave a visible sliver at print resolution.
 * Returns 0…1 (0 when the two levels are too close to tell apart).
 */
function edgeBias(m: Float64Array, at: (s: number) => number, s0: number, n: number): number {
  if (s0 <= 0) return 0;
  const flap = m[at(s0 - 1)]; // last line that is definitely flap
  const iBody = at(s0 + 1);
  if (iBody < 0 || iBody >= n) return 0;
  const body = m[iBody]; // first line that is definitely body
  if (Math.abs(flap - body) < 30) return 0;
  return Math.min(1, Math.max(0, (m[at(s0)] - body) / (flap - body)));
}

/**
 * How much the far edge of `aRect` repeats the near edge of `bRect` — the glue
 * tab, printed margin or duplicated strip that a print-and-play board asks you
 * to lay one half over. Both parts are sampled at 2 samples/mm across the seam
 * and 160 lines along it, then compared at every plausible overlap (and a small
 * slide along the seam) by normalised cross-correlation.
 *
 * Returns `null` when nothing matches convincingly, so the caller can leave the
 * seam alone rather than inventing a number.
 */
export function detectSeamOverlap(
  a: GrayImage,
  aRect: RectMm,
  b: GrayImage,
  bRect: RectMm,
  dir: 'h' | 'v',
  opts: { maxMm?: number; minMm?: number; maxShiftMm?: number } = {},
): SeamMatch | null {
  const horiz = dir === 'h';
  const acrossA = horiz ? aRect.w : aRect.h; // across the seam
  const acrossB = horiz ? bRect.w : bRect.h;
  const alongB = horiz ? bRect.h : bRect.w; // along the seam
  const minMm = opts.minMm ?? 2;
  const maxMm = Math.min(opts.maxMm ?? 90, acrossA * 0.45, acrossB * 0.45);
  if (!(maxMm > minMm) || !(alongB > 0)) return null;

  const SPM = 2; // samples per mm across the seam
  const cols = Math.max(4, Math.round(maxMm * SPM));
  const rows = 160; // sample lines along the seam
  const bandA: RectMm = horiz
    ? { x: aRect.x + aRect.w - maxMm, y: aRect.y, w: maxMm, h: aRect.h }
    : { x: aRect.x, y: aRect.y + aRect.h - maxMm, w: aRect.w, h: maxMm };
  const bandB: RectMm = horiz ? { x: bRect.x, y: bRect.y, w: maxMm, h: bRect.h } : { x: bRect.x, y: bRect.y, w: bRect.w, h: maxMm };
  // Column 0 of each band is `maxMm` in from the seam; column `cols-1` is on it
  // for A and `maxMm` in for B, so an overlap of `o` columns pairs A[cols-o+c]
  // with B[c].
  const sa = horiz ? sampleRect(a, bandA, cols, rows) : sampleRectT(a, bandA, cols, rows);
  const sb = horiz ? sampleRect(b, bandB, cols, rows) : sampleRectT(b, bandB, cols, rows);

  /** NCC of A's last `o` columns against B's first `o`, B slid by `dRow` lines. */
  const score = (o: number, dRow: number): number => {
    const r0 = Math.max(0, -dRow);
    const r1 = Math.min(rows, rows - dRow);
    const n = (r1 - r0) * o;
    if (n < 400) return 0;
    let ma = 0;
    let mb = 0;
    for (let r = r0; r < r1; r++) {
      const ra = r * cols + cols - o;
      const rb = (r + dRow) * cols;
      for (let c = 0; c < o; c++) {
        ma += sa[ra + c];
        mb += sb[rb + c];
      }
    }
    ma /= n;
    mb /= n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let r = r0; r < r1; r++) {
      const ra = r * cols + cols - o;
      const rb = (r + dRow) * cols;
      for (let c = 0; c < o; c++) {
        const x = sa[ra + c] - ma;
        const y = sb[rb + c] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
      }
    }
    // Two blank strips correlate perfectly and tell us nothing — reject them.
    if (da / n < 12 || db / n < 12) return 0;
    return num / Math.sqrt(da * db);
  };

  const minCols = Math.max(2, Math.round(minMm * SPM));
  const pick = (dRow: number) => {
    let bo = minCols;
    let bs = -2;
    for (let o = minCols; o <= cols; o++) {
      const s = score(o, dRow);
      if (s > bs) {
        bs = s;
        bo = o;
      }
    }
    // A repeated strip matches at its true width *and* at every narrower slice
    // of itself, so take the widest overlap that is essentially as good.
    for (let o = cols; o > bo; o--)
      if (score(o, dRow) >= bs - 0.02) {
        bo = o;
        break;
      }
    return { o: bo, s: bs };
  };

  let best = { o: minCols, s: -2, dRow: 0 };
  {
    const p = pick(0);
    best = { o: p.o, s: p.s, dRow: 0 };
  }
  // Only search the slide once we know roughly how wide the overlap is.
  const rowsPerMm = rows / alongB;
  const maxShiftRows = Math.round(Math.min(opts.maxShiftMm ?? 6, alongB * 0.2) * rowsPerMm);
  for (let dRow = -maxShiftRows; dRow <= maxShiftRows; dRow++) {
    if (dRow === 0) continue;
    const s = score(best.o, dRow);
    if (s > best.s + 0.01) best = { o: best.o, s, dRow };
  }
  if (best.dRow !== 0) {
    const p = pick(best.dRow);
    if (p.s >= best.s - 0.02) best = { o: p.o, s: p.s, dRow: best.dRow };
  }
  if (best.s < 0.6) return null;
  return { overlap: r2mm(best.o / SPM), shift: r2mm(best.dRow / rowsPerMm), score: Math.round(best.s * 100) / 100 };
}
