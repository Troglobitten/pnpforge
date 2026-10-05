/**
 * Triangle meshes for the game pieces, built once in JS (unit size: 1 = the piece size S, z up,
 * ground contact at the origin). Outlines and lathe profiles are traced from small 2D signed distance
 * functions with marching squares, so the silhouettes are smooth and the normals exact.
 */
import type { PieceShape } from '@/shared/types';

export interface Mesh {
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
}

type F2 = (x: number, y: number) => number;
type P2 = [number, number];

/* ------------------------------------------------------------------ */
/* 2D distance functions                                                */
/* ------------------------------------------------------------------ */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function smin(a: number, b: number, k: number) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}

function sdTrap(px: number, py: number, r1: number, r2: number, he: number) {
  const k1x = r2;
  const k1y = he;
  const k2x = r2 - r1;
  const k2y = 2 * he;
  px = Math.abs(px);
  const cax = px - Math.min(px, py < 0 ? r1 : r2);
  const cay = Math.abs(py) - he;
  const t = clamp(((k1x - px) * k2x + (k1y - py) * k2y) / (k2x * k2x + k2y * k2y), 0, 1);
  const cbx = px - k1x + k2x * t;
  const cby = py - k1y + k2y * t;
  const s = cbx < 0 && cay < 0 ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}

function sdSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Rounded cylinder profile in (radius, z). */
function rcyl(q: number, z: number, R: number, z0: number, z1: number, r: number) {
  const dx = q - R + r;
  const dy = Math.abs(z - 0.5 * (z0 + z1)) - 0.5 * (z1 - z0) + r;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
}

export const meeple2: F2 = (x, y) => {
  x = Math.abs(x);
  const head = Math.hypot(x, y - 0.8) - 0.195;
  const torso = sdTrap(x, y - 0.43, 0.2, 0.14, 0.2);
  const arm = sdSeg(x, y, 0.05, 0.54, 0.405, 0.495, 0.088);
  const leg = sdSeg(x, y, 0.11, 0.33, 0.285, 0.088, 0.088);
  let d = smin(torso, arm, 0.075);
  d = smin(d, leg, 0.07);
  d = Math.max(d, -y);
  return smin(d, head, 0.055);
};

export const pawn2: F2 = (q, z) => {
  q = Math.abs(q);
  const base = rcyl(q, z, 0.5, 0, 0.17, 0.055);
  const body = sdTrap(q, z - 0.5, 0.3, 0.12, 0.36);
  const collar = rcyl(q, z, 0.235, 0.83, 0.915, 0.035);
  const head = Math.hypot(q, z - 1.115) - 0.245;
  let d = smin(base, body, 0.09);
  d = smin(d, collar, 0.035);
  return smin(d, head, 0.05);
};

/* ------------------------------------------------------------------ */
/* Contours                                                             */
/* ------------------------------------------------------------------ */

function grad(f: F2, x: number, y: number): P2 {
  const h = 1e-4;
  return [(f(x + h, y) - f(x - h, y)) / (2 * h), (f(x, y + h) - f(x, y - h)) / (2 * h)];
}

