/**
 * /games/:gameId/play           → starts a new session from the game's setup
 * /games/:gameId/play/:sessionId → loads that session
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useStore } from 'zustand';
import {
  ArrowLeft,
  BookOpen,
  Ellipsis,
  FolderOpen,
  Hand,
  Keyboard,
  LayoutDashboard,
  MousePointerClick,
  Palette,
  Pencil,
  Plus,
  Redo2,
  RotateCcw,
  TriangleAlert,
  Undo2,
  Settings,
  Tag,
  Volume2,
  VolumeX,
  FlipHorizontal2,
} from 'lucide-react';
import type { Camera, Game, ID, Session, TableState, TableTheme } from '@/shared/types';
import { emptyTable } from '@/shared/types';
import { api, ApiError } from '@/api/client';
import { Button, EmptyState, IconButton, MenuButton, Spinner, confirm, toast, type MenuItem } from '@/ui';
import { useSoundMuted } from '@/lib/sound';
import { useSettings } from '@/state/settings';
import { openSettings } from '@/features/settings/SettingsDialog';
import { MAX_ZOOM, createTableHistory, freshStateFromSetup, normalizeState } from './engine';
import { TableView } from './table/TableView';
import type { TableController, CommitMeta } from './table/controller';
import { TABLE_THEMES, getTableThemeStyle } from './table/theme';
import { RulesPanel } from './chrome/RulesPanel';
import { SessionsDialog } from './chrome/SessionsDialog';
import './play.css';

const SAVE_DELAY = 800;

/** De-duplicates session creation (StrictMode runs effects twice). */
const creating = new Map<string, Promise<Session>>();

