/**
 * Regression check for thrown dice and dice trays (v2-6).
 *   (a) a die whose flight never touches a tray (and doesn't come to rest at it) lands EXACTLY as on the
 *       same table without the tray;
 *   (b) a die whose flight crosses a tray (release → where the throw carries), or that would rest at it,
 *       is caught: fully inside the tray, or spilled visibly beside it — never on the rim;
 *   (c) mouse-rate and touch-rate samples of one gesture give the same outcome;
 *   (d) throw distance is monotonic: in one direction, a harder throw never lands shorter (it plateaus
 *       at the edge of the permitted landing area);
 *   (e) capture is monotonic too: once a throw at the tray is caught, every harder one is caught.
 *
 *   npx tsx scripts/check-throws.mts
 */
import type { TableState, ZoneEntity } from '../src/shared/types.js';
import { flingOf, planDiceThrow, releaseVelocity, throwBounds, type Sample } from '../src/features/play/table/throw.js';
import { zoneLocal } from '../src/features/play/engine/zones.js';

type V = { x: number; y: number };
const game = { components: [{ id: 'die', kind: 'dice', name: 'Die', size: 16, color: '#fff', inkColor: '#000', faces: [], createdAt: 0 }] } as any;
const ZOOM = 2.0;
const SIZE = 16;
const tray: ZoneEntity = { id: 'tray', kind: 'zone', x: 110, y: -40, rot: 0, w: 90, h: 70, label: 'Dice tray', color: '#8fb8de', snap: 'pile', accepts: ['dice'], pieceMode: 'free' };
const OFFS = [{ x: 0, y: 0 }, { x: -18, y: 12 }, { x: 14, y: 16 }];
let fails = 0;
const fail = (msg: string) => {
  fails++;
  console.log('  FAIL: ' + msg);
};

function samples(dir: V, pxPerMs: number, dt: number, count: number): Sample[] {
  const out: Sample[] = [];
  for (let i = count; i >= 0; i--) out.push({ x: 700 - dir.x * pxPerMs * dt * i, y: 450 - dir.y * pxPerMs * dt * i, t: 1000 - dt * i });
  return out;
}

/** landingArea as the controller builds it: the view, narrowed to throwBounds ± 60 mm of the pieces (dice at rest). */
function area(s: TableState) {
  const v = { x: -400, y: -300, w: 800, h: 520 };
  const b = throwBounds(game, s);
  const span = (lo: number, size: number, bLo?: number, bSize?: number) => {
    let a = lo + 4;
    let z = lo + size - 4;
    if (bLo !== undefined && bSize !== undefined) {
      a = Math.max(a, bLo - 60);
      z = Math.min(z, bLo + bSize + 60);
    }
    return a > z ? [lo + size / 2, lo + size / 2] : [a, z];
  };
  const [xa, xb] = span(v.x, v.w, b?.x, b?.w);
  const [ya, yb] = span(v.y, v.h, b?.y, b?.h);
  return { x: xa, y: ya, w: xb - xa, h: yb - ya };
}

/**
 * One throw. The dice rest at `rest` (a sparse table like the critic's: only the dice, and the tray), are
 * released at rest + `carry` with a gesture of `pxPerMs` in direction `angle`.
 */
