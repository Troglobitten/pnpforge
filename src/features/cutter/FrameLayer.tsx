/**
 * The frames on the page, drawn in page units inside the Stage's SVG overlay: grid outlines with
 * their four handles (free corners for perspective, or a rectangle with edge handles when "Keep it
 * square" is on), every frame tinted by its group, numbers, and the selected frame's own corners.
 *
 * Gestures (mouse, pen and touch alike — the Stage turns two fingers into pinch/pan and cancels any
 * drag): tap a frame to leave it out or put it back · tap its number to adjust that frame · drag a
 * frame to move its whole grid (or the frame itself once selected or off its grid) · drag a handle.
 */
import type { CutFrame, CutGrid, CutQuad, CutterDoc } from '@/shared/types';
import { gridOutline } from '@/shared/cutter/grid';
import { applyH, axisFrame, homography, rectQuad } from '@/shared/cutter/geom';
import { useCanvas, type DragInfo, type OverlayCtx, type Pt } from './Stage';
import { toast } from '@/ui';
import { checkpoint, commit, patchDoc, select, setPickBack, useCutter } from './store';
import { groupTint, sameRef, setAnchors, setFrameQuad, toggleExcluded, useAsSharedBack, type PageDims } from './ops';

type Q = CutQuad;
const pts = (q: [number, number][]) => q.map((p) => `${p[0]},${p[1]}`).join(' ');
const centroid = (q: Q): [number, number] => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
const move = (q: Q, dx: number, dy: number) => q.map((p) => [p[0] + dx, p[1] + dy]) as Q;

/** The ellipse inscribed in a quad (a circle on a straight-on square), as points. */
export function ellipsePoints(q: Q, n = 48): [number, number][] {
  const H = homography(
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    q,
  );
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return applyH(H, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
  });
}

/** A rectangle from one moved corner, the opposite corner fixed (corner order kept). */
function rectFromCorner(q: Q, i: number, p: Pt, min: number): Q {
  const o = q[(i + 2) % 4];
  let x0 = Math.min(p.x, o[0]);
  let x1 = Math.max(p.x, o[0]);
  let y0 = Math.min(p.y, o[1]);
  let y1 = Math.max(p.y, o[1]);
  if (x1 - x0 < min) p.x < o[0] ? (x0 = x1 - min) : (x1 = x0 + min);
  if (y1 - y0 < min) p.y < o[1] ? (y0 = y1 - min) : (y1 = y0 + min);
  const r = rectQuad(x0, y0, x1 - x0, y1 - y0) as Q;
  // keep which corner is which (a turned frame's first corner is not the page's top-left)
  const ax = axisFrame(q, 1e-3);
  return ax ? ([0, 1, 2, 3].map((k) => r[(k - ax.turn + 4) % 4]) as Q) : r;
}

/** Move one side of an axis-aligned quad. side: 0 top, 1 right, 2 bottom, 3 left. */
function moveSide(q: Q, side: number, d: DragInfo, min: number): Q {
  const ax = axisFrame(q, 1e-3);
  if (!ax) return q;
  let { x, y, w, h } = ax.rect;
  if (side === 0) {
    const ny = Math.min(y + d.dy, y + h - min);
    h += y - ny;
    y = ny;
  } else if (side === 2) h = Math.max(min, h + d.dy);
  else if (side === 3) {
    const nx = Math.min(x + d.dx, x + w - min);
    w += x - nx;
    x = nx;
  } else w = Math.max(min, w + d.dx);
  const r = rectQuad(x, y, w, h) as Q;
  return [0, 1, 2, 3].map((k) => r[(k - ax.turn + 4) % 4]) as Q;
}

