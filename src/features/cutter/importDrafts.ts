/**
 * Owner ruling Q7: unsaved work from the retired PDF slicer lived in this browser's localStorage.
 * The first time a game is opened in the Cutter, that work is brought in once — as groups that were
 * never made — and the entries are then dropped. A browser that has already done it (or never had
 * any) does nothing. Nothing is silently changed: the user is told, and it is one undo step.
 */
import type { CutterDoc, Game } from '@/shared/types';
import { migrate } from '@/shared/cutter/migrate';
import { commit } from './store';

const PREFIX = 'pnpforge.slicer.';
const mark = (gameId: string) => `pnpforge.cutter.drafts-imported.${gameId}`;

function entriesFor(gameId: string): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(`${PREFIX}${gameId}:`)) continue;
      const raw = localStorage.getItem(key);
      if (raw) out.push({ key, value: raw });
    }
  } catch {
    /* storage blocked: nothing to import */
  }
  return out;
}

function forget(gameId: string, keys: string[]) {
  try {
    for (const k of keys) localStorage.removeItem(k);
    localStorage.setItem(mark(gameId), String(Date.now()));
  } catch {
    /* ignore */
  }
}

export interface DraftImport {
  groups: number;
  /** Names of the groups that came in, for the message. */
  names: string[];
}

/**
 * Bring this browser's leftover slicer drafts for `game` into the open cut. Returns null when there
 * is nothing to do (already imported, or none). Whatever the drafts held, the groups arrive unmade:
 * the user presses Make when they are happy.
 */
export function importSlicerDrafts(game: Game, doc: CutterDoc): DraftImport | null {
  const entries = entriesFor(game.id);
  if (!entries.length) return null;
  let done = false;
  try {
    done = !!localStorage.getItem(mark(game.id));
  } catch {
    /* ignore */
  }
  if (done) {
    forget(game.id, entries.map((e) => e.key));
    return null;
  }
  const before = new Set(doc.groups.map((g) => g.id));
  let added: string[] = [];
  // localStorage only: the SliceJobs on the server are the migration's business, never a browser's
  const { doc: next } = migrate({ game, slicerDrafts: entries, existing: doc, only: ['slicer-drafts'] });
  added = next.groups.filter((g) => !before.has(g.id)).map((g) => g.name);
  if (!added.length) {
    forget(game.id, entries.map((e) => e.key));
    return null;
  }
  commit('Import your unsaved slicer work', (d) => {
    const cur = d as CutterDoc;
    cur.grids = next.grids;
    cur.frames = next.frames;
    // groups that were already here keep everything, a made one its link; what the drafts bring in
    // was work in progress, so it arrives unmade of its own accord
    cur.groups = next.groups;
    cur.migrated = next.migrated;
  });
  forget(game.id, entries.map((e) => e.key));
  return { groups: added.length, names: added };
}

/** For tests: has this browser already imported (or dropped) this game's drafts? */
export const draftsImported = (gameId: string) => {
  try {
    return !!localStorage.getItem(mark(gameId));
  } catch {
    return false;
  }
};
