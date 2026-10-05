import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FilePlus2, PackageOpen, Plus, RefreshCw, Search, SearchX, Settings, Upload, WifiOff } from 'lucide-react';
import { openSettings } from '@/features/settings/SettingsDialog';
import { api } from '@/api/client';
import type { GameSummary } from '@/shared/types';
import { Button, EmptyState, IconButton, Select, TextInput, Tooltip, confirm, toast } from '@/ui';
import { createGameFromFiles } from './actions';
import { FirstRun } from './FirstRun';
import { GameTile, GameTileSkeleton, PendingTile } from './GameTile';
import { Logo } from './Logo';
import { NewGameDialog } from './NewGameDialog';
import { useWindowFileDrop } from './useFileDrop';
import {
  guardStrayBackdropClick,
  isArchiveFile,
  isSourceFile,
  isTypingTarget,
  nameFromFiles,
  pickFiles,
  plural,
} from './util';
import './library.css';

type SortKey = 'recent' | 'name' | 'played' | 'created';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'recent', label: 'Recently used' },
  { value: 'played', label: 'Last played' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'created', label: 'Newest first' },
];
const SEARCH_THRESHOLD = 6;

interface Pending {
  key: number;
  label: string;
  name: string;
  progress: number | null;
}
let pendingSeq = 1;

