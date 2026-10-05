/**
 * The Cutter's state: the game's cutter.json (one document for every source), one undo stack for
 * frames, grids and groups, and a debounced autosave with a real Saving / Saved / Not saved state.
 * Saves carry the version they were based on, so an edit made on another device is never
 * silently overwritten (the server answers 409 and the Cutter says so).
 */
import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import { api, ApiError } from '@/api/client';
import type { CutKind, CutterDoc, Game, ID, PageRef } from '@/shared/types';
import { useGame } from '@/state/gameStore';
import { emptyCutter } from '@/shared/cutter/doc';
import { syncJoins } from './ops';

/** An undo step: the cut, plus the game's sources (the Cutter adds files and flips photo/scan). */
type Snap = Pick<CutterDoc, 'grids' | 'frames' | 'groups' | 'clean'> & { sources: Game['sources'] | null };

export type SaveState = 'saved' | 'saving' | 'error' | 'conflict';

export interface Selection {
  frameId?: ID | null;
  gridId?: ID | null;
  /** Bring the selected frame into view if it is small on screen (a tap on its number). */
  zoom?: boolean;
}

export interface CutterState {
  gameId: ID | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  doc: CutterDoc;
  save: { state: SaveState; at: number | null };
  past: { snap: Snap; label: string }[];
  future: { snap: Snap; label: string }[];
  /** Drawing a frame by dragging on the page (explicit mode, so a stray drag never draws). */
  drawing: boolean;
  sel: Selection;
  /** The last "What's on this page?" answer, offered again on the next page. */
  startKind: CutKind;
  startRows: number;
  startCols: number;
  /** The "Another grid on this page" form is open. */
  addingGrid: boolean;
  /** Pages changed by an edit made elsewhere (a group-wide size…), marked in the strip until visited. */
  marked: Record<string, number>;
  /** The group overview is open. */
  overview: boolean;
  /** "One back for all": the next frame tapped on any page becomes this group's back. */
  pickBack: ID | null;
  /** Frames on flat pages with nothing printed in them, where their grid skips empty spaces. */
  empties: Record<ID, true>;
}

const initial = (): CutterState => ({
  gameId: null,
  status: 'idle',
  error: null,
  doc: emptyCutter(),
  save: { state: 'saved', at: null },
  past: [],
  future: [],
  drawing: false,
  sel: {},
  startKind: 'cards',
  startRows: 3,
  startCols: 3,
  addingGrid: false,
  marked: {},
  overview: false,
  pickBack: null,
  empties: {},
});

export const useCutter = create<CutterState>(() => initial());
const S = () => useCutter.getState();

const snapOf = (d: CutterDoc): Snap => ({ grids: d.grids, frames: d.frames, groups: d.groups, clean: d.clean, sources: useGame.getState().game?.sources ?? null });

/** Put a snapshot back: the cut, and the game's sources when they differ (no game-history entry). */
function restore(snap: Snap, label: string) {
  const { sources, ...raw } = snap;
  // what a group made is a fact about the game, not an edit: undo keeps it (or the next Make would copy)
  const now = S().doc.groups;
  const cut = { ...raw, groups: raw.groups.map((g) => {
    const m = now.find((x) => x.id === g.id)?.made;
    return m === g.made ? g : { ...g, made: m };
  }) };
  const game = useGame.getState().game;
  if (sources && game && game.sources !== sources) useGame.getState().update((g) => void (g.sources = sources as Game['sources']), label, { history: false });
  return cut;
}

/* ------------------------------------------------------------------ */
/* editing                                                              */
/* ------------------------------------------------------------------ */

/** Change the document without an undo step (while dragging; view state). */
export function patchDoc(recipe: (d: Draft<CutterDoc>) => void, opts: { evenInConflict?: boolean } = {}) {
  // while another device's version is unresolved, nothing may change (it could never be saved)
  if (S().save.state === 'conflict' && !opts.evenInConflict) return;
  // after every edit: each joined board's seams follow its parts (no stale or phantom seam)
  useCutter.setState((s) => ({
    doc: produce(s.doc, (d) => {
      recipe(d);
      syncJoins(d as CutterDoc);
    }),
  }));
}