function throwOnce(opts: { withTray: boolean; n: number; rest: V; carry: V; angle: number; pxPerMs: number; input: 'mouse' | 'touch'; seed: number; wide?: boolean; starts?: V[]; trace?: Sample[]; upT?: number }) {
  const a = (opts.angle * Math.PI) / 180;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  const pts = opts.trace ?? (opts.input === 'mouse' ? samples(dir, opts.pxPerMs, 16, 5) : samples(dir, opts.pxPerMs, 8, 10));
  const last = pts[pts.length - 1];
  const vel = releaseVelocity(pts, { t: opts.upT ?? last.t + 4 });
  const f = flingOf(vel, ZOOM);
  // the flick stretch in world mm, exactly as the controller converts it (screen px / zoom)
  const fo = vel.from ? { x: (vel.from.x - last.x) / ZOOM, y: (vel.from.y - last.y) / ZOOM } : { x: 0, y: 0 };
  const dice = (opts.starts ?? OFFS).slice(0, opts.n).map((o, i) => {
    const from = { x: opts.rest.x + opts.carry.x + o.x, y: opts.rest.y + opts.carry.y + o.y };
    return { id: `d${i}`, rest: { x: opts.rest.x + o.x, y: opts.rest.y + o.y }, from, flick: { x: from.x + fo.x, y: from.y + fo.y } };
  });
  const s: TableState = { entities: {}, order: [], hand: [] };
  for (const d of dice) {
    s.entities[d.id] = { id: d.id, kind: 'die', componentId: 'die', x: d.rest.x, y: d.rest.y, rot: 0, face: 0 };
    s.order.push(d.id);
  }
  if (opts.withTray) {
    s.entities.tray = tray;
    s.order.unshift('tray');
  }
  if (opts.wide) {
    // a board-sized note far right: the permitted landing area reaches well past the tray
    s.entities.board = { id: 'board', kind: 'note', x: 260, y: -40, rot: 0, w: 60, h: 60, text: '', color: '#fff' };
    s.order.unshift('board');
  }
  const res = planDiceThrow({
    dice: dice.map((d) => ({ id: d.id, from: d.from, size: SIZE, flick: d.flick })),
    dir: f.dir,
    travel: f.travel,
    area: area(s),
    obstacles: [],
    rects: [],
    blocked: [],
    trays: opts.withTray ? [{ zone: tray, resting: [] }] : [],
    seed: opts.seed,
  });
  return { f, res, dice, dir };
}

const fullyInside = (p: V) => {
  const l = zoneLocal(tray, p);
  return Math.abs(l.x) <= tray.w / 2 - SIZE * 0.5 && Math.abs(l.y) <= tray.h / 2 - SIZE * 0.5;
};
const onRim = (p: V) => {
  const l = zoneLocal(tray, p);
  const out = Math.abs(l.x) >= tray.w / 2 + SIZE / 2 || Math.abs(l.y) >= tray.h / 2 + SIZE / 2;
  return !out && !fullyInside(p);
};
/**
 * Independent restatement of the catch rule: flight flick→release→reach crosses the tray grown by half a die + 2,
 * or natural rest there. Exact: Cohen–Sutherland style clipping (a different method from the product's slab test).
 */
function segmentHitsBox(a: V, b: V, hx: number, hy: number) {
  const code = (p: V) => (p.x < -hx ? 1 : 0) | (p.x > hx ? 2 : 0) | (p.y < -hy ? 4 : 0) | (p.y > hy ? 8 : 0);
  let p = { ...a };
  let q = { ...b };
  let cp = code(p);
  let cq = code(q);
  for (let guard = 0; guard < 16; guard++) {
    if (!(cp | cq)) return true;
    if (cp & cq) return false;
    const out = cp || cq;
    let x = 0;
    let y = 0;
    if (out & 8) (x = p.x + ((q.x - p.x) * (hy - p.y)) / (q.y - p.y)), (y = hy);
    else if (out & 4) (x = p.x + ((q.x - p.x) * (-hy - p.y)) / (q.y - p.y)), (y = -hy);
    else if (out & 2) (y = p.y + ((q.y - p.y) * (hx - p.x)) / (q.x - p.x)), (x = hx);
    else (y = p.y + ((q.y - p.y) * (-hx - p.x)) / (q.x - p.x)), (x = -hx);
    if (out === cp) (p = { x, y }), (cp = code(p));
    else (q = { x, y }), (cq = code(q));
  }
  return false;
}
function shouldCatch(flick: V, from: V, aim: V) {
  const m = SIZE / 2 + 2;
  const hx = tray.w / 2 + m;
  const hy = tray.h / 2 + m;
  for (const [pa, pb] of [[flick, from], [from, aim]]) {
    if (segmentHitsBox(zoneLocal(tray, pa), zoneLocal(tray, pb), hx + 1e-6, hy + 1e-6)) return true;
  }
  return false;
}

