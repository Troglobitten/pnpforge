/**
 * /games/:gameId/edit/setup — the starting table every new play session is built from.
 *
 * Reuses the play engine: <TableView mode="setup"> renders and manipulates `game.setup`,
 * this page adds the palette, the inspector, warnings, the starting view and a few
 * setup-only tools. All edits go through the editor store (undo + autosave).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { castDraft } from 'immer';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  SquareDashedMousePointer,
  Camera,
  Copy,
  Crosshair,
  LayoutDashboard,
  LayoutGrid,
  Magnet,
  Tag,
  PanelLeft,
  Shapes,
  SlidersHorizontal,
  SquareDashed,
  StickyNote,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
} from 'lucide-react';
import type { Entity, Game, ID, TableState } from '@/shared/types';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settings';
import { Button, EmptyState, IconButton, MenuButton, toast, type MenuItem } from '@/ui';
import { MAX_ZOOM, ops, reflowZones, stateBounds, worldAABB, type Rect, type Vec } from '@/features/play/engine';
import { TableView } from '@/features/play/table/TableView';
import type { CommitMeta, TableController } from '@/features/play/table/controller';
import { Palette, type PaletteItem } from './Palette';
import { Inspector, type SetupActions } from './Inspector';
import { DrawLayer, ResizeHandles, StartViewFrame } from './overlays';
import {
  alignEntities,
  arrangeUnplaced,
  defaultZoneSize,
  distributeEntities,
  duplicateEntities,
  entityFromComponent,
  newZone,
  newZoneOf,
  placeable,
  sendToBack,
  snapMoved,
  stackFace,
  stepOrder,
} from './lib/place';
import { findFreeSpot } from './lib/spot';
import { analyzeSetup, isStartCamera, startViewRect, type SetupWarning } from './lib/warnings';
import './setup.css';

const GRID = 5;
type Size = 'wide' | 'medium' | 'narrow';

/** Same test the table controller uses, so we agree on who owns a keystroke. */
function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

export default function SetupPage() {
  const game = useGame((s) => s.game);
  if (!game) return null; // the editor shell only renders us once the game is loaded
  return <SetupEditor key={game.id} game={game} />;
}

