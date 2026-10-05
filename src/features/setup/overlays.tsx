/**
 * Screen-space overlays drawn inside <TableView>: the starting-view frame, resize handles
 * for zones and notes, and the draw-a-rectangle layer (new zone / box select on touch).
 * Everything interactive carries `data-ui`, so the table controller leaves it alone.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import type { Entity, ID, NoteEntity, ZoneEntity } from '@/shared/types';
import { GRID_PAD, clamp, gridBox, ops, rectsIntersect, rotateVec, worldAABB, type Rect, type Vec } from '@/features/play/engine';
import type { TableController } from '@/features/play/table/controller';
import { useCtl, useUi } from '@/features/play/table/store';
import { isStartCamera, startViewRect } from './lib/warnings';

/** Re-render on every camera move (rAF-throttled). */
export function useCameraTick(ctl: TableController | null) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!ctl) return;
    let raf = 0;
    const un = ctl.subscribeCamera(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          force();
        });
    });
    return () => {
      un();
      cancelAnimationFrame(raf);
    };
  }, [ctl]);
}

function toLocal(ctl: TableController, p: Vec): Vec {
  const s = ctl.worldToScreen(p);
  return { x: s.x - ctl.rect.left, y: s.y - ctl.rect.top };
}

export function StartViewFrame() {
  const ctl = useCtl();
  useCameraTick(ctl);
  const cam = useUi((s) => s.state.camera);
  if (!isStartCamera(cam)) return null;
  const r = startViewRect(cam);
  const a = toLocal(ctl, { x: r.x, y: r.y });
  const b = toLocal(ctl, { x: r.x + r.w, y: r.y + r.h });
  return (
    <div className="setup-startframe" style={{ transform: `translate(${a.x}px, ${a.y}px)`, width: b.x - a.x, height: b.y - a.y }} aria-hidden>
      <span className="setup-startframe__label">Starting view</span>
    </div>
  );
}

const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Corner handles to resize the single selected zone or note. */
export function ResizeHandles() {
  const ctl = useCtl();
  useCameraTick(ctl);
  const id = useUi((s) => {
    const keys = Object.keys(s.selection);
    return keys.length === 1 ? keys[0] : null;
  });
  const e = useUi((s) => (id ? s.state.entities[id] : undefined));
  const carrying = useUi((s) => !!s.ghost || !!s.menu);
  const [active, setActive] = useState<number | null>(null);
  if (!e || (e.kind !== 'zone' && e.kind !== 'note') || ctl.isFixed(e) || carrying) return null;
  const box = e as ZoneEntity | NoteEntity;
  // an endless grid has no edges to drag; a limited grid resizes by whole cells
  if (box.kind === 'zone' && box.grid?.endless) return null;
  const grid = box.kind === 'zone' && box.grid ? box.grid : null;

  const begin = (ev: React.PointerEvent, i: number) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const [sx, sy] = CORNERS[i];
    // the opposite corner stays put
    const o = rotateVec({ x: (-sx * box.w) / 2, y: (-sy * box.h) / 2 }, box.rot);
    const origin = { x: box.x + o.x, y: box.y + o.y };
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    setActive(i);
    const min = e.kind === 'note' ? 30 : 20;
    const move = (m: PointerEvent) => {
      if (m.pointerId !== ev.pointerId) return;
      const p = ctl.screenToWorld(m.clientX, m.clientY);
      const d = rotateVec({ x: p.x - origin.x, y: p.y - origin.y }, -box.rot);
      if (grid) {
        const cur = ctl.state.entities[box.id];
        if (cur?.kind !== 'zone' || !cur.grid) return;
        const g = cur.grid;
        const count = (size: number, cell: number, gap: number) => clamp(Math.round((size - 2 * GRID_PAD + gap) / (cell + gap)), 1, 60);
        const cols = count(d.x * sx, g.cellW, g.gapX);
        const rows = count(d.y * sy, g.cellH, g.gapY);
        if (cols === g.cols && rows === g.rows) return;
        const b = gridBox({ ...g, cols, rows });
        const c = rotateVec({ x: (sx * b.w) / 2, y: (sy * b.h) / 2 }, box.rot);
        const next = ops.updateEntity(ctl.state, box.id, (en) => ({ ...en, grid: { ...g, cols, rows }, w: b.w, h: b.h, x: origin.x + c.x, y: origin.y + c.y }) as Entity);
        ctl.commit(next, { label: 'Resize grid', coalesceKey: `resize:${box.id}` });
        return;
      }
      const w = Math.round(Math.max(min, d.x * sx));
      const h = Math.round(Math.max(min, d.y * sy));
      const c = rotateVec({ x: (sx * w) / 2, y: (sy * h) / 2 }, box.rot);
      const cur = ctl.state.entities[box.id];
      if (!cur || (cur.kind !== 'zone' && cur.kind !== 'note')) return;
      if (cur.w === w && cur.h === h) return;
      const next = ops.updateEntity(ctl.state, box.id, (en) => ({ ...en, w, h, x: origin.x + c.x, y: origin.y + c.y }) as Entity);
      ctl.commit(next, { label: e.kind === 'zone' ? 'Resize zone' : 'Resize note', coalesceKey: `resize:${box.id}` });
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== ev.pointerId) return;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      setActive(null);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <>
      {CORNERS.map(([sx, sy], i) => {
        const p = rotateVec({ x: (sx * box.w) / 2, y: (sy * box.h) / 2 }, box.rot);
        const l = toLocal(ctl, { x: box.x + p.x, y: box.y + p.y });
        const diag = (sx === sy) !== (Math.round(((box.rot % 180) + 180) % 180 / 90) === 1);
        return (
          <div
            key={i}
            data-ui
            role="slider"
            aria-label={`Resize ${e.kind}`}
            aria-valuetext={grid ? `${grid.cols} columns by ${grid.rows} rows` : `${Math.round(box.w)} by ${Math.round(box.h)} mm`}
            className={`setup-handle ${active === i ? 'is-active' : ''}`}
            style={{ transform: `translate(${l.x}px, ${l.y}px)`, cursor: diag ? 'nwse-resize' : 'nesw-resize' }}
            onPointerDown={(ev) => begin(ev, i)}
          />
        );
      })}
      {grid && active !== null && (() => {
        const [sx, sy] = CORNERS[active];
        const p = rotateVec({ x: (sx * box.w) / 2, y: (sy * box.h) / 2 }, box.rot);
        const l = toLocal(ctl, { x: box.x + p.x, y: box.y + p.y });
        return (
          <div className="setup-handle__tag" style={{ transform: `translate(${l.x}px, ${l.y}px)` }} aria-hidden>
            {grid.cols} × {grid.rows}
          </div>
        );
      })()}
    </>
  );
}