/* ---------------- (a)(b)(c): the case table ---------------- */
console.log('\n(a)(b)(c) catch table — sparse table (only dice + tray), tray rim at x = 65; dice rest at x = −150 (+ release offset)');
console.log('ok   | dice | angle | release x | gesture px/ms | carries to x | outcome | mouse = touch');
const REST = { x: -150, y: -40 };
for (const n of [1, 3])
  for (const [angle, lateral] of [[0, 0], [0, 75], [0, -80], [12, 0], [-20, 0]] as const)
    for (const carryX of [40, 120, 180, 230, 380])
      for (const px of [2, 5, 9, 14]) {
        const seed = 7000 + n * 1000 + carryX * 10 + px + angle;
        const base = { n, rest: { x: REST.x, y: REST.y + lateral }, carry: { x: carryX, y: 0 }, angle, pxPerMs: px, seed };
        const none = throwOnce({ ...base, withTray: false, input: 'mouse' });
        const withM = throwOnce({ ...base, withTray: true, input: 'mouse' });
        const withT = throwOnce({ ...base, withTray: true, input: 'touch' });
        let ok = true;
        const outcomes: string[] = [];
        const why: string[] = [];
        // all-or-none, decided from the handful's centre (restated independently)
        const avg = (pick: (d: (typeof withM.dice)[number]) => V) => withM.dice.reduce((s, d) => ({ x: s.x + pick(d).x / n, y: s.y + pick(d).y / n }), { x: 0, y: 0 });
        const fc = avg((d) => d.from);
        // restated from the deterministic flight: flick centre → release centre → release centre + direction × travel
        const groupCatch = shouldCatch(avg((d) => d.flick), fc, { x: fc.x + withM.f.dir.x * withM.f.travel, y: fc.y + withM.f.dir.y * withM.f.travel });
        if (withM.res.captured.length !== 0 && withM.res.captured.length !== n) (ok = false), why.push(`split: ${withM.res.captured.length}/${n} caught`);
        if ((withM.res.captured.length > 0) !== groupCatch) (ok = false), why.push(`group rule: planner caught=${withM.res.captured.length}, restated=${groupCatch}`);
        for (const d of withM.dice) {
          const nat = none.res.land.get(d.id)!;
          const lm = withM.res.land.get(d.id)!;
          const lt = withT.res.land.get(d.id)!;
          const caught = withM.res.captured.includes(d.id);
          const dmt = Math.hypot(lm.x - lt.x, lm.y - lt.y);
          if (dmt > 0.5 || caught !== withT.res.captured.includes(d.id)) (ok = false), why.push(`${d.id} mouse≠touch by ${dmt.toFixed(2)} mm (touch caught=${withT.res.captured.includes(d.id)})`);
          if (caught) {
            if (!fullyInside(lm) && onRim(lm)) (ok = false), why.push(`${d.id} caught but on rim`);
            outcomes.push(fullyInside(lm) ? 'IN' : 'beside');
          } else {
            const identical = nat.x === lm.x && nat.y === lm.y;
            if (!identical && onRim(lm)) (ok = false), why.push(`${d.id} loose on rim`);
            if (!identical && !onRim(nat) && !fullyInside(nat)) (ok = false), why.push(`${d.id} loose moved though not touching the tray`);
            if (!identical && (fullyInside(lm) || onRim(lm))) (ok = false), why.push(`${d.id} loose left in / across the tray`);
            outcomes.push(identical ? 'same as no tray' : 'moved out of tray');
          }
        }
        const rc = [...withM.res.reach.values()].reduce((s, p) => s + p.x, 0) / n;
        const line = `${ok ? 'ok  ' : 'FAIL'} | ${n}    | ${String(angle).padStart(4)}° ${lateral ? `(beside ${lateral > 0 ? '+' : ''}${lateral})` : '          '} | ${String(REST.x + carryX).padStart(4)} | ${String(px).padStart(2)} | ${String(Math.round(rc)).padStart(5)} | ${outcomes.join(', ')} | ${
          withM.res.captured.length === withT.res.captured.length
        }`;
        console.log(line + (why.length ? `   <- ${why.join('; ')}` : ''));
        if (!ok) fails++;
      }

