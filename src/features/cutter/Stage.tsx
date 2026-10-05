/**
 * The Cutter's stage: a zoomable / pannable page with an SVG overlay in PAGE UNITS (mm on PDF
 * pages, pixels on images). Grown from the slicer's PageCanvas (which stays until stage 8): the
 * page bitmap comes from any provider at any resolution, and a background drag can draw.
 *
 * Input model (same for mouse, pen and touch):
 *  - one pointer on an overlay element → that element's drag (tap = click)
 *  - one pointer elsewhere → pan (tap = background tap)
 *  - two pointers → pinch-zoom + pan (cancels any drag in progress)
 *  - wheel → zoom at cursor (trackpad scroll pans), Space/middle-drag pans
 * A magnifying loupe follows precise drags.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { IconButton, Spinner } from '@/ui';

export interface Pt {
  x: number;
  y: number;
}

export interface DragInfo {
  dx: number;
  dy: number;
  shift: boolean;
  alt: boolean;
}

export interface DragHandlers {
  /** Called once the pointer has actually moved (not for taps). */
  onStart?: () => void;
  onMove?: (p: Pt, d: DragInfo) => void;
  onEnd?: () => void;
  onCancel?: () => void;
  onTap?: (p: Pt, mods: { shift: boolean; ctrl: boolean }) => void;
  /** Show the loupe centred on this page point while dragging. */
  loupe?: () => Pt | null;
  /** Short text shown next to the pointer while dragging. */
  readout?: () => string | null;
}

export interface OverlayCtx {
  zoom: number;
  interactive: boolean;
  coarse: boolean;
}

interface CanvasApi {
  zoom: number;
  coarse: boolean;
  beginDrag: (h: DragHandlers) => void;
}

const CanvasCtx = createContext<CanvasApi>({ zoom: 1, coarse: false, beginDrag: () => {} });
export const useCanvas = () => useContext(CanvasCtx);

interface View {
  zoom: number;
  x: number;
  y: number;
}

const LOUPE = 176;

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** The page picture at `pxPerUnit` screen-independent pixels per page unit (the closest it has). */
export type BitmapProvider = (pxPerUnit: number) => Promise<CanvasImageSource & { width: number; height: number }>;

/** Whether a finger / button is down on the stage (page changes wait until it is up). */
export const stageGestures = { busy: () => false };

