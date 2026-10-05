/**
 * Game pieces: physical dimensions per shape, the classic player palette, supply heaps, and the
 * screen-space frames the renderer and the table agree on. Pure maths, no DOM.
 *
 * Frames. A piece is modelled in millimetres with z up and its ground contact at the origin, and
 * seen from above tilted VIEW_TILT toward the south (the dice's view). A point projects to
 *   u = x,   v = y·cos t + z·sin t      (v points up the screen)
 * The entity's body is a D×D square around the silhouette at yaw 0, so it does not change when the
 * piece is turned (the rendered image is re-lit instead of rotated, as dice are).
 */
import type { ID, PieceComponent, PieceEntity, PieceMaterial, PieceShape } from '@/shared/types';

export interface PieceLook {
  shape: PieceShape;
  material: PieceMaterial;
  color: string;
  /** mm */
  size: number;
  lying?: boolean;
}

export const PIECE_SHAPES: { id: PieceShape; label: string; sizeLabel: string; defaultSize: number }[] = [
  { id: 'cube', label: 'Cube', sizeLabel: 'Edge', defaultSize: 10 },
  { id: 'disc', label: 'Disc', sizeLabel: 'Diameter', defaultSize: 16 },
  { id: 'meeple', label: 'Meeple', sizeLabel: 'Width', defaultSize: 16 },
  { id: 'house', label: 'House', sizeLabel: 'Length', defaultSize: 14 },
  { id: 'pawn', label: 'Pawn', sizeLabel: 'Base diameter', defaultSize: 14 },
];

export const PIECE_MATERIALS: { id: PieceMaterial; label: string; hint: string }[] = [
  { id: 'wood', label: 'Wood', hint: 'Painted wood, matte with a soft grain' },
  { id: 'plastic', label: 'Plastic', hint: 'Glossy, saturated moulded plastic' },
  { id: 'acrylic', label: 'Acrylic', hint: 'Translucent, glass-like' },
];

/** Classic board-game player colours. */
export const PLAYER_COLORS: { name: string; hex: string }[] = [
  { name: 'Red', hex: '#c8302a' },
  { name: 'Blue', hex: '#2a5db0' },
  { name: 'Green', hex: '#2f8b47' },
  { name: 'Yellow', hex: '#f2c12e' },
  { name: 'Black', hex: '#2a292d' },
  { name: 'White', hex: '#efeae0' },
  { name: 'Orange', hex: '#e27428' },
  { name: 'Purple', hex: '#7b4ba5' },
  { name: 'Pink', hex: '#e3739f' },
  { name: 'Natural', hex: '#d9b183' },
];

export function colorName(hex: string): string | null {
  return PLAYER_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? null;
}

export function lookOf(comp: PieceComponent | undefined, e?: Pick<PieceEntity, 'color' | 'material'>): PieceLook {
  return {
    shape: comp?.shape ?? 'cube',
    material: e?.material ?? comp?.material ?? 'wood',
    color: e?.color ?? comp?.color ?? '#c8302a',
    size: comp?.size && comp.size > 0 ? comp.size : 12,
    // seen from above, a standing meeple is mostly its head and shoulders: lying down is the default
    lying: comp?.shape === 'meeple' ? comp.lying !== false : undefined,
  };
}

export const lookKey = (l: PieceLook) => `${l.shape}|${l.material}|${l.color.toLowerCase()}|${l.size}|${l.lying ? 1 : 0}`;

/* ------------------------------------------------------------------ */
/* View                                                                 */
/* ------------------------------------------------------------------ */

const TILT = (18 * Math.PI) / 180;
export const ST = Math.sin(TILT);
export const CT = Math.cos(TILT);
/** Toward the key light (north-west, high) — the dice's LIGHT. */
const LL = Math.hypot(-0.52, 0.6, 0.95);
export const LIGHT = [-0.52 / LL, 0.6 / LL, 0.95 / LL] as const;

/* ------------------------------------------------------------------ */
/* Shapes (units of the piece size S)                                   */
/* ------------------------------------------------------------------ */

/** Local bounds in S: half extents a (x), b (y), height h — and the renderer's bounding sphere. */
export const SHAPE_DIMS: Record<PieceShape, { a: number; b: number; h: number; bc: number; br: number }> = {
  cube: { a: 0.5, b: 0.5, h: 1, bc: 0.5, br: 0.9 },
  disc: { a: 0.5, b: 0.5, h: 0.36, bc: 0.18, br: 0.56 },
  meeple: { a: 0.53, b: 0.29, h: 1.03, bc: 0.5, br: 0.82 },
  house: { a: 0.38, b: 0.52, h: 0.91, bc: 0.45, br: 0.8 },
  pawn: { a: 0.5, b: 0.5, h: 1.37, bc: 0.68, br: 0.9 },
};

/** Row-major 3×3 rotation. */
type M3 = number[];
const rz = (deg: number): M3 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
const rx = (deg: number): M3 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const ry = (deg: number): M3 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
};
const mul = (a: M3, b: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
};
const apply = (m: M3, v: number[]) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/** One modelled piece in the scene: local -> world is `rot` then `pos` (mm). */
export interface Instance {
  rot: M3;
  pos: [number, number, number];
}

