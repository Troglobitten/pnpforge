/** Saved games (sessions) for the current game: open, rename, delete, start new. */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { ID, SessionSummary, TableState } from '@/shared/types';
import { api } from '@/api/client';
import { Badge, Button, Dialog, EmptyState, IconButton, Spinner, confirm, promptText, toast } from '@/ui';

/** How far along is this save? "Glory 2 · Reagents 28 · 3 in hand". */
function describe(state: TableState): string {
  const bits: string[] = [];
  const ents = Object.values(state.entities ?? {});
  for (const e of ents) {
    if (e.kind === 'counter' && bits.length < 2) bits.push(`${e.label || 'Counter'} ${e.value}`);
  }
  let biggest: { name: string; n: number } | null = null;
  for (const e of ents) {
    if (e.kind === 'stack' && e.cards.length > 1 && (!biggest || e.cards.length > biggest.n)) biggest = { name: e.name || 'Deck', n: e.cards.length };
  }
  if (biggest) bits.push(`${biggest.name} ${biggest.n}`);
  if (state.hand?.length) bits.push(`${state.hand.length} in hand`);
  return bits.join(' · ');
}

function when(ts: number) {
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function SessionsDialog({
  gameId,
  currentId,
  open,
  onClose,
  onOpen,
  onNew,
}: {
  gameId: ID;
  currentId: ID | undefined;
  open: boolean;
  onClose: () => void;
  onOpen: (id: ID) => void;
  onNew: () => void;
}) {
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [desc, setDesc] = useState<Record<ID, string>>({});
  const refresh = useCallback(() => {
    api
      .listSessions(gameId)
      .then(async (l) => {
        const sorted = l.slice().sort((a, b) => b.updatedAt - a.updatedAt);
        setList(sorted);
        // "Game of 12 Sept, 15:52" tells you nothing — say what state each save is in.
        for (const s of sorted.slice(0, 12)) {
          try {
            const full = await api.getSession(gameId, s.id);
            const d = describe(full.state);
            if (d) setDesc((m) => ({ ...m, [s.id]: d }));
          } catch {
            /* a missing save just shows no summary */
          }
        }
      })
      .catch(() => setList([]));
  }, [gameId]);
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const rename = async (s: SessionSummary) => {
    const name = await promptText({ title: 'Rename saved game', initial: s.name, confirmLabel: 'Rename' });
    if (!name) return;
    try {
      await api.saveSession(gameId, s.id, { name });
      refresh();
    } catch (e: any) {
      toast.error('Couldn’t rename', { description: e?.message });
    }
  };
  const remove = async (s: SessionSummary) => {
    const ok = await confirm({ title: `Delete “${s.name}”?`, message: 'This saved game will be gone for good. This can’t be undone.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteSession(gameId, s.id);
      refresh();
    } catch (e: any) {
      toast.error('Couldn’t delete', { description: e?.message });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title="Saved games"
      description="Every game you start is saved automatically as you play."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={Plus} onClick={onNew}>
            Start a new game
          </Button>
        </>
      }
    >
      {!list ? (
        <div style={{ display: 'grid', placeItems: 'center', minHeight: 120 }}>
          <Spinner size={20} />
        </div>
      ) : !list.length ? (
        <EmptyState compact title="No saved games yet" description="Start a game and it will appear here." />
      ) : (
        <div className="play-saves">
          {list.map((s) => {
            const current = s.id === currentId;
            return (
              <div key={s.id} className={`play-saves__row ${current ? 'is-current' : ''}`}>
                <div className="play-saves__main">
                  <div className="play-saves__name">{s.name}</div>
                  <div className="play-saves__meta">
                    {desc[s.id] ? `${desc[s.id]} · ` : ''}
                    last played {when(s.updatedAt)}
                  </div>
                </div>
                {current ? (
                  <Badge tone="accent">Playing</Badge>
                ) : (
                  <Button size="sm" icon={Play} onClick={() => onOpen(s.id)}>
                    Continue
                  </Button>
                )}
                <IconButton icon={Pencil} label="Rename" size="sm" onClick={() => void rename(s)} />
                <IconButton icon={Trash2} label={current ? 'You’re playing this one' : 'Delete'} size="sm" disabled={current} onClick={() => void remove(s)} />
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