/* ---------------- (d)(e): speed sweeps ---------------- */
console.log('\n(d)(e) speed sweeps: dice rest at x −150, released at x −140, flick 1 → 16 px/ms (travel ' + (22 / ZOOM).toFixed(1) + ' mm per px/ms, max 110)');
console.log('     sparse = only the dice (permitted area ends ~60 mm past them); wide = a board far right (area reaches past the tray)');
for (const wide of [false, true])
for (const withTray of [false, true])
  for (const n of [1, 3])
    for (const angle of [0, 15, -25]) {
      let prev = -Infinity;
      let caughtOnce = false;
      const row: string[] = [];
      let ok = true;
      for (let px = 1; px <= 16; px++) {
        const r = throwOnce({ withTray, wide, n, rest: REST, carry: { x: 10, y: 0 }, angle, pxPerMs: px, input: 'mouse', seed: 4242 + n + angle });
        const pts = r.dice.map((d) => r.res.land.get(d.id)!);
        // distance along the throw of the handful's centre, from where it left the hand
        const from = r.dice.reduce((s, d) => ({ x: s.x + d.from.x / n, y: s.y + d.from.y / n }), { x: 0, y: 0 });
        const c = pts.reduce((s, p) => ({ x: s.x + p.x / n, y: s.y + p.y / n }), { x: 0, y: 0 });
        const dist = (c.x - from.x) * r.dir.x + (c.y - from.y) * r.dir.y;
        const caught = r.res.captured.length > 0;
        if (!withTray && dist < prev - 1) ok = false;
        if (withTray && caughtOnce && r.res.captured.length < n) ok = false;
        caughtOnce ||= r.res.captured.length === n;
        prev = Math.max(prev, dist);
        row.push(`${Math.round(dist)}${caught ? '*' : ''}`);
      }
      console.log(`${ok ? 'ok  ' : 'FAIL'} | ${wide ? 'wide  ' : 'sparse'} | ${withTray ? 'tray   ' : 'no tray'} | ${n} dice | ${String(angle).padStart(3)}° | distance by speed: ${row.join(' ')}${withTray ? '   (* = caught)' : ''}`);
      if (!ok) fails++;
    }

/* ---------------- (d)(e) the critic's gesture: 3 dice, one flick of L px over 70 ms straight at the tray ---------------- */
console.log('\n(d)(e) gesture sweep like d4.mjs: 3 dice resting 137 mm before the tray rim, flick L px in 70 ms at the tray (release = rest + L/zoom)');
for (const input of ['mouse', 'touch'] as const)
  for (const withTray of [false, true]) {
    const rest = { x: -72, y: -30 };
    const angle = (Math.atan2(tray.y - rest.y, tray.x - rest.x) * 180) / Math.PI;
    const a = (angle * Math.PI) / 180;
    let prev = -Infinity;
    let caughtAll = false;
    let ok = true;
    const row: string[] = [];
    for (let L = 200; L <= 700; L += 50) {
      const carry = { x: (Math.cos(a) * L) / ZOOM, y: (Math.sin(a) * L) / ZOOM };
      const r = throwOnce({ withTray, n: 3, rest, carry, angle, pxPerMs: L / 70, input, seed: 99 });
      const pts = r.dice.map((d) => r.res.land.get(d.id)!);
      const c = pts.reduce((s, p) => ({ x: s.x + p.x / 3, y: s.y + p.y / 3 }), { x: 0, y: 0 });
      const dist = (c.x - rest.x) * r.dir.x + (c.y - rest.y) * r.dir.y;
      const nCaught = r.res.captured.length;
      if (!withTray && dist < prev - 3) ok = false;
      if (withTray && caughtAll && nCaught < 3) ok = false; // once a throw at the tray is caught, harder stays caught
      if (withTray && nCaught && !pts.filter((_, i) => r.res.captured.includes(r.dice[i].id)).every((p) => fullyInside(p) || !onRim(p))) ok = false;
      caughtAll ||= nCaught === 3;
      prev = Math.max(prev, dist);
      row.push(`${L}:${Math.round(dist)}${nCaught ? (nCaught === 3 ? ' IN' : ` ${nCaught}in`) : ''}`);
    }
    console.log(`${ok ? 'ok  ' : 'FAIL'} | ${input} | ${withTray ? 'tray   ' : 'no tray'} | px:landing distance from rest (mm) | ${row.join('  ')}`);
    if (!ok) fails++;
  }