/** The tray a supply sits in (mm). */
export interface Tray {
  r: number;
  h: number;
  floor: number;
  wall: number;
}

export interface Scene {
  look: PieceLook;
  instances: Instance[];
  tray: Tray | null;
}

/** Heap item: position in S (z above the tray floor), yaw, then tilts about local x / y (deg). */
interface HeapItem {
  x: number;
  y: number;
  z: number;
  yaw: number;
  tx?: number;
  ty?: number;
}

/** Radius of the supply bowl in S, and a hand-piled heap that fits inside it. */
const HEAPS: Record<PieceShape, { r: number; items: HeapItem[] }> = {
  cube: {
    r: 1.5,
    items: [
      { x: -0.48, y: 0.3, z: 0, yaw: 12 },
      { x: 0.5, y: 0.28, z: 0, yaw: -20 },
      { x: 0.02, y: -0.5, z: 0, yaw: 33 },
      { x: 0.04, y: 0.18, z: 0.72, yaw: 52, tx: -14, ty: 10 },
    ],
  },
  disc: {
    r: 1.28,
    items: [
      { x: -0.36, y: 0.3, z: 0, yaw: 0 },
      { x: -0.36, y: 0.3, z: 0.36, yaw: 0 },
      { x: 0.44, y: 0.2, z: 0, yaw: 0 },
      { x: -0.02, y: -0.5, z: 0, yaw: 0 },
      { x: 0.2, y: -0.12, z: 0.36, yaw: 0, tx: 9, ty: -12 },
    ],
  },
  meeple: {
    r: 1.4,
    items: [
      { x: -0.4, y: 0.18, z: 0, yaw: 28, tx: -90 },
      { x: 0.48, y: 0.16, z: 0, yaw: -52, tx: -90 },
      { x: -0.02, y: -0.52, z: 0, yaw: 96, tx: -90 },
      { x: 0.05, y: 0.08, z: 0.5, yaw: 168, tx: -84, ty: 8 },
    ],
  },
  house: {
    r: 1.42,
    items: [
      { x: -0.42, y: 0.3, z: 0, yaw: 24 },
      { x: 0.46, y: 0.24, z: 0, yaw: -34 },
      { x: 0.0, y: -0.44, z: 0, yaw: 78 },
    ],
  },
  pawn: {
    r: 1.4,
    items: [
      { x: -0.47, y: 0.46, z: 0, yaw: 0 },
      { x: 0.47, y: 0.48, z: 0, yaw: 0 },
      { x: 0.02, y: -0.5, z: 0, yaw: 90, tx: -84 },
    ],
  },
};

/**
 * How far a standing meeple leans back for the table view. Seen from 18° a truly upright meeple is its
 * head and shoulders; leant back like this (as if against a wall) its front — head, arms, legs — faces
 * the camera and reads at a glance. Its shadow is cast from the leaning pose, so light stays honest.
 */
export const STANDING_LEAN = 55;

/**
 * Local frame of one piece: standing, a leaning-back standing meeple, or a lying meeple on its back.
 * `lift` raises it so its lowest point rests on the table. `raw` skips the pose (heaps set their own).
 */
/** Rotation by `deg` about a unit axis (row-major). */
function rotAxis(ax: readonly number[], deg: number): M3 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const [x, y, z] = ax;
  const t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

function pieceRot(look: PieceLook, yaw: number, tx = 0, ty = 0, raw = false): { rot: M3; lift: number } {
  let base: M3 = rz(0);
  const standing = look.shape === 'meeple' && !look.lying && !raw;
  if (look.shape === 'meeple' && !raw) base = rx(look.lying ? -90 : -STANDING_LEAN);
  // A house square-on shows only its roof; turned a little, its gable and pitched roof both read.
  const baseYaw = look.shape === 'house' && !raw ? 25 : 0;
  // yaw is clockwise on screen = negative about +z
  let rot = mul(rz(-(yaw + baseYaw)), mul(mul(rx(tx), ry(ty)), base));
  // A standing meeple is leant back toward the viewer, then turned about the VIEW axis, not the table's
  // vertical: its full front silhouette faces the camera at every rotation and the turn reads on screen,
  // as a lying meeple's does. (Turned about the vertical first, it showed its side or back as a blob.)
  if (standing) rot = mul(rotAxis([0, -ST, CT], -yaw), base);
  let minZ = 0;
  if (look.shape === 'meeple' && !raw) for (const c of boxCorners(look)) minZ = Math.min(minZ, apply(rot, c)[2]);
  return { rot, lift: -minZ };
}

