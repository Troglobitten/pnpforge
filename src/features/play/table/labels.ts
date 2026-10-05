/**
 * Screen-space label placement for the table HUD.
 *
 * Zone labels, stack captions, count badges and lock pins all hold a **constant
 * on-screen size** while the pieces they name shrink with the camera. At desktop
 * zoom there is room for everything; at a tablet's fit-all the chrome is
 * proportionally much bigger than the pieces and everything piles up. So the
 * placement can't be decided in world space at authoring time — it has to be
 * re-solved in screen space every time the camera settles.
 *
 * The pass treats *every* label/badge/caption as one set and gives each a list of
 * candidate positions around the piece it belongs to. Candidates are clamped into
 * the viewport, rejected if they collide with anything already placed, and scored
 * so that a caption prefers free table over a board's printed art. Interactive
 * chrome (badges, lock pins) is placed first and never hidden; captions are placed
 * last, shrink if they must, and hide as a true last resort.
 *
 * Board art rule (it cannot be measured — a board is one <img>): **a caption is
 * drawn on the edge of its piece that faces the most free table.** Printed art is
 * scored as an obstacle covering the whole board, so a caption slides off the board
 * whenever any placement lets it, and hugs the piece when none does.
 */
import { rotateVec } from '../engine';

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

type Kind = 'badge' | 'pin' | 'zone' | 'caption';

interface Item {
  el: HTMLElement;
  kind: Kind;
  /** Screen rect of the piece the label belongs to. */
  anchor: Box;
  /** Screen rect the label occupies with no offset applied. */
  nat: Box;
  rot: number;
  /** Index of the owning `.play-ent` in DOM (= draw) order. */
  z: number;
  /** A name shown on demand (hover / selection) while names are off. */
  peek: boolean;
}

const PAD = 3;
const GAP = 6;
/** How far a badge/pin may drift from its home corner before it stops reading as attached. */
const RING = [10, 20, 34];
/**
 * Handles hold a constant screen size (`--hud-i`), so at far zoom-out a 45 px badge can be
 * wider than the piece it belongs to and two neighbouring pieces' handles cannot both fit in
 * the home ring. Tried only after every RING position has failed: drifting further reads
 * worse than sitting close, but it reads better than two handles overlapping.
 */
const FAR_RING = [50, 72, 96];

const NONE: Box[] = [];
const box = (x: number, y: number, w: number, h: number): Box => ({ l: x, t: y, r: x + w, b: y + h });
const wof = (r: Box) => r.r - r.l;
const hof = (r: Box) => r.b - r.t;
const fromRect = (r: DOMRect): Box => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });

function overlapArea(a: Box, b: Box, pad = 0): number {
  const x = Math.min(a.r + pad, b.r) - Math.max(a.l - pad, b.l);
  const y = Math.min(a.b + pad, b.b) - Math.max(a.t - pad, b.t);
  return x > 0 && y > 0 ? x * y : 0;
}

function hits(a: Box, b: Box): boolean {
  return a.l < b.r + PAD && a.r > b.l - PAD && a.t < b.b + PAD && a.b > b.t - PAD;
}

/** Slide a candidate back inside the view. A label wider than the view keeps its left edge. */
function clampInto(c: Box, view: Box): Box {
  const w = wof(c);
  const h = hof(c);
  let x = c.l;
  let y = c.t;
  if (x + w > view.r) x = view.r - w;
  if (x < view.l) x = view.l;
  if (y + h > view.b) y = view.b - h;
  if (y < view.t) y = view.t;
  return box(x, y, w, h);
}