function SetupEditor({ game }: { game: Game }) {
  const update = useGame((s) => s.update);
  const navigate = useNavigate();
  const setup = game.setup;
  // The table only needs to re-read the game when its pieces' definitions change —
  // not on every setup edit (which arrives through `state`).
  const tableGame = useMemo(() => game, [game.components, game.assets, game.table]); // eslint-disable-line react-hooks/exhaustive-deps

  const rootRef = useRef<HTMLDivElement>(null);
  // null until measured: the table must attach (and fit the camera) in its final layout
  const [sizeState, setSize] = useState<Size | null>(null);
  const size: Size = sizeState ?? 'wide';
  const [ctl, setCtl] = useState<TableController | null>(null);
  const ctlRef = useRef<TableController | null>(null);
  ctlRef.current = ctl;
  const [sel, setSel] = useState<ID[]>([]);
  const [tool, setTool] = useState<null | 'zone' | 'select'>(null);
  const snap = useSettings((s) => s.settings.snapToGrid);
  const showNames = useSettings((s) => s.settings.showNamesSetup);
  const setSettings = useSettings((s) => s.set);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const warnings = useMemo(() => analyzeSetup(game, setup), [game.components, setup]); // eslint-disable-line react-hooks/exhaustive-deps
  const problems = warnings.filter((w) => w.level !== 'info').length;

  /* ---------------- layout size ---------------- */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const classify = (w: number): Size => (w >= 1080 ? 'wide' : w >= 880 ? 'medium' : 'narrow');
    setSize(classify(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setSize(classify(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------------- committing ---------------- */
  const onCommit = useCallback(
    (next: TableState, meta?: CommitMeta) => {
      const prev = useGame.getState().game?.setup;
      let out = next;
      if (snapRef.current && prev && meta?.label === 'Move') out = snapMoved(game, prev, next, GRID);
      // snapping may nudge a pooled piece off its slot: pool zones stay laid out
      if (out !== next) out = reflowZones(game, out).state;
      update((g) => void (g.setup = castDraft(out)), meta?.label ?? 'Edit table', meta?.coalesceKey ? { coalesceKey: meta.coalesceKey } : undefined);
    },
    [update, game],
  );

  const commit = useCallback(
    (next: TableState, label: string, coalesceKey?: string, uiPatch?: Parameters<TableController['commit']>[2]) => {
      const c = ctlRef.current;
      if (c) {
        c.commit(next, { label, coalesceKey }, uiPatch);
        // the controller re-derives the selection on commit; apply ours afterwards
        if (uiPatch?.selection) c.ui.setState({ selection: uiPatch.selection });
      } else update((g) => void (g.setup = castDraft(next)), label, coalesceKey ? { coalesceKey } : undefined);
    },
    [update],
  );

  /* ---------------- undo: exactly once ---------------- */
  const onUndo = useCallback(() => {
    const s = useGame.getState();
    const entry = s.past[s.past.length - 1];
    if (!entry) return;
    s.undo();
    toast(`Undone: ${entry.label}`, { duration: 1600 });
  }, []);
  const onRedo = useCallback(() => {
    const s = useGame.getState();
    const entry = s.future[0];
    if (!entry) return;
    s.redo();
    toast(`Redone: ${entry.label}`, { duration: 1600 });
  }, []);
  useEffect(() => {
    // The table's own Ctrl+Z handler calls onUndo. Mark the event handled first (capture
    // phase) so the editor shell's global shortcut skips it — otherwise it would undo twice.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      if (isTypingTarget(e.target) || document.querySelector('.ui-dialog-backdrop')) return;
      const ui = ctlRef.current?.ui.getState();
      if (!ui || ui.menu || ui.browse || ui.shortcutsOpen) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* ---------------- actions ---------------- */
  const selectedOrHovered = () => {
    const c = ctlRef.current;
    if (!c) return [];
    return Object.keys(c.ui.getState().selection).filter((id) => c.state.entities[id]);
  };

  const showIds = useCallback(
    (ids: ID[]) => {
      const c = ctlRef.current;
      if (!c) return;
      const live = ids.filter((id) => c.state.entities[id]);
      c.select(live.filter((id) => !c.isFixed(c.state.entities[id])));
      const b = stateBounds(game, c.state, live);
      if (b) c.fitRect({ x: b.x - 20, y: b.y - 20, w: b.w + 40, h: b.h + 40 }, true, 4);
      if (size !== 'wide') setInspOpen(false);
    },
    [game, size],
  );

  const remove = useCallback((ids: ID[]) => ctlRef.current?.deleteEntities(ids), []);

  const duplicate = useCallback(
    (ids: ID[]) => {
      const c = ctlRef.current;
      if (!c) return;
      const r = duplicateEntities(c.state, ids);
      if (!r.ids.length) {
        toast('Decks can’t be duplicated', { description: 'Their cards would be dealt twice. Split the deck instead.' });
        return;
      }
      commit(r.state, r.ids.length > 1 ? `Duplicate ${r.ids.length} pieces` : 'Duplicate', undefined, { selection: Object.fromEntries(r.ids.map((id) => [id, true as const])) });
    },
    [commit],
  );

  const order = useCallback(
    (ids: ID[], how: 'front' | 'forward' | 'backward' | 'back') => {
      const c = ctlRef.current;
      if (!c) return;
      const s = c.state;
      const next = how === 'front' ? ops.bringToFront(s, ids) : how === 'back' ? sendToBack(s, ids) : stepOrder(game, s, ids, how === 'forward' ? 1 : -1);
      if (next === s) {
        toast(how === 'front' || how === 'forward' ? 'Already on top' : 'Already at the back', { duration: 1400 });
        return;
      }
      commit(next, how === 'front' ? 'Bring to front' : how === 'back' ? 'Send to back' : how === 'forward' ? 'Bring forward' : 'Send backward');
    },
    [commit, game],
  );

  const arrange = useCallback(() => {
    const c = ctlRef.current;
    if (!c) return;
    const r = arrangeUnplaced(game, c.state);
    if (!r.ids.length) {
      toast(game.components.some(placeable) ? 'Everything is already on the table' : 'Nothing to arrange yet', {
        description: game.components.length ? undefined : 'Cut out some components first.',
      });
      return;
    }
    commit(r.state, 'Arrange automatically', undefined, { selection: {} });
    window.setTimeout(() => c.fitAll(true), 30);
    toast(`Placed ${r.ids.length} piece${r.ids.length === 1 ? '' : 's'}`, { description: 'Drag them wherever they belong.', action: { label: 'Undo', onClick: onUndo } });
  }, [commit, game, onUndo]);

  const currentView = (c: TableController) => {
    c.measure();
    const r = c.rect;
    const ins = c.insets();
    const viewW = Math.round(r.width - ins.l - ins.r);
    const viewH = Math.round(r.height - ins.t - ins.b);
    const mid = c.screenToWorld(r.left + ins.l + viewW / 2, r.top + ins.t + viewH / 2);
    return { x: Math.round(mid.x * 10) / 10, y: Math.round(mid.y * 10) / 10, zoom: Math.round(c.camera.zoom * 1000) / 1000, viewW, viewH };
  };

  const saveStartView = useCallback(() => {
    const c = ctlRef.current;
    if (!c) return;
    commit({ ...c.state, camera: currentView(c) }, 'Set starting view');
    toast.success('Starting view saved', { description: 'New games open framed like this.' });
  }, [commit]);

  const goToStartView = useCallback(() => {
    const c = ctlRef.current;
    const cam = c?.state.camera;
    if (c && isStartCamera(cam)) c.fitRect(startViewRect(cam), true, MAX_ZOOM);
  }, []);

  const clearStartView = useCallback(() => {
    const c = ctlRef.current;
    if (!c) return;
    commit({ ...c.state, camera: undefined }, 'Clear starting view');
  }, [commit]);

  const fixWarning = useCallback(
    (w: SetupWarning) => {
      const c = ctlRef.current;
      if (!c || !w.fix) return;
      if (w.fix.apply) commit(w.fix.apply(game, c.state), w.fix.label);
      else if (w.fix.action === 'arrange') arrange();
      else if (w.fix.action === 'components') navigate(`/games/${game.id}/edit/components`);
      else if (w.fix.action === 'viewAll') {
        c.fitAll(false);
        commit({ ...c.state, camera: currentView(c) }, 'Set starting view');
      }
    },
    [arrange, commit, game, navigate],
  );

  const align = useCallback(
    (ids: ID[], how: Parameters<SetupActions['align']>[1]) => {
      const c = ctlRef.current;
      if (!c) return;
      const next = how === 'dist-x' || how === 'dist-y' ? distributeEntities(game, c.state, ids, how === 'dist-x' ? 'x' : 'y') : alignEntities(game, c.state, ids, how);
      if (next !== c.state) commit(next, how.startsWith('dist') ? 'Distribute' : 'Align');
    },
    [commit, game],
  );

  const actions: SetupActions = { commit: (n, l, k) => commit(n, l, k), arrange, saveStartView, goToStartView, clearStartView, fixWarning, showIds, remove, duplicate, order, align };

  /* ---------------- placing from the palette ---------------- */
  const place = useCallback(
    (item: PaletteItem, at?: Vec) => {
      const c = ctlRef.current;
      if (!c) return;
      const s = c.state;
      const where = at ?? c.viewCenterWorld();
      let e: Entity | null = null;
      let label = 'Add';
      if (item.type === 'component') {
        e = entityFromComponent(item.c, where);
        label = `Add ${item.c.name || 'piece'}`;
      } else if (item.type === 'zone') {
        e = newZoneOf(game, item.variant ?? 'area', where);
        label = item.variant === 'grid' || item.variant === 'endless' ? 'Add grid' : 'Add zone';
      } else if (item.type === 'note') {
        const r = ops.addNote(s, where);
        e = r.state.entities[r.id];
        label = 'Add note';
      } else {
        const r = ops.addCounter(s, where, { value: 0, min: 0, max: 99, label: 'Counter' });
        e = r.state.entities[r.id];
        label = 'Add counter';
      }
      if (!e) return;
      if (!at) {
        const p = findFreeSpot(game, s, e, where);
        e = { ...e, x: p.x, y: p.y };
      }
      if (snapRef.current) {
        const b = worldAABB(game, e);
        e = { ...e, x: e.x + Math.round(b.x / GRID) * GRID - b.x, y: e.y + Math.round(b.y / GRID) * GRID - b.y };
      }
      const next = ops.addEntity(s, e);
      const selectable = !c.isFixed(e);
      commit(next, label, undefined, {
        selection: selectable ? { [e.id]: true } : {},
        settle: { ...c.ui.getState().settle, [e.id]: c.nextSeq() },
        ...(item.type === 'note' && !at ? { editingNote: e.id } : {}),
      });
      if (!at) c.revealRect(worldAABB(game, e));
      if (size === 'narrow') setPaletteOpen(false);
    },
    [commit, game, size],
  );

  const dropAt = useCallback(
    (item: PaletteItem, x: number, y: number) => {
      const c = ctlRef.current;
      if (!c) return;
      c.measure();
      place(item, c.screenToWorld(x, y));
    },
    [place],
  );

  const isOverTable = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return !!el?.closest('.setup-stage .play-table') && !el.closest('[data-ui]');
  }, []);

  const findComponent = useCallback(
    (cid: ID) => {
      const c = ctlRef.current;
      if (!c) return;
      const ids = c.state.order.filter((id) => {
        const e = c.state.entities[id];
        return e && (e.kind === 'stack' ? e.cards.some((k) => k.deckId === cid) : 'componentId' in e && e.componentId === cid);
      });
      showIds(ids);
      if (size === 'narrow') setPaletteOpen(false);
    },
    [showIds, size],
  );

  /* ---------------- zones ---------------- */
  const drawZone = useCallback(
    (rect: Rect, tapped: boolean) => {
      const c = ctlRef.current;
      if (!c) return;
      const sz = defaultZoneSize(game);
      const r = tapped || rect.w < 12 || rect.h < 12 ? { x: rect.x - sz.w / 2, y: rect.y - sz.h / 2, ...sz } : rect;
      const snapV = (v: number) => (snapRef.current ? Math.round(v / GRID) * GRID : Math.round(v));
      const z = newZone({ x: snapV(r.x), y: snapV(r.y), w: Math.max(20, snapV(r.w)), h: Math.max(20, snapV(r.h)) });
      commit(ops.addEntity(c.state, z), 'Add zone', undefined, { selection: { [z.id]: true } });
      setTool(null);
      if (size === 'medium') setInspOpen(true);
    },
    [commit, game, size],
  );

  /* ---------------- keyboard (setup-only keys) ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ctlRef.current;
      if (!c || isTypingTarget(e.target) || document.querySelector('.ui-dialog-backdrop')) return;
      const ui = c.ui.getState();
      if (ui.menu || ui.browse || ui.shortcutsOpen) return;
      if (e.key === 'Escape' && tool) {
        setTool(null);
        return;
      }
      const ids = selectedOrHovered();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (ids.length) duplicate(ids);
        return;
      }
      if (mod || e.altKey) return;
      if (e.key.startsWith('Arrow') && ids.length) {
        const movable = ids.filter((id) => !c.isFixed(c.state.entities[id]));
        if (!movable.length) return;
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        commit(ops.translateEntities(c.state, movable, dx, dy), 'Nudge', 'nudge');
        return;
      }
      if ((e.key === ']' || e.key === '[') && ids.length) {
        order(ids, e.key === ']' ? 'front' : 'back');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commit, duplicate, order, tool]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- selection → inspector ---------------- */
  const prevSelCount = useRef(0);
  const onSelectionChange = useCallback(
    (ids: ID[]) => {
      setSel(ids);
      if (size === 'medium' && ids.length && !prevSelCount.current) setInspOpen(true);
      prevSelCount.current = ids.length;
    },
    [size],
  );

  /* ---------------- context menus ---------------- */
  const extraEntityMenuItems = useCallback(
    (e: Entity, c: TableController): MenuItem[] => {
      const selNow = c.ui.getState().selection;
      const ids = selNow[e.id] ? Object.keys(selNow).filter((id) => c.state.entities[id]) : [e.id];
      const items: MenuItem[] = [];
      if (e.kind === 'stack') {
        items.push(
          {
            label: 'Shuffle when the game starts',
            checked: !!e.shuffleOnStart,
            disabled: e.cards.length < 2,
            onSelect: () => commit(ops.updateEntity(c.state, e.id, (x) => ({ ...x, shuffleOnStart: e.shuffleOnStart ? undefined : true }) as Entity), e.shuffleOnStart ? 'Keep card order' : 'Shuffle on start'),
          },
          {
            label: stackFace(e) === 'up' ? 'Start face down' : 'Start face up',
            onSelect: () => commit(ops.setStackFace(c.state, e.id, stackFace(e) !== 'up'), stackFace(e) === 'up' ? 'Start face down' : 'Start face up'),
          },
        );
      }
      items.push(
        {
          label: 'Duplicate',
          icon: Copy,
          shortcut: 'Ctrl+D',
          disabled: ids.every((id) => c.state.entities[id]?.kind === 'stack'),
          hint: e.kind === 'stack' ? 'Decks can’t be copied — split instead' : undefined,
          onSelect: () => duplicate(ids),
        },
        { label: 'Bring to front', icon: ArrowUpToLine, shortcut: ']', onSelect: () => order(ids, 'front') },
        { label: 'Send to back', icon: ArrowDownToLine, shortcut: '[', onSelect: () => order(ids, 'back') },
        {
          label: 'Piece settings…',
          icon: SlidersHorizontal,
          onSelect: () => {
            c.select(ids);
            setInspOpen(true);
          },
        },
      );
      if (e.kind !== 'note') items.push({ label: ids.length > 1 ? `Remove ${ids.length} pieces` : 'Remove from table', icon: Trash2, shortcut: 'Delete', danger: true, onSelect: () => remove(ids) });
      return items;
    },
    [commit, duplicate, order, remove],
  );

  const extraTableMenuItems = useCallback(
    (at: Vec, c: TableController): MenuItem[] => {
      const sz = defaultZoneSize(game);
      return [
        {
          label: 'Add a zone here',
          icon: SquareDashed,
          onSelect: () => {
            const z = newZone({ x: at.x - sz.w / 2, y: at.y - sz.h / 2, ...sz });
            commit(ops.addEntity(c.state, z), 'Add zone', undefined, { selection: { [z.id]: true } });
          },
        },
        {
          label: 'Add a grid here',
          icon: LayoutGrid,
          onSelect: () => {
            const z = newZoneOf(game, 'grid', at);
            commit(ops.addEntity(c.state, z), 'Add grid', undefined, { selection: { [z.id]: true } });
          },
        },
        { label: 'Use this view as the starting view', icon: Camera, onSelect: saveStartView },
        { label: 'Arrange unplaced pieces', icon: Wand2, onSelect: arrange },
      ];
    },
    [arrange, commit, game, saveStartView],
  );

  /* ---------------- render ---------------- */
  const empty = setup.order.length === 0;
  const hasComponents = game.components.some(placeable);
  const startView = isStartCamera(setup.camera);
  const showPalette = size !== 'narrow' || paletteOpen;
  const inspFloating = size !== 'wide';
  const showInsp = !inspFloating || inspOpen;

  const viewMenu = (): MenuItem[] => [
    { label: startView ? 'Use this view instead' : 'Use this view as the starting view', icon: Camera, onSelect: saveStartView },
    { label: 'Go to the starting view', icon: Crosshair, disabled: !startView, onSelect: goToStartView },
    { label: 'Open games zoomed to fit everything', icon: X, disabled: !startView, onSelect: clearStartView },
  ];

  return (
    <div ref={rootRef} className={`setup is-${size}`} data-dragging={dragging || undefined}>
      {showPalette && (
        <aside className={`setup-side setup-side--left ${size === 'narrow' ? 'is-floating' : ''}`}>
          {size === 'narrow' && <IconButton icon={X} label="Close pieces" className="setup-insp__close" size="sm" onClick={() => setPaletteOpen(false)} />}
          <Palette game={game} state={setup} onAdd={(i) => place(i)} onDrop={dropAt} onFind={findComponent} isOverTable={isOverTable} onDragging={setDragging} />
        </aside>
      )}

      <div className="setup-stage">
        {sizeState && <TableView
          game={tableGame}
          state={setup}
          mode="setup"
          onCommit={onCommit}
          onUndo={onUndo}
          onRedo={onRedo}
          onSelectionChange={onSelectionChange}
          extraEntityMenuItems={extraEntityMenuItems}
          extraTableMenuItems={extraTableMenuItems}
          controllerRef={(c) => {
            setCtl(c);
            ctlRef.current = c;
            const cam = useGame.getState().game?.setup.camera;
            // open on the saved starting view; otherwise (none, or a camera saved without a
            // view size) show the whole table
            if (c && isStartCamera(cam)) c.fitRect(startViewRect(cam), false, MAX_ZOOM);
            else if (c) c.fitAll(false);
          }}
          className={dragging ? 'is-drop-armed' : undefined}
        >
          <StartViewFrame />
          <ResizeHandles />
          {tool && <DrawLayer mode={tool} onZone={drawZone} onDone={() => setTool(null)} />}
          {tool && (
            <div className="setup-toolhint" data-ui role="status">
              {tool === 'zone' ? 'Drag on the table to draw a zone — or tap to drop a card-sized one.' : 'Drag a box around the pieces to select them.'}
              <Button size="sm" variant="ghost" onClick={() => setTool(null)}>
                Cancel
              </Button>
            </div>
          )}
          {empty && !tool && !dragging && (
            <div className="play-center">
              <div className="play-center__card setup-empty" data-ui>
                <EmptyState
                  icon={LayoutDashboard}
                  title="Set the table for a new game"
                  description={
                    hasComponents
                      ? 'What you lay out here is exactly how every new game begins — which decks are shuffled, what’s face up, where the board sits and how many tokens are in reach.'
                      : 'This is where you lay out how a new game begins. First cut the decks, boards and tokens out of your PnP files.'
                  }
                  actions={
                    hasComponents ? (
                      <>
                        <Button variant="primary" icon={Wand2} onClick={arrange}>
                          Arrange everything automatically
                        </Button>
                        <Button icon={PanelLeft} onClick={() => (size === 'narrow' ? setPaletteOpen(true) : rootRef.current?.querySelector<HTMLElement>('.setup-pal__item')?.focus())}>
                          {size === 'narrow' ? 'Pick pieces myself' : 'Or drag pieces from the list'}
                        </Button>
                      </>
                    ) : (
                      <Link to={`/games/${game.id}/edit/components`}>
                        <Button variant="primary" icon={Shapes}>
                          Go to Components
                        </Button>
                      </Link>
                    )
                  }
                />
              </div>
            </div>
          )}
        </TableView>}

        <header className="play-bar setup-bar" data-ui>
          <div className="play-bar__group">
            {size === 'narrow' && <IconButton icon={PanelLeft} label="Pieces" active={paletteOpen} tooltipPlacement="bottom" onClick={() => setPaletteOpen((o) => !o)} />}
            <IconButton icon={StickyNote} label="Add a note" tooltipPlacement="bottom" onClick={() => place({ type: 'note' })} />
            <IconButton icon={SquareDashed} label="Draw a zone" tooltipPlacement="bottom" active={tool === 'zone'} onClick={() => setTool((t) => (t === 'zone' ? null : 'zone'))} />
            <IconButton icon={SquareDashedMousePointer} label="Select an area" shortcut="Shift+drag" tooltipPlacement="bottom" active={tool === 'select'} onClick={() => setTool((t) => (t === 'select' ? null : 'select'))} />
            <span className="play-bar__sep" />
            <IconButton
              icon={Magnet}
              label={snap ? `Snap to ${GRID} mm grid: on` : `Snap to ${GRID} mm grid: off`}
              tooltipPlacement="bottom"
              active={snap}
              aria-pressed={snap}
              onClick={() => setSettings({ snapToGrid: !snap })}
            />
            <IconButton
              icon={Tag}
              label={showNames ? 'Names on the table: shown' : 'Names on the table: on hover'}
              shortcut="N"
              tooltipPlacement="bottom"
              active={showNames}
              aria-pressed={showNames}
              onClick={() => setSettings({ showNamesSetup: !showNames })}
            />
            <IconButton icon={Wand2} label="Arrange unplaced pieces automatically" tooltipPlacement="bottom" onClick={arrange} />
          </div>
          <div className="play-bar__spacer" />
          <div className="play-bar__group">
            {problems > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={TriangleAlert}
                className="setup-bar__warn"
                onClick={() => {
                  ctl?.clearSelection();
                  setInspOpen(true);
                }}
              >
                {problems}
                <span className="setup-bar__label"> {problems === 1 ? 'problem' : 'problems'}</span>
              </Button>
            )}
            <MenuButton items={viewMenu} minWidth={260}>
              <IconButton icon={Camera} label="Starting view" tooltipPlacement="bottom" active={startView} />
            </MenuButton>
            {inspFloating && <IconButton icon={SlidersHorizontal} label="Settings" tooltipPlacement="bottom" active={inspOpen} badge={sel.length ? sel.length : undefined} onClick={() => setInspOpen((o) => !o)} />}
          </div>
        </header>

        {inspFloating && showInsp && (
          <aside className="setup-side setup-side--right is-floating">
            <Inspector game={game} state={setup} ids={sel} ctl={ctl} warnings={warnings} actions={actions} onClose={() => setInspOpen(false)} />
          </aside>
        )}
      </div>

      {!inspFloating && (
        <aside className="setup-side setup-side--right">
          <Inspector game={game} state={setup} ids={sel} ctl={ctl} warnings={warnings} actions={actions} />
        </aside>
      )}
    </div>
  );
}