/* ---------------- (f) boundary band: the critic's staggered 3 dice, flick 280→380 px, sparse vs dense events ---------------- */
{
  const CRITIC = [{ x: 0, y: -12 }, { x: 0, y: 12 }, { x: 24, y: 0 }]; // (−150,−52) (−150,−28) (−126,−40) around rest (−150,−40)
  const rest = { x: -150, y: -40 };
  /**
   * A gesture of L px in 5 moves, as the app records it: the carry starts on the first move (L/5), so samples run
   * from L/5 to L and the die leaves the hand at L. Mouse-like = those 5 events ~31 ms apart; touch-like = one
   * event every ~8 ms over the same motion.
   */
  const trace = (L: number, a: number, dense: boolean): Sample[] => {
    const d = { x: Math.cos(a), y: Math.sin(a) };
    const T = 124; // 4 gaps of ~31 ms
    const n = dense ? 16 : 4;
    return Array.from({ length: n + 1 }, (_, i) => {
      const f = i / n;
      const px = L / 5 + f * 0.8 * L;
      return { x: 700 + d.x * px, y: 450 + d.y * px, t: 1000 + f * T };
    });
  };
  console.log('\n(f) boundary band — 3 dice staggered like d3.mjs, flick 280→420 px straight at the tray ± angle; caught count mouse-like / touch-like (must be 0 or 3, equal, and never drop back to 0 once 3)');
  for (const angle of [-12, -6, 0, 6, 12]) {
    const row: string[] = [];
    let ok = true;
    for (let L = 280; L <= 420; L += 10) {
      const a = (angle * Math.PI) / 180;
      const counts: number[] = [];
      for (const dense of [false, true]) {
        const tr = trace(L, a, dense);
        const r = throwOnce({ withTray: true, n: 3, rest, starts: CRITIC, carry: { x: (Math.cos(a) * L) / ZOOM, y: (Math.sin(a) * L) / ZOOM }, angle, pxPerMs: 0, input: dense ? 'touch' : 'mouse', seed: 500 + L + angle, trace: tr, upT: tr[tr.length - 1].t + 30 });
        counts.push(r.res.captured.length);
        const pts = r.dice.map((d) => r.res.land.get(d.id)!);
        if (r.res.captured.length === 3 && !pts.every((p) => fullyInside(p) || !onRim(p))) ok = false;
      }
      if (!counts.every((c) => c === 0 || c === 3) || counts[0] !== counts[1]) ok = false;
      if (row.some((cell) => cell.endsWith(':3/3')) && counts[0] === 0) ok = false; // a harder throw must stay caught
      row.push(`${L}:${counts[0]}/${counts[1]}`);
    }
    console.log(`${ok ? 'ok  ' : 'FAIL'} | ${String(angle).padStart(3)}° | ${row.join('  ')}`);
    if (!ok) fails++;
  }

  /* (g) recorded traces from the real app (r5vel.mjs, zoom 2.0): x px / ms, pointer lifted ~30 ms after the last move */
  const REC: Record<string, { mouse: [number, number][]; touch: [number, number][] }> = {
    '300 px': { mouse: [[0, 0], [60, 25], [120, 58], [180, 89], [240, 120]], touch: [[0, 0], [60, 25], [120, 72], [180, 104], [240, 136]] },
    '300 px b': { mouse: [[0, 0], [60, 21], [120, 45], [180, 74], [240, 107]], touch: [[0, 0], [60, 26], [120, 57], [180, 88], [240, 118]] },
    '330 px': { mouse: [[0, 0], [66, 19], [132, 43], [198, 76], [264, 106]], touch: [[0, 0], [66, 28], [132, 58], [198, 89], [264, 120]] },
    '360 px': { mouse: [[0, 0], [72, 22], [144, 44], [216, 75], [288, 105]], touch: [[0, 0], [72, 28], [144, 58], [216, 90], [288, 121]] },
  };
  console.log('\n(g) recorded mouse vs touch traces of the same gestures: release speed and the throw decision');
  for (const [name, rec] of Object.entries(REC)) {
    const res: string[] = [];
    const speeds: number[] = [];
    const caught: number[] = [];
    for (const input of ['mouse', 'touch'] as const) {
      const tr = rec[input].map(([x, t]) => ({ x: 700 + x, y: 450, t: 1000 + t }));
      const v = releaseVelocity(tr, { t: tr[tr.length - 1].t + 30 });
      speeds.push(v.speed);
      // recorded x is relative to the first move (L/5): the die leaves the hand at L = last + L/5 = last · 5/4
      const L = (rec[input][rec[input].length - 1][0] * 5) / 4;
      const r = throwOnce({ withTray: true, n: 3, rest, starts: CRITIC, carry: { x: L / ZOOM, y: 0 }, angle: 0, pxPerMs: 0, input, seed: 77, trace: tr, upT: tr[tr.length - 1].t + 30 });
      caught.push(r.res.captured.length);
      res.push(`${input} ${v.speed.toFixed(2)} px/ms → travel ${flingOf(v, ZOOM).travel.toFixed(1)} mm, caught ${r.res.captured.length}/3`);
    }
    const ok = Math.abs(speeds[0] - speeds[1]) < 0.25 && caught[0] === caught[1] && caught.every((c) => c === 0 || c === 3);
    console.log(`${ok ? 'ok  ' : 'FAIL'} | ${name.padEnd(8)} | ${res.join(' | ')}`);
    if (!ok) fails++;
  }
}