export function Stage({
  pageKey,
  bitmap,
  levels,
  pageW,
  pageH,
  overlay,
  onBackgroundTap,
  onBackgroundDrag,
  onNudge,
  nudgeStep = [0.1, 1],
  children,
  toolbar,
  className,
  reserveBottom = 0,
  reserveTop = 0,
  focus = null,
  loupeMin = 9,
}: {
  /** The loupe magnifies at least to this many screen px per page unit (9 suits mm). */
  loupeMin?: number;
  /** Bring this page rectangle into view when its key changes, if it is small on screen. */
  focus?: { key: string; x: number; y: number; w: number; h: number } | null;
  /** Space kept free above the fitted page (the hint), px. */
  reserveTop?: number;
  /** Space kept free under the fitted page for the hint and the zoom bar (px). */
  reserveBottom?: number;
  /** Changes when the page changes (re-fit, new bitmap). */
  pageKey: string;
  bitmap: BitmapProvider | null;
  /** Resolutions (px per page unit) worth asking for, ascending. */
  levels: number[];
  pageW: number;
  pageH: number;
  overlay?: (o: OverlayCtx) => ReactNode;
  onBackgroundTap?: (p: Pt) => void;
  /** A drag that starts on the page background (not on a handle): return handlers to take it, or null to pan. */
  onBackgroundDrag?: (p: Pt) => DragHandlers | null;
  onNudge?: (dx: number, dy: number) => void;
  /** Arrow-key nudge in page units: [plain, with Shift]. */
  nudgeStep?: [number, number];
  children?: ReactNode;
  toolbar?: ReactNode;
  className?: string;
}) {
  const page = pageKey;
  const renderer = bitmap;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitted = useRef(true);
  const coarse = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches, []);

  const fitView = useCallback((): View | null => {
    if (!size.w || !size.h) return null;
    const pad = Math.min(48, Math.max(16, Math.min(size.w, size.h) * 0.05));
    const bottom = Math.max(pad, reserveBottom);
    const top = Math.max(pad, reserveTop);
    const zoom = Math.max(0.05, Math.min((size.w - pad * 2) / pageW, (size.h - top - bottom) / pageH));
    return { zoom, x: (size.w - pageW * zoom) / 2, y: top + (size.h - top - bottom - pageH * zoom) / 2 };
  }, [size.w, size.h, pageW, pageH, reserveBottom, reserveTop]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit on page change and when the container resizes (unless the user zoomed).
  const lastPage = useRef<string>('');
  useLayoutEffect(() => {
    const key = `${page}|${pageW}|${pageH}`;
    if (key !== lastPage.current || fitted.current || !viewRef.current) {
      lastPage.current = key;
      fitted.current = true;
      const v = fitView();
      if (v) setView(v);
    }
  }, [page, pageW, pageH, fitView]);

  // a small piece selected: zoom in on it (never out)
  useEffect(() => {
    const v = viewRef.current;
    if (!focus || !v || !size.w) return;
    if (Math.max(focus.w, focus.h) * v.zoom >= 170) return;
    const z = Math.min(60, (size.w * 0.45) / focus.w, (size.h * 0.45) / focus.h);
    if (z <= v.zoom) return;
    fitted.current = false;
    setView({ zoom: z, x: size.w / 2 - (focus.x + focus.w / 2) * z, y: size.h / 2 - (focus.y + focus.h / 2) * z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  const fitZoom = fitView()?.zoom ?? 1;
  const setZoomAt = useCallback(
    (cx: number, cy: number, zoom: number) => {
      const v = viewRef.current;
      if (!v) return;
      const z = Math.max(fitZoom * 0.4, Math.min(60, zoom));
      const px = (cx - v.x) / v.zoom;
      const py = (cy - v.y) / v.zoom;
      fitted.current = false;
      setView({ zoom: z, x: cx - px * z, y: cy - py * z });
    },
    [fitZoom],
  );

  /* ---------------- page bitmap (resolution follows zoom) ---------------- */
  const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const need = view ? view.zoom * dpr : levels[0];
  const wantDpi = levels.find((d) => d >= need * 0.85) ?? levels[levels.length - 1];
  const [bmp, setBmp] = useState<{ page: string; dpi: number; canvas: CanvasImageSource & { width: number; height: number }; r: BitmapProvider } | null>(null);
  const bmpOk = bmp && bmp.page === page && bmp.r === renderer ? bmp : null;
  useEffect(() => {
    if (!renderer) return;
    let alive = true;
    // keep showing what we have while a sharper version renders
    // (never downgrade — the sharper bitmap is already on screen)
    const dpi = bmpOk ? Math.max(wantDpi, bmpOk.dpi) : Math.min(wantDpi, levels[Math.min(1, levels.length - 1)]);
    if (bmpOk && bmpOk.dpi === dpi) return;
    const t = window.setTimeout(
      () => {
        renderer(dpi)
          .then((canvas) => alive && setBmp({ page, dpi, canvas, r: renderer }))
          .catch((e) => console.warn('Page render failed', e));
      },
      bmpOk ? 180 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [renderer, page, wantDpi, bmpOk]);

  const paperRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    if (bmpOk) {
      const node = bmpOk.canvas as unknown as Node;
      if (node instanceof Node) {
        if (el.firstChild !== node) el.replaceChildren(node);
      } else {
        // an ImageBitmap: paint it into a canvas of its own
        const c = document.createElement('canvas');
        c.width = bmpOk.canvas.width;
        c.height = bmpOk.canvas.height;
        c.getContext('2d')!.drawImage(bmpOk.canvas, 0, 0);
        el.replaceChildren(c);
      }
    } else el.replaceChildren();
  }, [bmpOk]);

  /* ---------------- pointer handling ---------------- */
  type Active =
    | { kind: 'drag'; id: number; h: DragHandlers; sx: number; sy: number; start: Pt; moved: boolean }
    | { kind: 'pan'; id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean; mouseMiddle: boolean }
    | { kind: 'pinch'; d0: number; c0: Pt; v0: View }
    | { kind: 'idle' };
  const pointers = useRef(new Map<number, Pt>());
  const pending = useRef<DragHandlers | null>(null);
  const active = useRef<Active | null>(null);

  // a drag belongs to the page it started on: changing page cancels it (and its loupe)
  const dragPage = useRef(page);
  useEffect(() => {
    if (dragPage.current === page) return;
    dragPage.current = page;
    const a = active.current;
    if (a?.kind === 'drag' && a.moved) a.h.onCancel?.();
    if (a) active.current = { kind: 'idle' };
    pending.current = null;
    setLoupe(null);
    setReadout(null);
    setHi(null);
    setGrabbing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  useEffect(() => {
    stageGestures.busy = () => pointers.current.size > 0;
    return () => {
      stageGestures.busy = () => false;
    };
  }, []);
  const space = useRef(false);
  const [loupe, setLoupe] = useState<{ at: Pt; focus: Pt; touch: boolean } | null>(null);
  const [readout, setReadout] = useState<{ at: Pt; text: string } | null>(null);
  const [hi, setHi] = useState<(CanvasImageSource & { width: number; height: number }) | null>(null);
  const [grabbing, setGrabbing] = useState(false);

  const toPage = (clientX: number, clientY: number): Pt => {
    const v = viewRef.current!;
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  };
  const local = (clientX: number, clientY: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const api = useMemo<CanvasApi>(
    () => ({
      zoom: view?.zoom ?? 1,
      coarse,
      beginDrag: (h) => {
        pending.current = h;
      },
    }),
    [view?.zoom, coarse],
  );

  const endGesture = () => {
    setLoupe(null);
    setReadout(null);
    setGrabbing(false);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!viewRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) {
      pending.current = null;
      return;
    }
    wrapRef.current!.setPointerCapture?.(e.pointerId);
    wrapRef.current!.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    let h = pending.current;
    pending.current = null;

    if (pointers.current.size === 2) {
      const a = active.current;
      if (a?.kind === 'drag' && a.moved) a.h.onCancel?.();
      const [p1, p2] = [...pointers.current.values()];
      const v = viewRef.current;
      active.current = { kind: 'pinch', d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, c0: local((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), v0: v };
      endGesture();
      return;
    }
    if (pointers.current.size > 2) return;

    if (!h && onBackgroundDrag && e.button === 0 && !space.current) h = onBackgroundDrag(toPage(e.clientX, e.clientY));
    if (h && e.button === 0 && !space.current) {
      active.current = { kind: 'drag', id: e.pointerId, h, sx: e.clientX, sy: e.clientY, start: toPage(e.clientX, e.clientY), moved: false };
    } else {
      const v = viewRef.current;
      active.current = { kind: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false, mouseMiddle: e.button === 1 };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const a = active.current;
    if (!a) return;
    if (a.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [p1, p2] = pts;
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const c = local((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
      const z = Math.max(fitZoom * 0.4, Math.min(60, a.v0.zoom * (d / a.d0)));
      const px = (a.c0.x - a.v0.x) / a.v0.zoom;
      const py = (a.c0.y - a.v0.y) / a.v0.zoom;
      fitted.current = false;
      setView({ zoom: z, x: c.x - px * z, y: c.y - py * z });
      return;
    }
    if (a.kind === 'idle' || a.id !== e.pointerId) return;
    const dist = Math.hypot(e.clientX - a.sx, e.clientY - a.sy);
    const thr = e.pointerType === 'touch' ? 9 : 4;
    if (a.kind === 'pan') {
      if (!a.moved && dist < thr) return;
      a.moved = true;
      setGrabbing(true);
      fitted.current = false;
      setView((v) => (v ? { ...v, x: a.vx + (e.clientX - a.sx), y: a.vy + (e.clientY - a.sy) } : v));
      return;
    }
    if (!a.moved) {
      if (dist < thr) return;
      a.moved = true;
      a.h.onStart?.();
      if (a.h.loupe && renderer) renderer(levels[levels.length - 1]).then((c) => setHi(c)).catch(() => {});
    }
    const p = toPage(e.clientX, e.clientY);
    a.h.onMove?.(p, { dx: p.x - a.start.x, dy: p.y - a.start.y, shift: e.shiftKey, alt: e.altKey });
    const at = local(e.clientX, e.clientY);
    const focus = a.h.loupe?.();
    setLoupe(focus ? { at, focus, touch: e.pointerType !== 'mouse' } : null);
    const text = a.h.readout?.();
    setReadout(text ? { at, text } : null);
  };

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const a = active.current;
    if (a?.kind === 'drag' && a.id === e.pointerId) {
      if (cancelled) a.moved && a.h.onCancel?.();
      else if (a.moved) a.h.onEnd?.();
      else a.h.onTap?.(a.start, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
      active.current = null;
    } else if (a?.kind === 'pan' && a.id === e.pointerId) {
      if (!a.moved && !cancelled && !a.mouseMiddle) onBackgroundTap?.(toPage(e.clientX, e.clientY));
      active.current = null;
    } else if (a?.kind === 'pinch') {
      active.current = pointers.current.size ? { kind: 'idle' } : null;
    } else if (a?.kind === 'idle' && !pointers.current.size) active.current = null;
    endGesture();
  };

  /* ---------------- wheel & keys ---------------- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!v) return;
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const mouseWheel = e.deltaMode !== 0 || (Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50 && e.deltaX === 0);
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const k = e.ctrlKey && !mouseWheel ? 0.012 : 0.0022;
        const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
        setZoomAt(cx, cy, v.zoom * Math.exp(-dy * k));
      } else {
        fitted.current = false;
        setView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoomAt]);

  const zoomBy = (f: number) => {
    const v = viewRef.current;
    if (v) setZoomAt(size.w / 2, size.h / 2, v.zoom * f);
  };
  const fit = () => {
    fitted.current = true;
    const v = fitView();
    if (v) setView(v);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('.ui-dialog-backdrop')) return;
      if (e.key === ' ') {
        space.current = true;
        if (e.target === document.body || wrapRef.current?.contains(e.target as Node)) e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = e.shiftKey ? nudgeStep[1] : nudgeStep[0];
      const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (map[e.key] && onNudge) {
        e.preventDefault();
        onNudge(...map[e.key]);
      } else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-' || e.key === '_') zoomBy(0.8);
      else if (e.key === '0') fit();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  const z = view?.zoom ?? 1;
  const pct = Math.round((z / fitZoom) * 100);

  return (
    <div
      ref={wrapRef}
      className={`cut-canvas ${grabbing ? 'is-grabbing' : ''} ${view && Math.abs(view.zoom / fitZoom - 1) > 0.02 ? 'is-zoomed' : ''} ${className ?? ''}`}
      tabIndex={0}
      aria-label="Page"
      data-testid="cut-stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onLostPointerCapture={(e) => finish(e, true)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {view && (
        <div className="cut-canvas__stage" style={{ transform: `translate(${view.x}px, ${view.y}px)`, width: pageW * z, height: pageH * z }}>
          <div className="cut-canvas__paper" ref={paperRef} />
          {!bmpOk && (
            <div className="cut-canvas__loading">
              <Spinner size={22} />
            </div>
          )}
          <svg className="cut-canvas__overlay" viewBox={`0 0 ${pageW} ${pageH}`} preserveAspectRatio="none" width={pageW * z} height={pageH * z}>
            <CanvasCtx.Provider value={api}>{overlay?.({ zoom: z, interactive: true, coarse })}</CanvasCtx.Provider>
          </svg>
        </div>
      )}

      {loupe && (bmpOk || hi) && (
        <Loupe
          bitmap={hi && bmpOk && hi.width > bmpOk.canvas.width ? hi : (bmpOk?.canvas ?? hi!)}
          pageW={pageW}
          pageH={pageH}
          focus={loupe.focus}
          at={loupe.at}
          touch={loupe.touch}
          box={size}
          zoom={Math.max(z * 3.2, loupeMin)}
          overlay={overlay}
          coarse={coarse}
        />
      )}
      {readout && (
        <div className="cut-readout" style={{ left: readout.at.x + 18, top: readout.at.y + 22 }}>
          {readout.text}
        </div>
      )}

      <div className="cut-canvas__zoom" onPointerDown={(e) => e.stopPropagation()}>
        {toolbar}
        {toolbar && <span className="cut-canvas__sep" />}
        <IconButton icon={Minus} label="Zoom out" shortcut="-" variant="ghost" size="sm" onClick={() => zoomBy(0.8)} tooltipPlacement="bottom" />
        <button type="button" className="cut-canvas__pct" onClick={fit} title="Fit page (0)">
          {pct}%
        </button>
        <IconButton icon={Plus} label="Zoom in" shortcut="+" variant="ghost" size="sm" onClick={() => zoomBy(1.25)} tooltipPlacement="bottom" />
        <IconButton icon={Maximize} label="Fit page" shortcut="0" variant="ghost" size="sm" onClick={fit} tooltipPlacement="bottom" />
      </div>
      {children}
    </div>
  );
}

function Loupe({
  bitmap,
  pageW,
  pageH,
  focus,
  at,
  touch,
  box,
  zoom,
  overlay,
  coarse,
}: {
  bitmap: CanvasImageSource & { width: number; height: number };
  pageW: number;
  pageH: number;
  focus: Pt;
  at: Pt;
  touch: boolean;
  box: { w: number; h: number };
  zoom: number;
  overlay?: (o: OverlayCtx) => ReactNode;
  coarse: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const half = LOUPE / 2 / zoom; // mm
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = LOUPE * dpr;
    c.height = LOUPE * dpr;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#6b6862';
    ctx.fillRect(0, 0, c.width, c.height);
    const k = bitmap.width / pageW;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // clip source rect to the bitmap and map to destination
    const sx = (focus.x - half) * k;
    const sy = (focus.y - half) * k;
    const sw = half * 2 * k;
    const s = c.width / sw;
    const cx0 = Math.max(0, sx);
    const cy0 = Math.max(0, sy);
    const cx1 = Math.min(bitmap.width, sx + sw);
    const cy1 = Math.min(bitmap.height, sy + sw);
    if (cx1 > cx0 && cy1 > cy0) ctx.drawImage(bitmap, cx0, cy0, cx1 - cx0, cy1 - cy0, (cx0 - sx) * s, (cy0 - sy) * s, (cx1 - cx0) * s, (cy1 - cy0) * s);
  }, [bitmap, focus.x, focus.y, half, pageW, pageH]);

  const off = touch ? 130 : 96;
  let left = at.x - LOUPE / 2;
  let top = at.y - LOUPE - off + LOUPE / 2 - 40;
  if (top < 8) {
    if (touch) {
      // never under the finger (the hand covers everything below it): beside it — to the left
      // when there is room (away from a right hand), else to the right — level with the finger
      top = at.y - LOUPE / 2;
      left = at.x - LOUPE - 64 >= 8 ? at.x - LOUPE - 64 : at.x + 64;
    } else top = at.y + 40;
  }
  left = Math.max(8, Math.min(box.w - LOUPE - 8, left));
  top = Math.max(8, Math.min(box.h - LOUPE - 8, top));
  return (
    <div className="cut-loupe" style={{ left, top, width: LOUPE, height: LOUPE }} aria-hidden>
      <canvas ref={ref} style={{ width: LOUPE, height: LOUPE }} />
      <svg viewBox={`${focus.x - half} ${focus.y - half} ${half * 2} ${half * 2}`} width={LOUPE} height={LOUPE}>
        {overlay?.({ zoom, interactive: false, coarse })}
      </svg>
      <div className="cut-loupe__cross" />
    </div>
  );
}