/** Remember the current state as an undo step (call once at the start of a drag). */
export function checkpoint(label: string) {
  if (S().save.state === 'conflict') return;
  useCutter.setState((s) => ({ past: [...s.past.slice(-120), { snap: snapOf(s.doc), label }], future: [] }));
}

/** An undoable change. */
export function commit(label: string, recipe: (d: Draft<CutterDoc>) => void) {
  const before = S().doc;
  checkpoint(label);
  patchDoc(recipe);
  // nothing changed (the same value again, a no-op): no undo step for it
  if (S().doc === before) useCutter.setState((s) => ({ past: s.past.slice(0, -1) }));
}

/** One undoable change to the cut and (optionally) the game — e.g. adding files, photo ↔ scan. */
export function commitWithGame(label: string, recipe: ((d: Draft<CutterDoc>) => void) | null, gameRecipe: (g: Draft<Game>) => void) {
  if (S().save.state === 'conflict') return;
  checkpoint(label);
  useGame.getState().update(gameRecipe, label, { history: false });
  if (recipe) patchDoc(recipe);
}

export function undo(): string | null {
  const s = S();
  const prev = s.past[s.past.length - 1];
  if (!prev || s.save.state === 'conflict') return null;
  const cur = snapOf(s.doc);
  useCutter.setState({ doc: { ...s.doc, ...restore(prev.snap, `Undo ${prev.label}`) }, past: s.past.slice(0, -1), future: [{ snap: cur, label: prev.label }, ...s.future], sel: {} });
  return prev.label;
}

export function redo(): string | null {
  const s = S();
  const next = s.future[0];
  if (!next || s.save.state === 'conflict') return null;
  const cur = snapOf(s.doc);
  useCutter.setState({ doc: { ...s.doc, ...restore(next.snap, `Redo ${next.label}`) }, future: s.future.slice(1), past: [...s.past, { snap: cur, label: next.label }], sel: {} });
  return next.label;
}

export function select(sel: Selection) {
  useCutter.setState({ sel });
}

export function setDrawing(on: boolean) {
  useCutter.setState({ drawing: on });
}

/** Where the user is (saved with the document, not undoable). */
export function goTo(at: PageRef) {
  const cur = S().doc.view;
  if (cur?.at && cur.at.sourceId === at.sourceId && cur.at.page === at.page) return;
  const key = `${at.sourceId}:${at.page}`;
  useCutter.setState((s) => {
    const { [key]: _seen, ...marked } = s.marked;
    return { sel: {}, drawing: false, addingGrid: false, marked };
  });
  patchDoc((d) => void (d.view = { ...(d.view ?? { mode: 'pages' }), at: { ...at } }), { evenInConflict: true });
}

/** Pages (frame the pieces) or Pieces (order, names, fronts & backs) for a group. */
export function setMode(mode: 'pages' | 'pieces', groupId?: ID | null) {
  useCutter.setState({ pickBack: null, drawing: false });
  patchDoc((d) => void (d.view = { ...(d.view ?? { at: null }), mode, ...(groupId !== undefined ? { groupId } : {}) }), { evenInConflict: true });
}

/** What the counts leave out: the empty spaces found on flat pages (not an edit; not saved). */
export function setEmpties(empties: Record<ID, true>) {
  const cur = useCutter.getState().empties;
  const keys = Object.keys(empties);
  if (keys.length === Object.keys(cur).length && keys.every((k) => cur[k])) return;
  useCutter.setState({ empties });
}

export function setPickBack(groupId: ID | null) {
  useCutter.setState({ pickBack: groupId, drawing: false });
}

/* ------------------------------------------------------------------ */
/* loading & saving                                                     */
/* ------------------------------------------------------------------ */

let saveTimer = 0;
let saving: Promise<void> | null = null;
let lastJson = '';
let baseAt: number | undefined;

