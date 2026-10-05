/**
 * <DieView> — a polyhedral die drawn as a shaded, chamfered solid.
 *
 * Why this approach and not WebGL: a table holds dozens of dice, each tiny, inside a CSS-transformed
 * world. At rest a die is vector SVG — sharp at every camera zoom and free to keep on screen (static
 * nodes, no GL context, no dependency). The solid is real geometry (see geometry.ts); a frame is an
 * orthographic projection, back-face culling (the solids are convex, so no depth sort), Lambert
 * shading in the body colour, and an affine matrix per face that lays the number/label/image on it.
 *
 * While it tumbles, the same frame is drawn into a small <canvas> instead. Chrome re-lays out SVG
 * text whenever its transform changes, so animating SVG prints cost ~0.5 s of layout for a 30-dice
 * roll; canvas has no layout at all. When the die lands it switches back to vector.
 *
 * Cost control:
 * - React builds the static SVG tree once (memoised; a ball's big result print is its own group);
 *   `paintSvg()` rewrites only attributes whose value changed.
 * - All tumbling dice share one rAF ticker. Hop, travel and shadow are CSS transforms every frame;
 *   at most `geoCap` dice redraw their facets per frame (round robin), and `geoCap` adapts to late
 *   frames. Durations are jittered so a handful of dice never all land on the same frame.
 */
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { DieFace, ID } from '@/shared/types';
import { IDENTITY, LIGHT, VIEW_DIR, VIEW_TILT, VIEW_UP, axisAngle, cross, dieModel, dot, lighting, mulMM, mulMV, norm, rotAxis, rotZ, transpose, type DieModel, type LabelFrame, type M3, type ShapeKind, type V3 } from './geometry';
import './dice.css';

export interface DieLook {
  color: string;
  inkColor: string;
  faces: DieFace[];
}

export const DEFAULT_FACES: DieFace[] = [1, 2, 3, 4, 5, 6].map((value) => ({ value }));

export function dieFaceText(f: DieFace | undefined, index: number): string {
  return f?.label?.trim() || String(f?.value ?? index + 1);
}

const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Half the on-screen extent of each solid, as a share of the nominal size. */
const SCALE: Record<ShapeKind, number> = { coin: 1.0, d4: 1.16, cube: 1.0, d8: 1.08, trap: 1.1, d12: 1.08, d20: 1.1, ball: 1.0 };
/** Label space is 100 units per model unit (keeps SVG font sizes sane). Facets use it too. */
const U = 100;
/** A ball's result plateau: a fixed share of its radius, whatever the face count. */
const BALL_TOP_R = 0.5;
/**
 * Prints fade in with how squarely their face turns to the viewer (1 = straight on). Below LO a
 * print would be a foreshortened sliver — a scratch, not a number — so it is not drawn at all;
 * side faces stay visibly quieter than the result face on top.
 */
const PRINT_LO = 0.36;
const PRINT_HI = 0.92;
/** A d4 is read on its side faces, near the top corner. */
const CORNER_HI = 0.55;

/* ------------------------------------------------------------------ */
/* Colour                                                               */
/* ------------------------------------------------------------------ */

type RGB = [number, number, number];

function parseColor(c: string | undefined, fb: RGB): RGB {
  const s = (c ?? '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16)) as RGB;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as RGB;
  const r = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  if (r) return [Number(r[1]), Number(r[2]), Number(r[3])];
  return fb;
}

const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const rgb = (c: RGB) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

/** Lit body colour. Light bodies get a higher floor (a white die is never dirty grey); dark ones a little more sheen. */
function shadeRGB(base: RGB, k: number, spec: number): RGB {
  const l = lum(base);
  const kk = k + Math.max(0, 1 - k) * 0.34 * l;
  const add = 255 * spec * (0.55 + 0.45 * (1 - l));
  return [Math.min(255, base[0] * kk + add), Math.min(255, base[1] * kk + add), Math.min(255, base[2] * kk + add)];
}
const shade = (base: RGB, k: number, spec: number) => rgb(shadeRGB(base, k, spec));
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------------------------------------------ */
/* Text fitting                                                         */
/* ------------------------------------------------------------------ */

let measureCtx: CanvasRenderingContext2D | null | undefined;
let fontFamily: string | null = null;
const widthCache = new Map<string, number>();
if (typeof document !== 'undefined') void document.fonts?.ready.then(() => widthCache.clear());

function printFont(): string {
  if (fontFamily == null) fontFamily = (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()) || 'system-ui, sans-serif';
  return fontFamily;
}

/** Advance width of `text` in em, in the print font. */
function textEm(text: string): number {
  const hit = widthCache.get(text);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  let w: number;
  const L = [...text].length;
  if (measureCtx) {
    measureCtx.font = `760 100px ${printFont()}`;
    w = measureCtx.measureText(text).width / 100;
  } else w = 0.64 * L;
  widthCache.set(text, w);
  return w;
}

/** Half the cap height of digits/capitals, in em. */
const HALF_CAP = 0.37;
/**
 * Both renderers set text on the alphabetic baseline, dropped by half the print font's cap height,
 * with no letter-spacing: SVG "central" and canvas "middle" baselines, and their letter-spacing,
 * are not computed identically, and the landed SVG must match the last canvas frame exactly.
 */
const BASE_DROP = 0.364;
const LINE = 1.02;

/** Does a text box (half extents, model units) sit on the flat face with a margin? */
function boxFits(hw: number, hh: number, lab: LabelFrame, r: number): boolean {
  if (!lab.clip || lab.corner) return Math.hypot(hw, hh) <= r * 0.9;
  const P = lab.clip;
  const margin = lab.r * 0.12;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    const nx = b[1] - a[1];
    const ny = a[0] - b[0];
    const l = Math.hypot(nx, ny) || 1;
    const side = Math.sign(-a[0] * nx - a[1] * ny) || 1;
    for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      if ((((cx - a[0]) * nx + (cy - a[1]) * ny) / l) * side < margin) return false;
    }
  }
  return true;
}

