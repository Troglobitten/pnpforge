import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import {
  BookOpen,
  Check,
  ChevronLeft,
  CloudOff,
  FileText,
  LayoutDashboard,
  LayoutGrid,
  Pencil,
  Play,
  Redo2,
  RefreshCw,
  SearchX,
  Settings,
  Shapes,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { assetUrlById } from '@/api/client';
import type { Game } from '@/shared/types';
import { useGame } from '@/state/gameStore';
import { useEditorChrome } from '@/state/editorChrome';
import { Button, Dialog, EmptyState, IconButton, Spinner, Tooltip, toast } from '@/ui';
import { GameCover } from '@/features/library/CoverArt';
import { isTypingTarget, relativeTime } from '@/features/library/util';
import { getChecklist } from './checklist';
import { useSessions } from './sessions';
import { openSettings } from '@/features/settings/SettingsDialog';
import './editor.css';

export default function EditorShell() {
  const { gameId } = useParams();
  const game = useGame((s) => s.game);
  const status = useGame((s) => s.status);
  const error = useGame((s) => s.error);
  const load = useGame((s) => s.load);

  useEffect(() => {
    if (gameId) void load(gameId);
  }, [gameId, load]);

  // Flush pending edits whenever the editor is left.
  useEffect(
    () => () => {
      void useGame.getState().flush();
    },
    [],
  );

  const name = game?.id === gameId ? game?.name : undefined;
  useEffect(() => {
    if (name) document.title = `${name} · pnpforge`;
  }, [name]);

  useUndoShortcuts();
  useSaveFailureAlert();
  useUnloadGuard();
  const retry = useReloadRetry(gameId, load);
  const compactNav = useEditorChrome((s) => s.compactNav);

  const broken = !game || game.id !== gameId;
  if ((status === 'error' || retry.busy) && broken) {
    return <EditorLoadError error={error} busy={retry.busy} checkedAt={retry.checkedAt} onRetry={retry.run} />;
  }

  if (broken) return <EditorSkeleton />;

  return (
    <div className={`ed ${compactNav ? 'is-compact-nav' : ''}`}>
      <TopBar game={game} />
      <div className="ed-body">
        <SideNav game={game} />
        <main className="ed-main" id="editor-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Not found / couldn't load                                            */
/* ------------------------------------------------------------------ */

/**
 * Retry state lives above the error page: `load()` flips the store to
 * "loading", which would otherwise unmount the page mid-retry and throw the
 * feedback away.
 */
function useReloadRetry(gameId: string | undefined, load: (id: string) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    setCheckedAt(null);
  }, [gameId]);

  const run = async () => {
    if (!gameId || busy) return;
    setBusy(true);
    const started = Date.now();
    try {
      await load(gameId);
    } catch {
      /* the store records the failure */
    }
    // let the spinner be seen even when the server answers instantly
    await new Promise((r) => window.setTimeout(r, Math.max(0, 500 - (Date.now() - started))));
    const st = useGame.getState();
    setBusy(false);
    if (st.status !== 'error' && st.game?.id === gameId) {
      toast.success('Found it — opening the game');
      return;
    }
    setCheckedAt(Date.now());
    if (!st.error || /not found/i.test(st.error)) {
      toast.warning('Still not on your shelf', {
        description: `The server has no game with the id “${gameId}”. It was most likely deleted.`,
      });
    } else {
      toast.error('Still couldn’t open this game', { description: st.error });
    }
  };

  return { busy, checkedAt, run };
}

function EditorLoadError({
  error,
  busy,
  checkedAt,
  onRetry,
}: {
  error: string | null;
  busy: boolean;
  checkedAt: number | null;
  onRetry: () => void;
}) {
  const missing = !error || /not found/i.test(error);
  const retrying = busy;

  return (
    <div className="ed-full">
      <EmptyState
        icon={missing ? SearchX : TriangleAlert}
        title={missing ? 'This game isn’t on your shelf' : 'We couldn’t open this game'}
        description={
          <>
            {missing
              ? 'It may have been deleted, or the link is out of date.'
              : 'Check that the pnpforge server is running, then try again.'}
            {!missing && <span className="ed-error-detail">{error}</span>}
            <span className="ed-error-detail" role="status">
              {retrying
                ? 'Checking the server…'
                : checkedAt
                  ? `Checked ${relativeTime(checkedAt)} — still no luck.`
                  : ''}
            </span>
          </>
        }
        actions={
          <>
            <Button icon={RefreshCw} loading={retrying} onClick={onRetry}>
              Try again
            </Button>
            <Link to="/">
              <Button variant="primary" icon={ChevronLeft}>
                Back to library
              </Button>
            </Link>
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Unsaved-work safety net                                              */
/* ------------------------------------------------------------------ */

/** Announce the first failed save loudly — the chip alone is too quiet. */
function useSaveFailureAlert() {
  const saveState = useGame((s) => s.saveState);
  const announced = useRef(false);
  useEffect(() => {
    if (saveState === 'error') {
      if (announced.current) return;
      announced.current = true;
      toast.error('Couldn’t save your changes', {
        description: 'The pnpforge server didn’t accept the last edit. Your work is still here — retry, or it stays unsaved.',
        duration: 12_000,
        action: { label: 'Retry now', onClick: () => void useGame.getState().flush() },
      });
    } else if (saveState === 'saved') {
      announced.current = false;
    }
  }, [saveState]);
}

/** Stop a reload / tab close from throwing away work that hasn't landed. */
function useUnloadGuard() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useGame.getState().saveState;
      if (s === 'error' || s === 'dirty' || s === 'saving') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}

/* ------------------------------------------------------------------ */
/* Keyboard undo / redo                                                 */
/* ------------------------------------------------------------------ */

function useUndoShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (useEditorChrome.getState().ownsHistory) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey);
      if (!undo && !redo) return;
      // Let text fields keep their native undo.
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('.ui-dialog-backdrop')) return;
      e.preventDefault();
      const s = useGame.getState();
      if (undo) {
        const entry = s.past[s.past.length - 1];
        if (!entry) return;
        s.undo();
        toast(`Undone: ${entry.label}`, { duration: 1600 });
      } else {
        const entry = s.future[0];
        if (!entry) return;
        s.redo();
        toast(`Redone: ${entry.label}`, { duration: 1600 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/* ------------------------------------------------------------------ */
/* Top bar                                                              */
/* ------------------------------------------------------------------ */

function TopBar({ game }: { game: Game }) {
  const navigate = useNavigate();
  const past = useGame((s) => s.past);
  const future = useGame((s) => s.future);
  const undo = useGame((s) => s.undo);
  const redo = useGame((s) => s.redo);
  const ownsHistory = useEditorChrome((s) => s.ownsHistory);
  const [leaving, setLeaving] = useState<'library' | 'play' | null>(null);
  const [blocked, setBlocked] = useState<{ to: string; kind: 'library' | 'play' } | null>(null);

  const leave = async (to: string, kind: 'library' | 'play') => {
    setLeaving(kind);
    try {
      await useGame.getState().flush();
    } finally {
      setLeaving(null);
    }
    // Never walk away from an edit the server refused — ask first, on every exit.
    if (useGame.getState().saveState === 'error') {
      setBlocked({ to, kind });
      return;
    }
    // Test play (`/play?new=1`) always starts a fresh game from the current setup, with a way back here.
    navigate(to, kind === 'play' ? { state: { returnTo: window.location.pathname } } : undefined);
  };

  const cover = assetUrlById(game, game.cover);
  const lastUndo = past[past.length - 1]?.label;
  const nextRedo = future[0]?.label;

  return (
    <header className="ed-top">
      <Tooltip label="Back to library" placement="bottom">
        <button type="button" className="ed-back" onClick={() => void leave('/', 'library')} aria-label="Back to library">
          {leaving === 'library' ? <Spinner size={16} /> : <ChevronLeft size={18} />}
          <span className="ed-back__label">Library</span>
        </button>
      </Tooltip>
      <span className="ed-top__sep" aria-hidden />
      <div className="ed-top__cover" aria-hidden>
        <GameCover src={cover} name={game.name} className="ed-top__cover-img" />
      </div>
      <GameNameEditor game={game} />
      {/* a tool with its own undo and save indicator (the Cutter) shows the only ones */}
      {!ownsHistory && <SaveStatus />}
      <div className="ed-top__spacer" />
      {!ownsHistory && (
      <div className="ed-top__history">
        <IconButton
          icon={Undo2}
          label={lastUndo ? `Undo “${lastUndo}”` : 'Nothing to undo'}
          shortcut="Ctrl+Z"
          tooltipPlacement="bottom"
          disabled={!past.length}
          onClick={undo}
        />
        <IconButton
          icon={Redo2}
          label={nextRedo ? `Redo “${nextRedo}”` : 'Nothing to redo'}
          shortcut="Ctrl+Shift+Z"
          tooltipPlacement="bottom"
          disabled={!future.length}
          onClick={redo}
        />
      </div>
      )}
      <IconButton icon={Settings} label="Settings" tooltipPlacement="bottom" className="ed-top__settings" onClick={openSettings} />
      <Tooltip label="Try the game on the table" placement="bottom">
        <Button variant="primary" icon={Play} loading={leaving === 'play'} onClick={() => void leave(`/games/${game.id}/play?new=1`, 'play')}>
          <span className="ed-hide-narrow">Test play</span>
          <span className="ed-show-narrow">Play</span>
        </Button>
      </Tooltip>

      <UnsavedLeaveDialog
        game={game}
        pending={blocked}
        onStay={() => setBlocked(null)}
        onGo={(to, discarded) => {
          setBlocked(null);
          if (discarded) {
            toast.warning(`“${game.name}” has changes that never saved`, {
              description: 'The server refused the last edit, so it was left behind.',
              duration: 8000,
            });
          }
          navigate(to);
        }}
      />
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Leaving with a failed save                                           */
/* ------------------------------------------------------------------ */

function UnsavedLeaveDialog({
  game,
  pending,
  onStay,
  onGo,
}: {
  game: Game;
  pending: { to: string; kind: 'library' | 'play' } | null;
  onStay: () => void;
  onGo: (to: string, discarded: boolean) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);

  useEffect(() => {
    if (pending) setFailedAgain(false);
  }, [pending]);

  if (!pending) return null;

  const retry = async () => {
    setRetrying(true);
    const started = Date.now();
    await useGame.getState().flush();
    await new Promise((r) => window.setTimeout(r, Math.max(0, 400 - (Date.now() - started))));
    setRetrying(false);
    if (useGame.getState().saveState === 'error') {
      setFailedAgain(true);
      return;
    }
    toast.success('Saved — off we go');
    onGo(pending.to, false);
  };

  return (
    <Dialog
      open
      onClose={onStay}
      dismissable={false}
      size="md"
      className="ed-leave"
      title="Your last changes couldn’t be saved"
      description={`“${game.name}” has an edit the server rejected. Leaving now for ${pending.kind === 'play' ? 'the table' : 'the library'} would lose it.`}
      footer={
        <>
          <Button variant="ghost" onClick={onStay} disabled={retrying}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={() => onGo(pending.to, true)} disabled={retrying}>
            Leave without saving
          </Button>
          <Button variant="primary" icon={RefreshCw} loading={retrying} onClick={() => void retry()}>
            Try saving again
          </Button>
        </>
      }
    >
      <p className="ed-leave__body">
        {failedAgain
          ? 'That didn’t work either. Check that the pnpforge server is running — your changes are safe in this tab until you leave.'
          : 'Retrying keeps your work. Leaving without saving throws that edit away — everything saved before it is fine.'}
      </p>
    </Dialog>
  );
}

function GameNameEditor({ game }: { game: Game }) {
  const update = useGame((s) => s.update);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(game.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(game.name);
  }, [game.name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v && v !== game.name) update((g) => void (g.name = v), 'Rename game');
    else setDraft(game.name);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="ed-name ed-name--input display"
        value={draft}
        aria-label="Game name"
        maxLength={120}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            setDraft(game.name);
            setEditing(false);
          }
        }}
        style={{ width: `${Math.max(8, Math.min(40, draft.length + 2))}ch` }}
      />
    );
  }
  return (
    <Tooltip label="Rename" placement="bottom">
      <button type="button" className="ed-name display" onClick={() => setEditing(true)} aria-label={`Rename ${game.name}`}>
        <span className="ed-name__text">{game.name}</span>
        <Pencil size={13} className="ed-name__pencil" aria-hidden />
      </button>
    </Tooltip>
  );
}

function SaveStatus() {
  const saveState = useGame((s) => s.saveState);
  const lastSavedAt = useGame((s) => s.lastSavedAt);
  const flush = useGame((s) => s.flush);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  if (saveState === 'error') {
    return (
      <span className="ed-save is-error" role="status">
        <CloudOff size={14} />
        <span className="ed-save__text">Couldn’t save</span>
        <button type="button" className="ed-save__retry" onClick={() => void flush()}>
          Retry
        </button>
      </span>
    );
  }
  if (saveState === 'saving') {
    return (
      <span className="ed-save is-saving" role="status">
        <Spinner size={13} />
        <span className="ed-save__text">Saving…</span>
      </span>
    );
  }
  if (saveState === 'dirty') {
    return (
      <span className="ed-save is-dirty" role="status">
        <span className="ed-save__dot" />
        <span className="ed-save__text">Unsaved</span>
      </span>
    );
  }
  return (
    <Tooltip label={lastSavedAt ? `All changes saved · ${relativeTime(lastSavedAt)}` : 'All changes saved'} placement="bottom">
      <span className="ed-save is-saved" role="status" tabIndex={0}>
        <Check size={14} strokeWidth={2.6} />
        <span className="ed-save__text">Saved</span>
      </span>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Side navigation                                                      */
/* ------------------------------------------------------------------ */

interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: LucideIcon;
  count?: number;
  dot?: boolean;
}

function SideNav({ game }: { game: Game }) {
  const sessions = useSessions(game.id);
  const base = `/games/${game.id}/edit`;
  const entityCount = Object.keys(game.setup.entities).length;
  const items: NavItem[] = [
    { to: `${base}/overview`, label: 'Overview', short: 'Overview', icon: LayoutDashboard },
    { to: `${base}/sources`, label: 'Sources', short: 'Sources', icon: FileText, count: game.sources.length },
    { to: `${base}/components`, label: 'Components', short: 'Pieces', icon: Shapes, count: game.components.length },
    { to: `${base}/setup`, label: 'Table setup', short: 'Table', icon: LayoutGrid, count: entityCount },
    { to: `${base}/rules`, label: 'Rules', short: 'Rules', icon: BookOpen, dot: !!(game.rules.sourceId || game.rules.notes.trim()) },
  ];
  const { next, doneCount, total } = getChecklist(game, sessions?.length);

  return (
    <nav className="ed-nav" aria-label="Game editor">
      <ul className="ed-nav__list">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <li key={it.to}>
              <NavLink to={it.to} className={({ isActive }) => `ed-nav__item ${isActive ? 'is-active' : ''}`}>
                <span className="ed-nav__icon">
                  <Icon size={18} strokeWidth={1.9} />
                  {(it.count ?? 0) > 0 && <span className="ed-nav__pip">{it.count! > 99 ? '99+' : it.count}</span>}
                  {it.dot && <span className="ed-nav__pip ed-nav__pip--dot" />}
                </span>
                <span className="ed-nav__label">{it.label}</span>
                <span className="ed-nav__short">{it.short}</span>
                {it.count != null && <span className="ed-nav__count">{it.count || ''}</span>}
                {it.dot && (
                  <span className="ed-nav__count">
                    <Check size={13} strokeWidth={2.6} />
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>

      {sessions !== undefined && (
        <Link
          to={next ? next.to : `${base}/overview`}
          className={`ed-progress ${next ? '' : 'is-complete'}`}
          aria-label={next ? `Getting started: ${doneCount} of ${total} done. Next: ${next.title}` : 'Getting started: every step is done'}
          title={next ? `Getting started · ${doneCount}/${total} · Next: ${next.title}` : 'Ready to play'}
        >
          <span className="ed-progress__ring">
            <ProgressRing value={doneCount / total} />
            {/* In the icon rail the label is hidden, so the ring shows the
                fraction itself instead of reading as a stuck spinner. */}
            {next && (
              <span className="ed-progress__frac" aria-hidden>
                {doneCount}/{total}
              </span>
            )}
          </span>
          <span className="ed-progress__text">
            <span className="ed-progress__title">{next ? 'Getting started' : 'Ready to play'}</span>
            <span className="ed-progress__next">{next ? `Next: ${next.title}` : 'Every step is done'}</span>
          </span>
        </Link>
      )}
      {sessions === undefined && (
        <span className="ed-progress ed-progress--skel" aria-hidden>
          <span className="ed-skel" style={{ width: 34, height: 34, borderRadius: '50%' }} />
        </span>
      )}
    </nav>
  );
}

export function ProgressRing({ value, size = 34 }: { value: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ed-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-4)" strokeWidth="3" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${c * Math.max(0.001, value)} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 400ms var(--ease-out)' }}
      />
      {value >= 1 && <path d={`M${size / 2 - 5} ${size / 2} l3.5 3.5 l6.5 -7`} stroke="var(--accent)" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Loading skeleton                                                     */
/* ------------------------------------------------------------------ */

function EditorSkeleton() {
  return (
    <div className="ed" aria-busy="true">
      <header className="ed-top">
        <Link to="/" className="ed-back" aria-label="Back to library">
          <ChevronLeft size={18} />
          <span className="ed-back__label">Library</span>
        </Link>
        <span className="ed-top__sep" aria-hidden />
        <span className="ed-skel" style={{ width: 34, height: 34, borderRadius: 8 }} />
        <span className="ed-skel" style={{ width: 180, height: 16 }} />
      </header>
      <div className="ed-body">
        <nav className="ed-nav">
          <ul className="ed-nav__list">
            {Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="ed-nav__item ed-nav__item--skel">
                <span className="ed-skel" style={{ width: 20, height: 20, borderRadius: 6 }} />
                <span className="ed-skel ed-nav__label" style={{ width: 90 + ((i * 23) % 40), height: 12 }} />
              </li>
            ))}
          </ul>
        </nav>
        <main className="ed-main ed-main--loading">
          <Spinner size={22} />
        </main>
      </div>
    </div>
  );
}
