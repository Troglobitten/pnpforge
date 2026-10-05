/**
 * TableController — the non-React brain of a <TableView>.
 *
 * Owns the camera, all pointer / touch / keyboard gestures, the drag
 * ("carry") loop and every table action. Performance-critical work (camera
 * moves, carrying pieces, tilt springs) writes straight to DOM nodes; React
 * only re-renders the entities whose data actually changed.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { Camera, DieEntity, Entity, ID, StackEntity, TableState, TableTheme, ZoneEntity } from '@/shared/types';
import type { MenuItem } from '@/ui';
import { toast } from '@/ui';
import { playSound } from '@/lib/sound';
import { useSettings } from '@/state/settings';
import {
  K,
  MAX_ZOOM,
  MIN_ZOOM,
  tableDropTarget,
  asidePosition,
  carriedCategories,
  carriedFootprint,
  inZone,
  isEndless,
  pieceModeOf,
  placeInZone,
  reflowZones,
  refusingZoneAt,
  renderOrder,
  zoneLocal,
  zoneTakes,
  zoneWorld,
  STACK_MIN_SLACK_PX,
  applyDrop,
  cardDims,
  clamp,
  getComponent,
  getDeck,
  localBounds,
  ops,
  payloadOf,
  pointInEntity,
  rectsIntersect,
  rotateVec,
  sameTarget,
  stackSlots,
  stateBounds,
  worldAABB,
  type DragSource,
  type DropTarget,
  type Rect,
  type Vec,
} from '../engine';
import { baseSize } from '../engine/geometry';
import { ppmBucket, warmPieceRenderer } from '../pieces/render';
import { placeLabels, type Box } from './labels';
import { surface, type Layer } from './theme';
import { createTableUi, type GhostItem, type TableMode, type TableUi } from './store';
import { boxSelectHint, entityMenu, handMenu, tableMenu } from './menus';
import { FLING_FRESH_MS, FLING_SPEED, flingOf, isTray, planDiceThrow, releaseVelocity, throwBounds } from './throw';

/** The "Names shown / hidden" toast, so the next N press replaces it instead of stacking. */
let namesToast = 0;

export interface CommitMeta {
  label?: string;
  /** Consecutive commits with the same key (within ~1 s) collapse into one undo step. */
  coalesceKey?: string;
}

export interface TableViewCallbacks {
  mode: TableMode;
  onCommit: (next: TableState, meta?: CommitMeta) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCameraChange?: (c: Camera) => void;
  onSelectionChange?: (ids: ID[]) => void;
  onThemeChange?: (t: TableTheme) => void;
  onResetGame?: () => void;
  extraEntityMenuItems?: (e: Entity, ctl: TableController) => MenuItem[];
  extraTableMenuItems?: (at: Vec, ctl: TableController) => MenuItem[];
}

export interface SettleInfo {
  /** Offset (world px, unrotated) the piece animates in from. */
  dx: number;
  dy: number;
  mode: 'whole' | 'top' | 'spread';
  delay?: number;
}

type Hit = { area: 'table' } | { area: 'entity'; id: ID; part?: string; cardUid?: ID } | { area: 'hand'; uid: ID };

interface Pending {
  kind: 'pending';
  pointerId: number;
  pointerType: string;
  hit: Hit;
  sx: number;
  sy: number;
  shift: boolean;
  meta: boolean;
  lp?: number;
  repeat?: number;
  repeated?: boolean;
}
interface PanG {
  kind: 'pan';
  pointerId: number;
  lx: number;
  ly: number;
  lt: number;
  vx: number;
  vy: number;
}
interface PinchG {
  kind: 'pinch';
  a: number;
  b: number;
  d0: number;
  z0: number;
  world: Vec;
}
interface MarqueeG {
  kind: 'marquee';
  pointerId: number;
  sx: number;
  sy: number;
  additive: boolean;
}
interface CarryG {
  kind: 'carry';
  pointerId: number;
}
interface DoneG {
  kind: 'done';
  pointerId: number;
}
/** Touch: held on bare table until the menu opened. Dragging on from here box-selects. */
interface HeldG {
  kind: 'held';
  pointerId: number;
  sx: number;
  sy: number;
}
type Gesture = Pending | PanG | PinchG | MarqueeG | CarryG | DoneG | HeldG;

interface Carry {
  source: DragSource;
  pointerId: number;
  grab: Vec;
  px: number;
  py: number;
  lx: number;
  ly: number;
  lt: number;
  /** Smoothed pointer velocity, px/ms. Sampled on every pointermove, NOT in rAF —
   *  a flick can be over in less than one frame. */
  vx: number;
  vy: number;
  /** Handling time (performance.now) of the last real pointermove — for the frame loop. */
  mt: number;
  /** Input time (event.timeStamp) of that move — a fling counts if the RELEASE came soon after
   *  it, measured on the same clock, however late a busy main thread got to handle either. */
  mtEv: number;
  tiltX: number;
  tiltY: number;
  tvx: number;
  tvy: number;
  target: DropTarget | null;
  /** Stack the carried card(s) came from — dropping back there cancels. */
  homeStack?: ID;
  overHand: boolean;
  /** Carried by a finger (not a mouse / pen): larger stacking tolerance floor. */
  touch: boolean;
  cardH: number;
  lastFrame: number;
  /** When the pointer entered the edge auto-pan band (0 = not in it). Auto-pan only
   *  starts after a deliberate dwell, so a flick that grazes an edge never pans. */
  edgeSince: number;
  /**
   * A handful of dice is carried as the pieces themselves (translated every frame), not as a
   * ghost: mounting thirty ghost dice and hiding thirty originals stalled the pickup ~150 ms at
   * CPU×1 (~1 s at ×4), long enough to swallow the flick that follows.
   */
  live: { el: HTMLElement; base: string; x: number; y: number }[];
  /** World position of the carried anchor piece when it was picked up. */
  origin: Vec;
  /** Pointer position the drop target was last computed for (release skips an identical recompute). */
  tpx: number;
  tpy: number;
  /** Recent pointer samples (client px, input timestamps) — the release speed is read from these. */
  samples: { x: number; y: number; t: number }[];
}

const HOLD_MS = 450;
const DOUBLE_MS = 340;
// FLING_SPEED / FLING_FRESH_MS / release velocity / throw planning live in ./throw (pure, tested).
/** Fraction of the viewport the table must always occupy — you can never pan it away. */
const KEEP_VISIBLE = 0.55;
/** Hold a carried piece against the edge this long before the table starts to slide. */
const EDGE_PAN_DWELL_MS = 220;
/** Edge auto-pan speed, screen px per ms (~11 px per 60 Hz frame) at any zoom. */
const EDGE_PAN_SPEED = 0.7;
const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One painted tiling: its DOM node, its layer, and the last values written. */
interface SurfaceTile {
  el: HTMLDivElement;
  s: Layer;
  size: string;
  tr: string;
}

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"]');
}

export class TableController {
  readonly ui: StoreApi<TableUi>;
  props: TableViewCallbacks;

  root: HTMLDivElement | null = null;
  world: HTMLDivElement | null = null;
  surface: HTMLDivElement | null = null;
  ghostEl: HTMLDivElement | null = null;
  ghostScaleEl: HTMLDivElement | null = null;
  ghostTiltEl: HTMLDivElement | null = null;
  marqueeEl: HTMLDivElement | null = null;

  camera: Camera = { x: 0, y: 0, zoom: 2 };
  /** The zone currently showing "won't take this" while carrying. */
  private refuseId: ID | null = null;
  rect = { left: 0, top: 0, width: 1, height: 1 };

  readonly settleFrom = new Map<ID, SettleInfo>();
  /** Thrown dice: where each left the hand (world px), for the roll whose rollSeq is `seq`. */
  readonly launches = new Map<ID, { seq: number; x: number; y: number }>();
  readonly handArrivals = new Map<ID, { x: number; y: number; scale: number; delay: number }>();
  /** Registered by the hand tray: insertion index for a pointer x. */
  handIndexAt: ((clientX: number) => number) | null = null;
  handCardH = 150;
  handTrayH = 170;
  private handChromeH = 0;

  hoverId: ID | null = null;
  hoverHandUid: ID | null = null;
  lastStackId: ID | null = null;

  private gesture: Gesture | null = null;
  private carry: Carry | null = null;
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private lastTap: { key: string; t: number; x: number; y: number } | null = null;
  private raf = 0;
  private camAnim = 0;
  private inertia = 0;
  private camIdleTimer = 0;
  private camEmitTimer = 0;
  private labelTimer = 0;
  private seq = 1;
  private camListeners = new Set<() => void>();
  private detachFns: (() => void)[] = [];
  private coarse = false;
  private tiles: SurfaceTile[] = [];
  private lastOffset = { ox: 0, oy: 0 };
  private lastHud = '';
  private lastHudI = '';
  private lastPx = '';
  private lastFar = false;
  private labelRetries = 0;
  private theme: TableTheme | undefined;

  constructor(props: TableViewCallbacks, init: Pick<TableUi, 'game' | 'state'>) {
    this.props = props;
    this.theme = init.game.table?.theme;
    this.ui = createTableUi({ mode: props.mode, ...init });
    // compile the piece renderer in the background so the first piece on this table appears at once
    if (init.game.components.some((c) => c.kind === 'piece')) warmPieceRenderer();
  }

  /* ================================================================ */
  /* Accessors                                                          */
  /* ================================================================ */

  get state() {
    return this.ui.getState().state;
  }
  get game() {
    return this.ui.getState().game;
  }
  get mode() {
    return this.ui.getState().mode;
  }
  nextSeq() {
    return this.seq++;
  }
  /** A finger-first device (menus word their hints for touch). */
  get coarsePointer() {
    return this.coarse;
  }

  setRoot = (el: HTMLDivElement | null) => {
    this.root = el;
    // React attaches this ref *after* the children's layout effects, so the hand tray's
    // own attempt to write --hand-h landed on a null root and the floating zoom buttons
    // stayed pinned to the bottom of the window, underneath the tray. Re-apply here.
    if (el) el.style.setProperty('--hand-h', `${this.handChromeH}px`);
  };
  /** Height the hand tray occupies; the floating chrome sits above it. */
  setHandChromeHeight(px: number) {
    this.handChromeH = px;
    this.root?.style.setProperty('--hand-h', `${px}px`);
  }
  setWorld = (el: HTMLDivElement | null) => {
    this.world = el;
  };
  setSurface = (el: HTMLDivElement | null) => {
    this.surface = el;
    this.buildSurface();
  };

  /**
   * One element carrying the material's photograph. React renders `.play-surface`
   * empty and never looks inside it: this is pure paint, it changes only when the
   * material does, and it is written to on every camera frame — which is exactly
   * the work React should not be in the middle of.
   */
  private buildSurface() {
    const host = this.surface;
    this.tiles = [];
    if (!host) return;
    host.replaceChildren();
    const { sharp, broad } = surface(this.theme);
    // broad first: it paints underneath, and it is the quieter of the two
    for (const s of [broad, sharp]) {
      const el = document.createElement('div');
      el.className = 'play-surface__band';
      el.style.backgroundImage = s.image;
      el.style.mixBlendMode = 'soft-light';
      el.style.opacity = String(s.alpha);
      host.appendChild(el);
      this.tiles.push({ el, s, size: '', tr: '' });
    }
  }
  setGhostEl = (el: HTMLDivElement | null) => {
    this.ghostEl = el;
  };
  private refuseEl: HTMLDivElement | null = null;
  setRefuseEl = (el: HTMLDivElement | null) => {
    this.refuseEl = el;
  };

  /**
   * The "Takes … only" pill is screen UI: above the carried piece (above the finger on touch), or below
   * it when there's no room, always inside the table's visible area — never under the bars or off screen.
   */
  private positionRefuse(c: Carry) {
    const el = this.refuseEl;
    if (!el || !this.refuseId || el.hidden) return;
    const r = this.rect;
    const z = this.camera.zoom;
    const fp = carriedFootprint(this.game, this.state, c.source, { x: 0, y: 0 });
    const half = fp ? (Math.max(fp.w, fp.h) / 2) * z : 20;
    const cx = c.px + c.grab.x * z;
    const cy = c.py + c.grab.y * z;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const ins = this.insets();
    const gap = 14;
    let top = Math.min(cy - half, c.touch ? c.py - 56 : cy - half) - gap - h;
    const minY = r.top + Math.max(ins.t, 60) + 8;
    const maxY = r.top + r.height - 8 - h;
    if (top < minY) top = Math.max(cy + half, c.touch ? c.py + 40 : cy + half) + gap;
    top = clamp(top, minY, Math.max(minY, maxY));
    const left = clamp(cx - w / 2, r.left + 12, r.left + r.width - 12 - w);
    el.style.transform = `translate3d(${(left - r.left).toFixed(1)}px, ${(top - r.top).toFixed(1)}px, 0)`;
    el.classList.add('is-placed');
  }
  setGhostScaleEl = (el: HTMLDivElement | null) => {
    this.ghostScaleEl = el;
  };
  setGhostTiltEl = (el: HTMLDivElement | null) => {
    this.ghostTiltEl = el;
  };
  setMarqueeEl = (el: HTMLDivElement | null) => {
    this.marqueeEl = el;
  };

  /** Commit a new TableState (immediately visible, then reported to the owner). */
  commit(next: TableState, meta?: CommitMeta, uiPatch?: Partial<TableUi>) {
    const prev = this.state;
    if (next === prev && !uiPatch) return;
    let patch = uiPatch;
    if (next !== prev) {
      // pool / stack zones stay neatly laid out whatever changed (an item taken out, a supply put in)
      const rf = reflowZones(this.game, next);
      if (rf.moved.size) {
        next = rf.state;
        const settle = { ...(uiPatch?.settle ?? this.ui.getState().settle) };
        const ids: ID[] = [];
        for (const [id, from] of rf.moved) {
          const en = next.entities[id];
          if (!en || this.launches.has(id)) continue;
          // each piece glides from its old slot, with a tiny stagger in reading order
          if (!this.settleFrom.has(id)) this.settleFrom.set(id, { dx: (from.x - en.x) * K, dy: (from.y - en.y) * K, mode: 'whole', delay: Math.min(ids.length * 18, 110) });
          settle[id] = this.nextSeq();
          ids.push(id);
        }
        patch = { ...(uiPatch ?? {}), settle };
        if (ids.length) this.scheduleSettleClear(ids);
      }
    }
    this.ui.setState({ ...(patch ?? {}), state: next, selection: this.pruneSelection(next) });
    if (next !== prev) this.props.onCommit(next, meta);
  }

  private pruneSelection(s: TableState) {
    const sel = this.ui.getState().selection;
    let changed = false;
    const out: Record<ID, true> = {};
    for (const id of Object.keys(sel)) {
      if (s.entities[id]) out[id] = true;
      else changed = true;
    }
    return changed ? out : sel;
  }