/** Candidate top-left positions, best first. */
function candidates(it: Item, view: Box, occluded = false): Box[] {
  const a = it.anchor;
  const w = wof(it.nat);
  const h = hof(it.nat);
  const cx = (a.l + a.r) / 2;
  const cy = (a.t + a.b) / 2;
  const out: Box[] = [it.nat];
  if (it.kind === 'caption') {
    out.push(
      box(cx - w / 2, a.t - GAP - h, w, h), // above
      box(a.r + GAP, cy - h / 2, w, h), // right
      box(a.l - GAP - w, cy - h / 2, w, h), // left
      box(a.l, a.b + GAP, w, h), // below, left-aligned
      box(a.r - w, a.b + GAP, w, h), // below, right-aligned
      box(a.l, a.t - GAP - h, w, h), // above, left-aligned
      box(a.r - w, a.t - GAP - h, w, h), // above, right-aligned
      box(a.r + GAP, a.t, w, h),
      box(a.l - GAP - w, a.t, w, h),
      box(a.r + GAP, a.b - h, w, h),
      box(a.l - GAP - w, a.b - h, w, h),
      box(cx - w / 2, a.b + GAP + h + 4, w, h), // a second row below
      box(cx - w / 2, a.t - GAP - h * 2 - 4, w, h), // a second row above
    );
  } else if (it.kind === 'zone') {
    // The label rides the zone's dashed edge like a fieldset legend: slide it along
    // that edge before ever moving it off.
    const edgeT = it.nat.t;
    const edgeB = a.b - h / 2;
    const inset = Math.max(10, Math.min(24, wof(a) * 0.06));
    out.push(
      box(cx - w / 2, edgeT, w, h),
      box(a.r - inset - w, edgeT, w, h),
      box(a.l + inset, edgeB, w, h),
      box(cx - w / 2, edgeB, w, h),
      box(a.r - inset - w, edgeB, w, h),
      box(a.l + inset, a.t + GAP, w, h), // tucked inside the top of the zone
      box(a.l + inset, a.b - GAP - h, w, h),
    );
  } else {
    // Badge / lock pin: an interactive handle. Keep it on its piece — nudge it around
    // the corner it lives on, then try the other corners, then drift a little further.
    const home = it.nat;
    // the natural offset of the badge from its corner, mirrored onto the other three
    const dx = home.l - a.r;
    const dy = home.t - a.t;
    const mirrored = [box(a.l - w - dx, a.t + dy, w, h), box(a.r + dx, a.b - h - dy, w, h), box(a.l - w - dx, a.b - h - dy, w, h)];
    // Buried under a piece resting on it: a nudge off the corner floats the badge over the
    // *covering* piece, where it reads as that piece's count. An uncovered corner of its own
    // piece is the honest place, so try those first.
    if (occluded) out.push(...mirrored);
    for (const r of RING) out.push(box(home.l + r, home.t, w, h), box(home.l, home.t + r, w, h), box(home.l - r, home.t, w, h), box(home.l, home.t - r, w, h));
    if (!occluded) out.push(...mirrored);
    for (const r of RING) out.push(box(home.l + r, home.t + r, w, h), box(home.l - r, home.t + r, w, h), box(home.l + r, home.t - r, w, h), box(home.l - r, home.t - r, w, h));
    // Zoomed in far enough and the piece is bigger than the screen: its home corner is off
    // view, so every candidate above clamps to the *same* viewport corner and the handle has
    // no way to dodge the top bar. A handle rides its piece's corner — when that corner is
    // off screen, it rides the corner of the piece's visible area instead.
    const vis = { l: Math.max(a.l, view.l), t: Math.max(a.t, view.t), r: Math.min(a.r, view.r), b: Math.min(a.b, view.b) };
    const clipped = a.l < view.l - 1 || a.t < view.t - 1 || a.r > view.r + 1 || a.b > view.b + 1;
    // A sliver of piece is enough: the candidates below are clamped into the view like every
    // other, so a piece hanging off the left edge gets its handle beside the strip that shows.
    if (clipped && wof(vis) > 0 && hof(vis) > 0) {
      const P = 6;
      const vx = (vis.l + vis.r) / 2 - w / 2;
      const vy = (vis.t + vis.b) / 2 - h / 2;
      out.push(
        box(vis.r - w - P, vis.t + P, w, h), // the corner it normally lives on
        box(vx, vis.t + P, w, h),
        box(vis.l + P, vis.t + P, w, h),
        box(vis.r - w - P, vy, w, h),
        box(vis.l + P, vy, w, h),
        box(vis.r - w - P, vis.b - h - P, w, h),
        box(vx, vis.b - h - P, w, h),
        box(vis.l + P, vis.b - h - P, w, h),
      );
    }
    // Appended last, so nothing that already had a clean home-ring spot moves.
    for (const r of FAR_RING) {
      out.push(box(home.l + r, home.t, w, h), box(home.l, home.t + r, w, h), box(home.l - r, home.t, w, h), box(home.l, home.t - r, w, h));
      out.push(box(home.l + r, home.t + r, w, h), box(home.l - r, home.t + r, w, h), box(home.l + r, home.t - r, w, h), box(home.l - r, home.t - r, w, h));
    }
  }
  return out;
}

