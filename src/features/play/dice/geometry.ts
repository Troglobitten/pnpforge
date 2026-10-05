/**
 * Die geometry — pure maths, no DOM.
 *
 * Every die is a real convex solid: faces come from the convex hull of a vertex set, then the
 * edges and corners are chamfered (each face inset toward its centre, edge strips and corner
 * polygons fill the gaps) so it catches light like a tumbled plastic die. A `DieModel` knows,
 * for each result slot, which rotation turns that result toward the viewer and where its
 * number/label/image is printed.
 *
 * World axes: x right, y north (screen up), z up out of the table. The view is orthographic,
 * tilted VIEW_TILT toward the south so the die reads as a solid seen from above at a slight angle.
 */

export type V3 = [number, number, number];
/** Row-major 3×3. */
export type M3 = [number, number, number, number, number, number, number, number, number];

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMV(m: M3, v: V3): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function mulMM(a: M3, b: M3): M3 {
  const r = new Array(9) as M3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function transpose(m: M3): M3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Right-handed rotation of `ang` radians about a unit axis (Rodrigues). */
export function rotAxis(axis: V3, ang: number): M3 {
  const [x, y, z] = norm(axis);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

export const rotZ = (ang: number) => rotAxis([0, 0, 1], ang);

/** Axis/angle of a rotation matrix (angle in [0, π]). */
export function axisAngle(m: M3): { axis: V3; angle: number } {
  const cos = Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2));
  const angle = Math.acos(cos);
  if (angle < 1e-5) return { axis: [0, 0, 1], angle: 0 };
  if (Math.PI - angle > 1e-3) {
    return { axis: norm([m[7] - m[5], m[2] - m[6], m[3] - m[1]]), angle };
  }
  // ~180°: axis from the symmetric part
  const xx = Math.sqrt(Math.max(0, (m[0] + 1) / 2));
  const yy = Math.sqrt(Math.max(0, (m[4] + 1) / 2));
  const zz = Math.sqrt(Math.max(0, (m[8] + 1) / 2));
  let axis: V3;
  if (xx >= yy && xx >= zz) axis = [xx, (m[1] + m[3]) / (4 * xx), (m[2] + m[6]) / (4 * xx)];
  else if (yy >= zz) axis = [(m[1] + m[3]) / (4 * yy), yy, (m[5] + m[7]) / (4 * yy)];
  else axis = [(m[2] + m[6]) / (4 * zz), (m[5] + m[7]) / (4 * zz), zz];
  return { axis: norm(axis), angle };
}

/** Rotation taking unit vector `u` onto +z. */
function toTop(u: V3): M3 {
  const axis = cross(u, [0, 0, 1]);
  const s = len(axis);
  if (s < 1e-9) return u[2] > 0 ? IDENTITY : rotAxis([1, 0, 0], Math.PI);
  return rotAxis(axis, Math.atan2(s, u[2]));
}

/* ------------------------------------------------------------------ */
/* View & light                                                         */
/* ------------------------------------------------------------------ */

export const VIEW_TILT = (18 * Math.PI) / 180;
/** Toward the viewer. */
export const VIEW_DIR: V3 = [0, -Math.sin(VIEW_TILT), Math.cos(VIEW_TILT)];
/** Screen-up in world space. */
export const VIEW_UP: V3 = [0, Math.cos(VIEW_TILT), Math.sin(VIEW_TILT)];
/** Key light from the upper left (north-west, high). */
export const LIGHT: V3 = norm([-0.52, 0.6, 0.95]);
const HALF = norm(add(LIGHT, VIEW_DIR));

/** Brightness multiplier (≈1 on a face turned to the light) and a specular term 0..1. */
export function lighting(n: V3): { k: number; spec: number } {
  const diff = Math.max(0, dot(n, LIGHT));
  const k = 0.44 + 0.12 * n[2] + 0.46 * diff + 0.05 * Math.max(0, dot(n, VIEW_DIR));
  const spec = Math.pow(Math.max(0, dot(n, HALF)), 48);
  return { k, spec };
}

/* ------------------------------------------------------------------ */
/* Model                                                                */
/* ------------------------------------------------------------------ */

export interface MeshPoly {
  idx: number[];
  n: V3;
  /** 0 face · 1 edge chamfer · 2 corner chamfer */
  kind: 0 | 1 | 2;
  /** Chamfers: the faces (poly indices) they join — they are shaded from those, never on their own. */
  faces?: number[];
}