  /** Called by <TableView> every render with fresh props. */
  sync(props: TableViewCallbacks, game: TableUi['game'], state: TableState) {
    this.props = props;
    const cur = this.ui.getState();
    const patch: Partial<TableUi> = {};
    if (cur.game !== game) patch.game = game;
    if (cur.mode !== props.mode) patch.mode = props.mode;
    if (cur.state !== state) {
      patch.state = state;
      patch.selection = this.pruneSelection(state);
      if (this.carry) this.cancelCarry();
    }
    if (Object.keys(patch).length) this.ui.setState(patch);
    if (patch.state) this.scheduleLabels();
    if (game.table?.theme !== this.theme) {
      this.theme = game.table?.theme;
      this.buildSurface();
      this.applyCamera(false);
    }
  }

  /* ================================================================ */
  /* Lifecycle                                                          */
  /* ================================================================ */

  attach(initialCamera?: Camera | null) {
    const root = this.root!;
    this.coarse = matchMedia('(pointer: coarse)').matches;
    this.measure();
    if (initialCamera && Number.isFinite(initialCamera.zoom) && initialCamera.zoom > 0) {
      // A camera saved on a 1440-wide desktop can leave the table off-screen on a tablet;
      // the clamp is a no-op for a normal camera, so a same-device reload is untouched.
      this.camera = this.clampedCamera({ ...initialCamera, zoom: clamp(initialCamera.zoom, MIN_ZOOM, MAX_ZOOM) });
      this.applyCamera(false);
    } else {
      this.fitAll(false);
    }

    const on = <T extends Event>(t: EventTarget, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.detachFns.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    on<PointerEvent>(window, 'pointermove', this.onPointerMove, { passive: true });
    on<PointerEvent>(window, 'pointerup', this.onPointerUp);
    on<PointerEvent>(window, 'pointercancel', this.onPointerCancel);
    on<WheelEvent>(root, 'wheel', this.onWheel, { passive: false });
    on<MouseEvent>(root, 'contextmenu', this.onContextMenu);
    on<KeyboardEvent>(window, 'keydown', this.onKeyDown);
    on<KeyboardEvent>(window, 'keyup', this.onKeyUp);
    on<Event>(window, 'blur', () => {
      this.ui.setState({ spaceHeld: false });
      if (this.ui.getState().inspect && !this.ui.getState().inspect!.sticky) this.ui.setState({ inspect: null });
    });
    // iOS: stop the page from rubber-banding / zooming while playing
    on<TouchEvent>(root, 'touchmove', (e) => e.preventDefault(), { passive: false });
    on<Event>(root, 'gesturestart', (e) => e.preventDefault());

    const ro = new ResizeObserver(() => {
      this.measure();
      this.applyCamera(false);
      // a new window size is a new screen-space layout for every label
      this.scheduleLabels();
    });
    ro.observe(root);
    this.detachFns.push(() => ro.disconnect());

    let prevSel = this.ui.getState().selection;
    this.detachFns.push(
      this.ui.subscribe((s) => {
        if (s.selection !== prevSel) {
          prevSel = s.selection;
          this.props.onSelectionChange?.(Object.keys(s.selection));
        }
      }),
    );
  }

  detach() {
    this.detachFns.forEach((f) => f());
    this.detachFns = [];
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.camAnim);
    cancelAnimationFrame(this.inertia);
    window.clearTimeout(this.camIdleTimer);
    window.clearTimeout(this.camEmitTimer);
    window.clearTimeout(this.labelTimer);
  }

