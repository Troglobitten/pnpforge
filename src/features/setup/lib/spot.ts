import type { Entity, Game, TableState } from '@/shared/types';
import { baseSize, worldAABB, type Rect, type Vec } from '@/features/play/engine';

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * A point near `near` where `e` doesn't cover another loose piece (boards and zones are
 * backgrounds, so pieces may sit on them). Boards and zones go exactly where asked.
 */
export function findFreeSpot(game: Pick<Game, 'components'>, s: TableState, e: Entity, near: Vec): Vec {
  if (e.kind === 'board' || e.kind === 'zone') return near;
  const size = baseSize(game, e);
  const boxes = s.order
    .map((id) => s.entities[id])
    .filter((o): o is Entity => !!o && o.kind !== 'board' && o.kind !== 'zone')
    .map((o) => worldAABB(game, o));
  const free = (p: Vec) => !boxes.some((b) => overlap({ x: p.x - size.w / 2 - 4, y: p.y - size.h / 2 - 4, w: size.w + 8, h: size.h + 8 }, b));
  if (free(near)) return near;
  const step = Math.max(14, Math.min(size.w, size.h) * 0.75);
  for (let ring = 1; ring < 16; ring++) {
    const n = 8 * ring;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const p = { x: near.x + Math.cos(a) * ring * step, y: near.y + Math.sin(a) * ring * step };
      if (free(p)) return p;
    }
  }
  return near;
}
