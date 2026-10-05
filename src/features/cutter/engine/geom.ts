/**
 * Plane geometry for photo import: homographies between a frame and a flat
 * rectangle, and the real shape of a frame.
 * Pure functions, no DOM — used by the worker and the UI alike.
 *
 * A Quad is always [TL, TR, BR, BL] in the item's upright orientation, in
 * photo pixels (after EXIF orientation).
 */
export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt];
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

/** Homography from an upright w×h rectangle (origin top-left) onto the quad. */
export function rectToQuad(w: number, h: number, q: Quad): Mat3 {
  return homography(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    q,
  );
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function centroid(p: Pt[]): Pt {
  return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
}

/** Rotate which corner counts as top-left: +1 = the item turns 90° clockwise. */
export function turnQuad(q: Quad, quarterTurns: number): Quad {
  const k = ((quarterTurns % 4) + 4) % 4;
  // turning the picture clockwise means the old bottom-left becomes the new top-left
  return [0, 1, 2, 3].map((i) => q[(i - k + 4) % 4]) as Quad;
}

function vanishingTerms(q: Quad, imgW: number, imgH: number) {
  const u0 = imgW / 2;
  const v0 = imgH / 2;
  // m1 = (0,0) TL, m2 = (w,0) TR, m3 = (0,h) BL, m4 = (w,h) BR
  const m = (p: Pt) => [p[0] - u0, p[1] - v0, 1];
  const m1 = m(q[0]);
  const m2 = m(q[1]);
  const m3 = m(q[3]);
  const m4 = m(q[2]);
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  return { n2, n3 };
}

/**
 * Focal length (px) of the camera, from the pieces in one photo: every
 * rectangle gives an estimate (Zhang & He) when it is seen at a clear angle;
 * the photo's pieces share one camera, so take the median of the good ones.
 * Falls back to a typical phone lens.
 */
export function focalFromQuads(quads: Quad[], imgW: number, imgH: number): number {
  const diag = Math.hypot(imgW, imgH);
  const fs: number[] = [];
  for (const q of quads) {
    const { n2, n3 } = vanishingTerms(q, imgW, imgH);
    const den = n2[2] * n3[2];
    // how far from straight-on the rectangle is seen; near 0 the solve is noise
    const tilt = Math.max(Math.abs(n2[2]) / Math.hypot(n2[0], n2[1]), Math.abs(n3[2]) / Math.hypot(n3[0], n3[1])) * diag;
    if (!Number.isFinite(den) || Math.abs(den) < 1e-12 || tilt < 0.08) continue;
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / den;
    if (!(f2 > 0)) continue;
    const f = Math.sqrt(f2);
    if (f > 0.35 * diag && f < 3 * diag) fs.push(f);
  }
  if (!fs.length) return 0.8 * diag;
  fs.sort((a, b) => a - b);
  return fs[fs.length >> 1];
}

/**
 * Width/height ratio of the real rectangle behind a perspective quad, with the
 * principal point at the image centre. Pass the photo's focal length
 * (focalFromQuads) for a stable answer; without it one is estimated from this
 * quad alone.
 */
export function estimateAspect(q: Quad, imgW: number, imgH: number, focal?: number): number {
  const { n2, n3 } = vanishingTerms(q, imgW, imgH);
  const plain = ((dist(q[0], q[1]) + dist(q[3], q[2])) / 2) / ((dist(q[0], q[3]) + dist(q[1], q[2])) / 2);
  const f = focal ?? focalFromQuads([q], imgW, imgH);
  const f2 = f * f;
  const a2 = (n2[0] ** 2 / f2 + n2[1] ** 2 / f2 + n2[2] ** 2) / (n3[0] ** 2 / f2 + n3[1] ** 2 / f2 + n3[2] ** 2);
  const r = Math.sqrt(a2);
  return Number.isFinite(r) && r > 0.05 && r < 20 ? r : plain;
}

/** Rotate a quad inside its own plane by `deg` around its centre (for fine rotation). */
export function rotateInPlane(q: Quad, deg: number, aspect: number): Quad {
  const w = aspect;
  const h = 1;
  const H = rectToQuad(w, h, q);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // crop window rotated the other way so the content turns by +deg
  const pt = (x: number, y: number): Pt => {
    const dx = x - w / 2;
    const dy = y - h / 2;
    return applyH(H, w / 2 + dx * c + dy * s, h / 2 - dx * s + dy * c);
  };
  return [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)];
}

