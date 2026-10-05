/**
 * Endless grids: drawn in screen space under the pieces (and under boards, so printed board art is
 * never overpowered), one tiled background per grid that follows the camera. The tile image is built
 * at a quantised zoom so a pinch doesn't rebuild it every frame. The lattice fades out as cells get
 * small on screen and steps back while something the grid doesn't take is being carried.
 */
import { useEffect, useMemo, useReducer } from 'react';
import type { ZoneEntity, ZoneGrid } from '@/shared/types';
import { clamp, rotateVec, zoneTakes } from '../engine';
import type { TableController } from './controller';
import { useCtl, useUi } from './store';

function useCameraTick(ctl: TableController) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
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

/**
 * One tile of the lattice. At rest only the cells' corners are marked (a few short ticks guide the eye
 * without laying a pattern over the table); while something the grid takes is carried, whole cells.
 */
function tileUrl(g: ZoneGrid, zoom: number, color: string, cells: boolean) {
  const tw = (g.cellW + g.gapX) * zoom;
  const th = (g.cellH + g.gapY) * zoom;
  const sw = 1.25;
  const x = (g.gapX * zoom) / 2 + sw / 2;
  const y = (g.gapY * zoom) / 2 + sw / 2;
  const w = Math.max(1, g.cellW * zoom - sw);
  const h = Math.max(1, g.cellH * zoom - sw);
  const f = (v: number) => v.toFixed(2);
  let body: string;
  if (cells) {
    const rx = Math.min(6, g.cellW * zoom * 0.06);
    body = `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(rx)}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-opacity="0.7" stroke-width="${sw}"/>`;
  } else {
    const t = Math.max(3, Math.min(9, Math.min(w, h) * 0.16));
    const x1 = x + w;
    const y1 = y + h;
    const d = `M${f(x)} ${f(y + t)}V${f(y)}H${f(x + t)}M${f(x1 - t)} ${f(y)}H${f(x1)}V${f(y + t)}M${f(x1)} ${f(y1 - t)}V${f(y1)}H${f(x1 - t)}M${f(x + t)} ${f(y1)}H${f(x)}V${f(y1 - t)}`;
    body = `<path d="${d}" fill="none" stroke="${color}" stroke-opacity="0.75" stroke-width="${sw}" stroke-linecap="round"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${f(tw)}" height="${f(th)}">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function EndlessGrid({ ctl, z, carrying, takes }: { ctl: TableController; z: ZoneEntity; carrying: boolean; takes: boolean }) {
  const g = z.grid!;
  const zoom = ctl.camera.zoom;
  const zq = 2 ** (Math.round(Math.log2(zoom) * 6) / 6);
  const color = /^#[0-9a-f]{6}$/i.test(z.color) ? z.color : '#e6a756';
  const cells = carrying && takes;
  const url = useMemo(() => tileUrl(g, zq, color, cells), [g, zq, color, cells]);
  const r = ctl.rect;
  const px = g.cellW + g.gapX;
  const py = g.cellH + g.gapY;
  const tw = px * zoom;
  const th = py * zoom;
  const small = Math.min(tw, th);
  if (!r.width || small < 14) return null;
  // cells fade in as they grow on screen: zoomed out, a lattice would read as a texture over the table
  const alpha = clamp((small - 14) / 56, 0, 1);
  // anchor the layer on the lattice cell nearest the middle of the view, so it always covers it
  const vc = ctl.screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
  const l = rotateVec({ x: vc.x - z.x, y: vc.y - z.y }, -z.rot);
  const cc = rotateVec({ x: Math.round(l.x / px) * px, y: Math.round(l.y / py) * py }, z.rot);
  const s = ctl.worldToScreen({ x: z.x + cc.x, y: z.y + cc.y });
  const D = Math.ceil(Math.hypot(r.width, r.height) + 4 * Math.max(tw, th));
  const k = D / 2;
  const opacity = alpha * (carrying ? (takes ? 0.7 : 0.16) : 0.3);
  return (
    <div
      className="play-grid-endless"
      style={{
        left: s.x - r.left - k,
        top: s.y - r.top - k,
        width: D,
        height: D,
        transform: z.rot ? `rotate(${z.rot}deg)` : undefined,
        backgroundImage: url,
        backgroundSize: `${tw}px ${th}px`,
        backgroundPosition: `${(k - tw / 2).toFixed(2)}px ${(k - th / 2).toFixed(2)}px`,
        opacity,
      }}
    />
  );
}

export function EndlessGrids() {
  const ctl = useCtl();
  useCameraTick(ctl);
  const entities = useUi((s) => s.state.entities);
  const order = useUi((s) => s.state.order);
  const ghost = useUi((s) => s.ghost);
  const zones = useMemo(() => order.map((id) => entities[id]).filter((e): e is ZoneEntity => e?.kind === 'zone' && !!e.grid?.endless), [entities, order]);
  if (!zones.length) return null;
  return (
    <div className="play-grids" aria-hidden>
      {zones.map((z) => (
        <EndlessGrid key={z.id} ctl={ctl} z={z} carrying={!!ghost} takes={!!ghost?.cats && ghost.cats.every((c) => zoneTakes(z, c))} />
      ))}
    </div>
  );
}