export function FrameLayer({ o, doc, dims, pageAt, numbers, draft, empties }: { o: OverlayCtx; doc: CutterDoc; dims: PageDims; pageAt: { sourceId: string; page: number }; numbers: Map<string, number>; draft: Q | null; empties?: Set<string> }) {
  const canvas = useCanvas();
  const sel = useCutter((s) => s.sel);
  const drawing = useCutter((s) => s.drawing);
  const z = o.zoom;
  const px = (n: number) => n / z;
  const coarse = o.coarse;
  const grids = Object.values(doc.grids).filter((g) => sameRef(g.at, pageAt));
  const frames = Object.values(doc.frames).filter((f) => sameRef(f.at, pageAt));
  const selFrame = sel.frameId ? doc.frames[sel.frameId] : undefined;
  const activeGrid = grids.find((g) => g.id === sel.gridId)?.id ?? grids[grids.length - 1]?.id;
  const interactive = o.interactive && !drawing;
  // frames that are a group's one back for all
  const shared = new Set(doc.groups.map((g) => (g.backs.mode === 'same' ? g.backs.sharedFrameId : null)).filter(Boolean));
  const minSize = Math.min(dims.w, dims.h) * 0.01;

  /* ---------------- drags ---------------- */
  const live = () => useCutter.getState().doc;

  const dragGridHandle = (g: CutGrid, i: number) => {
    const a0 = g.anchors.map((p) => [...p]) as Q;
    canvas.beginDrag({
      onStart: () => checkpoint('Move the grid'),
      onMove: (p, d) => {
        const next = g.square ? rectFromCorner(a0, i, p, minSize) : (a0.map((q, k) => (k === i ? [q[0] + d.dx, q[1] + d.dy] : q)) as Q);
        patchDoc((doc) => setAnchors(doc, g.id, next));
      },
      onCancel: () => patchDoc((doc) => setAnchors(doc, g.id, a0)),
      onTap: () => select({ gridId: g.id }),
      loupe: () => {
        const q = live().grids[g.id]?.anchors[i];
        return q ? { x: q[0], y: q[1] } : null;
      },
    });
  };

  const dragGridSide = (g: CutGrid, side: number) => {
    const a0 = g.anchors.map((p) => [...p]) as Q;
    canvas.beginDrag({
      onStart: () => checkpoint('Resize the grid'),
      onMove: (_p, d) => patchDoc((doc) => setAnchors(doc, g.id, moveSide(a0, side, d, minSize))),
      onCancel: () => patchDoc((doc) => setAnchors(doc, g.id, a0)),
      onTap: () => select({ gridId: g.id }),
      loupe: () => {
        const q = live().grids[g.id]?.anchors;
        if (!q) return null;
        const a = q[side];
        const b = q[(side + 1) % 4];
        return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
      },
    });
  };

  const dragGridBody = (g: CutGrid, onTap: () => void) => {
    const a0 = g.anchors.map((p) => [...p]) as Q;
    canvas.beginDrag({
      onStart: () => {
        checkpoint(g.backOf?.linked ? 'Shift the backs' : 'Move the grid');
        if (useCutter.getState().sel.gridId !== g.id) select({ gridId: g.id });
      },
      onMove: (_p, d) => patchDoc((doc) => setAnchors(doc, g.id, move(a0, d.dx, d.dy))),
      onCancel: () => patchDoc((doc) => setAnchors(doc, g.id, a0)),
      onTap: () => onTap(),
    });
  };

  const dragFrame = (f: CutFrame, onTap: () => void) => {
    const q0 = f.quad.map((p) => [...p]) as Q;
    canvas.beginDrag({
      onStart: () => checkpoint('Move a frame'),
      onMove: (_p, d) => patchDoc((doc) => setFrameQuad(doc, f.id, move(q0, d.dx, d.dy))),
      onCancel: () => patchDoc((doc) => setFrameQuad(doc, f.id, q0)),
      onTap: () => onTap(),
    });
  };

  const dragCorner = (f: CutFrame, i: number) => {
    const q0 = f.quad.map((p) => [...p]) as Q;
    const keepRect = !dims.photo && !!axisFrame(q0, 1e-3);
    canvas.beginDrag({
      onStart: () => checkpoint('Adjust a frame'),
      onMove: (p, d) => {
        const next = keepRect ? rectFromCorner(q0, i, p, minSize) : (q0.map((q, k) => (k === i ? [q[0] + d.dx, q[1] + d.dy] : q)) as Q);
        patchDoc((doc) => setFrameQuad(doc, f.id, next));
      },
      onCancel: () => patchDoc((doc) => setFrameQuad(doc, f.id, q0)),
      loupe: () => {
        const q = live().frames[f.id]?.quad[i];
        return q ? { x: q[0], y: q[1] } : null;
      },
    });
  };

  // "One back for all": the next frame tapped becomes the group's back
  const pickAsBack = (f: CutFrame) => {
    const gid = useCutter.getState().pickBack;
    if (!gid) return false;
    const group = live().groups.find((g) => g.id === gid);
    commit('Choose the back', (doc) => useAsSharedBack(doc, gid, f.id));
    setPickBack(null);
    select({ frameId: null, gridId: null });
    toast(`The back of “${group?.name ?? 'the group'}”`, { description: 'Every piece of the group gets this back.', duration: 3000 });
    return true;
  };
  const tapFrame = (f: CutFrame) => () => {
    if (pickAsBack(f)) return;
    commit(f.excluded ? 'Put a piece back in' : 'Leave a piece out', (doc) => toggleExcluded(doc, f.id));
    select(f.gridId ? { gridId: f.gridId } : {});
  };
  const tapNumber = (f: CutFrame) => () => pickAsBack(f) || select(sel.frameId === f.id ? { gridId: f.gridId ?? null } : { frameId: f.id, gridId: f.gridId ?? null, zoom: true });

  /* ---------------- drawing ---------------- */
  const hit = coarse ? 30 : 16;
  const gridHandleR = coarse ? 13 : 10;

  return (
    <g className={`cut-layer ${interactive ? '' : 'is-passive'}`}>
      {/* dim everything but the frame being adjusted */}
      {selFrame && (
        <path className="cut-dim" fillRule="evenodd" d={`M${-dims.w},${-dims.h}H${dims.w * 2}V${dims.h * 2}H${-dims.w}Z M${(selFrame.shape === 'round' ? ellipsePoints(selFrame.quad) : selFrame.quad).map((p) => `${p[0]},${p[1]}`).join('L')}Z`} />
      )}

      {grids.map((g) => (
        <polygon key={`o${g.id}`} className={`cut-grid__outline cut-t${groupTint(doc, g.groupId)} ${sel.gridId === g.id ? 'is-sel' : ''} ${g.backOf || g.backs ? 'is-back' : ''}`} points={pts(gridOutline(g))} vectorEffect="non-scaling-stroke" />
      ))}

      {/* the selected grid's frames on top of any other grid on the page (a mixed page) */}
      {[...frames].sort((a, b) => Number(a.gridId === sel.gridId) - Number(b.gridId === sel.gridId)).map((f) => {
        const round = f.shape === 'round';
        const outline = round ? ellipsePoints(f.quad) : f.quad;
        const isSel = f.id === selFrame?.id;
        const g = f.gridId ? doc.grids[f.gridId] : undefined;
        const body = () => {
          if (!interactive) return;
          if (isSel || !f.onGrid || !g) dragFrame(f, isSel ? () => select({ gridId: f.gridId ?? null }) : tapFrame(f));
          else dragGridBody(g, tapFrame(f));
        };
        return (
          <g key={f.id} className={`cut-frame cut-t${groupTint(doc, f.groupId)} ${isSel ? 'is-sel' : ''} ${f.excluded ? 'is-out' : ''} ${f.onGrid ? 'is-grid' : 'is-own'} ${f.side === 'back' ? 'is-back' : ''} ${shared.has(f.id) ? 'is-shared' : ''} ${empties?.has(f.id) && !f.keep ? 'is-empty' : ''}`} data-testid="cut-frame" data-n={numbers.get(f.id)}>
            <polygon className="cut-frame__shape" points={pts(outline)} vectorEffect="non-scaling-stroke" onPointerDown={body} />
            {f.excluded && (
              <g className="cut-frame__out" pointerEvents="none">
                <line x1={f.quad[0][0]} y1={f.quad[0][1]} x2={f.quad[2][0]} y2={f.quad[2][1]} vectorEffect="non-scaling-stroke" />
                <line x1={f.quad[1][0]} y1={f.quad[1][1]} x2={f.quad[3][0]} y2={f.quad[3][1]} vectorEffect="non-scaling-stroke" />
              </g>
            )}
            {isSel && !round && <line className="cut-frame__top" x1={f.quad[0][0]} y1={f.quad[0][1]} x2={f.quad[1][0]} y2={f.quad[1][1]} vectorEffect="non-scaling-stroke" />}
          </g>
        );
      })}

      {/* every number above every outline: a number can always be tapped, even where grids overlap */}
      {frames.map((f) => {
        const round = f.shape === 'round';
        const mid = centroid(f.quad);
        const bottom: [number, number] = [(f.quad[2][0] + f.quad[3][0]) / 2, (f.quad[2][1] + f.quad[3][1]) / 2];
        const c: [number, number] = round ? [mid[0] + (bottom[0] - mid[0]) * 0.55, mid[1] + (bottom[1] - mid[1]) * 0.55] : mid;
        const isSel = f.id === selFrame?.id;
        // the number shrinks with the frame on screen, so a tap on a small frame still reaches the frame
        const onScreen = Math.min(Math.hypot(f.quad[1][0] - f.quad[0][0], f.quad[1][1] - f.quad[0][1]), Math.hypot(f.quad[3][0] - f.quad[0][0], f.quad[3][1] - f.quad[0][1])) * z;
        const badge = Math.max(7, Math.min(isSel ? 14 : 12, onScreen * 0.16));
        const badgeHit = Math.max(badge, Math.min(coarse ? 22 : 16, onScreen * 0.2));
        return (
          <g key={`n${f.id}`} className={`cut-frame cut-t${groupTint(doc, f.groupId)} ${isSel ? 'is-sel' : ''} ${f.excluded ? 'is-out' : ''} ${f.side === 'back' ? 'is-back' : ''}`}>
            <g transform={`translate(${c[0]} ${c[1]}) scale(${px(1)})`} className="cut-frame__num" onPointerDown={() => interactive && canvas.beginDrag({ onTap: tapNumber(f), onStart: () => undefined })} data-testid="cut-frame-num" data-frame={f.id}>
              <circle r={badgeHit} className="cut-hit" />
              <circle r={badge} className="cut-frame__badge" />
              <text y={badge * 0.36} style={{ fontSize: Math.max(8, badge) }}>
                {numbers.get(f.id) ?? ''}
              </text>
            </g>
          </g>
        );
      })}

      {/* grid handles: only the active grid's (the selected one, or the page's last), so two grids never tangle */}
      {!selFrame &&
        grids.filter((g) => g.id === activeGrid && !g.backOf?.linked).map((g) => (
          <g key={`h${g.id}`} className={`cut-ghandles cut-t${groupTint(doc, g.groupId)}`}>
            {g.square &&
              [0, 1, 2, 3].map((side) => {
                const a = g.anchors[side];
                const b = g.anchors[(side + 1) % 4];
                const vertical = side % 2 === 1;
                const out = [
                  [0, -1],
                  [1, 0],
                  [0, 1],
                  [-1, 0],
                ][side];
                const k = px(12);
                return (
                  <g key={`s${side}`} className={`cut-side ${vertical ? 'is-ew' : 'is-ns'}`} transform={`translate(${(a[0] + b[0]) / 2 + out[0] * k} ${(a[1] + b[1]) / 2 + out[1] * k}) scale(${px(1)})`} onPointerDown={() => interactive && dragGridSide(g, side)} data-testid={`cut-side-${side}`}>
                    <rect className="cut-hit" x={vertical ? -hit / 1.4 : -hit * 1.2} y={vertical ? -hit * 1.2 : -hit / 1.4} width={vertical ? (hit * 2) / 1.4 : hit * 2.4} height={vertical ? hit * 2.4 : (hit * 2) / 1.4} />
                    <rect className="cut-side__knob" x={vertical ? -3.5 : -13} y={vertical ? -13 : -3.5} width={vertical ? 7 : 26} height={vertical ? 26 : 7} rx={3.5} />
                  </g>
                );
              })}
            {g.anchors.map((p, i) => (
              <g key={i} className="cut-ghandle" transform={`translate(${p[0]} ${p[1]}) scale(${px(1)})`} onPointerDown={() => interactive && dragGridHandle(g, i)} data-testid={`cut-grid-${i}`}>
                <circle r={coarse ? 30 : 20} className="cut-hit" />
                <circle r={gridHandleR} className="cut-ghandle__ring" />
                <circle r={3.5} className="cut-ghandle__dot" />
              </g>
            ))}
          </g>
        ))}

      {/* the selected frame's own corners */}
      {selFrame &&
        selFrame.quad.map((p, i) => (
          <g key={`c${i}`} className="cut-corner" transform={`translate(${p[0]} ${p[1]}) scale(${px(1)})`} onPointerDown={() => interactive && dragCorner(selFrame, i)} data-testid={`cut-corner-${i}`}>
            <circle r={hit + 4} className="cut-hit" />
            <circle r={coarse ? 11 : 8} className="cut-corner__ring" />
          </g>
        ))}

      {draft && <polygon className="cut-draft" points={pts(draft)} vectorEffect="non-scaling-stroke" />}
    </g>
  );
}
