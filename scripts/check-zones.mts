/**
 * Automated check for grid drops (v2-6): random drops of cards, tokens, pieces and dice into mixed grids
 * must never leave an item ≥ 90 % covered by an item drawn above it.
 *
 *   npx tsx scripts/check-zones.mts [iterations]
 */
import type { CardInstance, Component, Entity, TableState, ZoneEntity } from '../src/shared/types.js';
import { applyDrop, tableDropTarget, type DragSource } from '../src/features/play/engine/drop.js';
import { renderOrder, worldAABB } from '../src/features/play/engine/geometry.js';
import { addEntity, removeEntities } from '../src/features/play/engine/ops.js';
import { gridBox } from '../src/features/play/engine/zones.js';

const N = Number(process.argv[2] ?? 1500);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

const components: Component[] = [
  { id: 'deck', kind: 'deck', name: 'Deck', width: 63.5, height: 88.9, cornerRadius: 3, back: null, backColor: '#333', createdAt: 0, cards: [{ id: 'c1', front: null, count: 99 }] },
  { id: 'ember', kind: 'tokens', name: 'Ember', shape: 'round', width: 20, height: 20, front: null, back: null, color: '#c60', createdAt: 0 },
  { id: 'candle', kind: 'tokens', name: 'Candle', shape: 'round', width: 12, height: 12, front: null, back: null, color: '#fc6', createdAt: 0 },
  { id: 'cube', kind: 'piece', name: 'Cube', shape: 'cube', material: 'wood', color: '#c33', size: 10, createdAt: 0 },
  { id: 'meeple', kind: 'piece', name: 'Meeple', shape: 'meeple', material: 'wood', color: '#33c', size: 16, createdAt: 0 },
  { id: 'die', kind: 'dice', name: 'Die', size: 16, color: '#fff', inkColor: '#000', faces: [1, 2, 3, 4, 5, 6].map((value) => ({ value })), createdAt: 0 },
];
const game = { components };

const grid = (id: string, x: number, y: number, cellW: number, cellH: number, gap: number, cols: number, rows: number, accepts: ZoneEntity['accepts']): ZoneEntity => {
  const g = { cellW, cellH, gapX: gap, gapY: gap, cols, rows };
  return { id, kind: 'zone', x, y, rot: 0, ...gridBox(g), label: id, color: '#fff', snap: 'pile', accepts, grid: g };
};
const zones = [
  grid('mixed', 0, 0, 24, 24, 4, 4, 2, ['tokens', 'pieces', 'dice']),
  grid('cards', 0, 200, 63.5, 88.9, 3, 3, 2, ['cards', 'tokens', 'pieces', 'dice']),
  { ...grid('endless', 400, 0, 22, 22, 6, 1, 1, ['tokens', 'pieces', 'dice']), grid: { cellW: 22, cellH: 22, gapX: 6, gapY: 6, cols: 1, rows: 1, endless: true }, w: 22, h: 22 } as ZoneEntity,
];
let s: TableState = { entities: {}, order: [], hand: [] };
for (const z of zones) s = addEntity(s, z);

let n = 0;
const make = (x: number, y: number): Entity => {
  const id = `e${n++}`;
  const kind = pick(['stack', 'ember', 'candle', 'cube', 'meeple', 'die', 'ember']);
  if (kind === 'stack') {
    const c: CardInstance = { uid: `u${n}`, deckId: 'deck', cardId: 'c1', faceUp: true };
    return { id, kind: 'stack', x, y, rot: 0, cards: [c], layout: 'pile' };
  }
  if (kind === 'die') return { id, kind: 'die', x, y, rot: 0, componentId: 'die', face: 0 };
  if (kind === 'cube' || kind === 'meeple') return { id, kind: 'piece', x, y, rot: 0, componentId: kind };
  return { id, kind: 'token', x, y, rot: 0, componentId: kind, faceUp: true, count: 1 };
};

const area = (r: { w: number; h: number }) => r.w * r.h;
function check(step: string) {
  const order = renderOrder(s).filter((id) => s.entities[id]?.kind !== 'zone');
  const boxes = order.map((id) => worldAABB(game, s.entities[id]));
  for (let i = 0; i < order.length; i++)
    for (let j = i + 1; j < order.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w <= 0 || h <= 0) continue;
      if ((w * h) / area(a) >= 0.9) {
        console.error(`FAIL after ${step}: ${order[i]} (${s.entities[order[i]].kind}) is ${Math.round(((w * h) / area(a)) * 100)}% covered by ${order[j]} (${s.entities[order[j]].kind})`);
        process.exit(1);
      }
    }
}

let drops = 0;
for (let it = 0; it < N; it++) {
  const z = pick(zones);
  const live = s.order.map((id) => s.entities[id]).filter((e) => e && e.kind !== 'zone');
  if (live.length > 40 && rnd() < 0.3) {
    // a player takes something away
    s = removeEntities(s, [pick(live).id]);
    continue;
  }
  let src: DragSource;
  if (live.length && rnd() < 0.35) {
    const e = pick(live);
    src = e.kind === 'token' && e.count > 1 ? { type: 'tokenOne', tokenId: e.id } : { type: 'entities', ids: [e.id] };
  } else {
    const e = make(-600, -600 - it);
    s = addEntity(s, e);
    src = { type: 'entities', ids: [e.id] };
  }
  const span = z.grid?.endless ? { w: 120, h: 120 } : { w: z.w + 10, h: z.h + 10 };
  const centre = { x: z.x + (rnd() - 0.5) * span.w, y: z.y + (rnd() - 0.5) * span.h };
  const target = tableDropTarget(game, s, src, centre, 1);
  const r = applyDrop(game, s, src, target, centre);
  if (r.kind === 'none') continue;
  if (target.type === 'table' || target.type === 'hand') {
    // a plain table drop away from the grids: keep the check about grid drops
    if (r.landed.some((id) => { const e = r.state.entities[id]; return e && zones.every((q) => Math.hypot(e.x - q.x, e.y - q.y) > 140); })) continue;
    s = r.state;
    s = removeEntities(s, r.landed);
    continue;
  }
  s = r.state;
  drops++;
  check(`drop ${drops} (${target.type}${'id' in target ? ' ' + target.id : ''})`);
}
console.log(`OK: ${drops} grid drops, ${Object.keys(s.entities).length - zones.length} items on the grids, no item ≥ 90% covered.`);