/**
 * The same four points as a simple clockwise loop (on screen, y down), so a
 * frame can never cross itself. The labelling keeps as many corners as possible
 * where they were (TL stays TL unless two corners were dragged past each other).
 * `map[k]` is the new index of old corner k.
 */
export function convexOrder(q: Quad): { quad: Quad; map: number[] } {
  const c = centroid(q);
  const ang = (i: number) => Math.atan2(q[i][1] - c[1], q[i][0] - c[0]);
  const idx = [0, 1, 2, 3].sort((a, b) => ang(a) - ang(b));
  let best = idx;
  let bestKeep = -1;
  for (let r = 0; r < 4; r++) {
    const rot = [0, 1, 2, 3].map((i) => idx[(i + r) % 4]);
    const keep = rot.filter((old, i) => old === i).length;
    if (keep > bestKeep) {
      bestKeep = keep;
      best = rot;
    }
  }
  const map = [0, 0, 0, 0];
  best.forEach((old, i) => (map[old] = i));
  return { quad: best.map((i) => q[i]) as Quad, map };
}

/** All four corners bulge outwards (a shape a flat card can have in a photo). */
export function isConvex(q: Quad): boolean {
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

/** Move each edge of the frame inwards by `mm` (negative = outwards), in the piece's own plane. */
export function insetQuad(q: Quad, wMm: number, hMm: number, mm: number): Quad {
  const H = rectToQuad(wMm, hMm, q);
  return [applyH(H, mm, mm), applyH(H, wMm - mm, mm), applyH(H, wMm - mm, hMm - mm), applyH(H, mm, hMm - mm)];
}

/** Centre and the two half-axes of a round frame (the circle inside its square). */
export function ellipseOf(q: Quad): { c: Pt; u: Pt; v: Pt } {
  const H = rectToQuad(1, 1, q);
  const c = applyH(H, 0.5, 0.5);
  const r = applyH(H, 1, 0.5);
  const b = applyH(H, 0.5, 1);
  return { c, u: [r[0] - c[0], r[1] - c[1]], v: [b[0] - c[0], b[1] - c[1]] };
}

/** The square around a round frame with centre c and half-axes u (to the right) and v (down). */
export function quadOfEllipse(c: Pt, u: Pt, v: Pt): Quad {
  return [
    [c[0] - u[0] - v[0], c[1] - u[1] - v[1]],
    [c[0] + u[0] - v[0], c[1] + u[1] - v[1]],
    [c[0] + u[0] + v[0], c[1] + u[1] + v[1]],
    [c[0] - u[0] + v[0], c[1] - u[1] + v[1]],
  ];
}

/** Outline of the circle inside a frame, as seen in the photo (perspective included). */
export function ellipsePoints(q: Quad, n = 40): Pt[] {
  const H = rectToQuad(1, 1, q);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return applyH(H, 0.5 + 0.5 * Math.cos(t), 0.5 + 0.5 * Math.sin(t));
  });
}

/**
 * A frame a real flat piece can have in a photo: convex, clockwise, and no corner folded
 * nearly flat or nearly shut (between 20° and 160°). Anything else would cut
 * out a smear.
 */
export function isProperQuad(q: Quad): boolean {
  if (!isConvex(q)) return false;
  // clockwise on screen: the other way round the piece would come out mirrored
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