  measure() {
    if (!this.root) return;
    const r = this.root.getBoundingClientRect();
    this.rect = { left: r.left, top: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  /* ================================================================ */
  /* Camera                                                             */
  /* ================================================================ */

  subscribeCamera = (fn: () => void) => {
    this.camListeners.add(fn);
    return () => this.camListeners.delete(fn);
  };

  screenToWorld(clientX: number, clientY: number): Vec {
    const r = this.rect;
    const { x, y, zoom } = this.camera;
    return { x: x + (clientX - r.left - r.width / 2) / zoom, y: y + (clientY - r.top - r.height / 2) / zoom };
  }

  worldToScreen(p: Vec): Vec {
    const r = this.rect;
    const { x, y, zoom } = this.camera;
    return { x: r.left + r.width / 2 + (p.x - x) * zoom, y: r.top + r.height / 2 + (p.y - y) * zoom };
  }

  applyCamera(moving = true) {
    const w = this.world;
    if (!w) return;
    const { x, y, zoom } = this.camera;
    const r = this.rect;
    const ox = r.width / 2 - x * zoom;
    const oy = r.height / 2 - y * zoom;
    w.style.transform = `translate3d(${ox.toFixed(2)}px, ${oy.toFixed(2)}px, 0) scale(${(zoom / K).toFixed(5)})`;
    // Two counter-scales, not one. `--hud` keeps its upper cap so that at far zoom-out the
    // *decorative* chrome (captions, zone labels) shrinks with the table instead of dwarfing
    // the pieces it names. But the cap makes anything wearing it lose on-screen size once it
    // bites, and the count badge is the ONLY whole-stack drag handle on touch — a handle that
    // shrinks to 17 px is not a handle. `--hud-i` is the same scale with no upper cap, so an
    // interactive HUD element holds a constant screen size at every zoom (24 px fine /
    // 44.8 px coarse), the same screen-px floor `.play-hit` already gives small pieces.
    const base = Math.max(K / zoom, 0.3);
    const f = this.coarse ? 1.4 : 1;
    const hud = Math.min(base, 3) * f;
    const hs = hud.toFixed(3);
    if (hs !== this.lastHud) {
      this.lastHud = hs;
      w.style.setProperty('--hud', hs);
    }
    const his = (base * f).toFixed(3);
    if (his !== this.lastHudI) {
      this.lastHudI = his;
      w.style.setProperty('--hud-i', his);
    }
    // `--px` must track the zoom *un*clamped — it is the world-px-per-screen-px factor that
    // sizes hit pads and converts placeLabels()' screen-space nudges. Tying it to the clamped
    // `--hud` above froze it once the clamp bit (zoom < 1.33), which put every nudged label
    // and every touch pad out by the ratio of the stale value to the real one.
    const ps = (K / zoom).toFixed(4);
    if (ps !== this.lastPx) {
      this.lastPx = ps;
      w.style.setProperty('--px', ps);
    }
    // Zoomed so far out that even pill-backed labels are bigger than the pieces they
    // name — only then does the printed board speak for itself.
    const far = zoom < 0.8;
    if (far !== this.lastFar) {
      this.lastFar = far;
      this.root?.classList.toggle('is-far', far);
    }
    this.paintSurface(ox, oy, zoom);
    this.lastOffset = { ox, oy };
    if (moving) {
      if (w.style.willChange !== 'transform') w.style.willChange = 'transform';
      window.clearTimeout(this.camIdleTimer);
      this.camIdleTimer = window.setTimeout(() => {
        // drop the compositor hint so the browser re-rasterises crisply at the new scale
        if (this.world) this.world.style.willChange = 'auto';
        this.updatePieceRes();
        this.resolveLabels();
      }, 160);
    } else {
      this.updatePieceRes();
      window.clearTimeout(this.camEmitTimer);
      this.camEmitTimer = window.setTimeout(() => this.props.onCameraChange?.({ ...this.camera }), 400);
    }
    this.camListeners.forEach((l) => l());
  }

  /**
   * Paint the table surface for this camera.
   *
   * The grain belongs to the *table*, so the tile is a fixed number of millimetres
   * and its screen size is exactly `period × zoom` — continuous, never quantised.
   * A knot therefore stays under the same card from MIN_ZOOM to MAX_ZOOM.
   *
   * One photograph, tiled, and that is all. The three-copy stack this replaced
   * (each copy fading and re-rendering at its own moments) was inherited from the
   * procedural materials, and with a real photograph it bought a less countable
   * repeat at the price of texture that crawled while you zoomed.
   */
  private paintSurface(ox: number, oy: number, zoom: number) {
    for (const t of this.tiles) {
      const tw = t.s.pw * zoom;
      const th = t.s.ph * zoom;
      const size = `${tw.toFixed(2)}px ${th.toFixed(2)}px`;
      if (size !== t.size) {
        t.size = size;
        t.el.style.backgroundSize = size;
      }
      // start one whole tile before the viewport so it covers at any offset
      const sx = (((ox % tw) + tw) % tw) - tw;
      const sy = (((oy % th) + th) % th) - th;
      const tr = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
      if (tr !== t.tr) {
        t.tr = tr;
        t.el.style.transform = tr;
      }
    }
  }

  /**
   * Zone labels, stack captions, count badges and lock pins all hold a constant
   * on-screen size while the pieces shrink with the camera, so *where* they fit is a
   * question only the current zoom can answer. Re-solve the whole set in screen space
   * whenever the camera settles or the table changes. See table/labels.ts.
   */
  private labelView(): Box | null {
    // The same margin the floating chrome respects, so no pill is ever half off-screen.
    const m = 6;
    const r = this.rect;
    const view: Box = {
      l: Math.max(0, r.left) + m,
      t: Math.max(0, r.top) + m,
      r: Math.min(window.innerWidth, r.left + r.width) - m,
      b: Math.min(window.innerHeight, r.top + r.height) - m,
    };
    return view.r - view.l < 40 || view.b - view.t < 40 ? null : view;
  }

  resolveLabels = () => {
    const root = this.root;
    if (!root) return;
    const view = this.labelView();
    if (!view) return;
    // Pieces are measured as obstacles for badges: wait for a settle / aside slide to finish,
    // or the piece is measured where it was released rather than where it rests. A label's
    // own fade-in moves nothing, so it doesn't count.
    const world = root.querySelector('.play-world');
    const moving = world?.getAnimations?.({ subtree: true }).some((a) => {
      if (a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity) return false;
      const target = (a.effect as KeyframeEffect | null)?.target as Element | null | undefined;
      return !target?.closest?.('.play-hud, .play-zone__label');
    });
    if (moving && this.labelRetries++ < 12) {
      this.labelTimer = window.setTimeout(this.resolveLabels, 90);
      return;
    }
    this.labelRetries = 0;
    placeLabels({ root, view, farOut: this.lastFar });
  };

  /**
   * Place name labels that just appeared on demand (names setting off: hover, selection,
   * drop target) around everything already on screen, without moving any of it.
   */
  placePeekLabels(els: HTMLElement[]) {
    const root = this.root;
    const view = this.labelView();
    if (!root || !view) return;
    placeLabels({ root, view, farOut: this.lastFar, only: els });
  }

  /** Mirror the app setting for this mode (called by <TableView>). */
  setNames(v: boolean) {
    if (this.ui.getState().names === v) return;
    window.clearTimeout(this.peekTimer);
    this.ui.setState({ names: v, peek: null });
  }

  /** N: flip the "show names on the table" setting for this mode. */
  toggleNames() {
    const v = !this.ui.getState().names;
    useSettings.getState().set(this.mode === 'setup' ? { showNamesSetup: v } : { showNamesPlay: v });
    // One toast, replaced on every press — mashing N never stacks them over the board.
    toast.dismiss(namesToast);
    namesToast = toast(v ? 'Names shown on the table' : 'Names hidden', {
      description: v ? 'Press N to hide them again.' : 'Point at or tap a piece to see its name. Press N to show them all.',
      duration: 2200,
    });
  }

  private peekTimer = 0;
  private hasName(e: Entity | undefined): boolean {
    if (!e) return false;
    if (e.kind === 'zone') return !!(e.label || e.forceFace);
    if (e.kind === 'stack') return !!e.name;
    return (e.kind === 'token' || e.kind === 'piece') && !!e.infinite;
  }

  /**
   * Hover (mouse) while names are off. The first reveal waits a short dwell so a sweep across
   * the table stays quiet; once a name is showing, moving onto a neighbour swaps it at once, and
   * leaving keeps it for a beat so crossing the gap between two pieces doesn't blink.
   */
  private updatePeek(id: ID | null) {
    const cur = this.ui.getState();
    if (cur.names) return;
    const named = id && this.hasName(this.state.entities[id]) ? id : null;
    window.clearTimeout(this.peekTimer);
    if (cur.peek === named) return;
    if (named) {
      if (cur.peek) this.ui.setState({ peek: named });
      else this.peekTimer = window.setTimeout(() => this.ui.setState({ peek: named }), 260);
    } else if (cur.peek) {
      this.peekTimer = window.setTimeout(() => this.ui.setState({ peek: null }), 200);
    }
  }

  /**
   * A tap on something that doesn't select (a locked zone or board) says what it is for a
   * moment — on a tablet there is no hover, and names-off must never hide identity.
   */
  private flashName(id: ID) {
    const cur = this.ui.getState();
    if (cur.names || !this.hasName(this.state.entities[id])) return;
    window.clearTimeout(this.peekTimer);
    if (cur.peek !== id) this.ui.setState({ peek: id });
    this.peekTimer = window.setTimeout(() => {
      if (this.ui.getState().peek === id && this.hoverId !== id) this.ui.setState({ peek: null });
    }, 1800);
  }

  private scheduleLabels() {
    window.clearTimeout(this.labelTimer);
    this.labelTimer = window.setTimeout(this.resolveLabels, 120);
  }

  setCamera(c: Camera, animate = false, duration = 360) {
    cancelAnimationFrame(this.camAnim);
    cancelAnimationFrame(this.inertia);
    const to = { x: c.x, y: c.y, zoom: clamp(c.zoom, MIN_ZOOM, MAX_ZOOM) };
    if (!animate || reduceMotion()) {
      this.camera = to;
      this.applyCamera();
      return;
    }
    const from = { ...this.camera };
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const k = 1 - Math.pow(1 - t, 3);
      this.camera = {
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        zoom: from.zoom * Math.pow(to.zoom / from.zoom, k),
      };
      this.applyCamera();
      if (t < 1) this.camAnim = requestAnimationFrame(step);
    };
    this.camAnim = requestAnimationFrame(step);
  }

  zoomAt(clientX: number, clientY: number, factor: number, animate = false) {
    const z = clamp(this.camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const p = this.screenToWorld(clientX, clientY);
    const r = this.rect;
    const cx = p.x - (clientX - r.left - r.width / 2) / z;
    const cy = p.y - (clientY - r.top - r.height / 2) / z;
    this.setCamera({ x: cx, y: cy, zoom: z }, animate, 220);
  }

  zoomBy(factor: number) {
    const r = this.rect;
    const ins = this.insets();
    this.zoomAt(r.left + (r.width + ins.l - ins.r) / 2, r.top + (r.height + ins.t - ins.b) / 2, factor, true);
  }

  insets() {
    const handOpen = this.mode === 'play' && !this.ui.getState().handCollapsed;
    const narrow = this.rect.width < 900;
    return { t: 76, b: this.mode === 'play' ? (handOpen ? this.handTrayH + 12 : 70) : 24, l: 24, r: narrow ? 70 : 84 };
  }

  fitRect(rect: Rect, animate = true, maxZoom = 5, fill = false) {
    const r = this.rect;
    const ins = this.insets();
    const aw = Math.max(80, r.width - ins.l - ins.r);
    const ah = Math.max(80, r.height - ins.t - ins.b);
    const contain = Math.min(aw / Math.max(rect.w, 1), ah / Math.max(rect.h, 1));
    let zoom = contain;
    if (fill) {
      // A landscape table letterboxed into a portrait window wastes most of the screen and
      // shrinks every piece below the touch floor. Spend the slack: grow until the content
      // fills the *window* (it may slide under the zoom buttons), never past a cover fit,
      // and never so far that anything is cropped.
      // Grow sideways into the window margins (only floating zoom buttons live there,
      // with 40 px of breathing room so a wide caption isn't sliced) but NEVER past the
      // height the top bar and the hand leave free — those actually cover the table.
      const full = Math.min((r.width - 40) / Math.max(rect.w, 1), ah / Math.max(rect.h, 1));
      const cover = Math.max(aw / Math.max(rect.w, 1), ah / Math.max(rect.h, 1));
      zoom = clamp(Math.max(contain, Math.min(full, cover)), contain, contain * 2.2);
    }
    zoom = clamp(zoom, MIN_ZOOM, maxZoom);
    // If the content is wider/taller than the inset area, centre it in the whole window
    // instead of pushing it under the opposite edge.
    const bx = rect.w * zoom > aw ? 0 : (ins.l - ins.r) / (2 * zoom);
    const by = rect.h * zoom > ah ? 0 : (ins.t - ins.b) / (2 * zoom);
    this.setCamera({ x: rect.x + rect.w / 2 - bx, y: rect.y + rect.h / 2 - by, zoom }, animate, 420);
  }

  fitAll(animate = true) {
    const b = stateBounds(this.game, this.state);
    if (!b) {
      this.setCamera({ x: 0, y: 0, zoom: 2.4 }, animate);
      return;
    }
    const pad = 12;
    this.fitRect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, animate, 5, true);
  }

  /** Visible world rectangle (mm) for the current camera. */
  viewWorldRect(): Rect {
    const r = this.rect;
    const { x, y, zoom } = this.camera;
    return { x: x - r.width / (2 * zoom), y: y - r.height / (2 * zoom), w: r.width / zoom, h: r.height / zoom };
  }

  /**
   * Keep the table on screen. A hard flick used to be able to throw the whole game
   * into the wood; now the content bounds always overlap the viewport.
   */
  private clampedCamera(c: Camera): Camera {
    const b = stateBounds(this.game, this.state);
    if (!b) return c;
    const r = this.rect;
    // The table must always cover a decent share of the screen: you can push it to the
    // side to read the rules, never off into the wood.
    const axis = (pos: number, lo: number, size: number, view: number) => {
      const need = Math.min(size, view * KEEP_VISIBLE);
      const min = lo - view / 2 + need;
      const max = lo + size + view / 2 - need;
      return min > max ? lo + size / 2 : clamp(pos, min, max);
    };
    return {
      zoom: c.zoom,
      x: axis(c.x, b.x, b.w, r.width / c.zoom),
      y: axis(c.y, b.y, b.h, r.height / c.zoom),
    };
  }

  /**
   * Clamp a world point into the part of the table you can actually see — inside the
   * chrome, not under the top bar or the hand. A hard throw lands on the table, always.
   */
  clampToTable(p: Vec, margin = 8): Vec {
    const a = this.landingArea(margin);
    return { x: clamp(p.x, a.x, a.x + a.w), y: clamp(p.y, a.y, a.y + a.h) };
  }

  /**
   * How far up from the bottom of the table the bottom chrome reaches right now (px): the dice bar,
   * the hand tab and its hint. Nothing may land underneath them.
   */
  private chromeKeepOut(pad = 6): Rect[] {
    const root = this.root;
    if (!root) return [];
    const bottom = this.rect.top + this.rect.height;
    const out: Rect[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('.play-hand__tab, .play-hand__empty, .play-hand__card, .play-dicebar, .play-zoom')) {
      const b = el.getBoundingClientRect();
      const top = Math.max(b.top, this.rect.top);
      if (!b.width || !b.height || top >= bottom) continue;
      // down to the table's edge: all of these sit at the bottom, and a die squeezed underneath
      // one would still be hidden
      const a = this.screenToWorld(b.left - pad, top - pad);
      const z = this.screenToWorld(b.right + pad, bottom);
      out.push({ x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y });
    }
    return out;
  }

  /**
   * Tokens, counters and notes dropped along with a throw: nudge each clear of the dice, tokens,
   * counters and notes it would otherwise cover (cards stay fair game — markers sit on cards).
   */
  private clearOfPieces(s: TableState, ids: ID[]): TableState {
    const area = this.landingArea(2);
    const moving = new Set(ids);
    let next = s;
    for (const id of ids) {
      const e = next.entities[id];
      if (!e || (e.kind !== 'token' && e.kind !== 'counter' && e.kind !== 'note' && e.kind !== 'piece')) continue;
      const others = Object.values(next.entities)
        .filter((o) => !moving.has(o.id) && (o.kind === 'die' || o.kind === 'token' || o.kind === 'counter' || o.kind === 'note' || o.kind === 'piece'))
        .map((o) => worldAABB(this.game, o));
      const box = worldAABB(this.game, e);
      const hits = (dx: number, dy: number) => others.some((q) => rectsIntersect({ x: box.x + dx, y: box.y + dy, w: box.w, h: box.h }, q));
      if (!hits(0, 0)) continue;
      const step = Math.max(box.w, box.h) * 0.5;
      let found: Vec | null = null;
      for (let ring = 1; ring <= 8 && !found; ring++) {
        for (let k = 0; k < 8; k++) {
          const ang = (k / 8) * Math.PI * 2;
          const dx = Math.cos(ang) * step * ring;
          const dy = Math.sin(ang) * step * ring;
          const cx = e.x + dx;
          const cy = e.y + dy;
          if (cx < area.x || cx > area.x + area.w || cy < area.y || cy > area.y + area.h) continue;
          if (!hits(dx, dy)) {
            found = { x: dx, y: dy };
            break;
          }
        }
      }
      if (found) next = ops.translateEntities(next, [id], found.x, found.y);
    }
    return next;
  }

  /** The part of the table a piece may land on (mm): on screen, clear of the chrome, near the game. */
  landingArea(margin = 8): Rect {
    const r = this.rect;
    const z = this.camera.zoom;
    // Only what is actually drawn at the bottom is off-limits (chromeKeepOut), not a tray-high band:
    // an empty or collapsed hand is just a tint over the table.
    const ins = { ...this.insets(), b: 12 };
    const v: Rect = {
      x: this.camera.x + (ins.l - r.width / 2) / z,
      y: this.camera.y + (ins.t - r.height / 2) / z,
      w: Math.max(40, (r.width - ins.l - ins.r) / z),
      h: Math.max(40, (r.height - ins.t - ins.b) / z),
    };
    // near the game — but a dice tray never widens where a throw may land (it would stretch throws toward it)
    const b = throwBounds(this.game, this.state);
    const span =(lo: number, size: number, bLo?: number, bSize?: number) => {
      let a = lo + margin;
      let z1 = lo + size - margin;
      if (bLo !== undefined && bSize !== undefined) {
        a = Math.max(a, bLo - 60);
        z1 = Math.min(z1, bLo + bSize + 60);
      }
      return a > z1 ? [lo + size / 2, lo + size / 2] : [a, z1];
    };
    const [xa, xb] = span(v.x, v.w, b?.x, b?.w);
    const [ya, yb] = span(v.y, v.h, b?.y, b?.h);
    return { x: xa, y: ya, w: xb - xa, h: yb - ya };
  }

  /** World point at the middle of the free table area (not under the chrome / hand). */
  viewCenterWorld(): Vec {
    const r = this.rect;
    const ins = this.insets();
    return this.screenToWorld(r.left + (r.width + ins.l - ins.r) / 2, r.top + (r.height + ins.t - ins.b) / 2);
  }

  /* ================================================================ */
  /* Pointer input                                                      */
  /* ================================================================ */

  private hitFromTarget(t: HTMLElement): Hit {
    const handEl = t.closest<HTMLElement>('[data-hand-uid]');
    if (handEl) return { area: 'hand', uid: handEl.dataset.handUid! };
    const entEl = t.closest<HTMLElement>('[data-eid]');
    if (entEl && entEl.closest('.play-world')) {
      const part = t.closest<HTMLElement>('[data-part]')?.dataset.part;
      const cardUid = t.closest<HTMLElement>('[data-card-uid]')?.dataset.cardUid;
      return { area: 'entity', id: entEl.dataset.eid!, part, cardUid };
    }
    return { area: 'table' };
  }

  /**
   * What a press at (x, y) is aimed at. The DOM target alone is not enough: a small piece's invisible
   * touch pad (`.play-hit`) reaches past its body and can sit above a neighbour's visible body — a die
   * beside a meeple, say. So: any entity whose drawn body is under the point wins (topmost first); only
   * when the point is on pads alone does the pad whose piece centre is nearest take it.
   */
  private resolveHit(t: HTMLElement, x: number, y: number): Hit {
    const first = this.hitFromTarget(t);
    if (first.area !== 'entity' || !t.closest('.play-hit')) return first;
    const stack = typeof document !== 'undefined' && document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    const pads: string[] = [];
    for (const el of stack) {
      const h = el as HTMLElement;
      if (h.closest('[data-ui]')) break;
      const ent = h.closest<HTMLElement>('[data-eid]');
      if (!ent || !ent.closest('.play-world')) {
        if (h.closest('.play-world') || h.classList.contains('play-table')) continue;
        continue;
      }
      if (h.closest('.play-hit')) {
        pads.push(ent.dataset.eid!);
        continue;
      }
      return this.hitFromTarget(h);
    }
    if (pads.length < 2) return first;
    const w = this.screenToWorld(x, y);
    let best = first;
    let bestD = Infinity;
    for (const id of new Set(pads)) {
      const e = this.state.entities[id];
      if (!e) continue;
      const d = Math.hypot(e.x - w.x, e.y - w.y);
      if (d < bestD) {
        bestD = d;
        best = { area: 'entity', id };
      }
    }
    return best;
  }

  /**
   * Pieces that came to rest in a supply bowl they do not belong to are slid out to just beside it
   * (a matching one would have been returned instead), so nothing looks returned that wasn't.
   */
  private clearOfBowls(s: TableState, ids: ID[]): { state: TableState; moved: Map<ID, SettleInfo> } {
    const moved = new Map<ID, SettleInfo>();
    let next = s;
    const bowls = Object.values(s.entities).filter((e) => e.kind === 'piece' && !!e.infinite && !ids.includes(e.id));
    if (!bowls.length) return { state: s, moved };
    // Obstacles as circles: every resting piece-like thing (not boards / zones / cards), and each piece
    // as soon as it has its spot — so a group sliding out of a bowl never lands two pieces on one spot.
    const circle = (e: Entity) => ({ x: e.x, y: e.y, r: Math.max(baseSize(this.game, e).w, baseSize(this.game, e).h) / 2 });
    const idSet = new Set(ids);
    const placed = Object.values(s.entities)
      .filter((e) => !idSet.has(e.id) && e.kind !== 'board' && e.kind !== 'zone' && e.kind !== 'stack')
      .map((e) => (e.kind === 'piece' && e.infinite ? { ...circle(e), r: circle(e).r * 0.98 } : circle(e)));
    const free = (x: number, y: number, r: number) => placed.every((o) => Math.hypot(x - o.x, y - o.y) >= (o.r + r) * 0.92);
    const area = this.landingArea(2);
    const inArea = (x: number, y: number) => x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h;
    const carried = ids
      .map((id) => next.entities[id])
      .filter((p): p is Extract<Entity, { kind: 'piece' }> => p?.kind === 'piece' && !p.infinite);
    const bowlOf = (p: Entity) => bowls.find((o) => Math.hypot(p.x - o.x, p.y - o.y) < circle(o).r + circle(p).r * 0.85);
    // Two passes: everything that came to rest clear of a bowl is an obstacle BEFORE any piece is slid out,
    // so a slid piece can never take the spot a carried neighbour already occupies.
    const inBowl = carried.filter((p) => bowlOf(p));
    for (const p of carried) if (!inBowl.includes(p)) placed.push({ x: p.x, y: p.y, r: circle(p).r });
    for (const p of inBowl) {
      const pr = circle(p).r;
      const b = bowlOf(p)!;
      const br = circle(b).r;
      const a0 = Math.atan2(p.y - b.y, p.x - b.x) || 0;
      let spot: Vec | null = null;
      // rings just outside the rim, sweeping outward from the piece's own direction
      for (let ring = 0; ring < 6 && !spot; ring++) {
        const rad = br + pr * (1 + ring * 2.05);
        const steps = Math.max(8, Math.ceil((2 * Math.PI * rad) / (pr * 1.9)));
        for (let k = 0; k < steps && !spot; k++) {
          const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * ((2 * Math.PI) / steps);
          const x = b.x + Math.cos(a0 + off) * rad;
          const y = b.y + Math.sin(a0 + off) * rad;
          if (free(x, y, pr) && (inArea(x, y) || ring === 5)) spot = { x, y };
        }
      }
      if (!spot) spot = { x: b.x + Math.cos(a0) * (br + pr), y: b.y + Math.sin(a0) * (br + pr) };
      placed.push({ x: spot.x, y: spot.y, r: pr });
      next = ops.translateEntities(next, [p.id], spot.x - p.x, spot.y - p.y);
      moved.set(p.id, { dx: (p.x - spot.x) * K, dy: (p.y - spot.y) * K, mode: 'whole' });
    }
    return { state: next, moved };
  }

  isFixed(e: Entity): boolean {
    if (e.locked) return true;
    return this.mode === 'play' && e.kind === 'zone' && e.locked !== false;
  }

  onPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    // Menus, dialogs and toasts render through a React portal, but React still routes
    // their pointer events up through THIS component's tree. Without this guard, pressing
    // a menu item closes the menu before the click can land on it.
    if (t.closest('[data-ui], .ui-menu, .ui-dialog, .ui-dialog-backdrop, .ui-toast, .play-note__edit')) return;
    this.measure();
    cancelAnimationFrame(this.inertia);

    // second finger: pinch / two-finger pan
    if (e.pointerType === 'touch') {
      const touches = [...this.pointers.entries()].filter(([, p]) => p.type === 'touch');
      if (touches.length >= 2) {
        if (this.gesture?.kind === 'carry' || this.gesture?.kind === 'marquee') return;
        this.clearPendingTimers();
        const [[a, pa], [b, pb]] = touches;
        const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
        this.gesture = { kind: 'pinch', a, b, d0: Math.hypot(pa.x - pb.x, pa.y - pb.y) || 1, z0: this.camera.zoom, world: this.screenToWorld(mid.x, mid.y) };
        this.ui.setState({ longPress: null, panning: true });
        return;
      }
    }
    if (this.gesture) return;
    if (e.button === 2) return; // handled by contextmenu
    if (this.ui.getState().menu) this.ui.setState({ menu: null });

    const hit = this.resolveHit(t, e.clientX, e.clientY);
    if (e.button === 1 || (e.button === 0 && this.ui.getState().spaceHeld && e.pointerType === 'mouse')) {
      e.preventDefault();
      this.startPan(e.pointerId, e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    if (e.pointerType === 'mouse') e.preventDefault();

    // Capture BEFORE any movement threshold. Once this pointer is ours it stays ours,
    // however fast it moves and whatever it flies over — a flick can never turn into a pan.
    try {
      this.root?.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety; window listeners already cover us */
    }

    const g: Pending = {
      kind: 'pending',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      hit,
      sx: e.clientX,
      sy: e.clientY,
      shift: e.shiftKey,
      meta: e.ctrlKey || e.metaKey,
    };
    this.gesture = g;

    const isStepper = hit.area === 'entity' && (hit.part === 'inc' || hit.part === 'dec');
    if (isStepper) {
      g.repeat = window.setTimeout(() => {
        g.repeated = true;
        const tick = () => {
          if (this.gesture !== g) return;
          this.counter((hit as any).id, (hit as any).part === 'inc' ? 1 : -1);
          g.repeat = window.setTimeout(tick, 85);
        };
        tick();
      }, 380);
    } else if (e.pointerType !== 'mouse') {
      this.ui.setState({ longPress: { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top, seq: this.nextSeq() } });
      g.lp = window.setTimeout(() => {
        if (this.gesture !== g) return;
        this.ui.setState({ longPress: null });
        // On bare table (or a locked board, which usually IS the table) keep holding and drag
        // on to box-select: the touch way to pick up several dice at once.
        const hitEnt = hit.area === 'entity' ? this.state.entities[hit.id] : null;
        const boxable = hit.area === 'table' || (!!hitEnt && this.isFixed(hitEnt));
        this.gesture = boxable ? { kind: 'held', pointerId: g.pointerId, sx: g.sx, sy: g.sy } : { kind: 'done', pointerId: g.pointerId };
        (navigator as any).vibrate?.(8);
        this.openMenuFor(hit, g.sx, g.sy, boxable);
      }, HOLD_MS);
    }
  };

  private clearPendingTimers() {
    const g = this.gesture;
    if (g?.kind === 'pending') {
      window.clearTimeout(g.lp);
      window.clearTimeout(g.repeat);
    }
    if (this.ui.getState().longPress) this.ui.setState({ longPress: null });
  }

  onHover = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || this.gesture) return;
    const t = e.target as HTMLElement;
    const handEl = t.closest<HTMLElement>('[data-hand-uid]');
    this.hoverHandUid = handEl?.dataset.handUid ?? null;
    const entEl = handEl ? null : t.closest<HTMLElement>('[data-eid]');
    let hover = entEl && entEl.closest('.play-world') ? entEl.dataset.eid! : null;
    if (hover && t.closest('.play-hit')) {
      const h = this.resolveHit(t, e.clientX, e.clientY);
      hover = h.area === 'entity' ? h.id : hover;
    }
    this.hoverId = hover;
    this.updatePeek(this.hoverId);
  };

