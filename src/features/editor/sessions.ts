import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '@/api/client';
import type { ID, SessionSummary } from '@/shared/types';

/** Saved play sessions per game (refetched whenever an editor view mounts). */
const useSessionsStore = create<{
  byGame: Record<ID, SessionSummary[] | undefined>;
  fetch: (id: ID) => Promise<void>;
}>((set) => ({
  byGame: {},
  fetch: async (id) => {
    try {
      const list = await api.listSessions(id);
      set((s) => ({ byGame: { ...s.byGame, [id]: list } }));
    } catch {
      set((s) => ({ byGame: { ...s.byGame, [id]: s.byGame[id] ?? [] } }));
    }
  },
}));

export function useSessions(gameId: ID | undefined): SessionSummary[] | undefined {
  const list = useSessionsStore((s) => (gameId ? s.byGame[gameId] : undefined));
  const fetch = useSessionsStore((s) => s.fetch);
  useEffect(() => {
    if (gameId) void fetch(gameId);
  }, [gameId, fetch]);
  return list;
}