function readSort(): SortKey {
  try {
    const v = localStorage.getItem('pnpforge.library.sort') as SortKey | null;
    return v && SORTS.some((s) => s.value === v) ? v : 'recent';
  } catch {
    return 'recent';
  }
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newFiles, setNewFiles] = useState<File[] | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(readSort);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'pnpforge';
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listGames();
      setGames(list);
      setLoadError(null);
      return list;
    } catch (e: any) {
      setLoadError(e?.message ?? 'Could not load your games');
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!highlight) return;
    const el = document.querySelector(`[data-game-id="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const t = window.setTimeout(() => setHighlight(null), 2400);
    return () => window.clearTimeout(t);
  }, [highlight, games]);

  const addPending = (label: string, name: string) => {
    const key = pendingSeq++;
    setPending((p) => [...p, { key, label, name, progress: null }]);
    return {
      progress: (v: number) => setPending((p) => p.map((x) => (x.key === key ? { ...x, progress: v } : x))),
      done: () => setPending((p) => p.filter((x) => x.key !== key)),
    };
  };

  /* ---------------- actions ---------------- */

  const importFiles = async (files: File[]) => {
    for (const file of files) {
      const job = addPending('Importing…', file.name.replace(/\.(pnpforge|zip)$/i, ''));
      try {
        const game = await api.importGame(file, job.progress);
        await refresh();
        setHighlight(game.id);
        toast.success(`Imported “${game.name}”`, {
          action: { label: 'Open', onClick: () => navigate(`/games/${game.id}/edit`) },
        });
      } catch (e: any) {
        toast.error(`Couldn’t import ${file.name}`, { description: e?.message ?? 'The file could not be read.' });
      } finally {
        job.done();
      }
    }
  };

  const startImport = async () => {
    const files = await pickFiles({ accept: '.pnpforge,.zip', multiple: true });
    if (files.length) void importFiles(files);
  };

  const createFromFiles = async (files: File[]) => {
    const job = addPending('Creating…', nameFromFiles(files));
    try {
      const game = await createGameFromFiles(files);
      navigate(`/games/${game.id}/edit/sources`);
    } catch (e: any) {
      toast.error('Couldn’t create the game', { description: e?.message });
      job.done();
    }
  };

  const handleDroppedFiles = (files: File[]) => {
    const archives = files.filter(isArchiveFile);
    const sources = files.filter((f) => !isArchiveFile(f) && isSourceFile(f));
    const other = files.filter((f) => !isArchiveFile(f) && !isSourceFile(f));
    if (other.length) {
      toast.warning(other.length === 1 ? `pnpforge can’t open “${other[0].name}”` : `${other.length} files were skipped`, {
        description: 'Drop PDFs or images to start a new game, or a .pnpforge file to import one.',
      });
    }
    if (archives.length) void importFiles(archives);
    if (sources.length) void createFromFiles(sources);
  };

  const duplicate = async (g: GameSummary) => {
    const job = addPending('Duplicating…', `${g.name} (copy)`);
    try {
      const copy = await api.duplicateGame(g.id);
      await refresh();
      setHighlight(copy.id);
      toast.success(`Duplicated “${g.name}”`);
    } catch (e: any) {
      toast.error('Couldn’t duplicate the game', { description: e?.message });
    } finally {
      job.done();
    }
  };

  const remove = async (g: GameSummary) => {
    const ok = await confirm({
      title: `Delete “${g.name}”?`,
      message: (
        <>
          The game, its files and {g.sessionCount ? plural(g.sessionCount, 'saved game') : 'any saved games'} will be removed
          from your library. This can’t be undone from the app — consider exporting it first.
        </>
      ),
      confirmLabel: 'Delete game',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteGame(g.id);
      setGames((list) => list?.filter((x) => x.id !== g.id) ?? null);
      toast.success(`Deleted “${g.name}”`);
    } catch (e: any) {
      toast.error('Couldn’t delete the game', { description: e?.message });
      void refresh();
    }
  };

  const openNew = (files?: File[]) => {
    if (newOpen) return; // a second click must not toggle the dialog back shut
    setNewFiles(files);
    setNewOpen(true);
    guardStrayBackdropClick();
  };

  /* ---------------- drag & drop / shortcuts ---------------- */

  const drag = useWindowFileDrop(!newOpen, handleDroppedFiles);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('.ui-dialog-backdrop, .ui-menu')) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openNew();
      } else if (e.key === '/' && searchRef.current) {
        e.preventDefault();
        searchRef.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------- derived ---------------- */

  const showSearch = (games?.length ?? 0) > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    if (!games) return [];
    const q = query.trim().toLowerCase();
    let list = q
      ? games.filter((g) =>
          [g.name, g.designer, g.description, ...(g.tags ?? [])].some((s) => s?.toLowerCase().includes(q)),
        )
      : games.slice();
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    else if (sort === 'played') list.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.updatedAt - a.updatedAt);
    else if (sort === 'created') list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [games, query, sort]);

  const isEmpty = games !== null && games.length === 0 && pending.length === 0;

  return (
    <div className="lib">
      <header className="lib-top">
        <div className="lib-top__inner">
          <Logo />
          <div className="lib-top__actions">
            <IconButton icon={Settings} label="Settings" tooltipPlacement="bottom" onClick={openSettings} />
            <Tooltip label="Import a .pnpforge file">
              <Button variant="ghost" icon={Upload} onClick={startImport}>
                <span className="lib-hide-sm">Import</span>
              </Button>
            </Tooltip>
            <Tooltip label="Create a new game" shortcut="N">
              <Button variant="primary" icon={Plus} onClick={() => openNew()}>
                New game
              </Button>
            </Tooltip>
          </div>
        </div>
      </header>

      <main className="lib-main">
        {loadError && !games ? (
          <div className="lib-center">
            <EmptyState
              icon={WifiOff}
              title="Can’t reach your library"
              description={`The pnpforge server didn’t answer (${loadError}). Check that it’s running, then try again.`}
              actions={
                <Button variant="primary" icon={RefreshCw} onClick={() => void refresh()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : isEmpty ? (
          <FirstRun onFiles={handleDroppedFiles} onNewGame={() => openNew()} onImport={startImport} />
        ) : (
          <>
            <div className="lib-head">
              <div>
                <h1 className="lib-head__title display">Your games</h1>
                <p className="lib-head__sub">
                  {games === null ? (
                    <span className="lib-skel lib-skel--line" style={{ width: 120, display: 'inline-block' }} />
                  ) : (
                    <>
                      {plural(games.length, 'game')} on the shelf
                      <span className="lib-head__tip lib-hide-sm"> · Drop a PDF anywhere to start a new one</span>
                    </>
                  )}
                </p>
              </div>
              {showSearch && (
                <div className="lib-tools">
                  <TextInput
                    ref={searchRef}
                    icon={Search}
                    type="search"
                    className="lib-tools__search"
                    placeholder="Search games, designers, tags"
                    aria-label="Search games"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setQuery('');
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  <Select
                    value={sort}
                    className="lib-tools__sort"
                    options={SORTS}
                    onChange={(v) => {
                      setSort(v);
                      try {
                        localStorage.setItem('pnpforge.library.sort', v);
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                </div>
              )}
            </div>

            {games !== null && visible.length === 0 && query ? (
              <EmptyState
                compact
                icon={SearchX}
                title={`No games match “${query}”`}
                description="Try a different name, designer or tag."
                actions={<Button onClick={() => setQuery('')}>Clear search</Button>}
              />
            ) : (
              <div className="lib-grid">
                {games === null
                  ? Array.from({ length: 6 }, (_, i) => <GameTileSkeleton key={i} />)
                  : visible.map((g) => (
                      <GameTile key={g.id} game={g} highlighted={highlight === g.id} onDuplicate={duplicate} onDelete={remove} />
                    ))}
                {pending.map((p) => (
                  <PendingTile key={p.key} label={p.label} name={p.name} progress={p.progress} />
                ))}
                {games !== null && !query && (
                  <button type="button" className="lib-addtile" onClick={() => openNew()}>
                    <span className="lib-addtile__icon">
                      <FilePlus2 size={24} />
                    </span>
                    <span className="lib-addtile__title">New game</span>
                    <span className="lib-addtile__desc">Start from a PnP PDF, images or nothing at all</span>
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {drag && (
        <div className="lib-dropover" aria-hidden>
          <div className="lib-dropover__card">
            <div className="lib-dropover__icon">{drag.kind === 'import' ? <PackageOpen size={34} /> : <FilePlus2 size={34} />}</div>
            <div className="lib-dropover__title display">
              {drag.kind === 'import'
                ? drag.count > 1
                  ? `Import ${drag.count} games`
                  : 'Import this game'
                : drag.kind === 'create'
                  ? 'Start a new game'
                  : 'Drop to add to your library'}
            </div>
            <div className="lib-dropover__desc">
              {drag.kind === 'import'
                ? 'Release to import the .pnpforge file into your library.'
                : drag.kind === 'create'
                  ? `Release to create a game from ${drag.count > 1 ? `these ${drag.count} files` : 'this file'} and start cutting out the pieces.`
                  : 'PDFs and images start a new game; .pnpforge files are imported.'}
            </div>
          </div>
        </div>
      )}

      <NewGameDialog open={newOpen} initialFiles={newFiles} onClose={() => setNewOpen(false)} />
    </div>
  );
}