/** Drag out a rectangle: a new zone, or (touch-friendly) a box selection. */
export function DrawLayer({ mode, onZone, onDone }: { mode: 'zone' | 'select'; onZone: (rect: Rect, tapped: boolean) => void; onDone: () => void }) {
  const ctl = useCtl();
  const [box, setBox] = useState<{ a: Vec; b: Vec } | null>(null);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);

  const local = (x: number, y: number) => ({ x: x - ctl.rect.left, y: y - ctl.rect.top });
  const finish = (x: number, y: number) => {
    const s = start.current;
    start.current = null;
    setBox(null);
    if (!s) return;
    ctl.measure();
    const a = ctl.screenToWorld(s.x, s.y);
    const b = ctl.screenToWorld(x, y);
    const rect: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    const tapped = Math.hypot(x - s.x, y - s.y) < 8;
    if (mode === 'zone') {
      onZone(tapped ? { x: a.x, y: a.y, w: 0, h: 0 } : rect, tapped);
    } else {
      const st = ctl.state;
      const ids: ID[] = tapped ? [] : st.order.filter((id) => st.entities[id] && !ctl.isFixed(st.entities[id]) && rectsIntersect(rect, worldAABB(ctl.game, st.entities[id])));
      ctl.select(ids);
      onDone();
    }
  };

  return (
    <div
      className={`setup-draw is-${mode}`}
      data-ui
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        ctl.measure();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        setBox({ a: local(e.clientX, e.clientY), b: local(e.clientX, e.clientY) });
      }}
      onPointerMove={(e) => {
        if (start.current?.id !== e.pointerId) return;
        setBox((bx) => (bx ? { a: bx.a, b: local(e.clientX, e.clientY) } : bx));
      }}
      onPointerUp={(e) => start.current?.id === e.pointerId && finish(e.clientX, e.clientY)}
      onPointerCancel={() => {
        start.current = null;
        setBox(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onDone();
      }}
    >
      {box && (
        <div
          className="setup-draw__box"
          style={{
            transform: `translate(${Math.min(box.a.x, box.b.x)}px, ${Math.min(box.a.y, box.b.y)}px)`,
            width: Math.abs(box.a.x - box.b.x),
            height: Math.abs(box.a.y - box.b.y),
          }}
        />
      )}
    </div>
  );
}
