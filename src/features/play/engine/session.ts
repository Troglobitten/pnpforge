import type { CardInstance, Entity, TableState } from '@/shared/types';
import { newId, randomInt, type Rng } from './ids';
import { shuffleCards } from './ops';
import { normalizeZone } from './zones';

/**
 * Build the starting state of a new play session from a game's setup:
 * every physical card gets a fresh uid and stacks marked `shuffleOnStart`
 * are shuffled. The setup object itself is never mutated.
 */
export function freshStateFromSetup(setup: TableState | undefined | null, rng: Rng = randomInt): TableState {
  const src: TableState = setup ?? { entities: {}, order: [], hand: [] };
  const fresh = (c: CardInstance): CardInstance => ({ ...c, uid: newId() });
  const entities: Record<string, Entity> = {};
  for (const id of src.order) {
    const e = src.entities[id];
    if (!e) continue;
    if (e.kind === 'stack') {
      const cards = e.cards.map(fresh);
      entities[id] = { ...e, cards: e.shuffleOnStart ? shuffleCards(cards, rng) : cards };
    } else if (e.kind === 'zone') {
      entities[id] = normalizeZone({ ...e });
    } else {
      entities[id] = { ...e };
    }
  }
  return {
    entities,
    order: src.order.filter((id) => entities[id]),
    hand: (src.hand ?? []).map(fresh),
    camera: src.camera ? { ...src.camera } : undefined,
  };
}

/** Defensive normalisation of state loaded from disk (older / hand-edited saves). */
export function normalizeState(s: Partial<TableState> | undefined | null): TableState {
  const entities = { ...(s?.entities ?? {}) };
  const order = (s?.order ?? Object.keys(entities)).filter((id) => entities[id]);
  for (const id of Object.keys(entities)) if (!order.includes(id)) order.push(id);
  for (const id of order) {
    const e = entities[id];
    if (e.kind === 'stack' && !e.cards?.length) {
      delete entities[id];
    } else if (e.kind === 'zone') {
      // v2-6: accepts / pieceMode / grid are optional; old zones come back unchanged (cards only)
      const z = normalizeZone(e);
      if (z !== e) entities[id] = z;
    }
  }
  return { entities, order: order.filter((id) => entities[id]), hand: s?.hand ?? [], camera: s?.camera };
}
