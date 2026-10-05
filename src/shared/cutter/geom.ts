/**
 * Plane geometry for the unified cutter: homographies between a flat rectangle and a quad.
 * Pure, no DOM — shared by the server (migration), scripts, the client and workers.
 * Numerically identical to src/features/photos/cv/geom.ts (which it replaces in stage 8), so
 * grids migrated from photo drafts reproduce their frames exactly.
 */
import type { CutPt, CutQuad } from '../types.js';

export type Pt = CutPt;
export type Quad = CutQuad;
/** 3×3, row-major. */
export type Mat3 = number[];

/** Solve A x = b (n×n, in place) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Homography mapping the 4 `src` points onto the 4 `dst` points. */
export function homography(src: Pt[], dst: Pt[]): Mat3 {
  // normalise for conditioning
  const norm = (pts: Pt[]) => {
    const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
    const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / 4 || 1;
    const k = Math.SQRT2 / d;
    return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
  };
  const Ts = norm(src);
  const Td = norm(dst);
  const s = src.map((p) => applyH(Ts, p[0], p[1]));
  const d = dst.map((p) => applyH(Td, p[0], p[1]));
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = s[i];
    const [u, v] = d[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  if (!h) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const Hn = [...h, 1];
  return mulH(invertH(Td), mulH(Hn, Ts));
}

export function applyH(H: Mat3, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function mulH(A: Mat3, B: Mat3): Mat3 {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
}

export function invertH(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Rotate which corner counts as top-left: +1 = the piece turns 90° clockwise. */
export function turnQuad(q: Quad, quarterTurns: number): Quad {
  const k = ((quarterTurns % 4) + 4) % 4;
  // turning the picture clockwise means the old bottom-left becomes the new top-left
  return [0, 1, 2, 3].map((i) => q[(i - k + 4) % 4]) as Quad;
}

/** An axis-aligned rectangle as a quad. */
export function rectQuad(x: number, y: number, w: number, h: number): Quad {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** The quad as an axis-aligned rectangle, or null when it isn't one (within `eps` page units). */
export function quadRect(q: Quad, eps = 1e-6): { x: number; y: number; w: number; h: number } | null {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  const ok = q.every((p) => (Math.abs(p[0] - x) < eps || Math.abs(p[0] - x - w) < eps) && (Math.abs(p[1] - y) < eps || Math.abs(p[1] - y - h) < eps));
  return ok ? { x, y, w, h } : null;
}

/** Largest distance between corresponding corners. */
export function quadDistance(a: Quad, b: Quad): number {
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Width and height of a frame as the averages of its opposite edges (exact for a rectangle). */
export function quadSize(q: Quad): { w: number; h: number } {
  return { w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 };
}

/** Bounding box. */
export function quadBounds(q: Quad): { x: number; y: number; w: number; h: number } {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    if (!sign) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

/**
 * A frame that can be cut: convex, clockwise on screen (the other way round the piece would come
 * out mirrored) and no corner squashed below 20° or above 160°. Same rule as the photo import.
 */
export function isProperQuad(q: Quad): boolean {
  if (!isConvex(q)) return false;
  const cr = (q[1][0] - q[0][0]) * (q[2][1] - q[1][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[1][0]);
  if (cr <= 0) return false;
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4];
    const c = q[i];
    const n = q[(i + 1) % 4];
    const a: Pt = [p[0] - c[0], p[1] - c[1]];
    const b: Pt = [n[0] - c[0], n[1] - c[1]];
    const la = Math.hypot(a[0], a[1]);
    const lb = Math.hypot(b[0], b[1]);
    if (la < 1e-6 || lb < 1e-6) return false;
    const deg = (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)))) * 180) / Math.PI;
    if (deg < 20 || deg > 160) return false;
  }
  return true;
}

/**
 * For a frame whose corners lie on an axis-aligned rectangle: the rectangle and how many quarter
 * turns (clockwise) the piece is turned from the page's upright, so `turnQuad(rectQuad(r), turn)`
 * is the frame. null when the frame is not an axis-aligned rectangle (within `eps`).
 */
export function axisFrame(q: Quad, eps = 1e-6): { rect: { x: number; y: number; w: number; h: number }; turn: number } | null {
  const rect = quadRect(q, eps);
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  const base = rectQuad(rect.x, rect.y, rect.w, rect.h);
  for (let k = 0; k < 4; k++) if (quadDistance(turnQuad(base, k), q) < eps * 4) return { rect, turn: k };
  return null; // a mirrored corner order
}