/** Largest font size (model units) at which `lines` fit the face. */
function fitFont(lines: string[], lab: LabelFrame, r: number, cap: number): number {
  const w = Math.max(...lines.map(textEm));
  const extra = (lines.length - 1) * LINE * 0.5;
  let lo = 0;
  let hi = cap;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (boxFits((w * mid) / 2, (HALF_CAP + extra) * mid, lab, r)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/* ------------------------------------------------------------------ */
/* Prints: one layout, drawn as SVG at rest and on canvas in motion      */
/* ------------------------------------------------------------------ */

const PIPS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

type PrintSpec =
  | { kind: 'image'; url: string; x: number; y: number; w: number; h: number; clip: [number, number][] | null; clipR: number }
  | { kind: 'pips'; dots: [number, number, number][] }
  | { kind: 'text'; lines: string[]; fs: number; mark: boolean };

/** Everything in label units (U per model unit), centred on the face. */
function printSpec(model: DieModel, lab: LabelFrame, r: number, face: DieFace | undefined, index: number, url: string | undefined): PrintSpec {
  const R = r * U;
  if (url) {
    const onFace = lab.clip && !lab.corner && model.shape !== 'ball';
    let x = -R * 1.08;
    let y = -R * 1.08;
    let w = R * 2.16;
    let h = R * 2.16;
    if (onFace && model.shape === 'cube') {
      const xs = lab.clip!.map((p) => p[0] * U);
      const ys = lab.clip!.map((p) => p[1] * U);
      x = Math.min(...xs);
      y = Math.min(...ys);
      w = Math.max(...xs) - x;
      h = Math.max(...ys) - y;
    }
    return { kind: 'image', url, x, y, w, h, clip: onFace ? lab.clip!.map((p) => [p[0] * U, p[1] * U] as [number, number]) : null, clipR: R * (model.shape === 'ball' ? 1 : 1.08) };
  }
  const v = face?.value;
  if (model.pips && !face?.label?.trim() && v != null && PIPS[v]) {
    const g = R * 0.56;
    const pr = R * (v === 1 ? 0.3 : 0.2);
    return { kind: 'pips', dots: PIPS[v].map(([a, b]) => [a * g, b * g, pr]) };
  }
  const text = dieFaceText(face, index);
  const cap = r * (lab.corner ? 1.6 : 1.5);
  let lines = [text];
  let fs = fitFont(lines, lab, r, cap);
  // last resort for a long label on a small face: two lines at the space nearest the middle
  const spaces = [...text.matchAll(/ /g)].map((m) => m.index!);
  if (spaces.length && fs < r * 0.6) {
    const sp = spaces.sort((a, b) => Math.abs(a - text.length / 2) - Math.abs(b - text.length / 2))[0];
    const two = [text.slice(0, sp), text.slice(sp + 1)];
    const fs2 = fitFont(two, lab, r, cap);
    if (fs2 > fs) {
      lines = two;
      fs = fs2;
    }
  }
  return { kind: 'text', lines, fs: fs * U, mark: !lab.corner && model.slots >= 8 && (text === '6' || text === '9') };
}

const lineY = (spec: { lines: string[]; fs: number; mark: boolean }, i: number) => (i - (spec.lines.length - 1) / 2) * LINE * spec.fs - (spec.mark ? spec.fs * 0.06 : 0);

function PrintSvg({ spec, clipId }: { spec: PrintSpec; clipId: string }) {
  switch (spec.kind) {
    case 'image':
      return <image href={spec.url} x={spec.x} y={spec.y} width={spec.w} height={spec.h} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />;
    case 'pips':
      return (
        <>
          {spec.dots.map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} />
          ))}
        </>
      );
    case 'text':
      return (
        <>
          {spec.lines.map((ln, i) => (
            <text key={i} className="die3d__num" fontSize={spec.fs} y={lineY(spec, i) + BASE_DROP * spec.fs} textAnchor="middle">
              {ln}
            </text>
          ))}
          {spec.mark && <rect x={-spec.fs * 0.26} y={spec.fs * 0.42} width={spec.fs * 0.52} height={spec.fs * 0.075} rx={spec.fs * 0.03} />}
        </>
      );
  }
}

function clipFor(spec: PrintSpec, id: string): ReactNode {
  if (spec.kind !== 'image') return null;
  return (
    <clipPath key={id} id={id}>
      {spec.clip ? <polygon points={spec.clip.map((p) => `${f2(p[0])},${f2(p[1])}`).join(' ')} /> : <circle r={spec.clipR} />}
    </clipPath>
  );
}

const images = new Map<string, HTMLImageElement>();
function imageFor(url: string): HTMLImageElement {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = url;
    images.set(url, img);
  }
  return img;
}

