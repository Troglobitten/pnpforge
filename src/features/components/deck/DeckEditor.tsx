import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeftRight,
  ChevronDown,
  CopyPlus,
  Copy,
  FlipHorizontal2,
  FolderInput,
  ImagePlus,
  Images,
  Layers,
  ListChecks,
  Palette,
  PanelRight,
  Plus,
  Repeat,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareDashedMousePointer,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
  ImageOff,
} from 'lucide-react';
import { arrayMove } from '@dnd-kit/sortable';
import {
  Button,
  ColorField,
  EmptyState,
  IconButton,
  Menu,
  MenuButton,
  NumberField,
  Portal,
  ProgressBar,
  Segmented,
  Select,
  Slider,
  Spinner,
  toast,
  type MenuItem,
} from '@/ui';
import { useGame } from '@/state/gameStore';
import { CARD_PRESETS, type CardDef, type DeckComponent, type Game, type ID } from '@/shared/types';
import { deckCountLabel, fmtMm, matchPreset, naturalCompare, pickFiles, plural, sizeForImageAspect, urlOf } from '../lib';
import { CardBack, cardBox } from '../previews';
import { DetailHeader, Popover, commitOnEnter, isTypingTarget, undoToast, useCoarsePointer, useElementSize, useUploader } from '../common';
import { pickAsset } from '../AssetPicker';
import { useDeckActions, type DeckActions } from './actions';
import { CardGrid } from './CardGrid';
import { DeckInspector, type DeckOps } from './Inspector';

const THUMB_KEY = 'pnpforge.components.thumb';
const readThumb = () => {
  try {
    const v = Number(localStorage.getItem(THUMB_KEY));
    return v >= 90 && v <= 280 ? v : 150;
  } catch {
    return 150;
  }
};

