/**
 * Changes to a whole group can reach pages the user is not looking at (a size that resizes a grid
 * on page 15, a trim that changes the cards on IMG_2081). Such a change is one undo step, the pages
 * it touched are marked in the strip until visited, and a toast says what else changed — with Undo.
 */
import { useRef } from 'react';
import { produce, type Draft } from 'immer';
import { toast } from '@/ui';
import type { CutterDoc, Game, ID, PageRef } from '@/shared/types';
import { commit, undo, useCutter } from './store';
import { changedPages, groupPages, pageKey, pageLabel, sameRef } from './ops';

const list = (game: Pick<Game, 'sources'>, pages: PageRef[]) => {
  const names = pages.map((p) => pageLabel(game, p));
  if (names.length <= 3) return names.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more pages`;
};

export function markPages(pages: PageRef[]) {
  if (!pages.length) return;
  useCutter.setState((s) => ({ marked: { ...s.marked, ...Object.fromEntries(pages.map((p) => [pageKey(p), Date.now()])) } }));
}

/** Commit a group-wide change made while looking at `at`, and tell what it did elsewhere. */
export function commitGroupChange(game: Pick<Game, 'sources'>, at: PageRef, groupId: ID, label: string, recipe: (d: Draft<CutterDoc>) => void, opts: { quiet?: boolean } = {}) {
  const before = useCutter.getState().doc;
  commit(label, recipe);
  const after = useCutter.getState().doc;
  if (after === before) return;
  const moved = changedPages(before, after).filter((p) => !sameRef(p, at));
  const members = groupPages(after, groupId).filter((p) => !sameRef(p, at) && !moved.some((m) => sameRef(m, p)));
  markPages([...moved, ...members]);
  if (opts.quiet) return;
  const msg = moved.length ? `Also resized ${moved.length === 1 ? 'the grid' : 'the grids'} on ${list(game, moved)}` : members.length ? `Also applies to ${list(game, members)}` : null;
  if (msg) toast(msg, { description: `${label} — the whole group changes.`, action: { label: 'Undo', onClick: () => void undo() }, duration: 6000 });
}

/** Slider / stepper bursts on group settings: one undo step and one message per burst. */
export function useGroupBurst(game: Pick<Game, 'sources'>, at: PageRef, groupId: ID) {
  const last = useRef(0);
  return (label: string, recipe: (d: Draft<CutterDoc>) => void) => {
    const now = Date.now();
    if (now - last.current > 700) commitGroupChange(game, at, groupId, label, recipe);
    else if (useCutter.getState().save.state !== 'conflict') useCutter.setState((s) => ({ doc: produce(s.doc, recipe) }));
    last.current = now;
  };
}