export interface LabelFrame {
  /** Result slot printed here (face index = slot % faceCount). */
  slot: number;
  c: V3;
  up: V3;
  right: V3;
  n: V3;
  /** Room for the print: inradius of the face (model units). */
  r: number;
  /** Face outline in label space (x right, y down), for clipping images. */
  clip: [number, number][] | null;
  /** d4: printed near a corner, reads toward that corner. */
  corner?: boolean;
}

export type ShapeKind = 'coin' | 'd4' | 'cube' | 'd8' | 'trap' | 'd12' | 'd20' | 'ball';

export interface DieModel {
  key: string;
  shape: ShapeKind;
  /** Result slots on the solid (≥ face count; a d3 is a cube numbered 1–3 twice). */
  slots: number;
  pts: V3[];
  polys: MeshPoly[];
  labels: LabelFrame[];
  /** Per slot: the orientation that shows that result on top, printed upright. */
  rest: M3[];
  /** Half of the on-screen extent at rest (model units). */
  extent: number;
  /** Centre height above the table at rest (model units). */
  lift: number;
  /** Pips on a standard d6. */
  pips: boolean;
}

const PHI = (1 + Math.sqrt(5)) / 2;

function hullFaces(V: V3[]): { idx: number[]; n: V3 }[] {
  const out = new Map<string, { idx: number[]; n: V3 }>();
  const N = V.length;
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      for (let k = j + 1; k < N; k++) {
        let n = cross(sub(V[j], V[i]), sub(V[k], V[i]));
        const l = len(n);
        if (l < 1e-9) continue;
        n = mul(n, 1 / l);
        const d = dot(n, V[i]);
        let pos = false;
        let neg = false;
        const on: number[] = [];
        for (let m = 0; m < N; m++) {
          const s = dot(n, V[m]) - d;
          if (s > 1e-6) pos = true;
          else if (s < -1e-6) neg = true;
          else on.push(m);
          if (pos && neg) break;
        }
        if (pos && neg) continue;
        if (pos) n = mul(n, -1);
        const key = on.join(',');
        if (!out.has(key)) out.set(key, { idx: on, n });
      }
  return [...out.values()].map(({ idx, n }) => ({ idx: sortLoop(V, idx, n), n }));
}

function centroid(P: V3[]): V3 {
  let c: V3 = [0, 0, 0];
  for (const p of P) c = add(c, p);
  return mul(c, 1 / P.length);
}

/** Order points counter-clockwise around `n`. */
function sortLoop(V: V3[], idx: number[], n: V3): number[] {
  const c = centroid(idx.map((i) => V[i]));
  const e1 = norm(sub(V[idx[0]], c));
  const e2 = cross(n, e1);
  return [...idx].sort((a, b) => {
    const pa = sub(V[a], c);
    const pb = sub(V[b], c);
    return Math.atan2(dot(pa, e2), dot(pa, e1)) - Math.atan2(dot(pb, e2), dot(pb, e1));
  });
}

function outwardNormal(P: V3[]): V3 {
  // Newell
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  n = norm(n);
  return dot(n, centroid(P)) < 0 ? mul(n, -1) : n;
}

interface Solid {
  pts: V3[];
  polys: MeshPoly[];
  /** For each hull face: its inset outline (point indices), centre and normal. */
  faces: { loop: number[]; verts: number[]; c: V3; n: V3 }[];
}

/** Chamfer a convex solid: inset faces, edge strips, corner polygons. */
function chamfer(V: V3[], bevel: number): Solid {
  const hull = hullFaces(V);
  const pts: V3[] = [];
  const at = new Map<string, number>();
  const polys: MeshPoly[] = [];
  const faces: Solid['faces'] = [];
  hull.forEach((f, fi) => {
    const c = centroid(f.idx.map((i) => V[i]));
    const rf = f.idx.reduce((s, i) => s + len(sub(V[i], c)), 0) / f.idx.length;
    const t = Math.min(0.4, bevel / rf);
    const loop = f.idx.map((v) => {
      at.set(`${fi}:${v}`, pts.length);
      pts.push(add(V[v], mul(sub(c, V[v]), t)));
      return pts.length - 1;
    });
    faces.push({ loop, verts: f.idx, c, n: f.n });
    polys.push({ idx: loop, n: f.n, kind: 0 });
  });
  if (bevel > 0) {
    const seen = new Set<string>();
    hull.forEach((f, fi) => {
      for (let i = 0; i < f.idx.length; i++) {
        const a = f.idx[i];
        const b = f.idx[(i + 1) % f.idx.length];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const gi = hull.findIndex((g, k) => k !== fi && g.idx.includes(a) && g.idx.includes(b));
        if (gi < 0) continue;
        const idx = [at.get(`${fi}:${a}`)!, at.get(`${fi}:${b}`)!, at.get(`${gi}:${b}`)!, at.get(`${gi}:${a}`)!];
        polys.push({ idx, n: outwardNormal(idx.map((p) => pts[p])), kind: 1, faces: [fi, gi] });
      }
    });
    V.forEach((v, vi) => {
      const touching = hull.map((f, fi) => (f.idx.includes(vi) ? fi : -1)).filter((fi) => fi >= 0);
      const around = touching.map((fi) => at.get(`${fi}:${vi}`)!);
      if (around.length < 3) return;
      const n = norm(v);
      const idx = sortLoop(pts, around, n);
      polys.push({ idx, n: outwardNormal(idx.map((p) => pts[p])), kind: 2, faces: touching });
    });
  }
  return { pts, polys, faces };
}