  onLeave = (e?: { pointerType?: string }) => {
    this.hoverId = null;
    this.hoverHandUid = null;
    // a finger lifting fires pointerleave too — that must not cut short a tap's name flash
    if (!e || e.pointerType === 'mouse') this.updatePeek(null);
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.x = e.clientX;
      p.y = e.clientY;
    }
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case 'pending': {
        if (e.pointerId !== g.pointerId) return;
        const slop = g.pointerType === 'mouse' ? 4 : 9;
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < slop) return;
        this.clearPendingTimers();
        if (g.repeated) {
          this.gesture = { kind: 'done', pointerId: g.pointerId };
          return;
        }
        this.beginDrag(g, e);
        return;
      }
      case 'pan': {
        if (e.pointerId !== g.pointerId) return;
        const now = performance.now();
        const dx = e.clientX - g.lx;
        const dy = e.clientY - g.ly;
        const dt = Math.max(1, now - g.lt);
        g.vx = g.vx * 0.6 + (dx / dt) * 0.4;
        g.vy = g.vy * 0.6 + (dy / dt) * 0.4;
        g.lx = e.clientX;
        g.ly = e.clientY;
        g.lt = now;
        this.camera = this.clampedCamera({ ...this.camera, x: this.camera.x - dx / this.camera.zoom, y: this.camera.y - dy / this.camera.zoom });
        this.applyCamera();
        return;
      }
      case 'pinch': {
        const a = this.pointers.get(g.a);
        const b = this.pointers.get(g.b);
        if (!a || !b) return;
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoom = clamp((g.z0 * d) / g.d0, MIN_ZOOM, MAX_ZOOM);
        const r = this.rect;
        this.camera = this.clampedCamera({ x: g.world.x - (mid.x - r.left - r.width / 2) / zoom, y: g.world.y - (mid.y - r.top - r.height / 2) / zoom, zoom });
        this.applyCamera();
        return;
      }
      case 'held': {
        if (e.pointerId !== g.pointerId) return;
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 14) return;
        this.ui.setState({ menu: null });
        this.gesture = { kind: 'marquee', pointerId: g.pointerId, sx: g.sx, sy: g.sy, additive: false };
        this.onPointerMove(e);
        return;
      }
      case 'marquee': {
        if (e.pointerId !== g.pointerId || !this.marqueeEl) return;
        const x0 = Math.min(g.sx, e.clientX) - this.rect.left;
        const y0 = Math.min(g.sy, e.clientY) - this.rect.top;
        const m = this.marqueeEl;
        m.hidden = false;
        m.style.transform = `translate(${x0}px, ${y0}px)`;
        m.style.width = `${Math.abs(e.clientX - g.sx)}px`;
        m.style.height = `${Math.abs(e.clientY - g.sy)}px`;
        return;
      }
      case 'carry': {
        const c = this.carry;
        if (!c || e.pointerId !== c.pointerId) return;
        c.px = e.clientX;
        c.py = e.clientY;
        // Sample velocity HERE, not in the rAF loop: a flick can start and end inside a
        // single frame, and the frame callback would then read a velocity of zero. Input time,
        // not handling time: a busy frame must not turn a real flick into a slow drop. And every
        // coalesced sample: while the main thread is busy (a 30-dice pickup, a screen recorder)
        // the browser folds several moves into one event.
        const co = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        for (const ev of co.length ? co : [e]) {
          const now = ev.timeStamp || e.timeStamp;
          if (now < c.lt - 0.5) continue;
          const dt = clamp(now - c.lt, 1, 64);
          const ivx = (ev.clientX - c.lx) / dt;
          const ivy = (ev.clientY - c.ly) / dt;
          c.vx = c.vx * 0.55 + ivx * 0.45;
          c.vy = c.vy * 0.55 + ivy * 0.45;
          c.lx = ev.clientX;
          c.ly = ev.clientY;
          c.lt = now;
          c.mtEv = now;
          c.samples.push({ x: ev.clientX, y: ev.clientY, t: now });
        }
        if (c.samples.length > 24) c.samples.splice(0, c.samples.length - 24);
        c.mt = performance.now();
        return;
      }
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case 'pending':
        if (e.pointerId !== g.pointerId) return;
        this.clearPendingTimers();
        this.gesture = null;
        if (!g.repeated) this.onTap(g, e);
        return;
      case 'pan':
        if (e.pointerId !== g.pointerId) return;
        this.gesture = null;
        this.ui.setState({ panning: false });
        this.startInertia(g);
        return;
      case 'pinch':
        if (e.pointerId === g.a || e.pointerId === g.b) {
          this.gesture = { kind: 'done', pointerId: e.pointerId === g.a ? g.b : g.a };
          this.ui.setState({ panning: false });
        }
        return;
      case 'marquee':
        if (e.pointerId !== g.pointerId) return;
        this.gesture = null;
        this.finishMarquee(g, e);
        return;
      case 'carry':
        if (this.carry && e.pointerId === this.carry.pointerId) {
          this.gesture = null;
          this.endCarry(false, { x: e.clientX, y: e.clientY, t: e.timeStamp });
        }
        return;
      case 'done':
      case 'held':
        if (e.pointerId === g.pointerId) this.gesture = null;
        return;
    }
  };

  private onPointerCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === 'carry') {
      this.gesture = null;
      this.endCarry(true);
      return;
    }
    if (g.kind === 'pinch') {
      if (e.pointerId === g.a || e.pointerId === g.b) this.gesture = null;
      this.ui.setState({ panning: false });
      return;
    }
    if ('pointerId' in g && g.pointerId === e.pointerId) {
      this.clearPendingTimers();
      this.gesture = null;
      this.ui.setState({ panning: false });
      if (this.marqueeEl) this.marqueeEl.hidden = true;
    }
  };

  private startPan(pointerId: number, x: number, y: number) {
    try {
      this.root?.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    this.gesture = { kind: 'pan', pointerId, lx: x, ly: y, lt: performance.now(), vx: 0, vy: 0 };
    this.ui.setState({ panning: true });
  }

  private startInertia(g: PanG) {
    if (reduceMotion() || performance.now() - g.lt > 60) return;
    let vx = g.vx;
    let vy = g.vy;
    if (Math.hypot(vx, vy) < 0.25) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const f = Math.pow(0.94, dt / 16);
      vx *= f;
      vy *= f;
      const before = this.camera;
      this.camera = this.clampedCamera({ ...before, x: before.x - (vx * dt) / before.zoom, y: before.y - (vy * dt) / before.zoom });
      this.applyCamera();
      // hit the edge of the table? stop coasting rather than grinding against it
      if (this.camera.x === before.x) vx = 0;
      if (this.camera.y === before.y) vy = 0;
      if (Math.hypot(vx, vy) > 0.02) this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  private onWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest('[data-ui], .play-note__edit')) return;
    e.preventDefault();
    this.measure();
    cancelAnimationFrame(this.inertia);
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.6 && e.deltaMode === 0) {
      this.camera = this.clampedCamera({ ...this.camera, x: this.camera.x + e.deltaX / this.camera.zoom, y: this.camera.y + e.deltaY / this.camera.zoom });
      this.applyCamera();
      return;
    }
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.012 : 0.0018;
    const factor = Math.exp(clamp(-e.deltaY * unit * k, -0.5, 0.5));
    cancelAnimationFrame(this.camAnim);
    this.zoomAt(e.clientX, e.clientY, factor, false);
  };

  private onContextMenu = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('.play-note__edit')) return;
    e.preventDefault();
    if (t.closest('[data-ui]')) return;
    if (this.gesture && this.gesture.kind !== 'pending') return;
    this.clearPendingTimers();
    this.gesture = null;
    this.openMenuFor(this.resolveHit(t, e.clientX, e.clientY), e.clientX, e.clientY);
  };

  /* ================================================================ */
  /* Taps                                                               */
  /* ================================================================ */

  private onTap(g: Pending, e: PointerEvent) {
    const hit = g.hit;
    const now = performance.now();
    const key = hit.area === 'table' ? 'table' : hit.area === 'hand' ? `h:${hit.uid}` : `e:${hit.id}`;
    const isDouble =
      !!this.lastTap && this.lastTap.key === key && now - this.lastTap.t < DOUBLE_MS && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 24;
    this.lastTap = isDouble ? null : { key, t: now, x: e.clientX, y: e.clientY };
    const ui = this.ui.getState();

    if (ui.inspect?.sticky) this.ui.setState({ inspect: null });

    if (hit.area === 'table') {
      if (ui.editingNote) this.ui.setState({ editingNote: null });
      if (ui.raisedHandCard) this.ui.setState({ raisedHandCard: null });
      if (Object.keys(ui.selection).length) this.ui.setState({ selection: {} });
      return;
    }

    if (hit.area === 'hand') {
      if (isDouble) {
        this.playHandCard(hit.uid);
        return;
      }
      this.ui.setState({ raisedHandCard: ui.raisedHandCard === hit.uid ? null : hit.uid });
      return;
    }

    const ent = this.state.entities[hit.id];
    if (!ent) return;
    if (ui.raisedHandCard) this.ui.setState({ raisedHandCard: null });

    if (hit.part === 'inc' || hit.part === 'dec') {
      this.counter(ent.id, hit.part === 'inc' ? 1 : -1);
      return;
    }
    if (hit.part === 'lock') {
      this.toggleLock([ent.id], true);
      return;
    }

    if (this.isFixed(ent)) {
      if (Object.keys(ui.selection).length) this.ui.setState({ selection: {} });
      if (ui.editingNote) this.ui.setState({ editingNote: null });
      this.flashName(ent.id);
      return;
    }

    if (isDouble) {
      this.doubleTap(ent);
      return;
    }

    if (ent.kind === 'stack') this.lastStackId = ent.id;
    // Touch has no Shift: while dice are selected, tapping a die adds it (or takes it back out).
    const touchAdd = g.pointerType !== 'mouse' && ent.kind === 'die' && Object.keys(ui.selection).some((id) => this.state.entities[id]?.kind === 'die');
    if (g.shift || g.meta || touchAdd) {
      const sel = { ...ui.selection };
      if (sel[ent.id]) delete sel[ent.id];
      else sel[ent.id] = true;
      this.ui.setState({ selection: sel });
    } else {
      this.ui.setState({ selection: { [ent.id]: true }, editingNote: ui.editingNote === ent.id ? ent.id : null });
    }
  }

  private doubleTap(ent: Entity) {
    switch (ent.kind) {
      case 'stack':
      case 'token':
        this.flip([ent.id]);
        return;
      case 'die':
        this.roll([ent.id]);
        return;
      case 'note':
        this.ui.setState({ editingNote: ent.id, selection: { [ent.id]: true } });
        return;
    }
  }

  /* ================================================================ */
  /* Drag start                                                         */
  /* ================================================================ */

  private beginDrag(g: Pending, e: PointerEvent) {
    const hit = g.hit;
    if (hit.area === 'table') {
      if (g.shift && g.pointerType === 'mouse') {
        this.gesture = { kind: 'marquee', pointerId: g.pointerId, sx: g.sx, sy: g.sy, additive: g.meta };
        return;
      }
      this.startPan(g.pointerId, e.clientX, e.clientY);
      return;
    }
    if (hit.area === 'hand') {
      if (this.mode !== 'play') return;
      this.startCarry({ type: 'hand', uid: hit.uid }, g, e);
      return;
    }
    const s = this.state;
    const ent = s.entities[hit.id];
    if (!ent || this.isFixed(ent)) {
      // A locked board usually covers most of the table, so box-select has to work
      // *over* it — otherwise Shift+drag would almost never reach bare felt.
      if (g.shift && g.pointerType === 'mouse') {
        this.gesture = { kind: 'marquee', pointerId: g.pointerId, sx: g.sx, sy: g.sy, additive: g.meta };
        return;
      }
      this.startPan(g.pointerId, e.clientX, e.clientY);
      return;
    }
    if (this.ui.getState().editingNote === ent.id) {
      this.ui.setState({ editingNote: null });
    }
    const sel = Object.keys(this.ui.getState().selection).filter((id) => s.entities[id] && !this.isFixed(s.entities[id]));
    const pw0 = this.screenToWorld(g.sx, g.sy);
    // Setup arranges the table: dragging a stack anywhere moves the whole stack. Play keeps
    // "drag the top card" (whole stack only via the badge handle or Shift).
    const whole = hit.part === 'handle' || g.shift || (this.mode === 'setup' && ent.kind === 'stack');
    let src: DragSource;
    if (sel.length > 1 && sel.includes(ent.id)) {
      src = { type: 'entities', ids: [ent.id, ...sel.filter((id) => id !== ent.id)] };
    } else if (ent.kind === 'stack') {
      this.lastStackId = ent.id;
      if (whole || ent.cards.length === 1) src = { type: 'entities', ids: [ent.id] };
      else if (ent.layout !== 'pile' && hit.cardUid) src = { type: 'stackCard', stackId: ent.id, uid: hit.cardUid };
      else src = { type: 'stackTop', stackId: ent.id, count: 1 };
    } else if (ent.kind === 'token') {
      // The count badge keeps a constant screen size, so on a small token at low zoom it
      // covers the whole piece. Only treat it as the 'move the pile' handle when the press
      // is genuinely outside the token — a press on the token itself must take ONE.
      const onBadge = hit.part === 'handle' && !pointInEntity(this.game, ent, pw0);
      const wholePile = onBadge || g.shift;
      if (ent.infinite) src = { type: 'tokenOne', tokenId: ent.id };
      else if (ent.count > 1 && !wholePile) src = { type: 'tokenOne', tokenId: ent.id };
      else src = { type: 'entities', ids: [ent.id] };
    } else if (ent.kind === 'piece' && ent.infinite && !g.shift) {
      src = { type: 'pieceOne', supplyId: ent.id };
    } else {
      src = { type: 'entities', ids: [ent.id] };
    }
    this.startCarry(src, g, e);
  }

  private startCarry(src: DragSource, g: Pending, e: PointerEvent) {
    const s = this.state;
    const game = this.game;
    const pw = this.screenToWorld(g.sx, g.sy);
    let anchor: Vec = pw;
    let items: GhostItem[] = [];
    let cardH = 88;
    let homeStack: ID | undefined;
    const patch: Partial<TableUi> = {};
    let liveIds: ID[] = [];

    switch (src.type) {
      case 'entities': {
        const primary = s.entities[src.ids[0]];
        anchor = { x: primary.x, y: primary.y };
        const diceIds = src.ids.filter((id) => s.entities[id]?.kind === 'die');
        if (diceIds.length >= 2) liveIds = diceIds;
        const ghosted = src.ids.filter((id) => !liveIds.includes(id));
        items = ghosted.map((id) => {
          const en = s.entities[id];
          return { key: id, entity: en, dx: en.x - primary.x, dy: en.y - primary.y };
        });
        patch.hidden = Object.fromEntries(ghosted.map((id) => [id, true as const]));
        if (primary.kind === 'stack') cardH = cardDims(game, primary.cards[primary.cards.length - 1]).h;
        if (!this.ui.getState().selection[primary.id]) patch.selection = {};
        break;
      }
      case 'stackTop': {
        const st = s.entities[src.stackId] as StackEntity;
        const cards = st.cards.slice(-src.count);
        anchor = { x: st.x, y: st.y };
        items = [{ key: 'top', entity: { ...st, id: 'ghost', cards, layout: 'pile', name: undefined }, dx: 0, dy: 0 }];
        patch.lifted = { id: st.id, count: src.count };
        cardH = cardDims(game, cards[cards.length - 1]).h;
        homeStack = st.id;
        break;
      }
      case 'stackCard': {
        const st = s.entities[src.stackId] as StackEntity;
        const idx = st.cards.findIndex((c) => c.uid === src.uid);
        const slot = stackSlots(game, st)[idx] ?? { dx: 0, dy: 0, rot: 0 };
        const off = rotateVec({ x: slot.dx, y: slot.dy }, st.rot);
        anchor = { x: st.x + off.x, y: st.y + off.y };
        const card = st.cards[idx];
        items = [{ key: 'card', entity: { ...st, id: 'ghost', rot: st.rot + slot.rot, cards: [card], layout: 'pile', name: undefined }, dx: 0, dy: 0 }];
        patch.liftedCard = { id: st.id, uid: src.uid };
        cardH = cardDims(game, card).h;
        homeStack = st.id;
        break;
      }
      case 'tokenOne': {
        const tk = s.entities[src.tokenId];
        if (tk?.kind !== 'token') return;
        anchor = { x: tk.x, y: tk.y };
        items = [{ key: 'tok', entity: { ...tk, id: 'ghost', count: 1, infinite: false }, dx: 0, dy: 0 }];
        if (!tk.infinite) patch.tokenLift = tk.id;
        break;
      }
      case 'pieceOne': {
        const sp = s.entities[src.supplyId];
        if (sp?.kind !== 'piece') return;
        // the new piece comes up under the finger, not at the middle of the bowl
        anchor = pw;
        items = [{ key: 'piece', entity: { ...sp, id: 'ghost', infinite: false, x: pw.x, y: pw.y }, dx: 0, dy: 0 }];
        break;
      }
      case 'hand': {
        const card = s.hand.find((c) => c.uid === src.uid);
        if (!card) return;
        const d = cardDims(game, card);
        cardH = d.h;
        const el = this.root?.querySelector<HTMLElement>(`[data-hand-uid="${CSS.escape(src.uid)}"] .play-hand__face`);
        let fy = 0;
        let fx = 0;
        if (el) {
          const r = el.getBoundingClientRect();
          fx = (r.left + r.width / 2 - g.sx) / Math.max(1, r.height);
          fy = (r.top + r.height / 2 - g.sy) / Math.max(1, r.height);
        }
        anchor = { x: pw.x + fx * d.h, y: pw.y + fy * d.h };
        items = [
          {
            key: 'hand',
            entity: { id: 'ghost', kind: 'stack', x: 0, y: 0, rot: 0, cards: [{ ...card, faceUp: true }], layout: 'pile' },
            dx: 0,
            dy: 0,
          },
        ];
        patch.handDrag = src.uid;
        patch.raisedHandCard = null;
        break;
      }
    }

    const now = performance.now();
    const c: Carry = {
      source: src,
      pointerId: g.pointerId,
      grab: { x: anchor.x - pw.x, y: anchor.y - pw.y },
      px: e.clientX,
      py: e.clientY,
      lx: e.clientX,
      ly: e.clientY,
      lt: e.timeStamp,
      vx: 0,
      vy: 0,
      mt: now,
      mtEv: e.timeStamp,
      tiltX: 0,
      tiltY: 0,
      tvx: 0,
      tvy: 0,
      target: null,
      homeStack,
      overHand: src.type === 'hand',
      touch: g.pointerType === 'touch',
      cardH,
      lastFrame: now,
      edgeSince: 0,
      live: [],
      origin: anchor,
      tpx: NaN,
      tpy: NaN,
      samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }],
    };
    for (const id of liveIds) {
      const el = this.world?.querySelector<HTMLElement>(`[data-eid="${CSS.escape(id)}"]`);
      const en = s.entities[id];
      if (el && en) c.live.push({ el, base: el.style.transform, x: en.x, y: en.y });
    }
    this.carry = c;
    this.gesture = { kind: 'carry', pointerId: g.pointerId };

    // position the ghost before it paints
    if (this.ghostTiltEl) this.ghostTiltEl.style.transformOrigin = `${-c.grab.x * K}px ${-c.grab.y * K}px`;
    this.positionGhost(c, true);
    this.ui.setState({
      ...patch,
      ghost: { items, payload: payloadOf(s, src), cats: carriedCategories(s, src), seq: this.nextSeq() },
      dropTarget: null,
      menu: null,
      editingNote: null,
    });
    // after React's render, so a className write can't drop it
    for (const l of c.live) l.el.classList.add('is-carried');
    playSound(src.type === 'tokenOne' || (src.type === 'entities' && s.entities[src.ids[0]]?.kind === 'token') ? 'clink' : 'pickup', { volume: 0.8 });
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.frame);
  }

  private positionGhost(c: Carry, instant = false) {
    const el = this.ghostEl;
    if (!el) return;
    const r = this.rect;
    const z = this.camera.zoom;
    const ax = c.px - r.left + c.grab.x * z;
    const ay = c.py - r.top + c.grab.y * z;
    el.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0)`;
    const sc = this.ghostScaleEl;
    if (sc) {
      let scale = z / K;
      if (c.overHand && this.mode === 'play') scale = (this.handCardH / (c.cardH * K)) * 1.02;
      const v = `scale(${scale.toFixed(4)})`;
      if (instant) {
        sc.style.transition = 'none';
        sc.style.transform = v;
        void sc.offsetWidth;
        sc.style.transition = '';
      } else if (sc.style.transform !== v) sc.style.transform = v;
    }
    if (c.live.length) {
      // translate only: a scale on a die's ancestors would re-lay out its prints every frame
      const w = this.screenToWorld(c.px, c.py);
      const dx = (w.x + c.grab.x - c.origin.x) * K;
      const dy = (w.y + c.grab.y - c.origin.y) * K;
      for (const l of c.live) l.el.style.transform = `translate3d(${(l.x * K + dx).toFixed(2)}px, ${(l.y * K + dy).toFixed(2)}px, 0)`;
    }
    this.positionRefuse(c);
  }

  /** Hand carried dice back to React: its own transform (the commit then writes the new spot). */
  private releaseLive(c: Carry) {
    for (const l of c.live) {
      l.el.style.transform = l.base;
      l.el.classList.remove('is-carried');
    }
  }

  private frame = (now: number) => {
    const c = this.carry;
    if (!c) return;
    const dt = Math.max(1, Math.min(48, now - c.lastFrame));
    c.lastFrame = now;
    // velocity is sampled in onPointerMove; decay it here so a held-still piece settles upright
    if (now - c.mt > 48) {
      c.vx *= 0.8;
      c.vy *= 0.8;
    }

    // Edge auto-pan — for carrying a piece to a part of the table that is off screen.
    // It is NOT a follow-the-piece camera: a throw must never move the table. A flick
    // ends at speed, often inside the edge band, and the old code panned at ~8.8 screen
    // px/ms from the first frame, so grazing an edge for 100 ms slid the camera the whole
    // clamp range (measured up to ~600 px on a die flick). Three guards:
    //   1. never while the pointer is moving at throw speed;
    //   2. only after a deliberate dwell inside the band;
    //   3. a sane, zoom-independent speed you can follow with your eyes.
    const r = this.rect;
    const edge = 36;
    let pdx = 0;
    let pdy = 0;
    if (c.px - r.left < edge) pdx = -(edge - (c.px - r.left)) / edge;
    else if (r.left + r.width - c.px < edge) pdx = (edge - (r.left + r.width - c.px)) / edge;
    if (c.py - r.top < edge) pdy = -(edge - (c.py - r.top)) / edge;
    const flinging = now - c.mt < FLING_FRESH_MS && Math.hypot(c.vx, c.vy) > FLING_SPEED;
    if (!pdx && !pdy) c.edgeSince = 0;
    else if (flinging) c.edgeSince = 0;
    else if (!c.edgeSince) c.edgeSince = now;
    if ((pdx || pdy) && c.edgeSince && now - c.edgeSince >= EDGE_PAN_DWELL_MS) {
      // screen px this frame -> world units (the zoom divide keeps the speed constant on screen)
      const sp = (EDGE_PAN_SPEED * dt) / this.camera.zoom;
      this.camera = this.clampedCamera({ ...this.camera, x: this.camera.x + pdx * sp, y: this.camera.y + pdy * sp });
      this.applyCamera();
    }

    // tilt spring toward velocity
    const reduce = reduceMotion();
    const targetY = reduce ? 0 : clamp(c.vx * 10, -18, 18);
    const targetX = reduce ? 0 : clamp(-c.vy * 10, -18, 18);
    c.tvy = (c.tvy + (targetY - c.tiltY) * 0.2) * 0.72;
    c.tvx = (c.tvx + (targetX - c.tiltX) * 0.2) * 0.72;
    c.tiltY += c.tvy;
    c.tiltX += c.tvx;
    if (this.ghostTiltEl) {
      const rz = clamp(c.vx * 3, -6, 6);
      this.ghostTiltEl.style.transform = `perspective(${(1400).toFixed(0)}px) rotateX(${c.tiltX.toFixed(2)}deg) rotateY(${c.tiltY.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg)`;
    }

    this.updateDropTarget(c);
    this.positionGhost(c);
    this.raf = requestAnimationFrame(this.frame);
  };

  private updateDropTarget(c: Carry) {
    c.tpx = c.px;
    c.tpy = c.py;
    const s = this.state;
    let target: DropTarget = { type: 'table' };
    let refuse: ID | null = null;
    const payload = payloadOf(s, c.source);
    // The hand tray is UI: it is the one target still decided by the pointer.
    let overHand = false;
    let pointerOnTray = false;
    // by rectangle: the tray's shelf lets presses through to the table, so it isn't hit-testable
    const tray = this.root?.querySelector<HTMLElement>('[data-hand-drop]')?.getBoundingClientRect();
    if (tray && tray.height && c.px >= tray.left && c.px <= tray.right && c.py >= tray.top && c.py <= tray.bottom) pointerOnTray = true;
    if (pointerOnTray) {
      if (this.mode === 'play' && payload === 'cards') {
        overHand = true;
        target = { type: 'hand', index: this.handIndexAt?.(c.px) ?? s.hand.length };
      }
    } else {
      // Table targets come from the carried piece's CENTRE (coverage rule, see engine/drop.ts),
      // exactly as endCarry will compute it — so the preview always matches the outcome.
      const pw = this.screenToWorld(c.px, c.py);
      const slackPx = c.touch ? STACK_MIN_SLACK_PX.touch : STACK_MIN_SLACK_PX.mouse;
      const centre = { x: pw.x + c.grab.x, y: pw.y + c.grab.y };
      target = tableDropTarget(this.game, s, c.source, centre, slackPx / this.camera.zoom);
      // over a zone that won't take it: say so on the zone (it lands as on bare table)
      refuse = target.type === 'table' ? (refusingZoneAt(s, c.source, centre)?.id ?? null) : null;
    }
    if (refuse !== this.refuseId) {
      this.refuseId = refuse;
      this.refuseEl?.classList.remove('is-placed');
      this.ui.setState({ dropRefuse: refuse });
    }
    if (overHand !== c.overHand) {
      c.overHand = overHand;
      this.ghostEl?.classList.toggle('is-over-hand', overHand);
    }
    if (!sameTarget(target, c.target)) {
      c.target = target;
      this.ui.setState({ dropTarget: target.type === 'table' ? null : target, dropHint: this.dropHintFor(target, c) });
    }
  }

  /** How many cards / tokens the carry adds to a pile it joins. */
  private carriedCount(src: DragSource): number {
    const s = this.state;
    if (src.type === 'stackTop') return src.count;
    if (src.type !== 'entities') return 1;
    return src.ids.reduce((n, id) => {
      const e = s.entities[id];
      return n + (e?.kind === 'stack' ? e.cards.length : e?.kind === 'token' ? e.count : 1);
    }, 0);
  }

  /** What will happen if you let go right now. Shown on the target itself, before release. */
  private dropHintFor(target: DropTarget, c: Carry): string | null {
    const s = this.state;
    if (target.type === 'pieceSupply') return c.source.type === 'pieceOne' ? 'Put it back' : 'Back to the supply';
    if (target.type === 'zone') {
      const l = target.land;
      if (!l) return null;
      if (l.beside) return 'Full · goes beside it';
      const m = l.merge ? s.entities[l.merge] : null;
      const k = this.carriedCount(c.source);
      if (m?.kind === 'token') return `Adds to this pile → ${m.count + k}`;
      if (m?.kind === 'stack') {
        const n = m.cards.length + k;
        return `Goes on top of ${m.name || this.deckName(m.cards[m.cards.length - 1].deckId)} → ${n} cards`;
      }
      return null;
    }
    if (target.type !== 'stack' && target.type !== 'token') return null;
    const en = s.entities[target.id];
    if (!en) return null;
    if (target.type === 'token') {
      if (en.kind !== 'token') return null;
      return en.infinite ? 'Back to the supply' : `Adds to this pile · ${en.count}`;
    }
    if (en.kind !== 'stack') return null;
    if (c.homeStack === en.id) return 'Put it back';
    const n = en.cards.length;
    const name = en.name || this.deckName(en.cards[n - 1].deckId);
    return `Goes on top of ${name} · ${n} card${n === 1 ? '' : 's'}`;
  }

  private clearCarryUi(): Partial<TableUi> {
    if (this.ghostTiltEl) this.ghostTiltEl.style.transform = '';
    this.refuseId = null;
    return { ghost: null, hidden: {}, lifted: null, liftedCard: null, tokenLift: null, handDrag: null, dropTarget: null, dropHint: null, dropRefuse: null };
  }

  cancelCarry() {
    if (!this.carry) return;
    this.releaseLive(this.carry);
    this.carry = null;
    cancelAnimationFrame(this.raf);
    this.gesture = null;
    this.ghostEl?.classList.remove('is-over-hand');
    this.ui.setState(this.clearCarryUi());
  }

  /**
   * How fast the pointer was travelling as it let go (screen px/ms), from the input samples of the
   * last ~70 ms up to the release's own timestamp. Measured over a window ending AT the release, so
   * a pause before letting go reads as slow, while a short thumb flick (a handful of samples) or a
   * release handled late by a busy frame still reads at its true speed.
   */
  private releaseVelocity(c: Carry, up: { x: number; y: number; t: number }) {
    return releaseVelocity(c.samples, up);
  }

  /** `up`: the release event (client px + timeStamp); omitted for cancels. */
  private endCarry(cancelled: boolean, up?: { x: number; y: number; t: number }) {
    const c = this.carry;
    if (!c) return;
    this.carry = null;
    cancelAnimationFrame(this.raf);
    this.ghostEl?.classList.remove('is-over-hand');
    this.releaseLive(c);
    const liveIds = new Set(c.live.map((l) => l.el.dataset.eid));
    // the last frame already aimed from this exact spot (elementsFromPoint over a handful of dice isn't free)
    if (c.px !== c.tpx || c.py !== c.tpy) this.updateDropTarget(c);
    const s = this.state;
    const game = this.game;
    const pw = this.screenToWorld(c.px, c.py);
    let at = { x: pw.x + c.grab.x, y: pw.y + c.grab.y };
    const target = c.target ?? { type: 'table' };
    const clear = this.clearCarryUi();

    /* ---- was this a throw? ---- */
    // Decided BEFORE the drop target: a fast release always throws the dice, whatever zone or
    // piece is under the pointer (a board is mostly zones). Anything else carried along (cards,
    // tokens, notes) is put down normally — zones still take those.
    const vel = !cancelled && up ? this.releaseVelocity(c, up) : { vx: 0, vy: 0, speed: 0, quick: false };
    const fling = flingOf(vel, this.camera.zoom);
    const flung = fling.flung;
    const carriedDice =
      !cancelled && flung && target.type !== 'hand' && c.source.type === 'entities'
        ? c.source.ids.filter((id) => s.entities[id]?.kind === 'die')
        : [];
    const flungDie = carriedDice.length > 0;
    const unclampedAt = at;
    // where each die left the hand: the ghost keeps the group's arrangement around the anchor
    const release = new Map<ID, Vec>();
    // and where the flick that threw them began (the start of the release-speed window), for tray catching
    const flick = new Map<ID, Vec>();
    if (flungDie && c.source.type === 'entities') {
      const primary = s.entities[c.source.ids[0]];
      const fw = vel.from ? this.screenToWorld(vel.from.x, vel.from.y) : null;
      for (const id of carriedDice) {
        const en = s.entities[id];
        release.set(id, { x: at.x + en.x - primary.x, y: at.y + en.y - primary.y });
        if (fw) flick.set(id, { x: fw.x + c.grab.x + en.x - primary.x, y: fw.y + c.grab.y + en.y - primary.y });
      }
    }
    // Pin the landing to the visible table. Nothing you let go of ever ends up somewhere you
    // would have to go looking for it.
    if (target.type === 'table' || target.type === 'hand') at = this.clampToTable(at, 2);

    // Put back where it came from (or cancelled): animate home, commit nothing.
    const home = !flungDie && ((c.homeStack && target.type === 'stack' && target.id === c.homeStack) || (c.source.type === 'pieceOne' && target.type === 'pieceSupply'));
    if (cancelled || home) {
      const homeId = c.homeStack ?? (c.source.type === 'entities' ? c.source.ids[0] : c.source.type === 'tokenOne' ? c.source.tokenId : null);
      const homeEnt = homeId ? s.entities[homeId] : null;
      if (homeEnt && c.source.type !== 'hand') {
        const anchor0 = c.source.type === 'stackCard' ? homeEnt : homeEnt;
        this.settleFrom.set(homeEnt.id, { dx: (at.x - anchor0.x) * K, dy: (at.y - anchor0.y) * K, mode: c.homeStack ? 'top' : 'whole' });
        this.ui.setState({ ...clear, settle: { ...this.ui.getState().settle, [homeEnt.id]: this.nextSeq() } });
        this.scheduleSettleClear([homeEnt.id]);
      } else this.ui.setState(clear);
      if (!cancelled) playSound('place', { volume: 0.7 });
      return;
    }

    let res: DropResult;
    if (flungDie && c.source.type === 'entities') {
      // the dice fly; the rest of the carry (if any) is dropped as if carried on its own
      const rest = c.source.ids.filter((id) => !carriedDice.includes(id));
      res = { state: s, landed: [], kind: 'move' };
      if (rest.length) {
        const primary = s.entities[c.source.ids[0]];
        const r0 = s.entities[rest[0]];
        let restAt = { x: unclampedAt.x + r0.x - primary.x, y: unclampedAt.y + r0.y - primary.y };
        const restSrc: DragSource = { type: 'entities', ids: rest };
        let restTarget: DropTarget = target;
        if (restTarget.type === 'table') restAt = this.clampToTable(restAt, 2);
        let r = applyDrop(game, s, restSrc, restTarget, restAt);
        if (r.kind === 'none') {
          restTarget = { type: 'table' };
          r = applyDrop(game, s, restSrc, restTarget, this.clampToTable(restAt, 2));
        }
        if (r.kind === 'move') r = { ...r, state: this.clearOfPieces(r.state, rest) };
        if (r.kind !== 'none') res = r;
      }
    } else res = applyDrop(game, s, c.source, target, at);
    if (res.kind === 'none') {
      this.ui.setState(clear);
      return;
    }
    let next = res.state;
    let thrown: ID[] = [];
    if (flungDie) {
      // one direction and speed for the whole handful; a hard throw carries further
      const r = this.throwDice(next, carriedDice, { from: release, flick, dir: fling.dir, travel: fling.travel });
      next = r.state;
      thrown = r.ids;
    }
    const rolled = thrown.length > 0;

    // A near miss must read as "placed beside", never as a sloppy stack: slide it clear of the
    // stack / pile it almost covered (same commit, so one undo step restores the drop).
    let asideFrom: Vec | null = null;
    const singlePiece = !(c.source.type === 'entities' && c.source.ids.length > 1);
    const landedWhereReleased = res.kind === 'move' || (res.kind === 'zone' && !!res.landedAt && Math.hypot(res.landedAt.x - at.x, res.landedAt.y - at.y) < 1e-6);
    if (!flungDie && singlePiece && landedWhereReleased && res.landed.length === 1) {
      const id = res.landed[0];
      const p = asidePosition(game, next, id);
      const en = next.entities[id];
      if (p && en) {
        next = ops.translateEntities(next, [id], p.x - en.x, p.y - en.y);
        asideFrom = at;
      }
    }

    // pieces let go over a bowl they don't belong to settle beside it, visibly not returned
    const bowlMoves = res.kind === 'move' || res.kind === 'zone' ? this.clearOfBowls(next, res.landed) : null;
    if (bowlMoves?.moved.size) next = bowlMoves.state;

    const settle = { ...this.ui.getState().settle };
    for (const id of res.landed) {
      const en = next.entities[id];
      const bowlFrom = bowlMoves?.moved.get(id);
      if (bowlFrom && en) {
        this.settleFrom.set(id, bowlFrom);
        settle[id] = this.nextSeq();
        continue;
      }
      // a thrown die animates itself (a settle bounce on its frame would re-lay out its prints)
      if (!en || thrown.includes(id) || liveIds.has(id)) continue;
      const from = res.kind === 'merge' || res.kind === 'zone' || res.kind === 'token' || res.kind === 'supply' ? at : asideFrom;
      if (from && (res.kind !== 'zone' || Math.hypot(from.x - en.x, from.y - en.y) > 0.5)) {
        this.settleFrom.set(id, { dx: (from.x - en.x) * K, dy: (from.y - en.y) * K, mode: res.kind === 'merge' || (res.kind === 'zone' && en.kind === 'stack' && en.cards.length > 1) ? 'top' : 'whole' });
      }
      settle[id] = this.nextSeq();
    }
    if (res.kind === 'hand' && c.source.type !== 'hand') {
      // cards dropped into the hand fly from where they were released into their slot
      const added = next.hand.filter((hc) => !s.hand.some((o) => o.uid === hc.uid));
      const ax = c.px + c.grab.x * this.camera.zoom;
      const ay = c.py + c.grab.y * this.camera.zoom;
      added.forEach((hc, i) => this.handArrivals.set(hc.uid, { x: ax, y: ay, scale: 1.02, delay: i * 50 }));
    }
    const handPatch: Partial<TableUi> = res.kind === 'hand' && this.ui.getState().handCollapsed ? { handCollapsed: false } : {};
    const pieceDrop = c.source.type === 'pieceOne' || (c.source.type === 'entities' && s.entities[c.source.ids[0]]?.kind === 'piece');
    const labels: Record<DropResult['kind'], string> = {
      move: c.source.type === 'pieceOne' ? 'Take piece' : 'Move',
      merge: 'Stack cards',
      zone: 'Place in zone',
      hand: 'Hand',
      token: 'Stack tokens',
      supply: pieceDrop ? 'Return piece' : 'Return token',
      none: '',
    };
    const label = rolled ? (thrown.length > 1 ? `Throw ${thrown.length} dice` : 'Roll') : labels[res.kind];
    this.commit(next, { label }, { ...clear, settle, ...handPatch, ...(rolled ? this.readoutPatch(next, thrown) : {}) });
    this.scheduleSettleClear(res.landed);
    // a piece now rests somewhere new: it may cover (or uncover) another piece's count badge
    this.scheduleLabels();

    if (rolled) playSound('dice', { count: thrown.length });
    else if (res.kind === 'token' || res.kind === 'supply' || (c.source.type === 'tokenOne')) playSound('clink');
    else if (res.kind === 'hand') playSound('slide', { volume: 0.8 });
    else playSound('place');
  }

  private scheduleSettleClear(ids: ID[]) {
    window.setTimeout(() => {
      const cur = this.ui.getState().settle;
      if (!ids.some((id) => cur[id])) return;
      const n = { ...cur };
      for (const id of ids) delete n[id];
      this.ui.setState({ settle: n });
    }, 700);
  }

  private finishMarquee(g: MarqueeG, e: PointerEvent) {
    if (this.marqueeEl) this.marqueeEl.hidden = true;
    const a = this.screenToWorld(g.sx, g.sy);
    const b = this.screenToWorld(e.clientX, e.clientY);
    const rect: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    const s = this.state;
    const sel: Record<ID, true> = g.additive ? { ...this.ui.getState().selection } : {};
    for (const id of s.order) {
      const en = s.entities[id];
      if (!en || this.isFixed(en)) continue;
      if (rectsIntersect(rect, worldAABB(this.game, en))) sel[id] = true;
    }
    this.ui.setState({ selection: sel });
  }

  /* ================================================================ */
  /* Menus                                                              */
  /* ================================================================ */

  /** `boxHint`: opened by a finger still held on the table — say that dragging on box-selects. */
  openMenuFor(hit: Hit, x: number, y: number, boxHint = false) {
    let items: MenuItem[] = [];
    if (hit.area === 'entity') {
      const en = this.state.entities[hit.id];
      if (!en) return;
      items = entityMenu(this, en.id, hit.cardUid);
      if (!this.isFixed(en) && !this.ui.getState().selection[en.id]) this.ui.setState({ selection: { [en.id]: true } });
      if (en.kind === 'stack') this.lastStackId = en.id;
    } else if (hit.area === 'hand') {
      items = handMenu(this, hit.uid);
    } else {
      items = tableMenu(this, this.screenToWorld(x, y));
    }
    if (boxHint) items = [...boxSelectHint(), ...items];
    if (items.length) this.ui.setState({ menu: { x, y, items } });
  }

  /* ================================================================ */
  /* Keyboard                                                           */
  /* ================================================================ */

  /** Hovered entity (desktop) else the selection. */
  targets(kinds?: Entity['kind'][]): ID[] {
    const s = this.state;
    let ids: ID[];
    // a locked board or zone under the mouse is the table, not a target: fall back to the selection
    if (this.hoverId && s.entities[this.hoverId] && !this.isFixed(s.entities[this.hoverId])) {
      const sel = this.ui.getState().selection;
      ids = sel[this.hoverId] ? Object.keys(sel).filter((id) => s.entities[id]) : [this.hoverId];
    } else ids = Object.keys(this.ui.getState().selection).filter((id) => s.entities[id]);
    if (kinds) ids = ids.filter((id) => kinds.includes(s.entities[id].kind));
    return ids;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const ui = this.ui.getState();
    if (ui.menu || ui.browse || ui.shortcutsOpen) return;
    if (document.querySelector('.ui-dialog-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;

    if (mod && (k === 'z' || k === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) this.props.onRedo?.();
      else this.props.onUndo?.();
      return;
    }
    if (mod && (k === 'y' || k === 'Y')) {
      e.preventDefault();
      this.props.onRedo?.();
      return;
    }
    if (mod && (k === 'a' || k === 'A')) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (mod || e.repeat && !['+', '=', '-', '_', 'q', 'e', 'Q', 'E'].includes(k)) {
      if (k === ' ' ) e.preventDefault();
      return;
    }

    switch (k) {
      case ' ':
        e.preventDefault();
        if (!ui.spaceHeld) this.ui.setState({ spaceHeld: true });
        return;
      case 'Alt':
      case 'z':
      case 'Z':
        e.preventDefault();
        this.inspectHovered(false);
        return;
      case 'f':
      case 'F':
        this.flip(this.targets());
        return;
      case 'q':
      case 'Q':
        this.rotate(this.targets(), -90);
        return;
      case 'e':
      case 'E':
        this.rotate(this.targets(), 90);
        return;
      case 's':
      case 'S':
        for (const id of this.targets(['stack'])) this.shuffle(id);
        return;
      case 'd':
      case 'D': {
        if (this.mode !== 'play') return;
        const t = this.targets(['stack']);
        const id = t[0] ?? (this.lastStackId && this.state.entities[this.lastStackId] ? this.lastStackId : null);
        if (id) this.drawToHand(id, 1);
        else toast('Point at a deck first', { description: 'Hover a stack of cards, then press D to draw.' });
        return;
      }
      case 'r':
      case 'R':
        this.roll(this.targets(['die']));
        return;
      case '+':
      case '=':
        for (const id of this.targets(['counter'])) this.counter(id, 1);
        return;
      case '-':
      case '_':
        for (const id of this.targets(['counter'])) this.counter(id, -1);
        return;
      case 'l':
      case 'L':
        this.toggleLock(this.targets(), true);
        return;
      case 'g':
      case 'G':
        for (const id of this.targets(['stack'])) this.toggleSpread(id);
        return;
      case 'Delete':
      case 'Backspace': {
        const ids = this.targets(this.mode === 'play' ? ['note'] : undefined);
        if (ids.length) {
          e.preventDefault();
          this.deleteEntities(ids);
        }
        return;
      }
      case '?':
        this.ui.setState({ shortcutsOpen: true });
        return;
      case 'n':
      case 'N':
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        this.toggleNames();
        return;
      case '0':
      case 'Home':
        this.fitAll(true);
        return;
      case 'Escape':
        // first press closes the roll readout and keeps the selection, ready to roll again
        if (ui.rollReadout) {
          this.ui.setState({ rollReadout: null });
          return;
        }
        this.ui.setState({ selection: {}, inspect: null, editingNote: null, raisedHandCard: null, rollReadout: null });
        return;
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') this.ui.setState({ spaceHeld: false });
    if (e.key === 'Alt' || e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      const insp = this.ui.getState().inspect;
      if (insp && !insp.sticky) this.ui.setState({ inspect: null });
    }
  };

  /* ================================================================ */
  /* Actions (used by keys, menus, overlays)                            */
  /* ================================================================ */

  private settleMany(ids: ID[], infos?: Record<ID, SettleInfo>) {
    const settle = { ...this.ui.getState().settle };
    for (const id of ids) {
      if (infos?.[id]) this.settleFrom.set(id, infos[id]);
      settle[id] = this.nextSeq();
    }
    this.scheduleSettleClear(ids);
    return settle;
  }

  select(ids: ID[]) {
    this.ui.setState({ selection: Object.fromEntries(ids.map((id) => [id, true as const])) });
  }

  clearSelection() {
    this.ui.setState({ selection: {} });
  }

  selectAll() {
    const s = this.state;
    this.select(s.order.filter((id) => s.entities[id] && !this.isFixed(s.entities[id])));
  }

  flip(ids: ID[]) {
    let s = this.state;
    for (const id of ids) {
      const en = s.entities[id];
      if (en?.kind === 'stack') s = ops.flipTop(s, id);
      else if (en?.kind === 'token' && !en.infinite) s = ops.flipToken(s, id);
    }
    if (s !== this.state) {
      this.commit(s, { label: 'Flip' });
      playSound('flip');
    }
  }

  flipWholeStack(id: ID) {
    const s = ops.flipStack(this.state, id);
    if (s !== this.state) {
      this.commit(s, { label: 'Flip stack' });
      playSound('flip');
    }
  }

  setStackFace(id: ID, faceUp: boolean) {
    const s = ops.setStackFace(this.state, id, faceUp);
    if (s !== this.state) {
      this.commit(s, { label: faceUp ? 'Turn face up' : 'Turn face down' });
      playSound('flip');
    }
  }

  setRotation(ids: ID[], deg: number) {
    let s = this.state;
    for (const id of ids) {
      const e = s.entities[id];
      if (e && e.rot !== deg) s = ops.updateEntity(s, id, (en) => ({ ...en, rot: deg }));
    }
    if (s === this.state) return;
    this.commit(s, { label: 'Rotate' });
    playSound('slide', { volume: 0.5 });
  }

  rotate(ids: ID[], delta: number) {
    const movable = ids.filter((id) => this.state.entities[id]);
    if (!movable.length) return;
    this.commit(ops.rotateEntities(this.state, movable, delta), { label: 'Rotate' });
    playSound('slide', { volume: 0.5 });
  }

  shuffle(id: ID) {
    const st = this.state.entities[id];
    if (st?.kind !== 'stack' || st.cards.length < 2) return;
    const seq = this.nextSeq();
    this.commit(ops.shuffleStack(this.state, id), { label: 'Shuffle' }, { shuffling: { ...this.ui.getState().shuffling, [id]: seq } });
    playSound('shuffle');
    window.setTimeout(() => {
      const cur = this.ui.getState().shuffling;
      if (cur[id] !== seq) return;
      const n = { ...cur };
      delete n[id];
      this.ui.setState({ shuffling: n });
    }, 760);
  }

  drawToHand(id: ID, n = 1) {
    if (this.mode !== 'play') return;
    const st = this.state.entities[id];
    if (st?.kind !== 'stack') return;
    this.lastStackId = id;
    const k = Math.min(n, st.cards.length);
    const drawn = st.cards.slice(-k);
    const sp = this.worldToScreen({ x: st.x, y: st.y });
    const scale = (cardDims(this.game, drawn[0]).h * this.camera.zoom) / Math.max(1, this.handCardH);
    drawn
      .slice()
      .reverse()
      .forEach((c, i) => this.handArrivals.set(c.uid, { x: sp.x, y: sp.y, scale, delay: i * 70 }));
    const next = ops.drawToHand(this.state, id, k);
    this.commit(next, { label: k > 1 ? `Draw ${k}` : 'Draw' }, this.ui.getState().handCollapsed ? { handCollapsed: false } : undefined);
    for (let i = 0; i < Math.min(k, 5); i++) playSound('slide', { delay: i * 0.07 });
  }

  dealRow(id: ID, n: number, faceUp = true) {
    const st = this.state.entities[id];
    if (st?.kind !== 'stack') return;
    const r = ops.dealRow(this.game, this.state, id, n, faceUp);
    if (!r.ids.length) return;
    const infos: Record<ID, SettleInfo> = {};
    r.ids.forEach((nid, i) => {
      const en = r.state.entities[nid];
      infos[nid] = { dx: (st.x - en.x) * K, dy: (st.y - en.y) * K, mode: 'whole', delay: i * 80 };
    });
    this.commit(r.state, { label: `Deal ${r.ids.length}` }, { settle: this.settleMany(r.ids, infos) });
    r.ids.forEach((_, i) => playSound('slide', { delay: i * 0.08, volume: 0.8 }));
    r.ids.forEach((_, i) => playSound('place', { delay: i * 0.08 + 0.22, volume: 0.5 }));
  }

  split(id: ID) {
    const st = this.state.entities[id];
    if (!st) return;
    const r = ops.splitStack(this.game, this.state, id);
    if (!r) return;
    const en = r.state.entities[r.id];
    this.commit(r.state, { label: 'Split' }, { settle: this.settleMany([r.id], { [r.id]: { dx: (st.x - en.x) * K, dy: (st.y - en.y) * K, mode: 'whole' } }) });
    playSound('slide');
  }

  splitTokens(id: ID) {
    const t = this.state.entities[id];
    if (!t) return;
    const r = ops.splitTokens(this.game, this.state, id);
    if (!r) return;
    const en = r.state.entities[r.id];
    this.commit(r.state, { label: 'Split tokens' }, { settle: this.settleMany([r.id], { [r.id]: { dx: (t.x - en.x) * K, dy: (t.y - en.y) * K, mode: 'whole' } }) });
    playSound('clink');
  }

  setLayout(id: ID, layout: StackEntity['layout']) {
    let next = ops.setLayout(this.state, id, layout);
    if (next === this.state) return;
    if (layout !== 'pile') next = this.keepOnTable(next, id);
    const infos = layout !== 'pile' ? { [id]: { dx: 0, dy: 0, mode: 'spread' as const } } : undefined;
    this.commit(next, { label: layout === 'pile' ? 'Gather' : 'Spread' }, { settle: this.settleMany([id], infos) });
    playSound('slide');
    if (layout !== 'pile') {
      const en = next.entities[id];
      if (en) this.revealRect(worldAABB(this.game, en));
    }
  }

  /**
   * A spread-out deck is much bigger than the pile it came from. Slide it back so it
   * stays over the play area instead of hanging off the edge of the world.
   */
  private keepOnTable(s: TableState, id: ID): TableState {
    const en = s.entities[id];
    if (!en) return s;
    const fixed = s.order.map((i) => s.entities[i]).filter((e): e is Entity => !!e && e.id !== id && (e.kind === 'board' || e.kind === 'zone'));
    const area = fixed.length ? stateBounds(this.game, s, fixed.map((e) => e.id)) : stateBounds(this.game, s);
    if (!area) return s;
    const b = worldAABB(this.game, en);
    const pad = 6;
    let dx = 0;
    let dy = 0;
    if (b.w + pad * 2 <= area.w) dx = clamp(b.x, area.x + pad, area.x + area.w - b.w - pad) - b.x;
    else dx = area.x + (area.w - b.w) / 2 - b.x;
    if (b.h + pad * 2 <= area.h) dy = clamp(b.y, area.y + pad, area.y + area.h - b.h - pad) - b.y;
    else dy = area.y + (area.h - b.h) / 2 - b.y;
    return dx || dy ? ops.translateEntities(s, [id], dx, dy) : s;
  }

  /** Pan/zoom only as much as needed to bring `rect` fully into view. */
  revealRect(rect: Rect) {
    const v = this.viewWorldRect();
    const ins = this.insets();
    const z = this.camera.zoom;
    const vis: Rect = { x: v.x + ins.l / z, y: v.y + ins.t / z, w: v.w - (ins.l + ins.r) / z, h: v.h - (ins.t + ins.b) / z };
    if (rect.x >= vis.x && rect.y >= vis.y && rect.x + rect.w <= vis.x + vis.w && rect.y + rect.h <= vis.y + vis.h) return;
    const pad = 10;
    this.fitRect({ x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 }, true, z);
  }

  toggleSpread(id: ID) {
    const st = this.state.entities[id];
    if (st?.kind !== 'stack' || st.cards.length < 2) return;
    this.setLayout(id, st.layout === 'pile' ? 'row' : 'pile');
  }

  roll(ids: ID[]) {
    const r = this.throwDice(this.state, ids, {});
    if (!r.ids.length) return;
    this.commit(r.state, { label: r.ids.length > 1 ? `Roll ${r.ids.length} dice` : 'Roll' }, this.readoutPatch(r.state, r.ids));
    playSound('dice', { count: r.ids.length });
  }

  /** The readout lists a multi-dice roll; a single die needs none (and replaces an old one). */
  private readoutPatch(s: TableState, ids: ID[]): Partial<TableUi> {
    if (ids.length < 2) return { rollReadout: null };
    return { rollReadout: { ids, seqs: ids.map((id) => (s.entities[id] as { rollSeq?: number }).rollSeq ?? 0), seq: this.nextSeq() } };
  }

  /** Collision radius of a die on the table (mm): its solid reaches a little past the hit box. */
  private dieRadius(e: Entity) {
    const comp = e.kind === 'die' ? getComponent(this.game, e.componentId) : undefined;
    return (comp?.kind === 'dice' ? comp.size : 16) * 0.7;
  }

  /**
   * Roll dice as one throw: new faces, and landing spots that never overlap each other or a
   * resting die. With `from` (where each die left the hand) and a direction the dice fly out
   * and stay inside the visible table; without, they tumble where they lie. Never moves the camera.
   */
  private dieSize(e: Entity) {
    const comp = e.kind === 'die' ? getComponent(this.game, e.componentId) : undefined;
    return comp?.kind === 'dice' ? comp.size : 16;
  }

  private throwDice(s: TableState, ids: ID[], o: { from?: Map<ID, Vec>; flick?: Map<ID, Vec>; dir?: Vec; travel?: number }): { state: TableState; ids: ID[] } {
    const dice = ids.map((id) => s.entities[id]).filter((e): e is Extract<Entity, { kind: 'die' }> => e?.kind === 'die' && !e.locked);
    if (!dice.length) return { state: s, ids: [] };
    const set = new Set(dice.map((d) => d.id));
    const throwing = !!o.from && (o.travel ?? 0) > 0;
    const plan = dice.map((d) => ({ id: d.id, from: o.from?.get(d.id) ?? { x: d.x, y: d.y } }));
    const obstacles = Object.values(s.entities)
      .filter((e) => e.kind === 'die' && !set.has(e.id))
      .map((e) => ({ x: e.x, y: e.y, r: this.dieRadius(e) }));
    // cards, tokens, notes, counters: a throw lands beside them when there is room
    const rects = throwing
      ? Object.values(s.entities)
          .filter((e) => !set.has(e.id) && e.kind !== 'die' && e.kind !== 'board' && e.kind !== 'zone')
          .map((e) => worldAABB(this.game, e))
      : [];
    // every throw and roll — mouse, touch, keys, menu, one die or a handful — is planned by planDiceThrow
    const trays = throwing
      ? renderOrder(s)
          .map((id) => s.entities[id])
          .filter(isTray)
          .reverse()
          .map((zone) => ({
            zone,
            resting: Object.values(s.entities)
              .filter((e): e is DieEntity => e.kind === 'die' && !set.has(e.id) && inZone(zone, e))
              .map((e) => ({ x: e.x, y: e.y, size: this.dieSize(e) })),
          }))
      : [];
    const planned = planDiceThrow({
      dice: plan.map((p, i) => ({ id: p.id, from: p.from, size: this.dieSize(dice[i]), flick: o.flick?.get(p.id) })),
      dir: throwing ? o.dir! : { x: 0, y: 0 },
      travel: throwing ? o.travel! : 0,
      area: o.from ? this.landingArea(4) : null,
      obstacles,
      rects,
      blocked: this.chromeKeepOut(),
      trays,
      seed: Math.floor(Math.random() * 2 ** 31),
    });
    const land = planned.land;
    const tray = planned.tray;
    let next = s;
    for (const d of dice) {
      const comp = getComponent(this.game, d.componentId);
      next = ops.rollDie(next, d.id, comp?.kind === 'dice' && comp.faces.length ? comp.faces.length : 6, undefined, { scatter: false });
      const p = land.get(d.id)!;
      const spin = (Math.random() - 0.5) * (throwing ? 110 : 50);
      next = ops.updateEntity(next, d.id, (e) => ({ ...e, x: p.x, y: p.y, rot: e.rot + spin }));
      const from = o.from?.get(d.id);
      const seq = (next.entities[d.id] as { rollSeq?: number }).rollSeq ?? 0;
      if (from) this.launches.set(d.id, { seq, x: from.x * K, y: from.y * K });
      else this.launches.delete(d.id);
    }
    if (throwing) next = ops.bringToFront(next, dice.map((d) => d.id));
    // dice that come to rest in a zone arranging dice (a grid, a pool) take their cell / slot there
    const byZone = new Map<ID, ID[]>();
    for (const d of dice) {
      const en = next.entities[d.id];
      if (!en) continue;
      let zid: ID | null = tray && inZone(tray, en) ? tray.id : null;
      if (!zid) {
        const order = renderOrder(next);
        let endless: ID | null = null;
        for (let i = order.length - 1; i >= 0 && !zid; i--) {
          const z = next.entities[order[i]];
          if (z?.kind !== 'zone' || !zoneTakes(z, 'dice') || !inZone(z, en)) continue;
          if (isEndless(z)) endless ??= z.id;
          else zid = z.id;
        }
        zid ??= endless;
      }
      const z = zid ? next.entities[zid] : null;
      if (!z || z.kind !== 'zone' || (!z.grid && pieceModeOf(z) === 'free' && !tray)) continue;
      byZone.set(z.id, [...(byZone.get(z.id) ?? []), d.id]);
    }
    for (const [zid, zids] of byZone) next = placeInZone(this.game, next, zid, zids).state;
    return { state: next, ids: dice.map((d) => d.id) };
  }

  setDieFace(id: ID, face: number) {
    this.commit(ops.setDieFace(this.state, id, face), { label: 'Set die' });
    playSound('tap');
  }

  counter(id: ID, steps: number) {
    const next = ops.changeCounter(this.state, id, steps);
    if (next === this.state) return;
    this.commit(next, { label: 'Counter', coalesceKey: `counter:${id}` });
    playSound('tap', { volume: 0.8 });
  }

  setCounterValue(id: ID, value: number) {
    this.commit(ops.setCounter(this.state, id, value), { label: 'Set counter' });
    playSound('tap');
  }

  resetCounter(id: ID) {
    const c = this.state.entities[id];
    if (c?.kind !== 'counter') return;
    const comp = getComponent(this.game, c.componentId);
    const initial = comp?.kind === 'counter' ? comp.initial : Math.max(c.min, Math.min(c.max, 0));
    this.setCounterValue(id, initial);
  }

  renameCounter(id: ID, label: string) {
    this.commit(ops.updateEntity(this.state, id, (e) => (e.kind === 'counter' ? { ...e, label } : e)), { label: 'Rename counter' });
  }

  toggleLock(ids: ID[], announce = false) {
    const ents = ids.map((id) => this.state.entities[id]).filter(Boolean) as Entity[];
    if (!ents.length) return;
    const lock = ents.some((e) => !this.isFixed(e));
    this.commit(ops.setLocked(this.state, ents.map((e) => e.id), lock), { label: lock ? 'Lock' : 'Unlock' });
    if (lock) this.ui.setState({ selection: {} });
    if (announce) {
      const what = ents.length === 1 ? (ents[0].kind === 'board' ? 'Board' : ents[0].kind === 'zone' ? 'Zone' : 'Piece') : `${ents.length} pieces`;
      toast(lock ? `${what} locked` : `${what} unlocked`, {
        description: lock ? 'Dragging it now moves the table instead.' : 'You can drag it around now. Press L to lock it again.',
        duration: 2600,
      });
    }
    playSound('tap');
  }

  deleteEntities(ids: ID[]) {
    const next = ops.removeEntities(this.state, ids);
    if (next === this.state) return;
    this.commit(next, { label: 'Delete' });
    toast(ids.length > 1 ? `Removed ${ids.length} pieces` : 'Removed', { action: { label: 'Undo', onClick: () => this.props.onUndo?.() }, duration: 4000 });
  }

  addNote(at: Vec) {
    const r = ops.addNote(this.state, at);
    this.commit(r.state, { label: 'Add note' }, { editingNote: r.id, selection: { [r.id]: true }, settle: this.settleMany([r.id]) });
    playSound('place', { volume: 0.6 });
  }

  setNoteText(id: ID, text: string) {
    this.commit(ops.setNoteText(this.state, id, text), { label: 'Edit note', coalesceKey: `note:${id}` });
  }

  setNoteColor(id: ID, color: string) {
    this.commit(ops.setNoteColor(this.state, id, color), { label: 'Note colour' });
  }

  editNote(id: ID) {
    this.ui.setState({ editingNote: id, selection: { [id]: true } });
  }

  addCounter(at: Vec) {
    const r = ops.addCounter(this.state, at, { value: 0, min: 0, max: 99, label: 'Counter' });
    this.commit(r.state, { label: 'Add counter' }, { settle: this.settleMany([r.id]) });
    playSound('place', { volume: 0.6 });
  }

  takeTokenBeside(id: ID) {
    const t = this.state.entities[id];
    if (t?.kind !== 'token') return;
    const c = getComponent(this.game, t.componentId);
    const w = c?.kind === 'tokens' ? c.width : 20;
    const off = rotateVec({ x: w * (t.infinite ? 1.9 : 1.3), y: 0 }, t.rot);
    const at = { x: t.x + off.x, y: t.y + off.y };
    const r = ops.takeToken(this.state, id, at);
    if (!r) return;
    this.commit(r.state, { label: 'Take token' }, { settle: this.settleMany([r.id], { [r.id]: { dx: -off.x * K, dy: -off.y * K, mode: 'whole' } }) });
    playSound('clink');
  }

  takePieceBeside(id: ID) {
    const sp = this.state.entities[id];
    if (sp?.kind !== 'piece' || !sp.infinite) return;
    const bowl = baseSize(this.game, sp).w;
    const one = baseSize(this.game, { ...sp, infinite: false }).w;
    const off = { x: bowl / 2 + one * 0.75, y: 0 };
    const r = ops.takePiece(this.state, id, this.clampToTable({ x: sp.x + off.x, y: sp.y + off.y }, 4));
    if (!r) return;
    const en = r.state.entities[r.id];
    const from = { dx: (sp.x - en.x) * K, dy: (sp.y - en.y) * K, mode: 'whole' as const };
    this.commit(r.state, { label: 'Take piece' }, { settle: this.settleMany([r.id], { [r.id]: from }) });
    playSound('place', { volume: 0.7 });
  }

  returnPieceToSupply(id: ID) {
    const p = this.state.entities[id];
    if (p?.kind !== 'piece' || p.infinite) return;
    this.commit(ops.removeEntities(this.state, [id]), { label: 'Return piece' });
    playSound('place', { volume: 0.6 });
  }

  /** Render density for pieces: re-rendered only when the zoom crosses a half-octave. */
  private updatePieceRes() {
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const res = ppmBucket(this.camera.zoom * dpr);
    if (this.ui.getState().pieceRes !== res) this.ui.setState({ pieceRes: res });
  }

  returnTokenToSupply(id: ID) {
    const t = this.state.entities[id];
    if (t?.kind !== 'token') return;
    const supply = Object.values(this.state.entities).find((e) => e.kind === 'token' && e.infinite && e.componentId === t.componentId && e.id !== id);
    const next = supply ? ops.mergeTokens(this.state, id, supply.id, 1) : ops.removeOneToken(this.state, id);
    this.commit(next, { label: 'Return token' });
    playSound('clink');
  }

  playHandCard(uid: ID, opts: { faceUp?: boolean; at?: Vec } = {}) {
    if (!this.state.hand.some((c) => c.uid === uid)) return;
    const at = opts.at ?? this.freeSpotNear(this.viewCenterWorld());
    const r = ops.playFromHand(this.state, uid, at, { faceUp: opts.faceUp ?? true });
    if (!r) return;
    let info: SettleInfo | undefined;
    const el = this.root?.querySelector<HTMLElement>(`[data-hand-uid="${CSS.escape(uid)}"] .play-hand__face`);
    if (el) {
      const rr = el.getBoundingClientRect();
      const w = this.screenToWorld(rr.left + rr.width / 2, rr.top + rr.height / 2);
      info = { dx: (w.x - at.x) * K, dy: (w.y - at.y) * K, mode: 'whole' };
    }
    this.commit(r.state, { label: 'Play card' }, { settle: this.settleMany([r.id], info ? { [r.id]: info } : undefined), raisedHandCard: null });
    playSound('place');
  }

  /** A point near `p` not covered by a card stack (so played cards don't hide others). */
  freeSpotNear(p: Vec): Vec {
    const s = this.state;
    const stacks = Object.values(s.entities).filter((e) => e.kind === 'stack');
    const occupied = (q: Vec) => stacks.some((e) => Math.hypot(e.x - q.x, e.y - q.y) < 30);
    if (!occupied(p)) return p;
    for (let ring = 1; ring < 8; ring++) {
      for (let a = 0; a < 8; a++) {
        const q = { x: p.x + Math.cos((a / 8) * Math.PI * 2) * ring * 34, y: p.y + Math.sin((a / 8) * Math.PI * 2) * ring * 34 };
        if (!occupied(q)) return q;
      }
    }
    return p;
  }

  handCardToStack(uid: ID, stackId: ID, where: 'top' | 'bottom') {
    const st = this.state.entities[stackId];
    if (st?.kind !== 'stack') return;
    const r = ops.handRemove(this.state, [uid]);
    if (!r.cards.length) return;
    const faceUp = st.cards[st.cards.length - 1]?.faceUp ?? false;
    const next = ops.putCards(r.state, stackId, r.cards.map((c) => ({ ...c, faceUp })), where);
    this.commit(next, { label: where === 'top' ? 'Put on top' : 'Put on bottom' }, { settle: this.settleMany([stackId]) });
    playSound('place');
  }

  takeFromStack(id: ID, uid: ID, dest: 'hand' | 'table') {
    const st = this.state.entities[id];
    if (st?.kind !== 'stack') return;
    if (dest === 'hand') {
      const r = ops.removeCards(this.state, id, [uid]);
      this.commit(ops.handInsert(r.state, r.cards), { label: 'Take to hand' }, this.ui.getState().handCollapsed ? { handCollapsed: false } : undefined);
      playSound('slide');
      return;
    }
    const lb = localBounds(this.game, st);
    const { w } = cardDims(this.game, st.cards[st.cards.length - 1]);
    const off = rotateVec({ x: lb.x + lb.w + 8 + w / 2, y: 0 }, st.rot);
    const at = this.freeSpotNear({ x: st.x + off.x, y: st.y + off.y });
    const r = ops.takeCard(this.state, id, uid, at, { faceUp: true });
    if (!r) return;
    this.commit(r.state, { label: 'Take card' }, { settle: this.settleMany([r.id], { [r.id]: { dx: (st.x - at.x) * K, dy: (st.y - at.y) * K, mode: 'whole' } }) });
    playSound('place');
  }

  moveCardInStack(id: ID, uid: ID, where: 'top' | 'bottom') {
    this.commit(ops.moveCardInStack(this.state, id, uid, where), { label: where === 'top' ? 'Move to top' : 'Move to bottom' });
    playSound('slide', { volume: 0.6 });
  }

  inspectHovered(sticky: boolean) {
    const s = this.state;
    if (this.hoverHandUid) {
      const card = s.hand.find((c) => c.uid === this.hoverHandUid);
      if (card) this.ui.setState({ inspect: { card, faceUp: true, sticky } });
      return;
    }
    const id = this.hoverId ?? this.targets()[0];
    if (id) this.inspectEntity(id, sticky);
  }

  inspectEntity(id: ID, sticky: boolean, cardUid?: ID) {
    const en = this.state.entities[id];
    if (!en) return;
    if (en.kind === 'stack') {
      const card = (cardUid && en.cards.find((c) => c.uid === cardUid)) || en.cards[en.cards.length - 1];
      this.ui.setState({ inspect: { card, faceUp: card.faceUp, sticky } });
    } else if (en.kind === 'board' || en.kind === 'token' || en.kind === 'note') {
      this.ui.setState({ inspect: { entity: en, faceUp: en.kind === 'token' ? en.faceUp : true, sticky } });
    }
  }

  inspectHandCard(uid: ID) {
    const card = this.state.hand.find((c) => c.uid === uid);
    if (card) this.ui.setState({ inspect: { card, faceUp: true, sticky: true } });
  }

  browse(id: ID) {
    this.ui.setState({ browse: id, menu: null });
  }

  /** The deck a card belongs to, if a stack of that deck is on the table (largest first). */
  homeStackFor(deckId: ID): StackEntity | null {
    let best: StackEntity | null = null;
    for (const e of Object.values(this.state.entities)) {
      if (e.kind === 'stack' && e.cards.length && e.cards[e.cards.length - 1].deckId === deckId && (!best || e.cards.length > best.cards.length)) best = e;
    }
    return best;
  }

  deckName(deckId: ID) {
    return getDeck(this.game, deckId)?.name ?? 'deck';
  }
}

type DropResult = ReturnType<typeof applyDrop>;
