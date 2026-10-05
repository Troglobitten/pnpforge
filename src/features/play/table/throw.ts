/**
 * Where thrown dice come to rest. Pure maths (mm), no DOM.
 *
 * A throw is one gesture: the handful leaves the hand together, loses its arrangement in the air
 * and lands as a loose, organic cluster around a point along the throw direction — never a row or
 * a grid. Landing spots are solved BEFORE any animation starts, so each tumble already knows where
 * it ends: no die lands on another (thrown or resting), dice keep off cards / tokens / notes when
 * there is room, and every die stays inside `area` (the visible table, clear of the chrome).
 */
import type { Entity, Game, ID, TableState, ZoneEntity } from '@/shared/types';
import { clamp, inZone, isEndless, stateBounds, zoneLocal, zoneTakes, zoneWorld, type Rect, type Vec } from '../engine';

/* ------------------------------------------------------------------ */
/* Release → throw (input-independent)                                  */
/* ------------------------------------------------------------------ */

/** px/ms at which a throw counts as "flung" (a deliberate flick is 1–20 px/ms). */
export const FLING_SPEED = 1;
/** A fling only counts if the pointer was still moving this recently on release. */
export const FLING_FRESH_MS = 120;
/**
 * A short thumb flick straight from the pick-up is gentler than a throw at the end of a carry:
 * when the whole carry lasted at most QUICK_CARRY_MS, this lower release speed already throws.
 */
export const QUICK_FLING_SPEED = 0.55;
export const QUICK_CARRY_MS = 450;

export interface Sample {
  x: number;
  y: number;
  t: number;
}
export interface ReleaseVelocity {
  vx: number;
  vy: number;
  speed: number;
  quick: boolean;
  /** Where the flick that threw it began (the first sample of the speed window, client px). */
  from?: Sample;
}

/**
 * How fast the pointer was travelling as it let go (screen px/ms), from the input samples of the
 * last stretch of real movement. Mouse and touch go through exactly this.
 */
/** The time window (ms, ending at the last movement) release speed is fitted over. */
export const RELEASE_WINDOW_MS = 70;

/**
 * Release speed as a least-squares line through position over TIME for every sample in the last
 * RELEASE_WINDOW_MS of movement (at least two samples: when events are sparse the window reaches back to the
 * previous one). Time-based, not "the last N events", so a mouse delivering a move every 30 ms and a finger every
 * 8 ms read the same motion as the same speed, and one late or doubled event barely moves the result.
 */
export function releaseVelocity(pts: Sample[], up: { t: number }): ReleaseVelocity {
  const none = { vx: 0, vy: 0, speed: 0, quick: false };
  const last = pts[pts.length - 1];
  if (!last) return none;
  const sinceLast = up.t - last.t;
  if (sinceLast > FLING_FRESH_MS) return none;
  let i0 = pts.length - 1;
  while (i0 > 0 && (pts[i0 - 1].t >= last.t - RELEASE_WINDOW_MS || pts.length - i0 < 2)) i0--;
  const win = pts.slice(i0);
  let vx = 0;
  let vy = 0;
  if (win.length >= 2) {
    const tm = win.reduce((a, p) => a + p.t, 0) / win.length;
    const xm = win.reduce((a, p) => a + p.x, 0) / win.length;
    const ym = win.reduce((a, p) => a + p.y, 0) / win.length;
    let stt = 0;
    let stx = 0;
    let sty = 0;
    for (const p of win) {
      stt += (p.t - tm) ** 2;
      stx += (p.t - tm) * (p.x - xm);
      sty += (p.t - tm) * (p.y - ym);
    }
    // two samples in the same millisecond carry no timing: treat them as 8 ms apart
    const denom = Math.max(stt, 32 * (win.length - 1));
    vx = stx / denom;
    vy = sty / denom;
  }
  // holding still before letting go (beyond a normal release gap) is a put-down, not a throw
  const k = 60 / (60 + Math.max(0, sinceLast - 60));
  vx *= k;
  vy *= k;
  const quick = last.t - pts[0].t <= QUICK_CARRY_MS && Math.hypot(last.x - pts[0].x, last.y - pts[0].y) >= 40;
  return { vx, vy, speed: Math.hypot(vx, vy), quick, from: win[0] };
}