function normalize(V: V3[]): V3[] {
  const r = Math.max(...V.map(len));
  return V.map((v) => mul(v, 1 / r));
}

function signs(v: number[]): number[][] {
  return v.reduce<number[][]>((acc, x) => acc.flatMap((p) => (x === 0 ? [[...p, 0]] : [[...p, x], [...p, -x]])), [[]]);
}

const TETRA: V3[] = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
];
const CUBE = signs([1, 1, 1]) as V3[];
const OCTA: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const ICOSA = [...signs([0, 1, PHI]), ...signs([1, PHI, 0]), ...signs([PHI, 0, 1])] as V3[];
const DODECA = [...signs([1, 1, 1]), ...signs([0, 1 / PHI, PHI]), ...signs([1 / PHI, PHI, 0]), ...signs([PHI, 0, 1 / PHI])] as V3[];

/** Pentagonal (m = 5) and wider trapezohedra: two apexes and two staggered rings of kites. */
function trapezohedron(m: number): V3[] {
  const c = Math.cos(Math.PI / m);
  const h = 1;
  const z = (h * (1 - c)) / (1 + c);
  const V: V3[] = [
    [0, 0, h],
    [0, 0, -h],
  ];
  for (let k = 0; k < m; k++) {
    const a = (2 * Math.PI * k) / m;
    const b = a + Math.PI / m;
    V.push([Math.cos(a), Math.sin(a), z], [Math.cos(b), Math.sin(b), -z]);
  }
  return V;
}

function prism(k: number, halfThick: number): V3[] {
  const V: V3[] = [];
  for (let i = 0; i < k; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / k;
    V.push([Math.cos(a), Math.sin(a), halfThick], [Math.cos(a), Math.sin(a), -halfThick]);
  }
  return V;
}

function inradius(clip: [number, number][]): number {
  let r = Infinity;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const l = Math.hypot(ex, ey) || 1;
    r = Math.min(r, Math.abs(a[0] * ey - a[1] * ex) / l);
  }
  return r;
}

function planeUp(n: V3): V3 {
  let up = sub([0, 1, 0], mul(n, n[1]));
  if (len(up) < 0.35) up = sub([0, 0, 1], mul(n, n[2]));
  return norm(up);
}

/** Frame printed at the centre of a face. */
function faceFrame(solid: Solid, fi: number, slot: number): LabelFrame {
  const f = solid.faces[fi];
  const up = planeUp(f.n);
  const right = cross(up, f.n);
  const clip = f.loop.map((p) => {
    const d = sub(solid.pts[p], f.c);
    return [dot(d, right), -dot(d, up)] as [number, number];
  });
  return { slot, c: f.c, up, right, n: f.n, r: inradius(clip), clip };
}

/** Pair each face with the one opposite so opposite results add up (1+6, 1+20 …). */
function pairSlots(normals: V3[]): number[] {
  const S = normals.length;
  const order = normals.map((_, i) => i).sort((a, b) => normals[b][2] - normals[a][2] || Math.atan2(normals[a][1], normals[a][0]) - Math.atan2(normals[b][1], normals[b][0]));
  const slot = new Array<number>(S).fill(-1);
  let lo = 0;
  let hi = S - 1;
  for (const i of order) {
    if (slot[i] >= 0) continue;
    let opp = -1;
    let best = -0.999;
    for (let j = 0; j < S; j++) {
      if (j === i || slot[j] >= 0) continue;
      const d = dot(normals[i], normals[j]);
      if (d < best) {
        best = d;
        opp = j;
      }
    }
    slot[i] = lo++;
    if (opp >= 0 && hi >= lo) slot[opp] = hi--;
  }
  return slot;
}

function restFor(up: V3, labelUp: V3): M3 {
  const R = toTop(up);
  const u = mulMV(R, labelUp);
  const yaw = Math.PI / 2 - Math.atan2(u[1], u[0]);
  return mulMM(rotZ(yaw), R);
}

