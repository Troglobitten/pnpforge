import { useCallback, useMemo } from 'react';
import type { Draft } from 'immer';
import { useGame } from '@/state/gameStore';
import { toast } from '@/ui';
import type { Asset, CardDef, DeckComponent, Game, ID } from '@/shared/types';
import {
  bakeRotation,
  countCardPlacements,
  makeDeck,
  nameFromFile,
  newCard,
  newId,
  plural,
  removeCardPlacements,
  retargetCardPlacements,
  uploadImages,
  urlOf,
} from '../lib';
import { undoToast } from '../common';

export type DeckMut = (recipe: (d: Draft<DeckComponent>, g: Draft<Game>) => void, label: string, coalesce?: string) => void;

const cardsLabel = (n: number) => (n === 1 ? 'card' : `${n} cards`);

/** All deck mutations, each one undoable step. */
export function useDeckActions(deckId: ID) {
  const update = useGame((s) => s.update);
  const addAssets = useGame((s) => s.addAssets);

  const mut: DeckMut = useCallback(
    (recipe, label, coalesce) =>
      update(
        (g) => {
          const d = g.components.find((c) => c.id === deckId);
          if (d && d.kind === 'deck') recipe(d, g);
        },
        label,
        coalesce ? { coalesceKey: `${deckId}:${coalesce}` } : undefined,
      ),
    [update, deckId],
  );

  return useMemo(() => {
    const snapshot = () => {
      const g = useGame.getState().game!;
      return { g, d: g.components.find((c) => c.id === deckId) as DeckComponent | undefined };
    };

    const setCount = (ids: ID[], n: number) => {
      const s = new Set(ids);
      mut((d) => d.cards.forEach((c) => s.has(c.id) && (c.count = n)), `Set copies of ${cardsLabel(ids.length)}`, `count:${ids.join()}`);
    };

    const deleteCards = (ids: ID[]) => {
      const { g } = snapshot();
      const s = new Set(ids);
      const placed = countCardPlacements(g.setup, deckId, s);
      mut((d, gg) => {
        d.cards = d.cards.filter((c) => !s.has(c.id));
        removeCardPlacements(gg.setup, deckId, s);
      }, `Delete ${cardsLabel(ids.length)}`);
      toast(`Deleted ${plural(ids.length, 'card')}`, {
        description: placed ? `Also removed ${plural(placed, 'copy', 'copies')} from the table setup.` : undefined,
        action: undoToast(),
      });
    };

    const duplicate = (ids: ID[]): ID[] => {
      const s = new Set(ids);
      const created: ID[] = [];
      mut((d) => {
        for (let i = d.cards.length - 1; i >= 0; i--) {
          const c = d.cards[i];
          if (!s.has(c.id)) continue;
          const copy: CardDef = { ...c, id: newId() };
          d.cards.splice(i + 1, 0, copy);
          created.unshift(copy.id);
        }
      }, `Duplicate ${cardsLabel(ids.length)}`);
      return created;
    };

    const setBack = (ids: ID[], asset: ID | null) => {
      const s = new Set(ids);
      mut((d) => {
        for (const c of d.cards) {
          if (!s.has(c.id)) continue;
          if (asset) c.back = asset;
          else delete c.back;
        }
      }, asset ? `Set back of ${cardsLabel(ids.length)}` : `Use deck back for ${cardsLabel(ids.length)}`);
    };

    const swapFaces = (ids: ID[]) => {
      const s = new Set(ids);
      let swapped = 0;
      mut((d) => {
        for (const c of d.cards) {
          if (!s.has(c.id)) continue;
          const back = c.back ?? d.back ?? null;
          if (!c.front && !back) continue;
          const front = c.front;
          c.front = back;
          if (front && front !== d.back) c.back = front;
          else delete c.back;
          swapped++;
        }
      }, `Swap faces of ${cardsLabel(ids.length)}`);
      if (!swapped) toast.warning('Nothing to swap', { description: 'These cards have no front image and the deck has no back image.' });
    };

    const reorder = (order: ID[], label = 'Reorder cards') => {
      const idx = new Map(order.map((id, i) => [id, i]));
      mut((d) => {
        d.cards.sort((a, b) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0));
      }, label);
    };

    const rename = (id: ID, name: string) =>
      mut((d) => {
        const c = d.cards.find((x) => x.id === id);
        if (c) c.name = name || undefined;
      }, 'Rename card', `name:${id}`);

    const setFront = (id: ID, asset: ID | null) =>
      mut((d) => {
        const c = d.cards.find((x) => x.id === id);
        if (c) c.front = asset;
      }, 'Replace card image');

    const addFromAssets = (assets: Asset[], opts: { size?: { width: number; height: number } } = {}) => {
      const cards = assets.map((a) => newCard(a.id, nameFromFile(a.name ?? '')));
      mut((d) => {
        if (opts.size) {
          d.width = opts.size.width;
          d.height = opts.size.height;
        }
        d.cards.push(...cards);
      }, `Add ${plural(cards.length, 'card')}`);
      return cards.map((c) => c.id);
    };

    const addBlank = () => {
      const c = newCard(null);
      mut((d) => {
        d.cards.push(c);
      }, 'Add blank card');
      return c.id;
    };

    /** Move or copy cards into another deck ('new' creates one with the same size and back). */
    const moveTo = (ids: ID[], target: ID | 'new', copy: boolean): { deckId: ID; name: string } | null => {
      const { g, d } = snapshot();
      if (!d) return null;
      const s = new Set(ids);
      const fresh =
        target === 'new'
          ? makeDeck(g, { name: `${d.name} ${copy ? 'copy' : 'part 2'}`, width: d.width, height: d.height, cornerRadius: d.cornerRadius, back: d.back, backColor: d.backColor })
          : null;
      const targetId = fresh?.id ?? (target as ID);
      const targetName = fresh?.name ?? g.components.find((c) => c.id === targetId)?.name ?? 'deck';
      update((gg) => {
        if (fresh) gg.components.splice(gg.components.findIndex((c) => c.id === deckId) + 1, 0, fresh);
        const src = gg.components.find((c) => c.id === deckId) as Draft<DeckComponent> | undefined;
        const dst = gg.components.find((c) => c.id === targetId) as Draft<DeckComponent> | undefined;
        if (!src || !dst || dst.kind !== 'deck') return;
        const moving = src.cards.filter((c) => s.has(c.id)).map((c) => ({ ...c }));
        if (copy) dst.cards.push(...moving.map((c) => ({ ...c, id: newId() })));
        else {
          src.cards = src.cards.filter((c) => !s.has(c.id));
          dst.cards.push(...moving);
          retargetCardPlacements(gg.setup, deckId, targetId, s);
        }
      }, `${copy ? 'Copy' : 'Move'} ${cardsLabel(ids.length)} to ${targetName}`);
      return { deckId: targetId, name: targetName };
    };

    /** Bakes a rotated copy of each selected card's front and swaps it in. */
    const rotate = async (ids: ID[], deg: 90 | 180 | 270) => {
      const { g, d } = snapshot();
      if (!d) return;
      const s = new Set(ids);
      const fronts = [...new Set(d.cards.filter((c) => s.has(c.id) && c.front).map((c) => c.front!))];
      if (!fronts.length) {
        toast.warning('Nothing to rotate', { description: 'These cards have no image yet.' });
        return;
      }
      try {
        const baked: { blob: Blob; name: string }[] = [];
        for (let i = 0; i < fronts.length; i += 6) {
          const chunk = fronts.slice(i, i + 6);
          baked.push(...(await Promise.all(chunk.map((id) => bakeRotation(urlOf(g, id)!, g.assets[id], deg)))));
        }
        const assets = await uploadImages(g.id, baked, 'card');
        addAssets(assets);
        const map = new Map(fronts.map((id, i) => [id, assets[i]?.id]));
        mut((dd) => {
          for (const c of dd.cards) if (s.has(c.id) && c.front && map.get(c.front)) c.front = map.get(c.front)!;
        }, `Rotate ${cardsLabel(ids.length)}`);
      } catch (e: any) {
        toast.error('Could not rotate', { description: e?.message ?? 'Please try again.' });
      }
    };

    /** Move the selected cards one step left (-1) or right (+1) in the deck. */
    const nudge = (ids: ID[], dir: -1 | 1) => {
      const { d } = snapshot();
      if (!d) return;
      const s = new Set(ids);
      const order = d.cards.map((c) => c.id);
      if (dir < 0) {
        for (let i = 1; i < order.length; i++)
          if (s.has(order[i]) && !s.has(order[i - 1])) [order[i - 1], order[i]] = [order[i], order[i - 1]];
      } else {
        for (let i = order.length - 2; i >= 0; i--)
          if (s.has(order[i]) && !s.has(order[i + 1])) [order[i + 1], order[i]] = [order[i], order[i + 1]];
      }
      if (order.join() !== d.cards.map((c) => c.id).join()) reorder(order, `Move ${cardsLabel(ids.length)}`);
    };

    return { mut, setCount, deleteCards, duplicate, setBack, swapFaces, reorder, rename, setFront, addFromAssets, addBlank, moveTo, rotate, nudge };
  }, [mut, update, addAssets, deckId]);
}

export type DeckActions = ReturnType<typeof useDeckActions>;