function apply(it: Item, at: Box) {
  const dx = at.l - it.nat.l;
  const dy = at.t - it.nat.t;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
    it.el.style.removeProperty('--nx');
    it.el.style.removeProperty('--ny');
    return;
  }
  // `--nx/--ny` are added *outside* the HUD's counter-scale, so one unit is one screen
  // pixel; the piece's own rotation is divided out so the nudge stays screen-aligned.
  const v = rotateVec({ x: dx, y: dy }, -it.rot);
  it.el.style.setProperty('--nx', `${v.x.toFixed(1)}px`);
  it.el.style.setProperty('--ny', `${v.y.toFixed(1)}px`);
}

export interface PlaceLabelsOpts {
  /** `.play-table` root. */
  root: HTMLElement;
  /** Box every label must stay inside (screen coords). */
  view: Box;
  /** Zone labels and captions are faded out entirely at this zoom — skip them. */
  farOut: boolean;
  /**
   * Place only these labels (names shown on demand), treating every label already on
   * screen as fixed. Nothing that is showing moves when a name appears or disappears.
   */
  only?: HTMLElement[];
}

export interface PlaceLabelsResult {
  placed: number;
  hidden: number;
  /** Residual overlaps the search could not remove (interactive items only). */
  unresolved: number;
}

/**
 * Re-place every on-table label for the camera as it stands right now.
 * Cheap enough to run on every camera-idle: two measurement passes, one write pass.
 */
/**
 * A zone name that wraps to two lines keeps its box at max-width, leaving a pill twice as wide
 * as its text. CSS can't shrink-wrap wrapped text, so size the pill to its widest line.
 */
function hugWrappedText(el: HTMLElement, rot: number) {
  el.style.removeProperty('width');
  if (Math.abs(rot % 360) > 0.5) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
  if (rects.length < 2 || Math.abs(rects[rects.length - 1].top - rects[0].top) < 2) return;
  const outer = el.getBoundingClientRect().width;
  const scale = el.offsetWidth ? outer / el.offsetWidth : 1;
  if (!(scale > 0)) return;
  const widest = Math.max(...rects.map((r) => r.width)) / scale;
  const cs = getComputedStyle(el);
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const w = Math.ceil(widest + pad + 1);
  if (w < el.offsetWidth - 2) el.style.width = `${w}px`;
}

const LABELS = '.play-badge, .play-lockpin, .play-zone__label, .play-caption';
const kindOf = (el: HTMLElement): Kind =>
  el.classList.contains('play-badge') ? 'badge' : el.classList.contains('play-lockpin') ? 'pin' : el.classList.contains('play-zone__label') ? 'zone' : 'caption';