export function DeckEditor({ game, deck }: { game: Game; deck: DeckComponent }) {
  const navigate = useNavigate();
  const A = useDeckActions(deck.id);
  const coarse = useCoarsePointer();
  const [pageRef, page] = useElementSize<HTMLDivElement>();
  const narrow = page.width > 0 && page.width < 900;

  /* ---------------- selection ---------------- */
  const [sel, setSel] = useState<Set<ID>>(() => new Set());
  const [focusId, setFocusId] = useState<ID | null>(null);
  const anchor = useRef<ID | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [busy, setBusy] = useState<Set<ID>>(() => new Set());
  const [thumb, setThumb] = useState(readThumb);
  const [showBacks, setShowBacks] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { upload, progress } = useUploader();

  const ids = useMemo(() => deck.cards.map((c) => c.id), [deck.cards]);
  const selIds = useMemo(() => ids.filter((id) => sel.has(id)), [ids, sel]);
  const live = useRef({ ids, sel, focusId, selectMode, drawer, narrow });
  live.current = { ids, sel, focusId, selectMode, drawer, narrow };

  // Forget selected cards that no longer exist (deleted, moved, undone).
  useEffect(() => {
    setSel((prev) => {
      const keep = new Set(ids);
      const next = new Set([...prev].filter((id) => keep.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ids]);
  useEffect(() => {
    if (!sel.size) setDrawer(false);
  }, [sel.size]);

  // Show the top of the inspector (the preview) whenever a different card or mode is shown.
  const inspRef = useRef<HTMLElement>(null);
  const inspKey = selIds.length === 1 ? selIds[0] : `n${Math.min(selIds.length, 2)}`;
  useEffect(() => {
    inspRef.current?.scrollTo({ top: 0 });
  }, [inspKey]);

  const reveal = useCallback((id: ID, focus = true) => {
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (focus) el.focus({ preventScroll: true });
    });
  }, []);

  const selectOnly = useCallback(
    (id: ID) => {
      setSel(new Set([id]));
      setFocusId(id);
      anchor.current = id;
      reveal(id);
    },
    [reveal],
  );
  const selectMany = useCallback((list: ID[]) => {
    setSel(new Set(list));
    if (list.length) {
      setFocusId(list[list.length - 1]);
      anchor.current = list[0];
    }
  }, []);
  const clear = useCallback(() => {
    setSel(new Set());
    anchor.current = null;
  }, []);
  const selectAll = useCallback(() => selectMany(live.current.ids), [selectMany]);

  const range = (a: ID, b: ID) => {
    const list = live.current.ids;
    const [i, j] = [list.indexOf(a), list.indexOf(b)].sort((x, y) => x - y);
    return i < 0 ? [b] : list.slice(i, j + 1);
  };

  const onTileClick = useCallback((id: ID, e: ReactMouseEvent) => {
    const { sel: cur, selectMode: sm } = live.current;
    const toggle = e.ctrlKey || e.metaKey || sm;
    if (e.shiftKey && anchor.current) {
      const r = range(anchor.current, id);
      setSel(toggle ? new Set([...cur, ...r]) : new Set(r));
    } else if (toggle) {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSel(next);
      anchor.current = id;
    } else {
      setSel(new Set([id]));
      anchor.current = id;
    }
    setFocusId(id);
  }, []);

  const onTileDoubleClick = useCallback((id: ID) => {
    setSel(new Set([id]));
    anchor.current = id;
    setFocusId(id);
    if (live.current.narrow) setDrawer(true);
  }, []);

  const onDragBegin = useCallback((id: ID) => {
    if (!live.current.sel.has(id)) {
      setSel(new Set([id]));
      anchor.current = id;
    }
    setFocusId(id);
  }, []);

  const onReorder = useCallback(
    (activeId: ID, overId: ID) => {
      const list = live.current.ids;
      const cur = live.current.sel;
      const from = list.indexOf(activeId);
      const to = list.indexOf(overId);
      if (from < 0 || to < 0) return;
      let next = arrayMove(list, from, to);
      if (cur.size > 1 && cur.has(activeId)) {
        const moving = list.filter((id) => cur.has(id));
        const rest = next.filter((id) => !cur.has(id) || id === activeId);
        const at = rest.indexOf(activeId);
        next = [...rest.slice(0, at), ...moving, ...rest.slice(at + 1)];
      }
      if (next.join() !== list.join()) A.reorder(next, cur.size > 1 && cur.has(activeId) ? `Move ${cur.size} cards` : 'Reorder card');
    },
    [A],
  );

  const onTileContext = useCallback((id: ID, x: number, y: number) => {
    if (!live.current.sel.has(id)) {
      setSel(new Set([id]));
      anchor.current = id;
    }
    setFocusId(id);
    setCtx({ x, y });
  }, []);

  /* ---------------- operations ---------------- */
  const addFiles = useCallback(
    async (files: File[]) => {
      const sorted = [...files].sort((a, b) => naturalCompare(a.name, b.name));
      const assets = await upload(sorted, 'card');
      if (!assets.length) return;
      const d = useGame.getState().game?.components.find((c) => c.id === deck.id) as DeckComponent | undefined;
      let size: { width: number; height: number } | undefined;
      const first = assets.find((a) => a.width > 0);
      if (d && !d.cards.length && first) {
        const fit = sizeForImageAspect(first.width / first.height);
        if (Math.abs(Math.log(fit.width / fit.height / (d.width / d.height))) > 0.04) size = fit;
      }
      const created = A.addFromAssets(assets, { size });
      selectMany(created);
      reveal(created[0], false);
      toast.success(`Added ${plural(created.length, 'card')}`, {
        description: size ? `Card size set to ${fmtMm(size.width)} × ${fmtMm(size.height)} mm to match the images.` : undefined,
        action: undoToast(),
      });
    },
    [upload, A, deck.id, selectMany, reveal],
  );
  const uploadCards = useCallback(async () => {
    const files = await pickFiles();
    if (files.length) await addFiles(files);
  }, [addFiles]);

  const ops = useMemo<DeckOps>(
    () => buildOps({ A, game, deck, upload, setBusy, selectMany, navigate }),
    [A, game, deck, upload, selectMany, navigate],
  );

  /* ---------------- keyboard ---------------- */
  useEffect(() => {
    const cols = () => {
      const tiles = scrollRef.current?.querySelectorAll<HTMLElement>('[data-card-id]');
      if (!tiles?.length) return 1;
      const top = tiles[0].offsetTop;
      let n = 0;
      while (n < tiles.length && tiles[n].offsetTop === top) n++;
      return Math.max(1, n);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (document.querySelector('.ui-dialog-backdrop, .ui-menu')) return;
      const S = live.current;
      const selected = S.ids.filter((id) => S.sel.has(id));
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === 'Escape') {
        if (S.drawer) setDrawer(false);
        else if (S.sel.size) clear();
        else if (S.selectMode) setSelectMode(false);
        return;
      }
      if (mod && key === 'a') {
        e.preventDefault();
        selectAll();
      } else if (mod && key === 'd') {
        e.preventDefault();
        if (selected.length) ops.duplicate(selected);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
        e.preventDefault();
        ops.remove(selected);
      } else if (e.key === 'Enter' && selected.length && S.narrow) {
        setDrawer(true);
      } else if (e.key.startsWith('Arrow') && !mod && S.ids.length) {
        e.preventDefault();
        const horiz = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
        if (e.altKey && horiz && selected.length) {
          A.nudge(selected, e.key === 'ArrowLeft' ? -1 : 1);
          if (S.focusId) reveal(S.focusId);
          return;
        }
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols(), ArrowDown: cols() }[e.key] ?? 0;
        const cur = S.focusId ? S.ids.indexOf(S.focusId) : -1;
        const next = S.ids[cur < 0 ? 0 : Math.max(0, Math.min(S.ids.length - 1, cur + step))];
        if (e.shiftKey) {
          if (!anchor.current) anchor.current = S.focusId ?? next;
          setSel(new Set(range(anchor.current, next)));
          setFocusId(next);
          reveal(next);
        } else selectOnly(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [A, ops, clear, selectAll, selectOnly, reveal]);

  /* ---------------- file drop ---------------- */
  const dragDepth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDropOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDropOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDropOver(false);
      void addFiles(Array.from(e.dataTransfer.files));
    },
  };

  /* ---------------- render ---------------- */
  const box = cardBox(deck, (thumb * Math.max(deck.width, deck.height)) / Math.max(1, Math.min(deck.width, deck.height)) / 1.4);
  const frontUrl = useCallback((c: CardDef) => urlOf(game, c.front), [game]);
  const backUrl = useCallback((c: CardDef) => urlOf(game, c.back ?? deck.back), [game, deck.back]);
  const toSources = () => navigate(`/games/${game.id}/edit/sources`);
  const commonCount = selIds.length ? deck.cards.find((c) => c.id === selIds[0])?.count ?? 1 : 1;
  const mixed = selIds.length > 1 && new Set(selIds.map((id) => deck.cards.find((c) => c.id === id)?.count)).size > 1;

  const addItems: MenuItem[] = [
    { label: 'Upload card images…', icon: Upload, hint: 'Each image becomes a card', onSelect: () => void uploadCards() },
    {
      label: 'Blank card',
      icon: Plus,
      hint: 'A placeholder without an image',
      onSelect: () => {
        const id = A.addBlank();
        selectOnly(id);
      },
    },
    { type: 'separator' },
    { label: 'Cut more from a PDF…', icon: Scissors, hint: 'Opens the Sources page', onSelect: toSources },
  ];

  const inspector = <DeckInspector game={game} deck={deck} selIds={selIds} busy={busy} ops={ops} onSelectOnly={selectOnly} coarse={coarse} />;

  return (
    <div className={`cmp-page cmp-deckpage ${narrow ? 'is-narrow' : ''}`} ref={pageRef}>
      <DetailHeader
        comp={deck}
        meta={`${deckCountLabel(deck)} · ${fmtMm(deck.width)} × ${fmtMm(deck.height)} mm`}
        actions={
          <>
            <Button variant="ghost" icon={Scissors} onClick={toSources} className="cmp-hide-narrow">
              Cut from PDF
            </Button>
            <MenuButton items={addItems} placement="bottom-end" minWidth={250}>
              <Button variant="primary" icon={Plus}>
                Add cards
              </Button>
            </MenuButton>
          </>
        }
      />
      <DeckSettings game={game} deck={deck} A={A} />

      <div className="cmp-deck">
        <div className={`cmp-deck__main ${dropOver ? 'is-dropping' : ''}`} {...dropProps}>
          {deck.cards.length > 0 && (
            <div className="cmp-tb" role="toolbar" aria-label="Cards">
              {selIds.length === 0 ? (
                <>
                  <Button size="sm" variant={selectMode ? 'subtle' : 'ghost'} icon={selectMode ? X : ListChecks} onClick={() => setSelectMode(!selectMode)}>
                    {selectMode ? 'Done' : 'Select'}
                  </Button>
                  {selectMode ? (
                    <Button size="sm" variant="ghost" icon={SquareDashedMousePointer} onClick={selectAll}>
                      Select all
                    </Button>
                  ) : (
                    <span className="cmp-tb__hint">
                      {coarse ? 'Hold a card, then drag to reorder' : 'Drag to reorder · Shift or Ctrl-click to select several'}
                    </span>
                  )}
                  <span className="cmp-tb__spacer" />
                  <Segmented<'front' | 'back'>
                    size="sm"
                    value={showBacks ? 'back' : 'front'}
                    onChange={(v) => setShowBacks(v === 'back')}
                    aria-label="Show"
                    options={[
                      { value: 'front', label: 'Fronts' },
                      { value: 'back', label: 'Backs' },
                    ]}
                  />
                  <div className="cmp-tb__zoom">
                    <ZoomOut size={15} aria-hidden />
                    <Slider
                      value={thumb}
                      min={90}
                      max={280}
                      step={10}
                      aria-label="Card size"
                      onChange={(v) => {
                        setThumb(v);
                        try {
                          localStorage.setItem(THUMB_KEY, String(v));
                        } catch {
                          /* private mode */
                        }
                      }}
                    />
                    <ZoomIn size={15} aria-hidden />
                  </div>
                </>
              ) : (
                <>
                  <IconButton icon={X} size="sm" label="Clear selection" shortcut="Esc" onClick={clear} />
                  <span className="cmp-tb__count">{selIds.length} selected</span>
                  {(selectMode || coarse) && selIds.length < ids.length && (
                    <Button size="sm" variant="ghost" onClick={selectAll}>
                      All
                    </Button>
                  )}
                  <span className="cmp-tb__sep" />
                  <label className="cmp-tb__label" onKeyDown={commitOnEnter}>
                    <span>{mixed ? 'Copies (mixed)' : 'Copies'}</span>
                    <NumberField size="sm" value={commonCount} onChange={(n) => ops.setCount(selIds, n)} min={1} max={99} aria-label="Copies" />
                  </label>
                  <MenuButton items={ops.backItems(selIds)} placement="bottom-start">
                    <Button size="sm" variant="ghost" icon={Layers} className="cmp-tb__iconic">
                      Back
                    </Button>
                  </MenuButton>
                  <MenuButton items={ops.rotateItems(selIds)} placement="bottom-start">
                    <Button size="sm" variant="ghost" icon={RotateCw} className="cmp-tb__iconic" disabled={selIds.some((id) => busy.has(id))}>
                      Rotate
                    </Button>
                  </MenuButton>
                  <MenuButton items={ops.moveItems(selIds)} placement="bottom-start">
                    <Button size="sm" variant="ghost" icon={FolderInput} className="cmp-tb__iconic">
                      Move
                    </Button>
                  </MenuButton>
                  <IconButton icon={FlipHorizontal2} size="sm" label="Swap front and back" onClick={() => ops.swap(selIds)} />
                  <IconButton icon={Copy} size="sm" label="Duplicate" shortcut="Ctrl+D" onClick={() => ops.duplicate(selIds)} />
                  <IconButton icon={Trash2} size="sm" variant="danger" label="Delete" shortcut="Del" onClick={() => ops.remove(selIds)} />
                  {/* Only worth a spacer when something has to sit on the right. */}
                  {narrow && (
                    <>
                      <span className="cmp-tb__spacer" />
                      <Button size="sm" variant="subtle" icon={PanelRight} onClick={() => setDrawer(true)}>
                        {selIds.length === 1 ? 'Edit card' : 'Details'}
                      </Button>
                    </>
                  )}
                </>
              )}
              {progress != null && (
                <div className="cmp-tb__progress">
                  <ProgressBar value={progress} />
                </div>
              )}
            </div>
          )}

          {deck.cards.length === 0 ? (
            <div className="cmp-deck-empty">
              {progress != null ? (
                <div className="cmp-deck-empty__busy">
                  <Spinner size={22} />
                  <span>Uploading card images…</span>
                  <ProgressBar value={progress} />
                </div>
              ) : (
                <EmptyState
                  icon={Layers}
                  title="This deck has no cards yet"
                  description="Drop card images here or upload them. Each image becomes one card. You can also cut cards from a print-and-play PDF."
                  actions={
                    <>
                      <Button variant="primary" icon={Upload} onClick={() => void uploadCards()}>
                        Upload card images
                      </Button>
                      <Button icon={Scissors} onClick={toSources}>
                        Cut from a PDF
                      </Button>
                    </>
                  }
                />
              )}
            </div>
          ) : (
            <CardGrid
              cards={deck.cards}
              box={box}
              frontUrl={frontUrl}
              backUrl={backUrl}
              backColor={deck.backColor}
              showBacks={showBacks}
              selected={sel}
              focusId={focusId ?? ids[0] ?? null}
              busy={busy}
              selectMode={selectMode}
              scrollRef={scrollRef}
              onTileClick={onTileClick}
              onTileDoubleClick={onTileDoubleClick}
              onTileContext={onTileContext}
              onDragBegin={onDragBegin}
              onReorder={onReorder}
              onSelectSet={setSel}
              onBackgroundClick={() => !live.current.selectMode && clear()}
            />
          )}

          {dropOver && (
            <div className="cmp-drop" aria-hidden>
              <div className="cmp-drop__card">
                <ImagePlus size={28} />
                <strong>Drop to add cards</strong>
                <span>Each image becomes a card in “{deck.name}”</span>
              </div>
            </div>
          )}
        </div>
        {!narrow && (
          <aside className="cmp-deck__inspector" ref={inspRef}>
            {inspector}
          </aside>
        )}
      </div>

      {narrow && drawer && selIds.length > 0 && (
        <Portal>
          <div className="cmp-drawer-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setDrawer(false)}>
            <aside className="cmp-drawer" role="dialog" aria-label="Card details">
              <div className="cmp-drawer__head">
                <span>{selIds.length === 1 ? 'Card' : `${selIds.length} cards`}</span>
                <IconButton icon={X} label="Close" onClick={() => setDrawer(false)} />
              </div>
              <div className="cmp-drawer__body">{inspector}</div>
            </aside>
          </div>
        </Portal>
      )}

      {ctx && selIds.length > 0 && (
        <Menu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          minWidth={230}
          items={[
            { type: 'label', label: selIds.length === 1 ? 'Card' : `${selIds.length} cards` },
            { label: 'Duplicate', icon: Copy, shortcut: 'Ctrl+D', onSelect: () => ops.duplicate(selIds) },
            { label: 'Rotate', icon: RotateCw, submenu: ops.rotateItems(selIds) },
            { label: 'Swap front and back', icon: FlipHorizontal2, onSelect: () => ops.swap(selIds) },
            { label: 'Back', icon: Layers, submenu: ops.backItems(selIds) },
            ...ops.moveItems(selIds),
            { type: 'separator' },
            { label: selIds.length === 1 ? 'Delete card' : `Delete ${selIds.length} cards`, icon: Trash2, danger: true, shortcut: 'Del', onSelect: () => ops.remove(selIds) },
          ]}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Operations shared by toolbar, inspector and context menu             */
/* ------------------------------------------------------------------ */

function buildOps({
  A,
  game,
  deck,
  upload,
  setBusy,
  selectMany,
  navigate,
}: {
  A: DeckActions;
  game: Game;
  deck: DeckComponent;
  upload: (files: File[], role: 'card') => Promise<{ id: ID }[]>;
  setBusy: (fn: (s: Set<ID>) => Set<ID>) => void;
  selectMany: (ids: ID[]) => void;
  navigate: (to: string) => void;
}): DeckOps {
  const rotate = async (ids: ID[], deg: 90 | 180 | 270) => {
    setBusy((s) => new Set([...s, ...ids]));
    try {
      await A.rotate(ids, deg);
    } finally {
      setBusy((s) => new Set([...s].filter((id) => !ids.includes(id))));
    }
  };
  const otherDecks = game.components.filter((c): c is DeckComponent => c.kind === 'deck' && c.id !== deck.id);
  const move = (ids: ID[], target: ID | 'new', copy: boolean) => {
    const res = A.moveTo(ids, target, copy);
    if (!res) return;
    toast.success(`${copy ? 'Copied' : 'Moved'} ${plural(ids.length, 'card')} to “${res.name}”`, {
      action: target === 'new' ? { label: 'Open', onClick: () => navigate(`/games/${game.id}/edit/components/${res.deckId}`) } : undoToast(),
    });
  };
  const deckTargets = (ids: ID[], copy: boolean): MenuItem[] => [
    ...otherDecks.map((o) => ({ label: o.name, icon: Layers, hint: deckCountLabel(o), onSelect: () => move(ids, o.id, copy) })),
    ...(otherDecks.length ? [{ type: 'separator' as const }] : []),
    { label: 'New deck', icon: Plus, hint: 'Same size and back as this one', onSelect: () => move(ids, 'new', copy) },
  ];

  return {
    setCount: A.setCount,
    remove: A.deleteCards,
    duplicate: (ids) => {
      const created = A.duplicate(ids);
      selectMany(created);
    },
    swap: A.swapFaces,
    rotate: (ids, deg) => void rotate(ids, deg),
    rename: A.rename,
    replaceFront: async (id, how) => {
      if (how === 'choose') {
        const asset = await pickAsset({ title: 'Choose the card image', role: 'card', current: deck.cards.find((c) => c.id === id)?.front });
        if (asset) A.setFront(id, asset);
        return;
      }
      const files = await pickFiles({ multiple: false });
      const [a] = await upload(files, 'card');
      if (a) A.setFront(id, a.id);
    },
    backItems: (ids) => {
      const anyOwn = ids.some((id) => deck.cards.find((c) => c.id === id)?.back);
      const who = ids.length === 1 ? 'this card' : `${ids.length} cards`;
      return [
        {
          label: 'Choose a back image…',
          icon: Images,
          onSelect: async () => {
            const asset = await pickAsset({ title: `Back for ${who}`, description: 'This overrides the deck back for these cards only.', role: 'card' });
            if (asset) A.setBack(ids, asset);
          },
        },
        {
          label: 'Upload a back image…',
          icon: ImagePlus,
          onSelect: async () => {
            const files = await pickFiles({ multiple: false });
            const [a] = await upload(files, 'card');
            if (a) A.setBack(ids, a.id);
          },
        },
        { type: 'separator' },
        { label: 'Use the deck back', icon: Layers, disabled: !anyOwn, hint: anyOwn ? undefined : 'Already using it', onSelect: () => A.setBack(ids, null) },
      ];
    },
    rotateItems: (ids) => [
      { label: '90° clockwise', icon: RotateCw, onSelect: () => void rotate(ids, 90) },
      { label: '90° anticlockwise', icon: RotateCcw, onSelect: () => void rotate(ids, 270) },
      { label: '180°', icon: Repeat, onSelect: () => void rotate(ids, 180) },
    ],
    moveItems: (ids) => [
      { label: 'Move to deck', icon: FolderInput, submenu: deckTargets(ids, false) },
      { label: 'Copy to deck', icon: CopyPlus, submenu: deckTargets(ids, true) },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Deck settings strip: size, corners, back                             */
/* ------------------------------------------------------------------ */

function DeckSettings({ game, deck, A }: { game: Game; deck: DeckComponent; A: DeckActions }) {
  const match = matchPreset(deck.width, deck.height);
  const landscape = deck.width > deck.height;
  const backRef = useRef<HTMLSpanElement>(null);
  const [colourAt, setColourAt] = useState<DOMRect | null>(null);
  const { upload, busy } = useUploader();
  const maxR = Math.max(1, Math.floor(Math.min(deck.width, deck.height) / 4));
  const mini = cardBox(deck, 40);

  const setPreset = (id: string) => {
    const p = CARD_PRESETS.find((x) => x.id === id);
    if (!p) return;
    const [w, h] = landscape ? [p.height, p.width] : [p.width, p.height];
    A.mut((d) => {
      d.width = w;
      d.height = h;
    }, `Card size: ${p.label}`);
  };

  const setBackImage = (id: ID | null, label: string) => A.mut((d) => void (d.back = id), label);
  const backItems: MenuItem[] = [
    {
      label: 'Upload an image…',
      icon: ImagePlus,
      onSelect: async () => {
        const files = await pickFiles({ multiple: false });
        const [a] = await upload(files, 'card');
        if (a) setBackImage(a.id, 'Set deck back');
      },
    },
    {
      label: 'Choose from game images…',
      icon: Images,
      onSelect: async () => {
        const id = await pickAsset({ title: 'Choose the deck back', role: 'card', current: deck.back });
        if (id) setBackImage(id, 'Set deck back');
      },
    },
    {
      label: 'Use one of the cards…',
      icon: Layers,
      hint: 'When the back was cut as a card',
      disabled: !deck.cards.some((c) => c.front),
      onSelect: async () => {
        const only = [...new Set(deck.cards.map((c) => c.front).filter(Boolean) as ID[])];
        const id = await pickAsset({ title: 'Which card is the back?', description: 'Its image becomes the back of every card.', only, current: deck.back });
        if (!id) return;
        setBackImage(id, 'Use a card as the deck back');
        const card = useGame
          .getState()
          .game?.components.find((c): c is DeckComponent => c.id === deck.id && c.kind === 'deck')
          ?.cards.find((c) => c.front === id);
        if (card)
          toast.success('Deck back updated', {
            description: `Remove “${card.name || 'that card'}” from the deck now that it’s the back?`,
            action: { label: 'Remove card', onClick: () => A.deleteCards([card.id]) },
            duration: 8000,
          });
      },
    },
    { type: 'separator' },
    { label: 'Colour…', icon: Palette, hint: 'Used when there is no back image', onSelect: () => setColourAt(backRef.current?.getBoundingClientRect() ?? null) },
    ...(deck.back ? [{ label: 'Remove back image', icon: ImageOff, danger: true, onSelect: () => setBackImage(null, 'Remove deck back') }] : []),
  ];

  return (
    <div className="cmp-dbar" onKeyDown={commitOnEnter}>
      <div className="cmp-dbar__group">
        <span className="cmp-dbar__label">Card size</span>
        <div className="cmp-dbar__ctrl">
          <Select
            value={match ? match.preset.id : 'custom'}
            onChange={setPreset}
            className="cmp-dbar__preset"
            options={[
              ...CARD_PRESETS.map((p) => ({
                value: p.id,
                label: `${p.label} · ${landscape ? `${fmtMm(p.height)}×${fmtMm(p.width)}` : `${fmtMm(p.width)}×${fmtMm(p.height)}`}`,
              })),
              { value: 'custom', label: 'Custom size' },
            ]}
          />
          <NumberField
            value={deck.width}
            onChange={(v) => A.mut((d) => void (d.width = v), 'Card width')}
            min={10}
            max={300}
            step={0.5}
            precision={1}
            size="sm"
            className="cmp-dbar__mm"
            aria-label="Card width in mm"
          />
          <span className="cmp-dbar__x">×</span>
          <NumberField
            value={deck.height}
            onChange={(v) => A.mut((d) => void (d.height = v), 'Card height')}
            min={10}
            max={300}
            step={0.5}
            precision={1}
            size="sm"
            className="cmp-dbar__mm"
            aria-label="Card height in mm"
          />
          <span className="cmp-dbar__unit">mm</span>
          <IconButton
            icon={ArrowLeftRight}
            size="sm"
            label={landscape ? 'Make portrait' : 'Make landscape'}
            disabled={deck.width === deck.height}
            onClick={() =>
              A.mut((d) => {
                [d.width, d.height] = [d.height, d.width];
              }, 'Swap card orientation')
            }
          />
        </div>
      </div>

      <div className="cmp-dbar__group">
        <span className="cmp-dbar__label">Corners</span>
        <div className="cmp-dbar__ctrl">
          <span className="cmp-corner" style={{ borderTopLeftRadius: Math.min(26, deck.cornerRadius * 4.5) }} aria-hidden title="Corner, enlarged" />
          <Slider
            value={deck.cornerRadius}
            min={0}
            max={maxR}
            step={0.5}
            className="cmp-dbar__slider"
            aria-label="Corner radius"
            onChange={(v) => A.mut((d) => void (d.cornerRadius = v), 'Card corners', 'radius')}
          />
          <span className="cmp-dbar__val">{fmtMm(deck.cornerRadius)} mm</span>
        </div>
      </div>

      <div className="cmp-dbar__group">
        <span className="cmp-dbar__label">Back</span>
        <div className="cmp-dbar__ctrl">
          <MenuButton items={backItems} placement="bottom-end" minWidth={250}>
            <span ref={backRef} className="cmp-backbtn" role="button" tabIndex={0} aria-label="Change the deck back">
              <CardBack url={urlOf(game, deck.back)} color={deck.backColor} {...mini} />
              <span className="cmp-backbtn__text">{busy ? 'Uploading…' : deck.back ? 'Image' : 'Colour'}</span>
              {busy ? <Spinner size={14} /> : <ChevronDown size={14} />}
            </span>
          </MenuButton>
        </div>
      </div>

      {colourAt && (
        <Popover anchor={colourAt} onClose={() => setColourAt(null)} className="cmp-colourpop">
          <div className="cmp-colourpop__title">Back colour</div>
          <ColorField value={deck.backColor} onChange={(c) => A.mut((d) => void (d.backColor = c), 'Deck back colour', 'backColor')} />
          {deck.back && <p className="cmp-colourpop__note">The back image is shown instead. Remove it to use the colour.</p>}
        </Popover>
      )}
    </div>
  );
}