/** The longest zero-level loop of f inside the box, refined onto the surface and resampled evenly. */
function traceLoop(f: F2, x0: number, y0: number, x1: number, y1: number, step: number, count: number): P2[] {
  const nx = Math.ceil((x1 - x0) / step);
  const ny = Math.ceil((y1 - y0) / step);
  const v = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) v[j * (nx + 1) + i] = f(x0 + i * step, y0 + j * step);
  const at = (i: number, j: number) => v[j * (nx + 1) + i];
  const pts = new Map<string, P2>();
  const adj = new Map<string, string[]>();
  const edgePt = (id: string): P2 => {
    let p = pts.get(id);
    if (p) return p;
    const [k, si, sj] = id.split(':');
    const i = +si;
    const j = +sj;
    const a = at(i, j);
    const b = k === 'h' ? at(i + 1, j) : at(i, j + 1);
    const t = a / (a - b);
    p = k === 'h' ? [x0 + (i + t) * step, y0 + j * step] : [x0 + i * step, y0 + (j + t) * step];
    pts.set(id, p);
    return p;
  };
  const link = (a: string, b: string) => {
    edgePt(a);
    edgePt(b);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const A = at(i, j) < 0 ? 1 : 0;
      const B = at(i + 1, j) < 0 ? 2 : 0;
      const C = at(i + 1, j + 1) < 0 ? 4 : 0;
      const D = at(i, j + 1) < 0 ? 8 : 0;
      const c = A | B | C | D;
      if (c === 0 || c === 15) continue;
      const e0 = `h:${i}:${j}`;
      const e1 = `v:${i + 1}:${j}`;
      const e2 = `h:${i}:${j + 1}`;
      const e3 = `v:${i}:${j}`;
      const centre = (at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1)) / 4 < 0;
      switch (c) {
        case 1: case 14: link(e3, e0); break;
        case 2: case 13: link(e0, e1); break;
        case 3: case 12: link(e3, e1); break;
        case 4: case 11: link(e1, e2); break;
        case 6: case 9: link(e0, e2); break;
        case 7: case 8: link(e3, e2); break;
        case 5:
          if (centre) { link(e0, e1); link(e2, e3); } else { link(e3, e0); link(e1, e2); }
          break;
        case 10:
          if (centre) { link(e3, e0); link(e1, e2); } else { link(e0, e1); link(e2, e3); }
          break;
      }
    }
  }
  const seen = new Set<string>();
  let best: P2[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: P2[] = [];
    let prev = '';
    let cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      loop.push(pts.get(cur)!);
      const next = (adj.get(cur) ?? []).find((n) => n !== prev && !seen.has(n)) ?? '';
      prev = cur;
      cur = next;
    }
    if (loop.length > best.length) best = loop;
  }
  // resample by arc length
  const len: number[] = [0];
  for (let i = 1; i <= best.length; i++) {
    const a = best[i - 1];
    const b = best[i % best.length];
    len.push(len[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = len[len.length - 1];
  const out: P2[] = [];
  let k = 0;
  for (let n = 0; n < count; n++) {
    const s = (n / count) * total;
    while (k < best.length - 1 && len[k + 1] < s) k++;
    const a = best[k];
    const b = best[(k + 1) % best.length];
    const t = (s - len[k]) / Math.max(1e-9, len[k + 1] - len[k]);
    let p: P2 = [mix(a[0], b[0], t), mix(a[1], b[1], t)];
    for (let it = 0; it < 3; it++) {
      const g = grad(f, p[0], p[1]);
      const d = f(p[0], p[1]);
      const gg = g[0] * g[0] + g[1] * g[1] || 1;
      p = [p[0] - (d * g[0]) / gg, p[1] - (d * g[1]) / gg];
    }
    out.push(p);
  }
  return out;
}

function normalOf(f: F2, p: P2): P2 {
  const g = grad(f, p[0], p[1]);
  const l = Math.hypot(g[0], g[1]) || 1;
  return [g[0] / l, g[1] / l];
}

/* ------------------------------------------------------------------ */
/* Builders                                                             */
/* ------------------------------------------------------------------ */

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  idx: number[] = [];
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  done(): Mesh {
    return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), idx: new Uint32Array(this.idx) };
  }
}

