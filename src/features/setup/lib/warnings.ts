/**
 * Checks that catch a starting table which would give a broken game.
 * Each warning can carry a one-tap fix (a pure state transform) and the pieces it is about.
 */
import type { CardInstance, Camera, Game, ID, StackEntity, TableState } from '@/shared/types';
import { getCardDef, getComponent, getDeck, ops, worldAABB, type Rect } from '@/features/play/engine';
import { deckCards, placeable, placedCounts } from './place';

export type WarningLevel = 'error' | 'warning' | 'info';

export interface SetupWarning {
  key: string;
  level: WarningLevel;
  title: string;
  detail?: string;
  /** Pieces this is about ("Show" selects and frames them). */
  entityIds?: ID[];
  fix?: { label: string; apply?: (game: Game, s: TableState) => TableState; action?: 'arrange' | 'components' | 'viewAll' };
}

type StartCamera = Camera & { viewW: number; viewH: number };

export function isStartCamera(c: Camera | undefined | null): c is StartCamera {
  return !!c && Number.isFinite(c.zoom) && c.zoom > 0 && !!c.viewW && !!c.viewH;
}

/** World rectangle a saved starting view frames. */
export function startViewRect(c: StartCamera): Rect {
  const w = c.viewW / c.zoom;
  const h = c.viewH / c.zoom;
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function analyzeSetup(game: Game, s: TableState): SetupWarning[] {
  const out: SetupWarning[] = [];
  const stacks = s.order.map((id) => s.entities[id]).filter((e): e is StackEntity => e?.kind === 'stack');

  /* ---- pieces referring to things that no longer exist ---- */
  const staleIds: ID[] = [];
  let staleCards = 0;
  for (const id of s.order) {
    const e = s.entities[id];
    if (!e) continue;
    if (e.kind === 'stack') {
      const bad = e.cards.filter((c) => !getCardDef(game, c)).length;
      if (bad) {
        staleIds.push(id);
        staleCards += bad;
      }
    } else if ((e.kind === 'board' || e.kind === 'token' || e.kind === 'die' || e.kind === 'piece') && !getComponent(game, e.componentId)) {
      staleIds.push(id);
    }
  }
  if (staleIds.length) {
    out.push({
      key: 'stale',
      level: 'error',
      title: staleCards ? `${plural(staleCards, 'card')} on the table no longer exist` : `${plural(staleIds.length, 'piece')} belong to deleted components`,
      detail: 'They were removed in Components. In play they would show as blank pieces.',
      entityIds: staleIds,
      fix: {
        label: 'Remove them',
        apply: (g, st) => {
          let next = st;
          for (const id of staleIds) {
            const e = next.entities[id];
            if (!e) continue;
            if (e.kind === 'stack') next = ops.setStackCards(next, id, e.cards.filter((c) => getCardDef(g, c)));
            else next = ops.removeEntities(next, [id]);
          }
          return next;
        },
      },
    });
  }

  /* ---- empty stacks ---- */
  const empty = stacks.filter((st) => st.cards.length === 0).map((st) => st.id);
  if (empty.length) {
    out.push({
      key: 'empty',
      level: 'warning',
      title: `${plural(empty.length, 'empty stack')} on the table`,
      detail: 'A stack with no cards disappears when a game starts.',
      entityIds: empty,
      fix: { label: 'Remove', apply: (_g, st) => ops.removeEntities(st, empty) },
    });
  }

  /* ---- decks placed more than once / partly ---- */
  const tally = new Map<string, number>(); // deckId:cardId -> copies on the table
  const deckStacks = new Map<ID, ID[]>();
  const count = (c: CardInstance) => tally.set(`${c.deckId}:${c.cardId}`, (tally.get(`${c.deckId}:${c.cardId}`) ?? 0) + 1);
  for (const st of stacks) {
    st.cards.forEach(count);
    for (const d of new Set(st.cards.map((c) => c.deckId))) deckStacks.set(d, [...(deckStacks.get(d) ?? []), st.id]);
  }
  (s.hand ?? []).forEach(count);
  for (const deck of game.components) {
    if (deck.kind !== 'deck' || !deckStacks.has(deck.id)) continue;
    let extra = 0;
    let missing = 0;
    const total = deck.cards.reduce((n, d) => n + Math.max(0, d.count ?? 1), 0);
    for (const def of deck.cards) {
      const have = tally.get(`${deck.id}:${def.id}`) ?? 0;
      const want = Math.max(0, def.count ?? 1);
      if (have > want) extra += have - want;
      if (have < want) missing += want - have;
    }
    const ids = deckStacks.get(deck.id)!;
    if (extra) {
      out.push({
        key: `dup:${deck.id}`,
        level: 'error',
        title: ids.length > 1 ? `“${deck.name}” is on the table ${ids.length} times` : `“${deck.name}” has ${plural(extra, 'extra card')}`,
        detail: `${total + extra - missing} cards are laid out for a ${total}-card deck, so players would draw duplicates.`,
        entityIds: ids,
        fix: { label: 'Remove the extra copies', apply: (_g, st) => removeExtraCards(game, st, deck.id) },
      });
    }
    if (missing) {
      out.push({
        key: `missing:${deck.id}`,
        level: 'warning',
        title: `${plural(missing, 'card')} of “${deck.name}” aren’t on the table`,
        detail: 'Probably added in Components after the deck was placed. They won’t be in the game.',
        entityIds: ids,
        fix: { label: 'Add them to the deck', apply: (_g, st) => addMissingCards(game, st, deck.id) },
      });
    }
  }

  /* ---- components never placed ---- */
  const placed = placedCounts(s);
  const unplaced = game.components.filter((c) => !placed.has(c.id));
  const canPlace = unplaced.filter(placeable);
  if (canPlace.length) {
    const names = canPlace.map((c) => c.name || 'Untitled');
    out.push({
      key: 'unplaced',
      level: 'warning',
      title: `${plural(canPlace.length, 'component')} not on the table`,
      detail: `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''} — players won’t have ${canPlace.length === 1 ? 'it' : 'them'}.`,
      fix: { label: 'Arrange automatically', action: 'arrange' },
    });
  }
  const noCards = unplaced.filter((c) => !placeable(c));
  if (noCards.length) {
    out.push({
      key: 'nocards',
      level: 'info',
      title: `${noCards.map((c) => `“${c.name}”`).join(', ')} ${noCards.length === 1 ? 'has' : 'have'} no cards yet`,
      detail: 'An empty deck can’t be placed. Add its cards in Components first.',
      fix: { label: 'Open Components', action: 'components' },
    });
  }

  /* ---- outside the starting view ---- */
  if (isStartCamera(s.camera)) {
    const v = startViewRect(s.camera);
    const far = s.order.filter((id) => {
      const e = s.entities[id];
      if (!e) return false;
      const b = worldAABB(game, e);
      // "far outside": less than a third of the piece is inside the frame
      const ix = Math.max(0, Math.min(b.x + b.w, v.x + v.w) - Math.max(b.x, v.x));
      const iy = Math.max(0, Math.min(b.y + b.h, v.y + v.h) - Math.max(b.y, v.y));
      return ix * iy < (b.w * b.h) / 3;
    });
    if (far.length) {
      out.push({
        key: 'outside',
        level: 'warning',
        title: `${plural(far.length, 'piece')} outside the starting view`,
        detail: 'Players won’t see them when a game opens.',
        entityIds: far,
        fix: { label: 'Frame everything instead', action: 'viewAll' },
      });
    }
  }

  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Keep at most `count` copies of each card across the deck's stacks (earliest stacks win). */
export function removeExtraCards(game: Game, s: TableState, deckId: ID): TableState {
  const deck = getDeck(game, deckId);
  if (!deck) return s;
  const left = new Map(deck.cards.map((d) => [d.id, Math.max(0, d.count ?? 1)]));
  for (const c of s.hand ?? []) if (c.deckId === deckId) left.set(c.cardId, (left.get(c.cardId) ?? 0) - 1);
  let next = s;
  for (const id of s.order) {
    const st = next.entities[id];
    if (st?.kind !== 'stack' || !st.cards.some((c) => c.deckId === deckId)) continue;
    const keep = st.cards.filter((c) => {
      if (c.deckId !== deckId) return true;
      const n = left.get(c.cardId) ?? 0;
      left.set(c.cardId, n - 1);
      return n > 0;
    });
    if (keep.length !== st.cards.length) next = ops.setStackCards(next, id, keep);
  }
  return next;
}

/** Put the cards the table is missing on top of the deck's biggest stack, matching its face. */
export function addMissingCards(game: Game, s: TableState, deckId: ID): TableState {
  const deck = getDeck(game, deckId);
  if (!deck) return s;
  const have = new Map<ID, number>();
  let home: StackEntity | null = null;
  for (const id of s.order) {
    const st = s.entities[id];
    if (st?.kind !== 'stack') continue;
    let mine = 0;
    for (const c of st.cards) {
      if (c.deckId !== deckId) continue;
      have.set(c.cardId, (have.get(c.cardId) ?? 0) + 1);
      mine++;
    }
    if (mine && (!home || st.cards.length > home.cards.length)) home = st;
  }
  if (!home) return s;
  const faceUp = home.cards[home.cards.length - 1]?.faceUp ?? false;
  const add = deckCards(deck).filter((c) => {
    const n = have.get(c.cardId) ?? 0;
    if (n > 0) {
      have.set(c.cardId, n - 1);
      return false;
    }
    return true;
  });
  return ops.putCards(s, home.id, add.map((c) => ({ ...c, faceUp })));
}