/* ---------------- tray never widens the landing area; mouse/touch velocity ---------------- */
{
  const s0: TableState = { entities: { x: { id: 'x', kind: 'die', componentId: 'die', x: -150, y: -60, rot: 0, face: 0 } }, order: ['x'], hand: [] };
  const s1: TableState = { entities: { ...s0.entities, tray }, order: ['tray', 'x'], hand: [] };
  const same = JSON.stringify(area(s0)) === JSON.stringify(area(s1));
  console.log(`\nlanding area with / without tray identical: ${same}`);
  if (!same) fail('tray changes the landing area');
  for (const v of [0.8, 2, 5, 9]) {
    const m = flingOf(releaseVelocity(samples({ x: 1, y: 0 }, v, 16, 5), { t: 1004 }), ZOOM);
    const t = flingOf(releaseVelocity(samples({ x: 1, y: 0 }, v, 8, 10), { t: 1004 }), ZOOM);
    const same2 = m.flung === t.flung && Math.abs(m.travel - t.travel) < 0.01;
    console.log(`velocity ${v} px/ms: mouse travel ${m.travel.toFixed(1)} | touch travel ${t.travel.toFixed(1)} -> ${same2 ? 'same' : 'DIFFERENT'}`);
    if (!same2) fail('mouse/touch velocity differs');
  }
}
console.log(fails ? `\nFAILED: ${fails}` : '\nALL OK');
process.exit(fails ? 1 : 0);