/** Revolve a (radius, z) profile about the z axis. f is the profile's 2D distance (for normals). */
function lathe(f: F2, box: [number, number, number, number], step: number, segments: number, count = 420): Mesh {
  const loop = traceLoop(f, box[0], box[1], box[2], box[3], step, count);
  // the run of the loop on the positive side of the axis
  const n = loop.length;
  let s0 = loop.findIndex((p, i) => p[0] > 1e-4 && loop[(i - 1 + n) % n][0] <= 1e-4);
  if (s0 < 0) s0 = 0;
  const run: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = loop[(s0 + i) % n];
    if (p[0] <= 1e-4) break;
    run.push(p);
  }
  if (run[0][1] > run[run.length - 1][1]) run.reverse();
  const prof: { p: P2; n: P2 }[] = run.map((p) => ({ p, n: normalOf(f, p) }));
  prof.unshift({ p: [0, run[0][1]], n: [0, -1] });
  prof.push({ p: [0, run[run.length - 1][1]], n: [0, 1] });
  const b = new Builder();
  const rows: number[][] = [];
  for (const { p, n: nn } of prof) {
    const row: number[] = [];
    for (let k = 0; k <= segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      row.push(b.vert(p[0] * c, p[0] * s, p[1], nn[0] * c, nn[0] * s, nn[1]));
    }
    rows.push(row);
  }
  for (let i = 0; i < rows.length - 1; i++) for (let k = 0; k < segments; k++) b.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
  return b.done();
}

/**
 * Ear-clipping triangulation of a simple polygon; returns index triples into `poly`. It never gives up:
 * a traced outline has near-duplicate and near-collinear points, and an ear clipper that stopped early
 * left a hole in the meeple's cap (seen as a crease across the torso).
 */
function triangulate(poly: P2[]): number[] {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area < 0 ? -1 : 1;
  const cross = (o: P2, a: P2, b: P2) => sign * ((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]));
  // drop points that add nothing (duplicates, straight runs)
  let ids = [...Array(n).keys()];
  for (let pass = 0; pass < 3; pass++) {
    ids = ids.filter((id, i) => {
      const a = poly[ids[(i - 1 + ids.length) % ids.length]];
      const b = poly[id];
      const c = poly[ids[(i + 1) % ids.length]];
      return Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6 && Math.abs(cross(a, b, c)) > 1e-10;
    });
  }
  const out: number[] = [];
  const eps = 1e-12;
  const inside = (p: P2, a: P2, b: P2, c: P2) => cross(a, b, p) > eps && cross(b, c, p) > eps && cross(c, a, p) > eps;
  while (ids.length > 3) {
    let clipped = false;
    let bestI = -1;
    let bestScore = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const ia = ids[(i - 1 + ids.length) % ids.length];
      const ib = ids[i];
      const ic = ids[(i + 1) % ids.length];
      const a = poly[ia];
      const bb = poly[ib];
      const c = poly[ic];
      const cr = cross(a, bb, c);
      if (cr <= eps) continue;
      let blockers = 0;
      for (const j of ids) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inside(p, a, bb, c)) blockers++;
      }
      if (blockers === 0) {
        out.push(ia, ib, ic);
        ids.splice(i, 1);
        clipped = true;
        break;
      }
      if (blockers < bestScore) {
        bestScore = blockers;
        bestI = i;
      }
    }
    if (clipped) continue;
    // numerically stuck: clip the convex corner that blocks least rather than leave a hole
    const i = bestI >= 0 ? bestI : 0;
    out.push(ids[(i - 1 + ids.length) % ids.length], ids[i], ids[(i + 1) % ids.length]);
    ids.splice(i, 1);
  }
  if (ids.length === 3) out.push(ids[0], ids[1], ids[2]);
  return out;
}

/**
 * Extrude an (x, z) outline along y (±h) with rounded edges of radius r.
 * `outline` points go around the shape; `normals` point outward.
 */