export function buildScene(look: PieceLook, yaw: number, lift: number, supply: boolean): Scene {
  const S = look.size;
  if (!supply) {
    const { rot, lift: base } = pieceRot(look, yaw);
    // Turn about the middle of the body, not its ground origin (a lying meeple's origin is its feet):
    // the art then stays on the entity's centre — and its hit area — at every rotation.
    const c = apply(rot, [0, 0, SHAPE_DIMS[look.shape].bc * S]);
    return { look, instances: [{ rot, pos: [-c[0], -c[1], base + lift] }], tray: null };
  }
  const heap = HEAPS[look.shape];
  const tray: Tray = { r: heap.r * S, h: Math.max(2.4, 0.34 * S), floor: Math.max(1, 0.09 * S), wall: Math.max(1.2, 0.12 * S) };
  const turn = rz(-yaw);
  const instances = heap.items.map((it) => {
    const r = pieceRot(look, 0, it.tx ?? 0, it.ty ?? 0, true);
    let z = it.z * S;
    // a piece on its back rests on its thickness
    if (look.shape === 'meeple' && Math.abs((it.tx ?? 0) + 90) < 20) z += SHAPE_DIMS.meeple.b * S;
    if (look.shape === 'pawn' && it.tx) z += 0.26 * S;
    const p = apply(turn, [it.x * S, it.y * S, 0]);
    return { rot: mul(turn, mul(rz(-it.yaw), r.rot)), pos: [p[0], p[1], tray.floor + z + lift] as [number, number, number] };
  });
  return { look, instances, tray };
}

/* ------------------------------------------------------------------ */
/* Screen windows                                                       */
/* ------------------------------------------------------------------ */

/** Screen-space rectangle in mm around the origin (v up). */
export interface Win {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

function boxCorners(look: PieceLook): number[][] {
  const d = SHAPE_DIMS[look.shape];
  const S = look.size;
  const out: number[][] = [];
  for (const x of [-d.a, d.a]) for (const y of [-d.b, d.b]) for (const z of [0, d.h]) out.push([x * S, y * S, z * S]);
  return out;
}

function worldPoints(scene: Scene): number[][] {
  const pts: number[][] = [];
  const local = boxCorners(scene.look);
  for (const inst of scene.instances) {
    for (const c of local) {
      const w = apply(inst.rot, c);
      pts.push([w[0] + inst.pos[0], w[1] + inst.pos[1], w[2] + inst.pos[2]]);
    }
  }
  if (scene.tray) {
    const t = scene.tray;
    for (const [x, y] of [
      [-t.r, -t.r],
      [t.r, -t.r],
      [-t.r, t.r],
      [t.r, t.r],
    ])
      for (const z of [0, t.h]) pts.push([x, y, z]);
  }
  return pts;
}

/** The silhouette's screen window (no shadow). */
export function silhouetteWin(scene: Scene): Win {
  const w: Win = { u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity };
  for (const p of worldPoints(scene)) {
    const u = p[0];
    const v = p[1] * CT + p[2] * ST;
    w.u0 = Math.min(w.u0, u);
    w.u1 = Math.max(w.u1, u);
    w.v0 = Math.min(w.v0, v);
    w.v1 = Math.max(w.v1, v);
  }
  return w;
}

/** What the renderer draws: the silhouette plus the soft shadow it casts down-right. */
export function renderWin(scene: Scene): Win {
  const w = silhouetteWin(scene);
  const S = scene.look.size;
  let maxZ = 0;
  for (const p of worldPoints(scene)) {
    maxZ = Math.max(maxZ, p[2]);
    const gx = p[0] - (LIGHT[0] / LIGHT[2]) * p[2];
    const gy = p[1] - (LIGHT[1] / LIGHT[2]) * p[2];
    w.u0 = Math.min(w.u0, gx);
    w.u1 = Math.max(w.u1, gx);
    w.v0 = Math.min(w.v0, gy * CT);
    w.v1 = Math.max(w.v1, gy * CT);
  }
  // penumbra and contact occlusion spill past the geometric shadow
  const m = 0.14 * S + 0.22 * maxZ + 0.6;
  return { u0: w.u0 - m, v0: w.v0 - m, u1: w.u1 + m, v1: w.v1 + m };
}

export interface PieceFrame {
  /** Body square edge (mm). */
  D: number;
  /** Centre of the body square in the piece's screen coordinates (mm, v up). */
  uc: number;
  vc: number;
}

const frameCache = new Map<string, PieceFrame>();

/** The body square around the piece (or its supply bowl) at rest, yaw 0. */
export function pieceFrame(look: PieceLook, supply: boolean): PieceFrame {
  const key = `${lookKey(look)}|${supply ? 1 : 0}`;
  let f = frameCache.get(key);
  if (!f) {
    const w = silhouetteWin(buildScene(look, 0, 0, supply));
    const D = Math.max(w.u1 - w.u0, w.v1 - w.v0) * (supply ? 1 : 1.02);
    f = { D, uc: (w.u0 + w.u1) / 2, vc: (w.v0 + w.v1) / 2 };
    frameCache.set(key, f);
  }
  return f;
}

/** Body size (mm) for geometry / hit tests, without building anything heavier than needed. */
export function pieceSize(look: PieceLook, supply: boolean): number {
  return pieceFrame(look, supply).D;
}

/** How high a carried piece is held (mm). */
export const liftFor = (look: PieceLook) => Math.max(4, look.size * 0.5);

export type { ID };
