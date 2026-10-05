import { useState } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { TableState } from '@/shared/types';

/**
 * Undo/redo history of committed TableState snapshots.
 *
 *   const history = useTableHistory(initialState);          // stable store
 *   const present = useStore(history, (h) => h.present);
 *   history.getState().commit(next, { coalesceKey: 'counter:abc' });
 *   history.getState().undo();
 *
 * `coalesceKey`: consecutive commits with the same key within 1 s replace the
 * newest entry instead of adding one (e.g. tapping a counter +1 five times).
 */
export interface TableHistory {
  present: TableState;
  past: TableState[];
  future: TableState[];
  /** Label of the last committed action (for UI hints). */
  lastLabel: string | null;
  commit: (next: TableState, opts?: { coalesceKey?: string; label?: string }) => void;
  undo: () => TableState | null;
  redo: () => TableState | null;
  /** Replace everything (e.g. after loading a session). */
  reset: (state: TableState) => void;
}

export const HISTORY_LIMIT = 250;

export function createTableHistory(initial: TableState, limit = HISTORY_LIMIT): StoreApi<TableHistory> {
  let lastKey: { key: string; at: number } | null = null;
  return createStore<TableHistory>((set, get) => ({
    present: initial,
    past: [],
    future: [],
    lastLabel: null,
    commit: (next, opts) => {
      const cur = get().present;
      if (next === cur) return;
      const now = Date.now();
      const coalesce = !!opts?.coalesceKey && !!lastKey && lastKey.key === opts.coalesceKey && now - lastKey.at < 1000;
      lastKey = opts?.coalesceKey ? { key: opts.coalesceKey, at: now } : null;
      set((h) => ({
        present: next,
        past: coalesce ? h.past : [...h.past.slice(-(limit - 1)), cur],
        future: [],
        lastLabel: opts?.label ?? null,
      }));
    },
    undo: () => {
      const { past, present } = get();
      if (!past.length) return null;
      const prev = past[past.length - 1];
      lastKey = null;
      set((h) => ({ present: prev, past: h.past.slice(0, -1), future: [present, ...h.future] }));
      return prev;
    },
    redo: () => {
      const { future, present } = get();
      if (!future.length) return null;
      const next = future[0];
      lastKey = null;
      set((h) => ({ present: next, future: h.future.slice(1), past: [...h.past, present] }));
      return next;
    },
    reset: (state) => {
      lastKey = null;
      set({ present: state, past: [], future: [], lastLabel: null });
    },
  }));
}

/** A history store that lives as long as the calling component. */
export function useTableHistory(initial: TableState | (() => TableState)): StoreApi<TableHistory> {
  const [store] = useState(() => createTableHistory(typeof initial === 'function' ? initial() : initial));
  return store;
}