function extrude(outline: P2[], normals: P2[], h: number, r: number, rings = 6): Mesh {
  const b = new Builder();
  const m = outline.length;
  // side rings: +y rounding (φ 90° -> 0°), then -y rounding (0° -> 90°)
  const phis: { phi: number; s: number }[] = [];
  for (let j = rings; j >= 0; j--) phis.push({ phi: (j / rings) * (Math.PI / 2), s: 1 });
  for (let j = 0; j <= rings; j++) phis.push({ phi: (j / rings) * (Math.PI / 2), s: -1 });
  const grid: number[][] = [];
  for (const { phi, s } of phis) {
    const row: number[] = [];
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    for (let k = 0; k <= m; k++) {
      const p = outline[k % m];
      const nn = normals[k % m];
      const off = r * (1 - c);
      row.push(b.vert(p[0] - nn[0] * off, s * (h - r + r * sn), p[1] - nn[1] * off, nn[0] * c, s * sn, nn[1] * c));
    }
    grid.push(row);
  }
  for (let i = 0; i < grid.length - 1; i++) for (let k = 0; k < m; k++) b.quad(grid[i][k], grid[i][k + 1], grid[i + 1][k + 1], grid[i + 1][k]);
  // caps
  const inner: P2[] = outline.map((p, k) => [p[0] - normals[k][0] * r, p[1] - normals[k][1] * r]);
  // triangulate the outline itself (always simple) and reuse the indices on the inset ring
  const tris = triangulate(outline);
  for (const s of [1, -1]) {
    const base = inner.map((p) => b.vert(p[0], s * h, p[1], 0, s, 0));
    for (let t = 0; t < tris.length; t += 3) b.idx.push(base[tris[t]], base[tris[t + 1]], base[tris[t + 2]]);
  }
  return b.done();
}

/** Axis-aligned rounded box, half extents hx/hy/hz, centred at (0, 0, cz). */
function roundedBox(hx: number, hy: number, hz: number, cz: number, r: number): Mesh {
  const b = new Builder();
  const half = [hx, hy, hz];
  const ticks = (h: number) => {
    const f = Math.min(0.999, r / h);
    const zone = [0, 0.12, 0.3, 0.52, 0.76, 1].map((t) => -1 + f * (1 - Math.cos((t * Math.PI) / 2)));
    const mid = [-0.5, 0, 0.5].map((t) => t * (1 - f));
    const neg = zone;
    const pos = zone.map((t) => -t).reverse();
    return [...neg, ...mid, ...pos];
  };
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3;
      const w = (axis + 2) % 3;
      const tu = ticks(half[u]);
      const tw = ticks(half[w]);
      const rows: number[][] = [];
      for (const a of tu) {
        const row: number[] = [];
        for (const c of tw) {
          const q = [0, 0, 0];
          q[axis] = sign * half[axis];
          q[u] = a * half[u];
          q[w] = c * half[w];
          const p = q.map((v, i) => clamp(v, -(half[i] - r), half[i] - r));
          const d = q.map((v, i) => v - p[i]);
          const l = Math.hypot(d[0], d[1], d[2]);
          const nn = l > 1e-9 ? d.map((v) => v / l) : [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];
          row.push(b.vert(p[0] + nn[0] * r, p[1] + nn[1] * r, p[2] + nn[2] * r + cz, nn[0], nn[1], nn[2]));
        }
        rows.push(row);
      }
      for (let i = 0; i < rows.length - 1; i++) for (let k = 0; k < rows[i].length - 1; k++) b.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
    }
  }
  return b.done();
}

