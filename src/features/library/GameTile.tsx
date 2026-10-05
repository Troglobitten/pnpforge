import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ChevronDown,
  Clock,
  Copy,
  Download,
  History,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { api, assetUrl } from '@/api/client';
import type { GameSummary, SessionSummary } from '@/shared/types';
import { Button, IconButton, Menu, toast, type MenuItem } from '@/ui';
import { GameCover } from './CoverArt';
import { downloadUrl, plural, relativeTime } from './util';

interface Props {
  game: GameSummary;
  highlighted?: boolean;
  onDuplicate: (g: GameSummary) => void;
  onDelete: (g: GameSummary) => void;
}

type MenuState = { x?: number; y?: number; anchor?: DOMRect; kind: 'more' | 'play' } | null;

const LONG_PRESS_MS = 450;

export function GameTile({ game, highlighted, onDuplicate, onDelete }: Props) {
  const navigate = useNavigate();
  const [menu, setMenu] = useState<MenuState>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pressing, setPressing] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const draft = game.componentCount === 0;
  const hasSessions = game.sessionCount > 0;
  const cover = game.coverFile ? assetUrl(game.id, game.coverFile) : null;

  const loadSessions = useCallback(async () => {
    const list = await api.listSessions(game.id);
    setSessions(list);
    return list;
  }, [game.id]);

  const play = async () => {
    if (!hasSessions) {
      navigate(`/games/${game.id}/play`);
      return;
    }
    setBusy(true);
    try {
      const list = sessions ?? (await loadSessions());
      navigate(list[0] ? `/games/${game.id}/play/${list[0].id}` : `/games/${game.id}/play`);
    } catch {
      navigate(`/games/${game.id}/play`);
    } finally {
      setBusy(false);
    }
  };
  const edit = () => navigate(`/games/${game.id}/edit`);
  const primary = draft ? edit : play;

  const exportGame = (withSessions: boolean) => {
    downloadUrl(api.exportUrl(game.id, withSessions));
    toast.success('Export started', {
      description: `“${game.name}” is downloading as a .pnpforge file${withSessions ? ' with its saved games' : ''}.`,
    });
  };

  const moreItems = (): MenuItem[] => [
    { label: 'Edit game', icon: Pencil, onSelect: edit },
    { label: hasSessions ? 'Start a new game' : 'Play', icon: hasSessions ? RotateCcw : Play, onSelect: () => navigate(`/games/${game.id}/play`) },
    { type: 'separator' },
    { label: 'Duplicate', icon: Copy, onSelect: () => onDuplicate(game) },
    {
      label: 'Export',
      icon: Download,
      submenu: [
        { label: 'Game only', hint: 'Components, setup and rules', onSelect: () => exportGame(false) },
        {
          label: 'Game + saved games',
          hint: hasSessions ? plural(game.sessionCount, 'saved game') : 'No saved games yet',
          disabled: !hasSessions,
          onSelect: () => exportGame(true),
        },
      ],
    },
    { type: 'separator' },
    { label: 'Delete…', icon: Trash2, danger: true, onSelect: () => onDelete(game) },
  ];

  const playItems = (): MenuItem[] => {
    const list = sessions ?? [];
    const items: MenuItem[] = [
      {
        label: 'Continue last game',
        icon: History,
        hint: list[0] ? `${list[0].name} · ${relativeTime(list[0].updatedAt)}` : undefined,
        onSelect: () => navigate(list[0] ? `/games/${game.id}/play/${list[0].id}` : `/games/${game.id}/play`),
      },
      { label: 'Start a new game', icon: RotateCcw, hint: 'Fresh table from the setup', onSelect: () => navigate(`/games/${game.id}/play`) },
    ];
    if (list.length > 1) {
      items.push({ type: 'separator' }, { type: 'label', label: 'Saved games' });
      for (const s of list.slice(1, 7)) {
        items.push({
          label: s.name,
          hint: relativeTime(s.updatedAt),
          onSelect: () => navigate(`/games/${game.id}/play/${s.id}`),
        });
      }
    }
    return items;
  };

  const openPlayMenu = async () => {
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    try {
      if (!sessions) await loadSessions();
    } catch {
      /* the menu still offers a fresh game */
    }
    setMenu({ kind: 'play', anchor: rect });
  };

  /* ---- context menu: right-click and touch long-press ---- */
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
    setPressing(false);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    if ((e.target as HTMLElement).closest('button:not(.lib-tile__cover)')) return;
    const x = e.clientX;
    const y = e.clientY;
    setPressing(true);
    press.current = {
      x,
      y,
      fired: false,
      timer: window.setTimeout(() => {
        if (!press.current) return;
        press.current.fired = true;
        setPressing(false);
        navigator.vibrate?.(8);
        setMenu({ kind: 'more', x, y });
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress();
  };
  const onPointerUp = () => {
    const fired = press.current?.fired;
    if (press.current) window.clearTimeout(press.current.timer);
    setPressing(false);
    // keep `fired` until the click that follows so it can be swallowed
    if (!fired) press.current = null;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (press.current?.fired) {
      e.preventDefault();
      e.stopPropagation();
      press.current = null;
    }
  };

  return (
    <article
      className={`lib-tile ${highlighted ? 'is-highlighted' : ''} ${pressing ? 'is-pressing' : ''}`}
      data-game-id={game.id}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input, textarea')) return;
        e.preventDefault();
        cancelPress();
        if (!menu) setMenu({ kind: 'more', x: e.clientX, y: e.clientY });
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelPress}
      onClickCapture={onClickCapture}
    >
      <button
        type="button"
        className="lib-tile__cover"
        onClick={primary}
        aria-label={draft ? `Set up ${game.name}` : hasSessions ? `Continue ${game.name}` : `Play ${game.name}`}
      >
        <GameCover src={cover} name={game.name} className="lib-tile__img" />
        <span className="lib-tile__sheen" aria-hidden />
        {draft ? (
          <span className="lib-tile__flag lib-tile__flag--draft">Draft</span>
        ) : hasSessions ? (
          <span className="lib-tile__flag">
            <History size={12} strokeWidth={2.4} /> In progress
          </span>
        ) : null}
        <span className="lib-tile__hover" aria-hidden>
          <span className="lib-tile__hover-btn">
            {draft ? <Pencil size={18} /> : <Play size={20} fill="currentColor" />}
          </span>
        </span>
      </button>

      <div className="lib-tile__body">
        <h3 className="lib-tile__name display" title={game.name}>
          {game.name}
        </h3>
        <div className="lib-tile__by">
          {game.designer ? <span>by {game.designer}</span> : <span className="lib-tile__faint">No designer set</span>}
          {game.playTime && (
            <>
              <span className="lib-tile__dot" aria-hidden>
                ·
              </span>
              <span>{game.playTime}</span>
            </>
          )}
        </div>
        <div className="lib-tile__meta">
          {draft ? (
            <span>No pieces yet</span>
          ) : (
            <>
              <span>{plural(game.cardCount, 'card')}</span>
              <span className="lib-tile__dot" aria-hidden>
                ·
              </span>
              <span>{plural(game.componentCount, 'component')}</span>
            </>
          )}
        </div>
        <div className="lib-tile__meta lib-tile__when">
          <Clock size={12} aria-hidden />
          <span>
            {game.lastPlayedAt
              ? `Played ${relativeTime(game.lastPlayedAt)}`
              : draft
                ? `Edited ${relativeTime(game.updatedAt)}`
                : 'Not played yet'}
          </span>
        </div>

        <div className="lib-tile__actions">
          {draft ? (
            <>
              <Button variant="primary" icon={Pencil} onClick={edit} className="lib-tile__main">
                Set up
              </Button>
              <Button variant="secondary" icon={Play} onClick={play} className="lib-tile__second" aria-label={`Play ${game.name}`}>
                Play
              </Button>
            </>
          ) : hasSessions ? (
            <>
              <div className="lib-split lib-tile__main" ref={splitRef}>
                <Button variant="primary" icon={Play} onClick={play} loading={busy} className="lib-split__main">
                  Continue
                </Button>
                <button
                  type="button"
                  className="ui-btn ui-btn--primary lib-split__more"
                  aria-label="More ways to play"
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (menu?.kind === 'play') setMenu(null);
                    else void openPlayMenu();
                  }}
                >
                  <ChevronDown size={16} />
                </button>
              </div>
              <Button variant="secondary" icon={Pencil} onClick={edit} className="lib-tile__second" aria-label={`Edit ${game.name}`}>
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" icon={Play} onClick={play} className="lib-tile__main">
                Play
              </Button>
              <Button variant="secondary" icon={Pencil} onClick={edit} className="lib-tile__second" aria-label={`Edit ${game.name}`}>
                Edit
              </Button>
            </>
          )}
          <span ref={moreRef} className="lib-tile__more">
            <IconButton
              icon={MoreHorizontal}
              label="More actions"
              variant="ghost"
              onClick={(e) => {
                e.stopPropagation();
                if (menu?.kind === 'more') setMenu(null);
                else setMenu({ kind: 'more', anchor: moreRef.current!.getBoundingClientRect() });
              }}
            />
          </span>
        </div>
      </div>

      {menu && (
        <Menu
          items={menu.kind === 'play' ? playItems() : moreItems()}
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          placement={menu.kind === 'play' ? 'bottom-start' : 'bottom-end'}
          minWidth={menu.kind === 'play' ? 240 : 210}
          onClose={() => setMenu(null)}
        />
      )}
    </article>
  );
}

export function GameTileSkeleton() {
  return (
    <div className="lib-tile lib-tile--skeleton" aria-hidden>
      <div className="lib-tile__cover lib-skel" />
      <div className="lib-tile__body">
        <div className="lib-skel lib-skel--line" style={{ width: '62%', height: 18 }} />
        <div className="lib-skel lib-skel--line" style={{ width: '40%' }} />
        <div className="lib-skel lib-skel--line" style={{ width: '75%' }} />
        <div className="lib-tile__actions">
          <div className="lib-skel lib-skel--btn" style={{ flex: 1 }} />
          <div className="lib-skel lib-skel--btn" style={{ width: 72 }} />
        </div>
      </div>
    </div>
  );
}

export function PendingTile({ label, name, progress }: { label: string; name: string; progress: number | null }) {
  return (
    <div className="lib-tile lib-tile--pending" aria-live="polite">
      <div className="lib-tile__cover lib-skel lib-pending__cover">
        <span className="lib-pending__label">{label}</span>
      </div>
      <div className="lib-tile__body">
        <h3 className="lib-tile__name display">{name}</h3>
        <div className="lib-pending__bar">
          <div className="ui-progress">
            <div
              className="ui-progress__bar"
              style={progress == null ? { width: '35%' } : { width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