let loadSeq = 0;
export async function openCutter(gameId: ID, opts: { fresh?: boolean } = {}) {
  // already open, or on its way (React runs mount effects twice in development)
  if (!opts.fresh && S().gameId === gameId && (S().status === 'ready' || S().status === 'loading')) return;
  const seq = ++loadSeq;
  if (S().gameId && !opts.fresh) await flushSave();
  window.clearTimeout(saveTimer);
  const { startKind, startRows, startCols, overview } = S();
  useCutter.setState({ ...initial(), gameId, status: 'loading', startKind, startRows, startCols, overview });
  try {
    const { cutter } = await api.getCutter(gameId);
    // a later open wins: an older answer must not replace what is on screen
    if (S().gameId !== gameId || seq !== loadSeq) return;
    const doc = cutter ?? emptyCutter();
    baseAt = cutter?.updatedAt;
    lastJson = cutter ? JSON.stringify(strip(doc)) : '';
    useCutter.setState({ doc, status: 'ready', save: { state: 'saved', at: cutter?.updatedAt ?? null } });
  } catch (e) {
    if (S().gameId === gameId && seq === loadSeq) useCutter.setState({ status: 'error', error: e instanceof Error ? e.message : 'Could not load the cutter.' });
  }
}

export function closeCutter() {
  void flushSave();
}

const strip = (d: CutterDoc): CutterDoc => {
  const { updatedAt: _u, ...rest } = d;
  return rest as CutterDoc;
};

function scheduleSave() {
  window.clearTimeout(saveTimer);
  if (S().save.state === 'saved') useCutter.setState((s) => ({ save: { ...s.save, state: 'saving' } }));
  saveTimer = window.setTimeout(() => void flushSave(), 700);
}

export async function flushSave(): Promise<void> {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  if (saving) await saving;
  const s = S();
  const gameId = s.gameId;
  if (!gameId || s.status !== 'ready' || s.save.state === 'conflict') return;
  const doc = strip(s.doc);
  const json = JSON.stringify(doc);
  if (json === lastJson) {
    if (S().save.state === 'saving') useCutter.setState((x) => ({ save: { ...x.save, state: 'saved' } }));
    return;
  }
  useCutter.setState((x) => ({ save: { ...x.save, state: 'saving' } }));
  saving = (async () => {
    try {
      const res = await api.saveCutter(gameId, doc, baseAt);
      baseAt = res.updatedAt;
      lastJson = json;
      if (S().gameId === gameId) useCutter.setState({ save: { state: saveTimer ? 'saving' : 'saved', at: res.updatedAt } });
    } catch (e) {
      console.warn('Saving the cutter failed', e);
      if (S().gameId === gameId) useCutter.setState((x) => ({ save: { state: e instanceof ApiError && e.status === 409 ? 'conflict' : 'error', at: x.save.at } }));
    } finally {
      saving = null;
    }
  })();
  await saving;
}

/** Try again after a failed save. */
export function retrySave() {
  if (S().save.state === 'error') {
    useCutter.setState((x) => ({ save: { ...x.save, state: 'saving' } }));
    void flushSave();
  }
}

/** The version on the server changed elsewhere: take theirs (discarding these edits) or keep mine (overwrite). */
export async function resolveConflict(choice: 'theirs' | 'mine') {
  const gameId = S().gameId;
  if (!gameId || S().save.state !== 'conflict') return;
  if (choice === 'theirs') {
    await openCutter(gameId, { fresh: true });
    return;
  }
  useCutter.setState((x) => ({ save: { ...x.save, state: 'saving' } }));
  try {
    const doc = strip(S().doc);
    const res = await api.saveCutter(gameId, doc);
    baseAt = res.updatedAt;
    lastJson = JSON.stringify(doc);
    useCutter.setState({ save: { state: 'saved', at: res.updatedAt } });
  } catch (e) {
    console.warn('Overwriting the cutter failed', e);
    useCutter.setState((x) => ({ save: { state: 'conflict', at: x.save.at } }));
  }
}

/** Work that is not on the server yet (a conflict counts: those edits are not saved). */
export const unsaved = () => !!saveTimer || !!saving || S().save.state === 'error' || S().save.state === 'conflict' || S().save.state === 'saving';

useCutter.subscribe((s, p) => {
  if (s.status !== 'ready' || !s.gameId || s.doc === p.doc || p.status !== 'ready') return;
  scheduleSave();
});

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!S().gameId || !unsaved()) return;
    void flushSave();
    e.preventDefault();
  });
}