/** A polygon (counter-clockwise) with every corner rounded by rc. */
function roundedPolygon(verts: P2[], rc: number, steps: number): { pts: P2[]; nrm: P2[] } {
  const pts: P2[] = [];
  const nrm: P2[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const p = verts[i];
    const a = verts[(i - 1 + n) % n];
    const c = verts[(i + 1) % n];
    const d0 = [p[0] - a[0], p[1] - a[1]];
    const d1 = [c[0] - p[0], c[1] - p[1]];
    const l0 = Math.hypot(d0[0], d0[1]);
    const l1 = Math.hypot(d1[0], d1[1]);
    // outward normals of the two edges (CCW polygon: right-hand normal)
    const n0: P2 = [d0[1] / l0, -d0[0] / l0];
    const n1: P2 = [d1[1] / l1, -d1[0] / l1];
    const a0 = Math.atan2(n0[1], n0[0]);
    let a1 = Math.atan2(n1[1], n1[0]);
    while (a1 < a0) a1 += Math.PI * 2;
    const bis = [n0[0] + n1[0], n0[1] + n1[1]];
    const bl = Math.hypot(bis[0], bis[1]);
    const cosHalf = bl / 2;
    const centre: P2 = [p[0] - (bis[0] / bl) * (rc / cosHalf), p[1] - (bis[1] / bl) * (rc / cosHalf)];
    for (let s = 0; s <= steps; s++) {
      const ang = mix(a0, a1, s / steps);
      const nn: P2 = [Math.cos(ang), Math.sin(ang)];
      pts.push([centre[0] + nn[0] * rc, centre[1] + nn[1] * rc]);
      nrm.push(nn);
    }
  }
  return { pts, nrm };
}

/* ------------------------------------------------------------------ */
/* Public                                                               */
/* ------------------------------------------------------------------ */

const cache = new Map<string, Mesh>();

/**
 * Unit mesh (S = 1) for a shape with edge rounding `round` (fraction of S). `lod` 1 is a coarse mesh
 * for the CPU fallback renderer.
 */
export function pieceMesh(shape: PieceShape, round: number, lod: 0 | 1 = 0): Mesh {
  const key = `${shape}|${round}|${lod}`;
  let m = cache.get(key);
  if (m) return m;
  const seg = lod ? 22 : 72;
  const prof = lod ? 90 : 420;
  switch (shape) {
    case 'cube':
      m = roundedBox(0.5, 0.5, 0.5, 0.5, round);
      break;
    case 'disc': {
      const r = round * 1.3;
      m = lathe((q, z) => rcyl(Math.abs(q), z, 0.5, 0, 0.36, r), [-0.6, -0.05, 0.6, 0.42], 0.004, seg, prof);
      break;
    }
    case 'pawn':
      m = lathe(pawn2, [-0.6, -0.05, 0.6, 1.42], 0.004, seg, prof);
      break;
    case 'meeple': {
      const loop = traceLoop(meeple2, -0.6, -0.05, 0.6, 1.05, 0.004, lod ? 90 : 260);
      // the edge radius stays under the tightest fillet (armpit, crotch), or the inset cap ring folds over itself
      m = extrude(loop, loop.map((p) => normalOf(meeple2, p)), 0.28, Math.min(round * 1.25, 0.045), lod ? 2 : 6);
      break;
    }
    case 'house': {
      const rc = 0.03;
      const poly = roundedPolygon(
        [
          [-0.36, 0],
          [0.36, 0],
          [0.36, 0.53],
          [0, 0.9],
          [-0.36, 0.53],
        ],
        rc,
        6,
      );
      m = extrude(poly.pts, poly.nrm, 0.5, round, lod ? 2 : 6);
      break;
    }
  }
  cache.set(key, m);
  return m;
}

/** The supply bowl (mm): outer radius R, height H, floor F, wall W. */
export function trayMesh(R: number, H: number, F: number, W: number, lod: 0 | 1 = 0): Mesh {
  const key = `tray|${R.toFixed(2)}|${H.toFixed(2)}|${F.toFixed(2)}|${W.toFixed(2)}|${lod}`;
  let m = cache.get(key);
  if (m) return m;
  const f: F2 = (q, z) => {
    q = Math.abs(q);
    const outer = rcyl(q, z, R, 0, H, Math.min(H * 0.48, W * 0.9));
    const inner = rcyl(q, z, R - W, F, H + 40, Math.min((H - F) * 1.6, R - W - 0.1));
    return -smin(-outer, inner, W * 0.35);
  };
  m = lathe(f, [-R - 0.5, -0.5, R + 0.5, H + 0.5], Math.max(0.02, R / 160), lod ? 28 : 96, lod ? 70 : 420);
  cache.set(key, m);
  return m;
}
