import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import { api } from '@/api/client';
import type { Asset, Game, ID } from '@/shared/types';

/**
 * The game currently open in the editor. All editor features read and write
 * the game through this store:
 *
 *   const game = useGame((s) => s.game);
 *   const update = useGame((s) => s.update);
 *   update((g) => { g.name = 'New name'; }, 'Rename game');
 *
 * `update` applies an immer recipe, pushes an undo entry and schedules a
 * debounced autosave. Assets are server-managed — after uploading call
 * `addAssets(assets)` to merge them into the local copy.
 */

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface HistoryEntry {
  game: Game;
  label: string;
}

interface GameStore {
  game: Game | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  saveState: SaveState;
  lastSavedAt: number | null;
  past: HistoryEntry[];
  future: HistoryEntry[];

  load: (id: ID) => Promise<void>;
  unload: () => void;
  /** `history: false` = no undo entry here (a tool that keeps its own undo stack, e.g. the Cutter). */
  update: (recipe: (draft: Draft<Game>) => void, label?: string, opts?: { coalesceKey?: string; history?: boolean }) => void;
  addAssets: (assets: Asset[]) => void;
  removeAssetsLocal: (ids: ID[]) => void;
  undo: () => void;
  redo: () => void;
  flush: () => Promise<void>;
}

const SAVE_DELAY = 700;
const HISTORY_LIMIT = 100;
let saveTimer: number | undefined;
let lastCoalesce: { key: string; at: number } | null = null;
let savingPromise: Promise<void> | null = null;

export const useGame = create<GameStore>((set, get) => {
  const scheduleSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().flush(), SAVE_DELAY);
  };

  return {
    game: null,
    status: 'idle',
    error: null,
    saveState: 'saved',
    lastSavedAt: null,
    past: [],
    future: [],

    load: async (id) => {
      if (get().game?.id === id && get().status === 'ready') return;
      await get().flush();
      set({ status: 'loading', error: null, game: null, past: [], future: [] });
      try {
        const game = await api.getGame(id);
        set({ game, status: 'ready', saveState: 'saved', lastSavedAt: game.updatedAt });
      } catch (e: any) {
        set({ status: 'error', error: e?.message ?? 'Could not load game' });
      }
    },

    unload: () => {
      void get().flush();
      set({ game: null, status: 'idle', past: [], future: [] });
    },

    update: (recipe, label = 'Edit', opts) => {
      const cur = get().game;
      if (!cur) return;
      const next = produce(cur, recipe);
      if (next === cur) return;
      const now = Date.now();
      const coalesce =
        opts?.coalesceKey && lastCoalesce && lastCoalesce.key === opts.coalesceKey && now - lastCoalesce.at < 1200;
      lastCoalesce = opts?.coalesceKey ? { key: opts.coalesceKey, at: now } : null;
      if (opts?.history === false) {
        set({ game: next, saveState: 'dirty' });
        scheduleSave();
        return;
      }
      set((s) => ({
        game: next,
        saveState: 'dirty',
        past: coalesce ? s.past : [...s.past.slice(-HISTORY_LIMIT + 1), { game: cur, label }],
        future: [],
      }));
      scheduleSave();
    },

    addAssets: (assets) => {
      const cur = get().game;
      if (!cur) return;
      const merged = { ...cur.assets };
      for (const a of assets) merged[a.id] = a;
      set({ game: { ...cur, assets: merged } });
    },

    removeAssetsLocal: (ids) => {
      const cur = get().game;
      if (!cur) return;
      const merged = { ...cur.assets };
      for (const id of ids) delete merged[id];
      set({ game: { ...cur, assets: merged } });
    },

    undo: () => {
      const { past, game } = get();
      if (!past.length || !game) return;
      const prev = past[past.length - 1];
      // keep the newest asset table — assets are never undone
      set((s) => ({
        game: { ...prev.game, assets: game.assets },
        past: s.past.slice(0, -1),
        future: [{ game, label: prev.label }, ...s.future],
        saveState: 'dirty',
      }));
      scheduleSave();
    },

    redo: () => {
      const { future, game } = get();
      if (!future.length || !game) return;
      const next = future[0];
      set((s) => ({
        game: { ...next.game, assets: game.assets },
        future: s.future.slice(1),
        past: [...s.past, { game, label: next.label }],
        saveState: 'dirty',
      }));
      scheduleSave();
    },

    flush: async () => {
      window.clearTimeout(saveTimer);
      if (savingPromise) await savingPromise;
      const { game, saveState } = get();
      if (!game || (saveState !== 'dirty' && saveState !== 'error')) return;
      set({ saveState: 'saving' });
      const snapshot = game;
      savingPromise = (async () => {
        try {
          const saved = await api.saveGame(snapshot);
          const stillSame = get().game === snapshot;
          set({
            saveState: stillSame ? 'saved' : 'dirty',
            lastSavedAt: saved.updatedAt,
            game: stillSame ? { ...snapshot, updatedAt: saved.updatedAt } : get().game,
          });
          if (!stillSame) scheduleSave();
        } catch {
          set({ saveState: 'error' });
        } finally {
          savingPromise = null;
        }
      })();
      await savingPromise;
    },
  };
});

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    const s = useGame.getState().saveState;
    if (s === 'dirty' || s === 'saving') {
      void useGame.getState().flush();
      e.preventDefault();
    }
  });
}

/** Convenience: current game's asset URL for an asset id. */
export function useAssetUrl(id: ID | null | undefined): string | undefined {
  return useGame((s) => {
    if (!s.game || !id) return undefined;
    const a = s.game.assets[id];
    return a ? `/api/games/${s.game.id}/assets/${a.file}` : undefined;
  });
}
