/**
 * Where made components come from, for the rest of the editor: the Sources cards ("Cut → Keepers,
 * Embers"), Components and the deck editor ("Made from Crucible p3–4 · Change the cut"). Reads the
 * game's cutter.json (the Cutter's own copy while it is open), and links back into the Cutter on
 * the group that made a component.
 */
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import type { CutGroup, CutterDoc, Game, ID } from '@/shared/types';
import { useCutter } from './store';

const cache = new Map<ID, { at: number; doc: CutterDoc | null }>();

/** The game's cutter document (null while loading or when there is none). */
export function useCutterDoc(gameId: ID | undefined): CutterDoc | null {
  const live = useCutter((s) => (s.gameId === gameId && s.status === 'ready' ? s.doc : null));
  const [doc, setDoc] = useState<CutterDoc | null>(() => (gameId ? (cache.get(gameId)?.doc ?? null) : null));
  useEffect(() => {
    if (!gameId || live) return;
    let alive = true;
    api
      .getCutter(gameId)
      .then(({ cutter }) => {
        cache.set(gameId, { at: Date.now(), doc: cutter ?? null });
        if (alive) setDoc(cutter ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [gameId, live]);
  return live ?? doc;
}

/** The group that made a component (a deck, a token, a board), if any. */
export function groupThatMade(doc: CutterDoc | null, componentId: ID): CutGroup | undefined {
  if (!doc) return undefined;
  return doc.groups.find((g) => g.made && (g.made.componentId === componentId || ((g.kind === 'tokens' || g.kind === 'board') && g.made.pieceIds.includes(componentId))));
}

/** "p3–4, 7" from page numbers. */
function ranges(nums: number[]): string {
  const s = [...new Set(nums)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`);
    i = j;
  }
  return out.join(', ');
}

/** A short name for a file: "Crucible" for "The crucible hours .pdf". */
function shortName(name: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  const words = base.split(/\s+/).filter((w) => !/^(the|a|an|pnp|print|and|play|&)$/i.test(w));
  const w = words[0] ?? base;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Where a group's pieces are: "Crucible p3–4" · "IMG_2100, IMG_2101". */
export function groupFromLabel(doc: CutterDoc, game: Pick<Game, 'sources'>, group: CutGroup): string {
  const bySource = new Map<ID, number[]>();
  for (const f of Object.values(doc.frames)) {
    if (f.groupId !== group.id && f.id !== group.backs.sharedFrameId) continue;
    bySource.set(f.at.sourceId, [...(bySource.get(f.at.sourceId) ?? []), f.at.page]);
  }
  const parts: string[] = [];
  for (const s of game.sources) {
    const pages = bySource.get(s.id);
    if (!pages) continue;
    if (s.kind === 'images') {
      const names = [...new Set(pages)].sort((a, b) => a - b).map((p) => (s.pages[p]?.name ?? `image ${p + 1}`).replace(/\.[a-z0-9]+$/i, ''));
      parts.push(names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '));
    } else parts.push(`${shortName(s.name)} p${ranges(pages.map((p) => p + 1))}`);
  }
  return parts.join(' · ');
}

/** The groups made from a source (named as in the Cutter). */
export function groupsFromSource(doc: CutterDoc | null, sourceId: ID): CutGroup[] {
  if (!doc) return [];
  const ids = new Set(Object.values(doc.frames).filter((f) => f.at.sourceId === sourceId && f.side === 'front').map((f) => f.groupId));
  // only what was actually made: "Cut → …" names things you can find in Components
  return doc.groups.filter((g) => ids.has(g.id) && !!g.made);
}

/** Open the Cutter on a group (or a source). */
export const cutterLink = (gameId: ID, to: { group?: ID; source?: ID }) => `/games/${gameId}/edit/cut${to.group ? `?group=${to.group}` : to.source ? `?source=${to.source}` : ''}`;