/** Was it a throw, and how far does the handful carry (mm at this zoom)? */
export function flingOf(vel: ReleaseVelocity, zoom: number): { flung: boolean; dir: Vec; travel: number } {
  const flung = vel.speed > FLING_SPEED || (vel.quick && vel.speed > QUICK_FLING_SPEED);
  const s = Math.max(1e-4, vel.speed);
  return { flung, dir: { x: vel.vx / s, y: vel.vy / s }, travel: clamp((vel.speed * 22) / zoom, 0, 110) };
}

/** Deterministic 0..1 generator (mulberry32). */
export function seededRng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What a throw's "near the game" bounds are measured against: everything on the table EXCEPT zones that
 * take dice. A dice tray must never widen where a throw may land — that stretched throws toward it.
 */
export function throwBounds(game: Pick<Game, 'components'>, s: TableState): Rect | null {
  return stateBounds(
    game,
    s,
    s.order.filter((id) => {
      const e = s.entities[id] as Entity | undefined;
      return !!e && !(e.kind === 'zone' && zoneTakes(e, 'dice'));
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Dice trays                                                           */
/* ------------------------------------------------------------------ */

export const dieRadius = (size: number) => size * 0.7;
const dieHalf = (size: number) => size * 0.62;

export interface ThrowTray {
  zone: ZoneEntity;
  /** Dice already resting in it. */
  resting: { x: number; y: number; size: number }[];
}

export interface DiceThrow {
  /** `from`: where it leaves the hand; `flick`: where the flick that threw it began (the die's centre then). */
  dice: { id: ID; from: Vec; size: number; flick?: Vec }[];
  dir: Vec;
  travel: number;
  area: Rect | null;
  obstacles: { x: number; y: number; r: number }[];
  rects: Rect[];
  blocked: Rect[];
  /** Bounded zones that take dice (front-most first). */
  trays: ThrowTray[];
  seed: number;
}

export const isTray = (e: Entity | undefined): e is ZoneEntity => e?.kind === 'zone' && !isEndless(e) && zoneTakes(e, 'dice');

/** The axis-aligned part of a tray dice may land in (mm). */
export function trayArea(z: ZoneEntity): Rect {
  const q = ((z.rot % 180) + 180) % 180;
  const quarter = q > 45 && q < 135;
  const skew = q % 90 > 1 && q % 90 < 89;
  let hw = (quarter ? z.h : z.w) / 2 - 2;
  let hh = (quarter ? z.w : z.h) / 2 - 2;
  if (skew) hw = hh = Math.min(z.w, z.h) / 2 / Math.SQRT2 - 2;
  return { x: z.x - hw, y: z.y - hh, w: hw * 2, h: hh * 2 };
}

/**
 * THE capture rule: the handful's natural landing (the plan made with no tray) has its centre inside a
 * tray or within half a die (+2 mm) past its rim.
 */
export function capturingTray(trays: ThrowTray[], dice: DiceThrow['dice'], land: Map<ID, Vec>): ThrowTray | null {
  const pts = dice.map((d) => land.get(d.id)).filter(Boolean) as Vec[];
  if (!pts.length) return null;
  const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  const margin = Math.min(15, dice.reduce((a, d) => a + d.size, 0) / dice.length / 2 + 2);
  for (const t of trays) {
    const l = zoneLocal(t.zone, c);
    if (Math.abs(l.x) <= t.zone.w / 2 + margin && Math.abs(l.y) <= t.zone.h / 2 + margin) return t;
  }
  return null;
}

/**
 * Every captured die fully inside the tray, off each other and off dice resting there: the solver's spots
 * when they qualify, else the nearest slots of a tighter packing; dice that genuinely don't fit land in a
 * row just below the tray, visibly outside, never on the rim.
 */
export function packInTray(t: ThrowTray, dice: DiceThrow['dice'], land: Map<ID, Vec>): Map<ID, Vec> {
  const tray = t.zone;
  const inside = (size: number, p: Vec) => {
    const l = zoneLocal(tray, p);
    return Math.abs(l.x) <= tray.w / 2 - dieHalf(size) - 1 && Math.abs(l.y) <= tray.h / 2 - dieHalf(size) - 1;
  };
  const apart = (a: Vec, sa: number, b: Vec, sb: number) => Math.hypot(a.x - b.x, a.y - b.y) >= dieHalf(sa) + dieHalf(sb);
  const ok =
    dice.every((d) => inside(d.size, land.get(d.id)!)) &&
    dice.every((d, i) => dice.slice(i + 1).every((o) => apart(land.get(d.id)!, d.size, land.get(o.id)!, o.size)) && t.resting.every((o) => apart(land.get(d.id)!, d.size, o, o.size)));
  if (ok) return land;
  const out = new Map<ID, Vec>();
  const size = Math.max(...dice.map((d) => d.size), ...t.resting.map((d) => d.size));
  const pitch = size * 1.3;
  const cols = Math.max(0, Math.floor((tray.w - 4 - size * 0.24) / pitch));
  const rows = Math.max(0, Math.floor((tray.h - 4 - size * 0.24) / pitch));
  const slots: Vec[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const w = zoneWorld(tray, { x: (c - (cols - 1) / 2) * pitch, y: (r - (rows - 1) / 2) * pitch });
      if (t.resting.every((o) => Math.hypot(o.x - w.x, o.y - w.y) >= pitch * 0.95)) slots.push(w);
    }
  const spill: DiceThrow['dice'] = [];
  for (const d of dice) {
    const p = land.get(d.id)!;
    let bi = -1;
    slots.forEach((q, i) => {
      if (bi < 0 || Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(slots[bi].x - p.x, slots[bi].y - p.y)) bi = i;
    });
    if (bi < 0) spill.push(d);
    else out.set(d.id, slots.splice(bi, 1)[0]);
  }
  spill.forEach((d, i) => {
    const k = i - (spill.length - 1) / 2;
    out.set(d.id, zoneWorld(tray, { x: k * pitch, y: tray.h / 2 + pitch * 0.5 + 4 }));
  });
  return out;
}

/** A die that isn't captured never rests across a tray's rim: fully in if its centre is in, else fully out. */
export function offTrayRims(trays: ThrowTray[], dice: DiceThrow['dice'], land: Map<ID, Vec>): Map<ID, Vec> {
  if (!trays.length) return land;
  let out: Map<ID, Vec> | null = null;
  for (const d of dice) {
    const p = land.get(d.id);
    if (!p) continue;
    const h = dieHalf(d.size);
    for (const { zone: z } of trays) {
      const l = zoneLocal(z, p);
      const ax = Math.abs(l.x);
      const ay = Math.abs(l.y);
      if (ax >= z.w / 2 + h || ay >= z.h / 2 + h) continue;
      // a throw the tray didn't catch never leaves a die in it or across its rim: out through the nearest side
      if (z.w / 2 + h - ax < z.h / 2 + h - ay) l.x = Math.sign(l.x || 1) * (z.w / 2 + h + 2);
      else l.y = Math.sign(l.y || 1) * (z.h / 2 + h + 2);
      out ??= new Map(land);
      out.set(d.id, zoneWorld(z, l));
      break;
    }
  }
  return out ?? land;
}

/**
 * The ONE place every throw and roll is planned (mouse, touch, keyboard, menu; one die or a handful).
 * 1. the natural plan, exactly as on a table without any tray (seeded);
 * 2. capture decided from that plan only (capturingTray);
 * 3. captured → the same throw re-planned inside the tray and packed; not captured → the natural plan,
 *    untouched except a die that would rest across a rim.
 */
/** Where along a→b (0..1) the segment first touches the zone's rect grown by `m` (0 when a starts inside), else null. */
function pathEntersZone(z: ZoneEntity, a: Vec, b: Vec, m: number): number | null {
  const la = zoneLocal(z, a);
  const lb = zoneLocal(z, b);
  const hx = z.w / 2 + m;
  const hy = z.h / 2 + m;
  let s0 = 0;
  let s1 = 1;
  const axis = (p: number, q: number, h: number) => {
    const d = q - p;
    if (Math.abs(d) < 1e-9) return Math.abs(p) <= h;
    let e0 = (-h - p) / d;
    let e1 = (h - p) / d;
    if (e0 > e1) [e0, e1] = [e1, e0];
    s0 = Math.max(s0, e0);
    s1 = Math.min(s1, e1);
    return s0 <= s1;
  };
  if (!axis(la.x, lb.x, hx) || !axis(la.y, lb.y, hy)) return null;
  return s0;
}

/**
 * A die is caught by the first tray its flight crosses — from where it leaves the hand to where the throw
 * carries it — or the tray it would come to rest in anyway. A tray has walls: a die thrown across it stops
 * in it. A die whose path never touches a tray lands exactly as on a table without one.
 */
export function trayCatching(trays: ThrowTray[], d: DiceThrow['dice'][number], reach: Vec, natural?: Vec): ThrowTray | null {
  const m = d.size / 2 + 2;
  let best: ThrowTray | null = null;
  let bestS = Infinity;
  for (const tr of trays) {
    // the flight: the flick stretch (flick → release), then the carry (release → reach)
    let s: number | null = null;
    if (d.flick) {
      const s0 = pathEntersZone(tr.zone, d.flick, d.from, m);
      if (s0 !== null) s = s0 - 1;
    }
    if (s === null) s = pathEntersZone(tr.zone, d.from, reach, m);
    if (s === null && natural) {
      const l = zoneLocal(tr.zone, natural);
      if (Math.abs(l.x) <= tr.zone.w / 2 + m && Math.abs(l.y) <= tr.zone.h / 2 + m) s = 1;
    }
    if (s !== null && s < bestS) {
      bestS = s;
      best = tr;
    }
  }
  return best;
}

export function planDiceThrow(t: DiceThrow): { land: Map<ID, Vec>; tray: ZoneEntity | null; reach: Map<ID, Vec>; captured: ID[] } {
  const plan: ThrowDie[] = t.dice.map((d) => ({ id: d.id, from: d.from, r: dieRadius(d.size) }));
  const natural = planThrow(plan, { dir: t.dir, travel: t.travel, area: t.area, obstacles: t.obstacles, rects: t.rects, blocked: t.blocked, rng: seededRng(t.seed) });
  if (!(t.travel > 0.5)) return { land: natural, tray: null, reach: natural, captured: [] };
  // Where the throw actually carries: the same plan without the "near the game" landing area (which only
  // exists to keep dice from rolling off into empty table). Capture is decided from this, so a tray right
  // where the handful carries catches it even on a sparse table — and a throw that carries short of a tray
  // is never captured, and then lands exactly as it would with no tray (`natural`).
  const reach = t.area ? planThrow(plan, { dir: t.dir, travel: t.travel, area: null, obstacles: t.obstacles, rects: t.rects, blocked: t.blocked, rng: seededRng(t.seed) }) : natural;
  // ONE decision for the whole throw, from the handful's centre: where the flick began, where it left the hand,
  // where it carries, where it would rest. Every die goes into that tray, or none does — a handful thrown together
  // lands together, and the random spread of one die can never tip the outcome.
  const mean = (pick: (d: DiceThrow['dice'][number]) => Vec) => {
    const n = t.dice.length;
    return t.dice.reduce((s, d) => ({ x: s.x + pick(d).x / n, y: s.y + pick(d).y / n }), { x: 0, y: 0 });
  };
  const size = t.dice.reduce((s, d) => s + d.size, 0) / t.dice.length;
  const group = {
    id: '__group',
    size,
    from: mean((d) => d.from),
    flick: t.dice.every((d) => d.flick) ? mean((d) => d.flick!) : undefined,
  };
  // the handful's flight WITHOUT the random scatter of the landing cloud: where it left the hand plus the throw —
  // so the same release and speed always give the same decision (a new random seed per throw can't tip it)
  const aim = { x: group.from.x + t.dir.x * t.travel, y: group.from.y + t.dir.y * t.travel };
  const tr = trayCatching(t.trays, group, aim);
  if (!tr) return { land: offTrayRims(t.trays, t.dice, natural), tray: null, reach, captured: [] };
  const inTray = planThrow(plan, {
    dir: t.dir,
    travel: t.travel,
    area: trayArea(tr.zone),
    obstacles: t.obstacles,
    rects: t.rects.filter((q) => inZone(tr.zone, { x: q.x + q.w / 2, y: q.y + q.h / 2 })),
    rng: seededRng(t.seed),
  });
  return { land: packInTray(tr, t.dice, inTray), tray: tr.zone, reach, captured: t.dice.map((d) => d.id) };
}

export interface ThrowDie {
  id: ID;
  /** Where the die leaves the hand (mm, centre). */
  from: Vec;
  /** Collision radius (mm). */
  r: number;
}

export interface ThrowPlan {
  /** Unit throw direction; {0,0} rolls in place. */
  dir: Vec;
  /** How far the group centre carries (mm). */
  travel: number;
  /** Allowed area for dice (their whole footprint stays inside). */
  area: Rect | null;
  /** Dice that stay where they are: thrown dice never land on them. */
  obstacles: { x: number; y: number; r: number }[];
  /** Other pieces (cards, tokens, notes, counters): avoided when there is room. */
  rects?: Rect[];
  /** Screen chrome over the table (hand tab and cards, dice bar): never landed under. */
  blocked?: Rect[];
  rng?: () => number;
}

/** Roughly normal, mean 0, sd 1, clipped to ±2.2 so no die strays absurdly. */
function gauss(rng: () => number) {
  const u = Math.max(1e-6, rng());
  const v = rng();
  return clamp(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v), -2.2, 2.2);
}

export function planThrow(dice: ThrowDie[], plan: ThrowPlan): Map<ID, Vec> {
  const rng = plan.rng ?? Math.random;
  const n = dice.length;
  const out = new Map<ID, Vec>();
  if (!n) return out;
  const rMean = dice.reduce((s, d) => s + d.r, 0) / n;
  const c = { x: dice.reduce((s, d) => s + d.from.x, 0) / n, y: dice.reduce((s, d) => s + d.from.y, 0) / n };
  const { dir, travel } = plan;
  const perp = { x: -dir.y, y: dir.x };
  const moving = travel > 0.5;

  // 1. initial guesses
  let pos: Vec[];
  if (!moving) {
    // rolled where they lie: each die shuffles a little about its own spot
    pos = dice.map((d) => ({ x: d.from.x + gauss(rng) * d.r * 0.45, y: d.from.y + gauss(rng) * d.r * 0.45 }));
  } else {
    // A cloud around the landing point: a little longer along the throw than across it, wider
    // for a bigger handful and a harder throw. Which die lands where is random — the formation
    // in the hand is gone.
    const uv = dice.map(() => [gauss(rng), gauss(rng)] as const);
    const spread0 = rMean * (0.55 + 0.62 * Math.sqrt(n));
    const cloudAt = (t: number) => {
      const spread = spread0 + t * 0.1;
      const along = spread * 1.2;
      const across = spread * 0.9;
      return uv.map(([gu, gv]) => {
        const u = t + gu * along;
        const v = gv * across;
        return { x: c.x + dir.x * u + perp.x * v, y: c.y + dir.y * u + perp.y * v };
      });
    };
    // A throw that would carry the handful out of the permitted area comes down at the area's far edge
    // ALONG ITS OWN PATH: every die's spot is linear in the distance carried, so the largest distance that
    // keeps them all inside is exact — a harder throw never lands shorter than a softer one.
    let t = travel;
    const a0 = plan.area;
    if (a0) {
      const pad = Math.min(rMean * (0.4 + 0.5 * Math.sqrt(n)), a0.w / 4, a0.h / 4);
      const p0 = cloudAt(0);
      const p1 = cloudAt(1);
      let fits0 = true;
      dice.forEach((d, i) => {
        const room = d.r + pad;
        const axes: [number, number, number, number][] = [
          [p0[i].x, p1[i].x - p0[i].x, a0.x + room, a0.x + a0.w - room],
          [p0[i].y, p1[i].y - p0[i].y, a0.y + room, a0.y + a0.h - room],
        ];
        for (const [a, b, lo, hi] of axes) {
          if (a < lo - 1e-6 || a > hi + 1e-6) fits0 = false;
          if (b > 1e-9) t = Math.min(t, (hi - a) / b);
          else if (b < -1e-9) t = Math.min(t, (lo - a) / b);
        }
      });
      // released where the handful doesn't fit at all: it comes down where it left the hand (step 2 slides it in)
      t = fits0 ? clamp(t, 0, travel) : 0;
    }
    pos = cloudAt(t);
  }

  // 2. keep the landing footprint on the table: slide the whole cloud inside the area, with room
  //    to spread — a cloud relaxed against the edge would be squashed flat into a line along it
  const area = plan.area;
  if (moving && area) {
    const pad = Math.min(rMean * (0.4 + 0.5 * Math.sqrt(n)), area.w / 4, area.h / 4);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pos.forEach((p, i) => {
      x0 = Math.min(x0, p.x - dice[i].r - pad);
      y0 = Math.min(y0, p.y - dice[i].r - pad);
      x1 = Math.max(x1, p.x + dice[i].r + pad);
      y1 = Math.max(y1, p.y + dice[i].r + pad);
    });
    const shift = (lo: number, hi: number, alo: number, ahi: number) => {
      if (hi - lo > ahi - alo) return (alo + ahi) / 2 - (lo + hi) / 2;
      if (lo < alo) return alo - lo;
      if (hi > ahi) return ahi - hi;
      return 0;
    };
    const dx = shift(x0, x1, area.x, area.x + area.w);
    const dy = shift(y0, y1, area.y, area.y + area.h);
    if (dx || dy) pos.forEach((p) => ((p.x += dx), (p.y += dy)));
  }

  // 3. relax: push dice apart (each with its own, uneven breathing room so nothing settles into a
  //    lattice), off resting dice and other pieces, inside the area
  const room = dice.map(() => rMean * (0.06 + 0.4 * rng() * rng()));
  const obs = plan.obstacles;
  const rects = moving ? (plan.rects ?? []) : [];
  const blocked = plan.blocked ?? [];
  /** Push a die out of a rect through its nearest side; returns how deep it was. */
  const pushOut = (a: Vec, i: number, q: Rect) => {
    const r = dice[i].r + room[i];
    const x0 = q.x - r, x1 = q.x + q.w + r, y0 = q.y - r, y1 = q.y + q.h + r;
    if (a.x <= x0 || a.x >= x1 || a.y <= y0 || a.y >= y1) return 0;
    const l = a.x - x0, rr = x1 - a.x, t = a.y - y0, bt = y1 - a.y;
    const m = Math.min(l, rr, t, bt);
    // out by a random extra and with a sideways nudge: pushed exactly to the edge, several
    // dice would line up along a card like a fence
    const extra = rMean * (0.15 + 0.9 * rng());
    const slide = (rng() - 0.5) * rMean * 0.8;
    if (m === l) (a.x = x0 - extra), (a.y += slide);
    else if (m === rr) (a.x = x1 + extra), (a.y += slide);
    else if (m === t) (a.y = y0 - extra), (a.x += slide);
    else (a.y = y1 + extra), (a.x += slide);
    return m;
  };
  const clampIn = (p: Vec, r: number) => {
    if (!area) return;
    const ax0 = area.x + r, ax1 = area.x + area.w - r;
    const ay0 = area.y + r, ay1 = area.y + area.h - r;
    p.x = ax0 > ax1 ? area.x + area.w / 2 : clamp(p.x, ax0, ax1);
    p.y = ay0 > ay1 ? area.y + area.h / 2 : clamp(p.y, ay0, ay1);
  };
  const PASSES = 160;
  for (let pass = 0; pass < PASSES; pass++) {
    let worst = 0;
    // soft obstacles give way in the last passes if the table is too crowded to honour them
    const soft = pass < PASSES * 0.7;
    for (let i = 0; i < n; i++) {
      const a = pos[i];
      for (let j = i + 1; j < n; j++) {
        const b = pos[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const min = dice[i].r + dice[j].r + (room[i] + room[j]) / 2;
        if (d >= min) continue;
        if (d < 1e-4) {
          const ang = rng() * Math.PI * 2;
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const push = (min - Math.max(d, 1e-4)) / 2 + 0.01;
        worst = Math.max(worst, min - d);
        const ux = dx / d;
        const uy = dy / d;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
      for (const o of obs) {
        let dx = a.x - o.x;
        let dy = a.y - o.y;
        let d = Math.hypot(dx, dy);
        const min = dice[i].r + o.r + room[i];
        if (d >= min) continue;
        if (d < 1e-4) {
          dx = moving ? dir.x || 1 : 1;
          dy = moving ? dir.y : 0;
          d = Math.hypot(dx, dy);
        }
        worst = Math.max(worst, min - d);
        a.x += (dx / d) * (min - d + 0.01);
        a.y += (dy / d) * (min - d + 0.01);
      }
      if (soft) for (const q of rects) worst = Math.max(worst, pushOut(a, i, q));
      for (const q of blocked) worst = Math.max(worst, pushOut(a, i, q));
    }
    if (moving) pos.forEach((p, i) => clampIn(p, dice[i].r));
    if (worst < 0.05 && pass > 2) break;
  }
  dice.forEach((d, i) => out.set(d.id, pos[i]));
  return out;
}