function drawSpec(ctx: CanvasRenderingContext2D, spec: PrintSpec) {
  if (spec.kind === 'image') {
    const img = imageFor(spec.url);
    if (!img.complete || !img.naturalWidth) return;
    ctx.save();
    ctx.beginPath();
    if (spec.clip) spec.clip.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    else ctx.arc(0, 0, spec.clipR, 0, Math.PI * 2);
    ctx.clip();
    const sc = Math.max(spec.w / img.naturalWidth, spec.h / img.naturalHeight);
    const sw = spec.w / sc;
    const sh = spec.h / sc;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, spec.x, spec.y, spec.w, spec.h);
    ctx.restore();
  } else if (spec.kind === 'pips') {
    for (const [cx, cy, r] of spec.dots) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    ctx.font = `760 ${spec.fs}px ${printFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fontKerning = 'normal';
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
    spec.lines.forEach((ln, i) => ctx.fillText(ln, 0, lineY(spec, i) + BASE_DROP * spec.fs));
    if (spec.mark) ctx.fillRect(-spec.fs * 0.26, spec.fs * 0.42, spec.fs * 0.52, spec.fs * 0.075);
  }
}

/* ------------------------------------------------------------------ */
/* Shared animation ticker                                              */
/* ------------------------------------------------------------------ */

interface Anim {
  /** Layout reads, once, before any die writes this frame. */
  prepare?(): void;
  /** Advance to `now`; redraw facets only when `geo`. Return false when finished. */
  step(now: number, geo: boolean): boolean;
}

const anims = new Set<Anim>();
let tickRaf = 0;
let lastTick = 0;
let frameMs = 16.7;
let geoCap = 16;
let rr = 0;
/**
 * Dice that may swap back from canvas to SVG this frame. The swap re-lays out that die's SVG
 * prints (~2-3 ms each); thirty landing in one frame was a 60 ms hitch. The rest keep showing
 * their final pose on canvas and swap on the next frames — invisible, the picture is identical.
 */
let settleBudget = 3;
/**
 * Dice that may take over from their SVG onto the canvas this frame. A die's first canvas frame
 * is its most expensive (bitmap + glyph work); thirty starting together made the first frame of a
 * cold roll ~60 ms. The others keep showing their resting SVG for a frame or two before lift-off.
 */
let startBudget = 8;
const takeStart = () => (startBudget > 0 ? (startBudget--, true) : false);
const takeSettle = () => (settleBudget > 0 ? (settleBudget--, true) : false);

function tick(now: number) {
  settleBudget = 3;
  startBudget = 8;
  if (lastTick) {
    const dt = now - lastTick;
    frameMs = Math.min(frameMs * 1.02, dt); // the display's frame length, give or take
    if (dt > frameMs * 1.6 + 2) geoCap = Math.max(3, Math.floor(geoCap * 0.7));
    else if (dt < frameMs * 1.25) geoCap = Math.min(64, geoCap + 1);
  }
  lastTick = now;
  const list = [...anims];
  const n = list.length;
  for (const a of list) {
    if (a.prepare) {
      a.prepare();
      a.prepare = undefined;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = list[(rr + i) % n];
    if (!a.step(now, i < geoCap)) anims.delete(a);
  }
  rr = n ? (rr + Math.min(geoCap, n)) % n : 0;
  if (anims.size) tickRaf = requestAnimationFrame(tick);
  else {
    tickRaf = 0;
    lastTick = 0;
  }
}

function startAnim(a: Anim) {
  anims.add(a);
  if (!tickRaf) tickRaf = requestAnimationFrame(tick);
}

/* Idle warm-up queue: canvases are sized and drawn once off-screen before anyone rolls, a few
   dice per idle slice, never while dice are moving. */
const warmQueue: (() => void)[] = [];
let warmScheduled = false;
const onIdle = (cb: () => void) => {
  const ric = (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(cb, { timeout: 3000 });
  else window.setTimeout(cb, 300);
};
function drainWarm() {
  warmScheduled = false;
  const t0 = performance.now();
  while (warmQueue.length && !anims.size && performance.now() - t0 < 4) warmQueue.shift()!();
  if (warmQueue.length) {
    warmScheduled = true;
    onIdle(drainWarm);
  }
}
function queueWarm(fn: () => void) {
  warmQueue.push(fn);
  if (!warmScheduled) {
    warmScheduled = true;
    onIdle(drainWarm);
  }
}

/* ------------------------------------------------------------------ */
/* DieView                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  look: DieLook;
  /** Face index shown on top. */
  face: number;
  /** Nominal size in px (the table's hit box edge). */
  size: number;
  /** Degrees clockwise, as the entity's rotation. */
  yaw?: number;
  /** Changing it tumbles the die into `face`. */
  rollSeq?: number;
  /** Where the die sits (px, a screen-aligned frame) — a roll travels in from the previous spot. */
  x?: number;
  y?: number;
  /** Carried in the hand: raised with a wider, softer shadow. */
  lifted?: boolean;
  /** Table selection: the ring is drawn here so it travels with the die through a roll. */
  selected?: boolean;
  /** A throw: the roll numbered `seq` flies in from where the die left the hand (same frame as x/y). */
  launch?: { seq: number; x: number; y: number };
  resolve:(id: ID | null | undefined) => string | undefined;
  className?: string;
  style?: CSSProperties;
}

interface Written {
  vis: (boolean | undefined)[];
  pts: string[];
  fill: string[];
  lvis: Map<number, boolean>;
  ltf: Map<number, string>;
  lop: Map<number, string>;
  lfill: Map<number, string>;
  plate: Map<number, string>;
}
const fresh = (): Written => ({ vis: [], pts: [], fill: [], lvis: new Map(), ltf: new Map(), lop: new Map(), lfill: new Map(), plate: new Map() });

/** Label key for the ball's big result print (ordinary prints use their index). */
const TOP = -1;

export const DieView = memo(function DieView({ look, face, size, yaw = 0, rollSeq = 0, x, y, lifted, selected, launch, resolve, className, style }: Props) {
  const faces = look.faces.length ? look.faces : DEFAULT_FACES;
  const n = faces.length;
  const model = dieModel(n);
  const ball = model.shape === 'ball';
  const cur = Math.max(0, Math.min(n - 1, Math.round(face) || 0));
  const P = ((size / 2) * SCALE[model.shape]) / model.extent;
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const body = parseColor(look.color, [241, 235, 221]);
  const ink = parseColor(look.inkColor, [42, 36, 28]);
  const bodyKey = rgb(body);
  const inkKey = rgb(ink);
  const faceCount = useMemo(() => model.polys.filter((p) => p.kind === 0).length, [model]);

  const rootEl = useRef<HTMLDivElement>(null);
  const polyEls = useRef<(SVGPolygonElement | null)[]>([]);
  const labelEls = useRef<(SVGGElement | null)[]>([]);
  const plateEls = useRef<(SVGCircleElement | null)[]>([]);
  const topEl = useRef<SVGGElement>(null);
  const topPlateEl = useRef<SVGCircleElement>(null);
  const svgEl = useRef<SVGSVGElement>(null);
  const canvasEl = useRef<HTMLCanvasElement>(null);
  const bodyEl = useRef<HTMLDivElement>(null);
  const vecEl = useRef<HTMLDivElement>(null);
  const shadowEl = useRef<HTMLDivElement>(null);
  const shown = useRef<M3 | null>(null);
  const anim = useRef<Anim | null>(null);
  const anchorRef = useRef(-1);
  const ringEl = useRef<HTMLDivElement>(null);
  const seenSeq = useRef(rollSeq);
  const prevPos = useRef<{ x: number; y: number } | undefined>(x == null || y == null ? undefined : { x, y });

  const yawRad = (-yaw * Math.PI) / 180;
  const target = useMemo(() => mulMM(rotZ(yawRad), model.rest[cur % model.slots] ?? IDENTITY), [model, cur, yawRad]);
  const rise = model.lift * Math.sin(VIEW_TILT) * P; // where the table is under the centre, on screen
  const baseY = -rise * 0.5;
  const liftH = lifted ? 0.34 : 0;
  const ballTop = ball ? cur : -1;
  const s = P / U; // label units → px

  // Static tree: rebuilt only when the die itself changes — never on a roll, a set face or a move.
  const tree = useMemo(() => {
    const clips: ReactNode[] = [];
    const specs: PrintSpec[] = [];
    const prints = model.labels.map((lab, i) => {
      const fi = lab.slot % n;
      const spec = printSpec(model, lab, lab.r, faces[fi], fi, resolve(faces[fi]?.image));
      specs.push(spec);
      clips.push(clipFor(spec, `c${uid}_${i}`));
      return (
        <g key={i} ref={(el) => void (labelEls.current[i] = el)}>
          {ball && <circle ref={(el) => void (plateEls.current[i] = el)} r={lab.r * U * 1.02} stroke="rgba(0,0,0,0.14)" strokeWidth={lab.r * 6} />}
          <PrintSvg spec={spec} clipId={`c${uid}_${i}`} />
        </g>
      );
    });
    return {
      clips,
      specs,
      body: (
        <>
          {ball && <circle r={U} fill={`url(#b${uid})`} />}
          {model.polys.map((_, i) => (
            <polygon key={i} ref={(el) => void (polyEls.current[i] = el)} strokeWidth={0.7} strokeLinejoin="round" />
          ))}
          {prints}
        </>
      ),
    };
  }, [model, faces, n, uid, resolve, ball]);

  // A ball's result, printed big on a plateau of fixed size: one small group, re-rendered alone.
  const topPrint = useMemo(() => {
    if (ballTop < 0) return null;
    const lab = model.labels[ballTop];
    const fi = lab.slot % n;
    const spec = printSpec(model, lab, BALL_TOP_R, faces[fi], fi, resolve(faces[fi]?.image));
    return {
      spec,
      clip: clipFor(spec, `t${uid}`),
      g: (
        <g ref={topEl}>
          <circle ref={topPlateEl} r={BALL_TOP_R * U * 1.02} stroke="rgba(0,0,0,0.14)" strokeWidth={BALL_TOP_R * 6} />
          <PrintSvg spec={spec} clipId={`t${uid}`} />
        </g>
      ),
    };
  }, [model, faces, n, uid, resolve, ballTop]);
  const written = useMemo(fresh, [tree, topPrint]); // new DOM may carry nothing yet

  const raster = useRef<{ ctx: CanvasRenderingContext2D; px: number } | null>(null);
  /* ---- hop / travel / shadow: CSS transforms, every frame ---- */
  const motion = (ox: number, oy: number, h: number) => {
    // While tumbling only the canvas moves. Chrome sizes SVG text by its on-screen scale, so a
    // changing scale on any ancestor of the <svg> (or on the svg itself) re-lays out every print,
    // every frame. The hidden vector copy stays put; it takes a transform only when static (lifted).
    const tf = ox || oy || h ? `translate(${f2(ox)}px, ${f2(oy - h * P * 0.85)}px) scale(${f2(1 + h * 0.2)})` : '';
    const moving = raster.current ? canvasEl.current : vecEl.current;
    const other = raster.current ? vecEl.current : canvasEl.current;
    if (moving && moving.style.transform !== tf) moving.style.transform = tf;
    if (!raster.current && other && other.style.transform) other.style.transform = '';
    const ring = ringEl.current;
    if (ring) {
      // translate first (screen space), then turn with the die: the separate CSS rotate property
      // would apply before transform and swing the travel offset round by the die's yaw
      const rt = `${ox || oy || h ? `translate(${f2(ox)}px, ${f2(oy - h * P * 0.85)}px) ` : ''}rotate(${f2(yaw)}deg)`;
      if (ring.style.transform !== rt) ring.style.transform = rt;
    }
    const sh = shadowEl.current;
    if (sh) {
      sh.style.transform = ox || oy || h ? `translate(${f2(ox + h * P * 0.55)}px, ${f2(oy + h * P * 0.75)}px) scale(${f2(1 + h * 0.3)})` : '';
      sh.style.opacity = h ? f2(1 - h * 0.55) : '';
    }
  };

  /* ---- one frame of the solid: to SVG attributes (rest) or onto a canvas (motion) ---- */
  const frame = (M: M3, ctx: CanvasRenderingContext2D | null, lock = false) => {
    const w = written;
    const proj = model.pts.map((v) => {
      const q = mulMV(M, v);
      return [q[0] * U, -dot(q, VIEW_UP) * U] as const;
    });
    if (ctx) {
      if (ball) {
        const g = ctx.createRadialGradient(((LIGHT[0] * 0.5 + 0.5) * 0.55 - 0.275) * 2 * U, ((-dot(LIGHT, VIEW_UP) * 0.5 + 0.5) * 0.55 - 0.275) * 2 * U, 0, 0, 0, U);
        g.addColorStop(0, shade(body, 1.08, 0.5));
        g.addColorStop(0.45, shade(body, 0.95, 0));
        g.addColorStop(0.85, shade(body, 0.66, 0));
        g.addColorStop(1, shade(body, 0.5, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, U, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.lineJoin = 'round';
    }
    if (model.polys.length) {
      const faceK: number[] = [];
      for (let i = 0; i < faceCount; i++) faceK.push(lighting(mulMV(M, model.polys[i].n)).k);
      model.polys.forEach((poly, i) => {
        const nw = mulMV(M, poly.n);
        const vis = dot(nw, VIEW_DIR) > 0.001;
        const el = ctx ? null : polyEls.current[i];
        if (el && w.vis[i] !== vis) {
          el.style.visibility = vis ? '' : 'hidden';
          w.vis[i] = vis;
        }
        if (!vis) return;
        let fill: string;
        if (poly.kind === 0) {
          const { k, spec } = lighting(nw);
          fill = shade(body, k, Math.min(1, spec) * 0.2);
        } else {
          // A chamfer is shaded from the faces it joins — a touch lighter, like a worn rounded edge —
          // with a small capped glint. Lit on its own normal it caught the full highlight and drew as
          // a white stripe across the die.
          const fs = poly.faces ?? [];
          const avg = fs.length ? fs.reduce((sum, f) => sum + faceK[f], 0) / fs.length : lighting(nw).k;
          fill = shade(body, avg * 1.03 + 0.02, Math.min(0.5, lighting(nw).spec) * 0.12);
        }
        if (ctx) {
          ctx.beginPath();
          poly.idx.forEach((k, j) => (j ? ctx.lineTo(proj[k][0], proj[k][1]) : ctx.moveTo(proj[k][0], proj[k][1])));
          ctx.closePath();
          ctx.fillStyle = fill;
          ctx.strokeStyle = fill;
          ctx.fill();
          ctx.stroke();
          return;
        }
        if (!el) return;
        const pts = poly.idx.map((k) => `${f2(proj[k][0])},${f2(proj[k][1])}`).join(' ');
        if (w.pts[i] !== pts) {
          el.setAttribute('points', pts);
          w.pts[i] = pts;
        }
        if (w.fill[i] !== fill) {
          el.setAttribute('fill', fill);
          el.setAttribute('stroke', fill);
          w.fill[i] = fill;
        }
      });
    }
    const top = ballTop >= 0 ? model.labels[ballTop] : null;
    const print = (key: number, lab: LabelFrame, spec: PrintSpec | undefined, el: SVGGElement | null, plate: SVGCircleElement | null, plateR: number, covered: boolean) => {
      const nw = mulMV(M, lab.n);
      const vd = dot(nw, VIEW_DIR);
      const hi = lab.corner ? CORNER_HI : PRINT_HI;
      const vis = !covered && vd >= PRINT_LO;
      if (el && !ctx && w.lvis.get(key) !== vis) {
        el.style.visibility = vis ? '' : 'hidden';
        w.lvis.set(key, vis);
      }
      if (!vis) return;
      const Rv = mulMV(M, lab.right);
      const Uv = mulMV(M, lab.up);
      const C = mulMV(M, lab.c);
      const a = Rv[0];
      const b = -dot(Rv, VIEW_UP);
      const c = -Uv[0];
      const d = dot(Uv, VIEW_UP);
      const e = C[0] * U;
      const f = -dot(C, VIEW_UP) * U;
      const t0 = clamp01((vd - PRINT_LO) / (hi - PRINT_LO));
      // Only the result leads: the print facing the viewer most squarely (a d4: those at the top
      // corner). Every other print is held back, so a neighbour never reads as a second result.
      // a ball's big result print always leads (its covered neighbours can face the view a hair more squarely)
      const lead = top ? key === TOP : lock ? lab.slot === cur : (lab.corner ? C[2] : vd) >= leadMin;
      // held-back prints stay readable on dark bodies (gold on black was near invisible)
      const dim = lum(body) < 0.3;
      const t = lead ? t0 : Math.min(t0, dim ? 0.6 : 0.3);
      const s0 = t0 * t0 * (3 - 2 * t0);
      const op = lead ? s0 : Math.min(dim ? 0.8 : 0.55, s0);
      const { k, spec: sp } = lighting(nw);
      const faceRGB = shadeRGB(body, k, 0);
      const kk = Math.min(1.08, 0.5 + 0.5 * k);
      const inkLit: RGB = [Math.min(255, ink[0] * kk + 40 * sp), Math.min(255, ink[1] * kk + 40 * sp), Math.min(255, ink[2] * kk + 40 * sp)];
      // side prints lean toward the body colour, so the face on top is the one that reads
      const fill = rgb(mix(faceRGB, inkLit, 0.45 + 0.55 * t));
      const plateFill = plateR ? shade(body, k * 1.03, sp * 0.3) : '';
      if (ctx) {
        if (op < 0.01 || !spec) return;
        ctx.save();
        ctx.transform(a, b, c, d, e, f);
        ctx.globalAlpha = op;
        if (plateR) {
          ctx.beginPath();
          ctx.arc(0, 0, plateR * U * 1.02, 0, Math.PI * 2);
          ctx.fillStyle = plateFill;
          ctx.fill();
          ctx.lineWidth = plateR * 6;
          ctx.strokeStyle = 'rgba(0,0,0,0.14)';
          ctx.stroke();
        }
        ctx.fillStyle = fill;
        drawSpec(ctx, spec);
        ctx.restore();
        return;
      }
      if (!el) return;
      const tf = `matrix(${a.toFixed(4)} ${b.toFixed(4)} ${c.toFixed(4)} ${d.toFixed(4)} ${f2(e)} ${f2(f)})`;
      if (w.ltf.get(key) !== tf) {
        el.setAttribute('transform', tf);
        w.ltf.set(key, tf);
      }
      const ops = f2(op);
      if (w.lop.get(key) !== ops) {
        el.setAttribute('opacity', ops);
        w.lop.set(key, ops);
      }
      if (w.lfill.get(key) !== fill) {
        el.setAttribute('fill', fill);
        w.lfill.set(key, fill);
      }
      if (plate && w.plate.get(key) !== plateFill) {
        plate.setAttribute('fill', plateFill);
        w.plate.set(key, plateFill);
      }
    };
    // Which print reads as the result. Locked to the result itself while landing, setting a face
    // and at rest (it is known). While tumbling, the squarest face (a d4: the highest corner)
    // leads, with hysteresis so the emphasis never strobes between neighbours.
    const metricOf = (lab: LabelFrame) => (lab.corner ? mulMV(M, lab.c)[2] : dot(mulMV(M, lab.n), VIEW_DIR));
    let leadMin = Infinity;
    if (lock || top) anchorRef.current = -1;
    else {
      let best = -1;
      let bestM = -Infinity;
      model.labels.forEach((lab, i) => {
        if (dot(mulMV(M, lab.n), VIEW_DIR) < PRINT_LO) return;
        const m = metricOf(lab);
        if (m > bestM) {
          bestM = m;
          best = i;
        }
      });
      let anchor = best;
      const prev = anchorRef.current;
      const pl = prev >= 0 ? model.labels[prev] : undefined;
      if (pl && dot(mulMV(M, pl.n), VIEW_DIR) >= PRINT_LO && metricOf(pl) >= bestM - (pl.corner ? 0.12 : 0.08)) anchor = prev;
      anchorRef.current = anchor;
      if (anchor >= 0) leadMin = metricOf(model.labels[anchor]) - (model.labels[anchor].corner ? 0.08 : 0.03);
    }
    model.labels.forEach((lab, i) => {
      // on a ball, the enlarged result plateau covers its own small print and its neighbours
      const covered = !!top && Math.sqrt(Math.max(0, 2 - 2 * dot(lab.n, top.n))) < BALL_TOP_R + lab.r * 1.05;
      print(i, lab, tree.specs[i], labelEls.current[i], plateEls.current[i], ball ? lab.r : 0, covered);
    });
    if (top && topPrint) print(TOP, top, topPrint.spec, topEl.current, topPlateEl.current, BALL_TOP_R, false);
  };

  /* ---- canvas while moving ---- */
  const beginRaster = () => {
    const cv = canvasEl.current;
    const root = rootEl.current;
    if (!cv || !root) return;
    // screen px per die px (camera zoom, DPR); the die's frame is screen-aligned
    const box = root.getBoundingClientRect();
    let px = Math.max(0.5, Math.min(4, ((box.width || size) / size) * (window.devicePixelRatio || 1)));
    // Reuse the idle-warmed bitmap when it is close enough: a camera change since warm-up must not
    // turn the first roll back into thirty bitmap allocations in one frame (a little over- or
    // under-resolution for the 0.8 s of motion is invisible).
    const warmedPx = cv.width ? cv.width / (size * 2) : 0;
    if (warmedPx && px / warmedPx > 0.7 && px / warmedPx < 1.45) px = warmedPx;
    raster.current = { ctx: null as unknown as CanvasRenderingContext2D, px };
  };
  const showRaster = () => {
    const cv = canvasEl.current;
    const r = raster.current;
    if (!cv || !r) return null;
    if (!r.ctx) {
      const side = Math.ceil(size * 2 * r.px);
      if (cv.width !== side) cv.width = side;
      if (cv.height !== side) cv.height = side;
      const ctx = cv.getContext('2d');
      if (!ctx) return null;
      r.ctx = ctx;
      // Hide the vector copy on its plain wrapper div: any style change on the <svg> root itself
      // (even opacity) makes Chrome re-lay out every print inside it.
      if (vecEl.current) {
        vecEl.current.style.opacity = '0';
        if (vecEl.current.style.transform) vecEl.current.style.transform = '';
      }
    }
    return r.ctx;
  };
  const drawRaster = (M: M3, lock = false) => {
    const ctx = showRaster();
    const r = raster.current;
    if (!ctx || !r) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const k = r.px * s;
    ctx.setTransform(k, 0, 0, k, size * r.px, (size + baseY) * r.px);
    ctx.lineWidth = 0.8 / k;
    frame(M, ctx, lock);
  };
  /**
   * Size the canvas bitmap and draw one frame into it, then clear it in the same task (never
   * shown). Without this the first roll after load paid thirty bitmap allocations and a cold glyph
   * cache in its first frame (~70 ms).
   */
  const warm = () => {
    const cv = canvasEl.current;
    const root = rootEl.current;
    if (!cv || !root || raster.current) return;
    const box = root.getBoundingClientRect();
    if (!box.width) return;
    let px = Math.max(0.5, Math.min(4, (box.width / size) * (window.devicePixelRatio || 1)));
    const side = Math.ceil(size * 2 * px);
    if (Math.abs(cv.width - side) > side * 0.3) {
      cv.width = side;
      cv.height = side;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const k = (cv.width / (size * 2)) * s;
    px = cv.width / (size * 2);
    ctx.setTransform(k, 0, 0, k, size * px, (size + baseY) * px);
    ctx.lineWidth = 0.8 / k;
    frame(shown.current ?? target, ctx, true);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
  };
  const endRaster = () => {
    const r = raster.current;
    if (!r) return;
    raster.current = null;
    // The canvas stays in layout (never display-toggled, which re-adds it); just empty it.
    if (r.ctx) {
      r.ctx.setTransform(1, 0, 0, 1, 0, 0);
      r.ctx.clearRect(0, 0, r.ctx.canvas.width, r.ctx.canvas.height);
    }
    if (vecEl.current) vecEl.current.style.opacity = '';
  };

  const live = useRef({ frame, motion, beginRaster, drawRaster, endRaster, warm });
  live.current = { frame, motion, beginRaster, drawRaster, endRaster, warm };

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let alive = true;
    queueWarm(() => {
      if (alive) live.current.warm();
    });
    return () => {
      alive = false;
    };
  }, [tree, P]);

  useLayoutEffect(() => {
    const from = shown.current;
    const rolled = rollSeq !== seenSeq.current;
    seenSeq.current = rollSeq;
    if (anim.current) anims.delete(anim.current);
    anim.current = null;
    const L = live.current;
    const settle = () => {
      shown.current = target;
      live.current.frame(target, null, true);
      live.current.endRaster();
      live.current.motion(0, 0, liftH);
    };
    if (!from || prefersReducedMotion()) return settle();

    let a: Anim;
    if (rolled) {
      // Travel in from where it left the hand (a throw), else from where it was (a nudge), else
      // from a random side.
      const thrown = launch && launch.seq === rollSeq && x != null && y != null ? launch : null;
      const pp = thrown ?? prevPos.current;
      let dx = pp && x != null ? pp.x - x : 0;
      let dy = pp && y != null ? pp.y - y : 0;
      let dist = Math.hypot(dx, dy);
      if (dist < P * 0.2) {
        const ang = Math.random() * Math.PI * 2;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        dist = 1;
      }
      const mag = thrown && dist > 1 ? Math.max(P * 1.2, dist) : Math.min(P * 2.4, Math.max(P * 1.2, dist));
      const sx = (dx / dist) * mag;
      const sy = (dy / dist) * mag;
      if (thrown && !raster.current) {
        // Until its turn to lift off (a few dice start per frame) the die waits in the hand, not
        // at its landing spot. A translate only: a scale here would re-lay out its prints.
        const tf = `translate(${f2(sx)}px, ${f2(sy - P * 0.85)}px)`;
        if (vecEl.current) vecEl.current.style.transform = tf;
        if (ringEl.current) ringEl.current.style.transform = `${tf} rotate(${f2(yaw)}deg)`;
        if (shadowEl.current) shadowEl.current.style.transform = `translate(${f2(sx + P * 0.55)}px, ${f2(sy + P * 0.75)}px)`;
      }
      // rolling axis: z × travel direction (world y is up, screen y is down)
      const travel: V3 = norm([-sx, sy, 0]);
      const base = cross([0, 0, 1], travel);
      const axis = norm([base[0] + (Math.random() - 0.5) * 0.5, base[1] + (Math.random() - 0.5) * 0.5, base[2]]);
      const spin = (1.7 + Math.random() * 0.9) * Math.PI * 2;
      const dur = 720 + Math.random() * 140;
      const land = 0.68;
      let t0 = performance.now();
      let started = false;
      let landed = false;
      a = {
        prepare: () => live.current.beginRaster(),
        step(now, geo) {
          if (!started) {
            if (!takeStart()) {
              t0 = now;
              return true;
            }
            started = true;
            t0 = now;
          }
          const t = Math.min(1, (now - t0) / dur);
          if (t >= 1) {
            if (!raster.current?.ctx) {
              settle();
              return false;
            }
            if (!landed) {
              // The canvas first shows the exact rest pose (a capped frame may have been a few
              // frames old); the SVG takes over on a later frame, under an identical picture.
              landed = true;
              shown.current = target;
              live.current.motion(0, 0, liftH);
              live.current.drawRaster(target, true);
              return true;
            }
            if (takeSettle()) {
              settle();
              return false;
            }
            return true;
          }
          let h = 0;
          if (t < 0.3) h = 1 - (t / 0.3) ** 2;
          else if (t < 0.52) {
            const u = (t - 0.3) / 0.22;
            h = 0.34 * 4 * u * (1 - u);
          } else if (t < 0.66) {
            const u = (t - 0.52) / 0.14;
            h = 0.1 * 4 * u * (1 - u);
          }
          const e = 1 - (1 - Math.min(1, t / 0.8)) ** 3;
          live.current.motion(sx * (1 - e), sy * (1 - e), liftH + h * (1 - liftH));
          if (geo || !raster.current?.ctx) {
            let ang = spin * (1 - Math.min(1, t / land)) ** 2.3;
            if (t > land) {
              const u = (t - land) / (1 - land);
              ang += 0.16 * (1 - u) ** 2 * Math.sin(u * Math.PI * 2.2);
            }
            const M = ang ? mulMM(rotAxis(axis, ang), target) : target;
            shown.current = M;
            // from touchdown on, the result (known) is the print that leads
            live.current.drawRaster(M, t >= land);
          }
          return true;
        },
      };
      // the die lifts off on the first tick, when the canvas takes over
    } else {
      const { axis, angle } = axisAngle(mulMM(target, transpose(from)));
      if (angle < 0.002) return settle();
      // set a face / turn: tip over onto it with a small hop
      const dur = 180 + 150 * (angle / Math.PI);
      const t0 = performance.now();
      let landed = false;
      a = {
        prepare: () => live.current.beginRaster(),
        step(now, geo) {
          const t = Math.min(1, (now - t0) / dur);
          if (t >= 1) {
            if (!raster.current?.ctx) {
              settle();
              return false;
            }
            if (!landed) {
              // The canvas first shows the exact rest pose (a capped frame may have been a few
              // frames old); the SVG takes over on a later frame, under an identical picture.
              landed = true;
              shown.current = target;
              live.current.motion(0, 0, liftH);
              live.current.drawRaster(target, true);
              return true;
            }
            if (takeSettle()) {
              settle();
              return false;
            }
            return true;
          }
          live.current.motion(0, 0, liftH + Math.sin(Math.PI * t) * 0.14 * Math.min(1, angle));
          if (geo || !raster.current?.ctx) {
            const ez = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
            const M = mulMM(rotAxis(axis, -angle * (1 - ez)), target);
            shown.current = M;
            live.current.drawRaster(M, true);
          }
          return true;
        },
      };
    }
    anim.current = a;
    startAnim(a);
  }, [target, rollSeq, P, bodyKey, inkKey, liftH, tree, topPrint]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    prevPos.current = x == null || y == null ? undefined : { x, y };
  }, [x, y]);

  useEffect(
    () => () => {
      if (anim.current) anims.delete(anim.current);
    },
    [],
  );

  // soft contact shadow, down-right of the solid (light comes from the upper left)
  const sw = model.extent * P * 2 * (ball ? 0.95 : 1.02);
  const sy0 = rise * 0.5 + P * 0.1;
  const lightSX = LIGHT[0] * 0.5 + 0.5;
  const lightSY = -dot(LIGHT, VIEW_UP) * 0.5 + 0.5;

  return (
    <div ref={rootEl} className={`die3d ${className ?? ''}`} style={{ width: size, height: size, ...style }}>
      <div ref={shadowEl} className="die3d__shadow" style={{ width: sw, height: sw * 0.86, marginLeft: -sw / 2 + P * 0.1, marginTop: -sw * 0.43 + sy0 }} />
      <div ref={bodyEl} className="die3d__body">
      <canvas ref={canvasEl} className="die3d__canvas" width={0} height={0} style={{ width: size * 2, height: size * 2, marginLeft: -size, marginTop: -size }} aria-hidden />
      <div ref={vecEl} className="die3d__vec">
      <svg ref={svgEl} className="die3d__svg" width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} aria-hidden>
        <defs>
          {ball && (
            <radialGradient id={`b${uid}`} cx="0.5" cy="0.5" r="0.5" fx={lightSX * 0.55 + 0.225} fy={lightSY * 0.55 + 0.225}>
              <stop offset="0" stopColor={shade(body, 1.08, 0.5)} />
              <stop offset="0.45" stopColor={shade(body, 0.95, 0)} />
              <stop offset="0.85" stopColor={shade(body, 0.66, 0)} />
              <stop offset="1" stopColor={shade(body, 0.5, 0)} />
            </radialGradient>
          )}
          {tree.clips}
          {topPrint?.clip}
        </defs>
        {/* label space: 1 unit = 1/U model unit; one scale for the whole solid */}
        <g transform={`translate(0 ${f2(baseY)}) scale(${s.toFixed(5)})`}>
          {tree.body}
          {topPrint?.g}
        </g>
      </svg>
      </div>
      </div>
      {selected != null && <div ref={ringEl} className={`die3d__ring ${selected ? 'is-on' : ''}`} style={{ transform: `rotate(${f2(yaw)}deg)` }} aria-hidden />}
    </div>
  );
});