function finish(key: string, shape: ShapeKind, slots: number, solid: Pick<Solid, 'pts' | 'polys'>, labels: LabelFrame[], ups: V3[], pips = false): DieModel {
  const rest = ups.map((u, s) => {
    const lab = labels.find((l) => l.slot === s)!;
    return restFor(u, lab.corner ? norm(sub(lab.up, mul(u, dot(lab.up, u)))) : lab.up);
  });
  let extent = 0;
  let low = 0;
  for (const p of solid.pts) {
    const q = mulMV(rest[0], p);
    extent = Math.max(extent, Math.abs(q[0]), Math.abs(dot(q, VIEW_UP)));
    low = Math.min(low, q[2]);
  }
  return { key, shape, slots, pts: solid.pts, polys: solid.polys, labels, rest, extent: shape === 'ball' ? 1 : extent, lift: shape === 'ball' ? 1 : -low, pips };
}

function faceDie(key: string, shape: ShapeKind, V: V3[], bevel: number, labelled?: (n: V3) => boolean, pips = false): DieModel {
  const solid = chamfer(normalize(V), bevel);
  const faceIds = solid.faces.map((_, i) => i).filter((i) => !labelled || labelled(solid.faces[i].n));
  const slotOf = pairSlots(faceIds.map((i) => solid.faces[i].n));
  const labels = faceIds.map((fi, k) => faceFrame(solid, fi, slotOf[k]));
  const ups: V3[] = [];
  labels.forEach((l) => (ups[l.slot] = l.n));
  return finish(key, shape, labels.length, solid, labels, ups, pips);
}

function d4(): DieModel {
  const V = normalize(TETRA);
  const solid = chamfer(V, 0.1);
  const labels: LabelFrame[] = [];
  solid.faces.forEach((f) => {
    const clip = f.loop.map((p) => {
      const up = planeUp(f.n);
      const right = cross(up, f.n);
      const d = sub(solid.pts[p], f.c);
      return [dot(d, right), -dot(d, up)] as [number, number];
    });
    const rin = inradius(clip);
    for (const v of f.verts) {
      const dir = sub(V[v], f.c);
      const up = norm(dir);
      labels.push({ slot: v, c: add(f.c, mul(dir, 0.47)), up, right: cross(up, f.n), n: f.n, r: rin * 0.64, clip: null, corner: true });
    }
  });
  return finish('d4', 'd4', 4, solid, labels, V.map(norm));
}

/** A d100 / any big count: a ball with a flat plateau per result (a Zocchihedron, roughly). */
function ball(n: number): DieModel {
  const labels: LabelFrame[] = [];
  const ups: V3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rho = 2 / Math.sqrt(n);
  for (let i = 0; i < n; i++) {
    const zz = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - zz * zz);
    const th = i * golden;
    const p: V3 = [rad * Math.cos(th), rad * Math.sin(th), zz];
    const up = planeUp(p);
    labels.push({ slot: i, c: mul(p, 1 - rho * rho * 0.06), up, right: cross(up, p), n: p, r: rho * 0.5, clip: null });
    ups.push(p);
  }
  return finish(`ball${n}`, 'ball', n, { pts: [], polys: [] }, labels, ups);
}

const cache = new Map<number, DieModel>();

/** The solid used for a die with `n` faces. */
export function dieModel(faceCount: number): DieModel {
  const n = Math.max(2, Math.round(faceCount) || 6);
  let m = cache.get(n);
  if (m) return m;
  if (n === 2) m = faceDie('coin', 'coin', prism(28, 0.13), 0.035, (v) => Math.abs(v[2]) > 0.9);
  else if (n === 3 || n === 6) m = faceDie('cube', 'cube', CUBE, 0.13, undefined, n === 6);
  else if (n === 4) m = d4();
  else if (n === 8) m = faceDie('d8', 'd8', OCTA, 0.085);
  else if (n === 12) m = faceDie('d12', 'd12', DODECA, 0.075);
  else if (n === 20) m = faceDie('d20', 'd20', ICOSA, 0.065);
  else if (n === 10) m = faceDie('trap5', 'trap', trapezohedron(5), 0.06);
  // d5 / d7: a d10 / d14 numbered twice, as the real ones are
  else if (n === 5 || n === 7) m = faceDie(`trap${n}`, 'trap', trapezohedron(n), 0.06);
  // Everything else (d9, d11, d13–d19, d21+): a ball with a plateau per result. Trapezohedra past
  // seven kites turn into spindles whose kites are too narrow to print on; a ball keeps every
  // number round and upright, and its result plateau reads at any zoom.
  else m = ball(n);
  cache.set(n, m);
  return m;
}