export function placeLabels({ root, view, farOut, only }: PlaceLabelsOpts): PlaceLabelsResult {
  const world = root.querySelector<HTMLElement>('.play-world');
  if (!world) return { placed: 0, hidden: 0, unresolved: 0 };

  const all = only ? only.filter((el) => el.isConnected) : [...world.querySelectorAll<HTMLElement>(LABELS)];
  // 1. clear every previous decision so the natural rects are the real ones
  for (const el of all) {
    el.style.removeProperty('--nx');
    el.style.removeProperty('--ny');
    el.classList.remove('is-crowded', 'is-tight', 'is-offview');
  }

  // 2. measure (one reflow), and drop anything that can't be seen at all
  const items: Item[] = [];
  const offview: HTMLElement[] = [];
  const entEls = [...world.querySelectorAll<HTMLElement>('.play-ent[data-eid]')];
  const zOf = new Map(entEls.map((e, i) => [e, i]));
  for (const el of all) {
    const kind = kindOf(el);
    const peek = el.classList.contains('is-peek');
    if (farOut && (kind === 'zone' || kind === 'caption') && !peek) continue;
    const ent = el.closest<HTMLElement>('.play-ent');
    if (!ent || ent.classList.contains('is-hidden')) continue;
    const body = el.closest<HTMLElement>('.play-ent__body');
    if (!body) continue;
    const m = /rotate\(([-\d.]+)deg\)/.exec(ent.querySelector<HTMLElement>('.play-ent__rot')?.style.transform ?? '');
    if (kind === 'zone') hugWrappedText(el, m ? parseFloat(m[1]) : 0);
    const nat = fromRect(el.getBoundingClientRect());
    if (wof(nat) < 1 || hof(nat) < 1) continue;
    const anchor = fromRect(body.getBoundingClientRect());
    if (overlapArea(anchor, view) <= 0) {
      offview.push(el);
      continue;
    }
    items.push({ el, kind, anchor, nat, rot: m ? parseFloat(m[1]) : 0, z: zOf.get(ent) ?? -1, peek });
  }

  // Pieces drawn above a piece hide its handles. A count badge must never be buried under a
  // card resting on its stack, so for badges and pins every piece drawn later is an obstacle.
  const pieces = entEls.map((e) => {
    if (e.classList.contains('is-hidden') || e.classList.contains('play-ent--zone') || e.classList.contains('play-ent--board')) return null;
    const b = e.querySelector<HTMLElement>('.play-ent__body');
    return b ? fromRect(b.getBoundingClientRect()) : null;
  });
  const above = (it: Item): Box[] => {
    if (it.z < 0) return NONE;
    const reach = 140;
    const out: Box[] = [];
    for (let i = it.z + 1; i < pieces.length; i++) {
      const p = pieces[i];
      if (p && p.l < it.anchor.r + reach && p.r > it.anchor.l - reach && p.t < it.anchor.b + reach && p.b > it.anchor.t - reach) out.push(p);
    }
    return out;
  };

  // Soft obstacles: printed board art (captions only) and the fixed chrome.
  const boards = [...world.querySelectorAll<HTMLElement>('.play-ent--board .play-ent__body')].map((e) => fromRect(e.getBoundingClientRect()));
  // `.play-bar` is a SIBLING of `.play-table`, not a descendant, so searching inside `root`
  // found none of the top bar and "avoid the fixed chrome" quietly ignored the one piece of
  // chrome most likely to be in the way. Scope the search to the page instead.
  const chromeRoot = root.parentElement ?? root;
  const chrome = [...chromeRoot.querySelectorAll<HTMLElement>('.play-bar__group, .play-zoom, .play-hand__tab, .play-hand__card, .play-hand__shelf, .play-coach')].map((e) => fromRect(e.getBoundingClientRect()));

  // Zone labels first: they name a fixed region and ride its edge, so they have the
  // fewest honest alternatives — and a row of zone names reads badly when one of them
  // has wandered. Badges and pins go next (small, and ringed with alternatives, but
  // never hidden — they are handles); captions last, being the most expendable.
  const rank: Record<Kind, number> = { zone: 0, badge: 1, pin: 2, caption: 3 };
  // Names shown on demand go after everything else, so their coming and going never
  // changes where any permanent label lands.
  items.sort((a, b) => (a.peek ? 4 : 0) + rank[a.kind] - ((b.peek ? 4 : 0) + rank[b.kind]));

  const taken: Box[] = [];
  if (only) {
    // Partial pass: everything already showing stays exactly where it is, as an obstacle.
    const mine = new Set(all);
    for (const el of world.querySelectorAll<HTMLElement>(LABELS)) {
      if (mine.has(el) || el.classList.contains('is-crowded') || el.classList.contains('is-offview')) continue;
      if (farOut && !el.classList.contains('is-peek') && (kindOf(el) === 'zone' || kindOf(el) === 'caption')) continue;
      if (el.closest('.play-ent')?.classList.contains('is-hidden')) continue;
      const b = fromRect(el.getBoundingClientRect());
      if (wof(b) >= 1 && hof(b) >= 1) taken.push(b);
    }
  }
  const crowded: Item[] = [];
  let unresolved = 0;

  const score = (it: Item, c: Box, i: number): number => {
    let s = i;
    const area = Math.max(1, wof(c) * hof(c));
    if (it.kind === 'caption') {
      let onArt = 0;
      for (const b of boards) onArt += overlapArea(c, b);
      s += Math.min(1, onArt / area) * 40;
    }
    let onUi = 0;
    for (const b of chrome) onUi += overlapArea(c, b);
    s += Math.min(1, onUi / area) * 60;
    return s;
  };

  const place = (it: Item): boolean => {
    let best: Box | null = null;
    let bestScore = Infinity;
    let fallback: Box | null = null;
    let fallbackCost = Infinity;
    // A caption under the top bar is merely ugly; a *handle* under it cannot be pressed at
    // all, so for badges and pins the fixed chrome is a hard obstacle, not a score penalty.
    // This matters most when the piece is bigger than the screen: its home corner is then
    // off-view, every candidate clamps to the same viewport corner, and without this the
    // only whole-stack drag handle on touch parks itself beneath the top bar.
    const covering = it.kind === 'badge' || it.kind === 'pin' ? above(it) : NONE;
    const solid = covering.length ? [...chrome, ...covering] : it.kind === 'badge' || it.kind === 'pin' ? chrome : NONE;
    const cands = candidates(it, view, covering.some((p) => overlapArea(it.nat, p) > 0));
    for (let i = 0; i < cands.length; i++) {
      const c = clampInto(cands[i], view);
      let clash = 0;
      for (const t of taken) clash += overlapArea(c, t, PAD);
      for (const b of solid) clash += overlapArea(c, b);
      if (clash === 0) {
        const s = score(it, c, i);
        if (s < bestScore) {
          bestScore = s;
          best = c;
        }
        // preference order already encodes "good enough" — stop once a clean spot scores
        // better than any later candidate possibly could
        if (s <= i) break;
      } else if (clash < fallbackCost) {
        fallbackCost = clash;
        fallback = c;
      }
    }
    if (best) {
      apply(it, best);
      taken.push(best);
      return true;
    }
    if (it.kind === 'badge' || it.kind === 'pin' || it.peek) {
      // Never hide a control — nor a name the player asked to see. Take the least-bad spot.
      const at = fallback ?? clampInto(it.nat, view);
      apply(it, at);
      taken.push(at);
      unresolved++;
      return true;
    }
    return false;
  };

  for (const it of items) if (!place(it)) crowded.push(it);

  // 3. Second chance for the crowded text: a smaller pill often fits where the full one
  // didn't. Only then do we give up and hide it.
  let hidden = 0;
  if (crowded.length) {
    for (const it of crowded) it.el.classList.add('is-tight');
    for (const it of crowded) it.nat = fromRect(it.el.getBoundingClientRect());
    for (const it of crowded) {
      if (!place(it)) {
        it.el.classList.remove('is-tight');
        it.el.classList.add('is-crowded');
        hidden++;
      }
    }
  }
  for (const el of offview) el.classList.add('is-offview');

  return { placed: taken.length, hidden, unresolved };
}