function sessionName() {
  return `Game of ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

function startSession(game: Game, key: string): Promise<Session> {
  let p = creating.get(key);
  if (!p) {
    const state = freshStateFromSetup(game.setup);
    state.camera = undefined; // fit the table to this screen on first open
    p = api.createSession(game.id, { name: sessionName(), state });
    creating.set(key, p);
    p.finally(() => window.setTimeout(() => creating.delete(key), 5000));
  }
  return p;
}

/**
 * `/play` **resumes** — it is where "Play" in the library and a bookmark both land, and
 * silently starting a brand-new game each time buried players under identical saves.
 * Only "Start a new game" (and a game that has never been played) creates one.
 */
async function resumeOrStart(game: Game, key: string): Promise<{ session: Session; resumed: boolean }> {
  let latest: { id: ID; updatedAt: number } | null = null;
  try {
    const list = await api.listSessions(game.id);
    for (const s of list) if (!latest || (s.updatedAt ?? 0) > latest.updatedAt) latest = { id: s.id, updatedAt: s.updatedAt ?? 0 };
  } catch {
    /* offline / first run — fall through to a new game */
  }
  if (latest) {
    try {
      return { session: await api.getSession(game.id, latest.id), resumed: true };
    } catch {
      /* it was deleted between listing and loading */
    }
  }
  return { session: await startSession(game, key), resumed: false };
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export default function PlayPage() {
  const { gameId = '', sessionId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [history] = useState(() => createTableHistory(emptyTable()));
  const present = useStore(history, (h) => h.present);
  const canUndo = useStore(history, (h) => h.past.length > 0);
  const canRedo = useStore(history, (h) => h.future.length > 0);
  const [ctl, setCtl] = useState<TableController | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [savesOpen, setSavesOpen] = useState(false);
  const [save, setSave] = useState<SaveState>('saved');
  const [muted, setMuted] = useSoundMuted();
  const coach = useSettings((s) => s.settings.tableTips && !s.tipsSeen);
  const showNames = useSettings((s) => s.settings.showNamesPlay);
  const setSettings = useSettings((s) => s.set);
  const newKey = useRef(`${gameId}:${Date.now()}`);
  const newGameRef = useRef<(() => Promise<void>) | null>(null);
  // Additive (setup editor): opened from Table setup's "Test play" → offer the way back.
  const loc = useLocation();
  const returnTo = (loc.state as { returnTo?: string } | null)?.returnTo;
  // Additive (editor "Test play"): `/play?new=1` always starts a fresh game from the current setup.
  const startNew = new URLSearchParams(loc.search).has('new');
  // Additive (setup editor): a session that has never saved a camera opens on the
  // designer's starting view (setup.camera with its view size), framed for this screen.
  const startViewPending = useRef(false);
  const attachCtl = useCallback(
    (c: TableController | null) => {
      setCtl(c);
      const cam = game?.setup?.camera;
      if (c && startViewPending.current && cam?.viewW && cam.viewH && cam.zoom > 0) {
        const w = cam.viewW / cam.zoom;
        const h = cam.viewH / cam.zoom;
        c.fitRect({ x: cam.x - w / 2, y: cam.y - h / 2, w, h }, false, MAX_ZOOM);
      }
      if (c) startViewPending.current = false;
    },
    [game],
  );

  /* ---------------- load game ---------------- */
  useEffect(() => {
    let alive = true;
    setGame(null);
    setError(null);
    api
      .getGame(gameId)
      .then((g) => alive && setGame(g))
      .catch((e) => alive && setError(e instanceof ApiError && e.status === 404 ? 'This game doesn’t exist any more.' : String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [gameId]);

  useEffect(() => {
    if (game) document.title = `${game.name} · pnpforge`;
  }, [game?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- create / load session ---------------- */
  useEffect(() => {
    if (!game || sessionId) return;
    let alive = true;
    (startNew ? startSession(game, newKey.current).then((session) => ({ session, resumed: false })) : resumeOrStart(game, newKey.current))
      .then(({ session: s, resumed }) => {
        if (!alive) return;
        navigate(`/games/${game.id}/play/${s.id}`, { replace: true, state: loc.state });
        if (resumed)
          toast('Picked up where you left off', {
            description: s.name,
            action: { label: 'Start a new game', onClick: () => void newGameRef.current?.() },
            duration: 6000,
          });
      })
      .catch((e) => alive && setError(`Couldn’t start a game: ${e?.message ?? e}`));
    return () => {
      alive = false;
    };
  }, [game, sessionId, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    setSession(null);
    api
      .getSession(gameId, sessionId)
      .then((s) => {
        if (!alive) return;
        const state = normalizeState(s.state);
        cameraRef.current = state.camera ?? null;
        startViewPending.current = !state.camera;
        history.getState().reset(state);
        setSession({ ...s, state });
        setSave('saved');
      })
      .catch((e) => alive && setError(e instanceof ApiError && e.status === 404 ? 'That saved game couldn’t be found.' : String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [gameId, sessionId, history]);

  /* ---------------- autosave ---------------- */
  const cameraRef = useRef<Camera | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const sidRef = useRef<ID | undefined>(undefined);
  sidRef.current = session?.id;

  const payload = useCallback((): TableState => ({ ...history.getState().present, camera: cameraRef.current ?? undefined }), [history]);

  const saveNow = useCallback(async () => {
    window.clearTimeout(timer.current);
    const sid = sidRef.current;
    if (!dirty.current || !sid) return;
    if (saving.current) {
      timer.current = window.setTimeout(() => void saveNow(), 300);
      return;
    }
    dirty.current = false;
    saving.current = true;
    setSave('saving');
    try {
      await api.saveSession(gameId, sid, { state: payload() });
      setSave(dirty.current ? 'pending' : 'saved');
    } catch {
      dirty.current = true;
      setSave('error');
      timer.current = window.setTimeout(() => void saveNow(), 5000);
    } finally {
      saving.current = false;
    }
  }, [gameId, payload]);

  const schedule = useCallback(
    (quiet = false) => {
      dirty.current = true;
      if (!quiet) setSave((s) => (s === 'error' ? s : 'pending'));
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void saveNow(), SAVE_DELAY);
    },
    [saveNow],
  );

  // flush with keepalive when leaving the page / tab
  useEffect(() => {
    const flush = () => {
      const sid = sidRef.current;
      if (!dirty.current || !sid) return;
      dirty.current = false;
      void fetch(`/api/games/${gameId}/sessions/${sid}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: payload() }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.clearTimeout(timer.current);
      flush();
    };
  }, [gameId, session?.id, payload]);

  /* ---------------- table callbacks ---------------- */
  const onCommit = useCallback(
    (next: TableState, meta?: CommitMeta) => {
      history.getState().commit(next, meta);
      schedule();
    },
    [history, schedule],
  );
  const onUndo = useCallback(() => {
    if (history.getState().undo()) schedule();
  }, [history, schedule]);
  const onRedo = useCallback(() => {
    if (history.getState().redo()) schedule();
  }, [history, schedule]);
  const onCameraChange = useCallback(
    (c: Camera) => {
      cameraRef.current = c;
      schedule(true);
    },
    [schedule],
  );

  const onThemeChange = useCallback(
    async (theme: TableTheme) => {
      setGame((g) => (g ? { ...g, table: { ...g.table, theme } } : g));
      try {
        const fresh = await api.getGame(gameId);
        await api.saveGame({ ...fresh, table: { ...fresh.table, theme } });
      } catch (e: any) {
        toast.error('Couldn’t save the table material', { description: e?.message });
      }
    },
    [gameId],
  );

  const restart = useCallback(async () => {
    if (!game) return;
    const ok = await confirm({
      title: 'Restart this game?',
      message: 'Everything goes back to the starting layout, with freshly shuffled decks. You can still undo this.',
      confirmLabel: 'Restart',
      danger: true,
    });
    if (!ok) return;
    const fresh = freshStateFromSetup(game.setup);
    onCommit({ ...fresh, camera: undefined }, { label: 'Restart game' });
    window.setTimeout(() => ctl?.fitAll(true), 30);
    toast('Game restarted', { action: { label: 'Undo', onClick: onUndo } });
  }, [game, onCommit, onUndo, ctl]);

  const newGame = useCallback(async () => {
    if (!game) return;
    await saveNow();
    setSavesOpen(false);
    try {
      const s = await startSession(game, `${game.id}:${Date.now()}`);
      navigate(`/games/${game.id}/play/${s.id}`);
      toast.success('New game started', { description: 'Your previous game is kept under Saved games.' });
    } catch (e: any) {
      toast.error('Couldn’t start a new game', { description: e?.message });
    }
  }, [game, navigate, saveNow]);
  newGameRef.current = newGame;

  const openSession = useCallback(
    async (id: ID) => {
      await saveNow();
      setSavesOpen(false);
      navigate(`/games/${gameId}/play/${id}`);
    },
    [gameId, navigate, saveNow],
  );

  // per device: "Got it" hides the tips here, not on the owner's other devices
  const dismissCoach = () => useSettings.getState().dismissTips();

  /* ---------------- render ---------------- */
  const theme = game?.table?.theme ?? 'felt-green';

  if (error) {
    return (
      <div className="play-page" style={getTableThemeStyle(theme)}>
        <div className="play-center">
          <div className="play-center__card">
            <EmptyState
              icon={TriangleAlert}
              title="Can’t open this game"
              description={error}
              actions={
                <>
                  <Button onClick={() => location.reload()}>Try again</Button>
                  <Link to="/">
                    <Button variant="primary">Back to library</Button>
                  </Link>
                </>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  const ready = !!game && !!session && session.id === sessionId;
  const empty = ready && present.order.length === 0 && present.hand.length === 0;

  const menuItems = (): MenuItem[] => [
    { label: 'Saved games…', icon: FolderOpen, onSelect: () => setSavesOpen(true) },
    { label: 'Start a new game', icon: Plus, hint: 'Keeps this one in Saved games', onSelect: () => void newGame() },
    { label: 'Restart this game…', icon: RotateCcw, danger: true, onSelect: () => void restart() },
    { type: 'separator' },
    {
      label: 'Table material',
      icon: Palette,
      submenu: TABLE_THEMES.map((t) => ({ label: t.label, checked: t.id === theme, onSelect: () => void onThemeChange(t.id) })),
    },
    { label: 'Show names on the table', icon: Tag, checked: showNames, hint: 'Zones, stacks and supplies', shortcut: 'N', onSelect: () => setSettings({ showNamesPlay: !showNames }) },
    { label: muted ? 'Turn sound on' : 'Turn sound off', icon: muted ? Volume2 : VolumeX, onSelect: () => setMuted(!muted) },
    { label: 'Keyboard & gestures', icon: Keyboard, shortcut: '?', onSelect: () => ctl?.ui.setState({ shortcutsOpen: true }) },
    { label: 'Settings…', icon: Settings, onSelect: openSettings },
    { type: 'separator' },
    { label: 'Edit this game', icon: Pencil, onSelect: () => navigate(`/games/${gameId}/edit`) },
    { label: 'Back to library', icon: ArrowLeft, onSelect: () => navigate('/') },
  ];

  return (
    <div className="play-page">
      {ready ? (
        <TableView
          key={session.id}
          game={game}
          state={present}
          mode="play"
          onCommit={onCommit}
          onUndo={onUndo}
          onRedo={onRedo}
          onCameraChange={onCameraChange}
          onThemeChange={(t) => void onThemeChange(t)}
          onResetGame={() => void restart()}
          controllerRef={attachCtl}
        >
          {empty && (
            <div className="play-center">
              <div className="play-center__card">
                <EmptyState
                  icon={LayoutDashboard}
                  title="The table is empty"
                  description="This game has no starting layout yet. Lay out the decks, boards and tokens in Table setup, then come back to play."
                  actions={
                    <Link to={`/games/${gameId}/edit/setup`}>
                      <Button variant="primary">Open table setup</Button>
                    </Link>
                  }
                />
              </div>
            </div>
          )}
          {coach && !empty && (
            <div className="play-coach" data-ui role="note">
              <span className="play-coach__item">
                <Hand size={16} /> <b>Drag</b> the top card to draw
              </span>
              <span className="play-coach__item">
                <FlipHorizontal2 size={16} /> <b>Double-tap</b> to flip
              </span>
              <span className="play-coach__item">
                <MousePointerClick size={16} /> <b>Long-press</b> or <b>right-click</b> for more
              </span>
              {!showNames && (
                <span className="play-coach__item">
                  <Tag size={16} /> <b>Point at</b> or <b>tap</b> a piece for its name
                </span>
              )}
              <Button size="sm" variant="primary" onClick={dismissCoach}>
                Got it
              </Button>
            </div>
          )}
        </TableView>
      ) : (
        <div className="play-table" style={getTableThemeStyle(theme)}>
          <div className="play-center">
            <div className="play-loading">
              <Spinner size={16} /> {game ? (sessionId ? 'Laying out the table…' : 'Shuffling the decks…') : 'Opening the box…'}
            </div>
          </div>
        </div>
      )}

      <header className="play-bar" data-ui>
        <div className="play-bar__group">
          {returnTo ? (
            <IconButton icon={ArrowLeft} label={returnTo.endsWith('/setup') ? 'Back to table setup' : 'Back to the editor'} tooltipPlacement="bottom" onClick={() => navigate(returnTo)} />
          ) : (
            <IconButton icon={ArrowLeft} label="Back to library" tooltipPlacement="bottom" onClick={() => navigate('/')} />
          )}
          <div className="play-bar__title" title={game?.name}>
            {game?.name ?? ' '}
          </div>
          <span className={`play-save is-${save}`} role="status" aria-live="polite">
            <span className="play-save__dot" />
            <span className="play-save__text">{save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved — retrying' : 'Saving…'}</span>
          </span>
        </div>
        <div className="play-bar__spacer" />
        <div className="play-bar__group">
          <IconButton icon={Undo2} label="Undo" shortcut="Ctrl+Z" tooltipPlacement="bottom" disabled={!canUndo} onClick={onUndo} />
          <IconButton icon={Redo2} label="Redo" shortcut="Ctrl+Shift+Z" tooltipPlacement="bottom" disabled={!canRedo} onClick={onRedo} />
          <span className="play-bar__sep" />
          <IconButton icon={BookOpen} label="Rules" tooltipPlacement="bottom" active={rulesOpen} disabled={!game} onClick={() => setRulesOpen((o) => !o)} />
          <IconButton icon={muted ? VolumeX : Volume2} label={muted ? 'Sound off' : 'Sound on'} tooltipPlacement="bottom" onClick={() => setMuted(!muted)} />
          <MenuButton items={menuItems} minWidth={240}>
            <IconButton icon={Ellipsis} label="More" tooltipPlacement="bottom" />
          </MenuButton>
        </div>
      </header>

      {game && <RulesPanel game={game} open={rulesOpen} onClose={() => setRulesOpen(false)} />}
      <SessionsDialog gameId={gameId} currentId={session?.id} open={savesOpen} onClose={() => setSavesOpen(false)} onOpen={(id) => void openSession(id)} onNew={() => void newGame()} />
    </div>
  );
}
