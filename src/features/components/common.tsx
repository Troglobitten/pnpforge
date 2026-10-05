import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ChevronLeft, Copy, ImagePlus, Images, MoreHorizontal, Trash2, X } from 'lucide-react';
import { Button, IconButton, MenuButton, Portal, ProgressBar, Spinner, computePosition, toast, type MenuItem } from '@/ui';
import { useGame } from '@/state/gameStore';
import type { AssetRole, Component, Game, ID } from '@/shared/types';
import { KIND_META, cloneComponent, countPlacements, isImageFile, pickFiles, plural, removePlacements, uploadImages, urlOf } from './lib';
import { pickAsset } from './AssetPicker';
import { MadeFrom } from '@/features/cutter/MadeFrom';

/* ------------------------------------------------------------------ */
/* Store helpers                                                        */
/* ------------------------------------------------------------------ */

export function useGameId() {
  return useParams().gameId ?? useGame.getState().game?.id ?? '';
}

/**
 * Toast action that undoes the change just made. Call it right after the
 * update. If history moved on since (the change was already undone or other
 * edits followed), it explains instead of undoing something else.
 */
export const undoToast = () => {
  const s = useGame.getState();
  const len = s.past.length;
  const entry = s.past[len - 1];
  return {
    label: 'Undo',
    onClick: () => {
      const now = useGame.getState();
      if (now.past.length === len && now.past[len - 1] === entry) now.undo();
      else toast('Can’t undo that from here', { description: 'Other changes happened since. Use Undo in the top bar (Ctrl+Z) to step back.' });
    },
  };
};

/** Update one component by id with an immer recipe. */
export function useComponentUpdate<T extends Component>(id: ID) {
  const update = useGame((s) => s.update);
  return useCallback(
    (recipe: (c: T) => void, label = 'Edit component', coalesceKey?: string) =>
      update(
        (g) => {
          const c = g.components.find((x) => x.id === id);
          if (c) recipe(c as unknown as T);
        },
        label,
        coalesceKey ? { coalesceKey: `${id}:${coalesceKey}` } : undefined,
      ),
    [id, update],
  );
}

export function useComponentActions() {
  const update = useGame((s) => s.update);
  const navigate = useNavigate();
  const gameId = useGameId();

  const remove = useCallback(
    (comp: Component, opts: { leave?: boolean } = {}) => {
      const game = useGame.getState().game;
      if (!game) return;
      const n = countPlacements(game.setup, comp);
      update((g) => {
        g.components = g.components.filter((c) => c.id !== comp.id);
        removePlacements(g.setup, comp);
      }, `Delete ${comp.name}`);
      if (opts.leave) navigate(`/games/${gameId}/edit/components`);
      toast(`Deleted “${comp.name}”`, {
        description: n
          ? `Also removed ${comp.kind === 'deck' ? plural(n, 'card') : plural(n, 'placement')} from the table setup.`
          : undefined,
        action: undoToast(),
      });
    },
    [update, navigate, gameId],
  );

  const duplicate = useCallback(
    (comp: Component, opts: { open?: boolean } = {}) => {
      const game = useGame.getState().game;
      if (!game) return;
      const copy = cloneComponent(game, comp);
      update((g) => {
        const i = g.components.findIndex((c) => c.id === comp.id);
        g.components.splice(i + 1, 0, copy);
      }, `Duplicate ${comp.name}`);
      toast.success(`Duplicated as “${copy.name}”`, { action: undoToast() });
      if (opts.open) navigate(`/games/${gameId}/edit/components/${copy.id}`);
    },
    [update, navigate, gameId],
  );

  const rename = useCallback(
    (comp: Component, name: string) => {
      const n = name.trim();
      if (!n || n === comp.name) return;
      update((g) => {
        const c = g.components.find((x) => x.id === comp.id);
        if (c) c.name = n;
      }, 'Rename component');
    },
    [update],
  );

  return { remove, duplicate, rename };
}

/** Upload helper with progress + error toast. */
export function useUploader() {
  const [progress, setProgress] = useState<number | null>(null);
  const addAssets = useGame((s) => s.addAssets);
  const gameId = useGameId();
  const upload = useCallback(
    async (files: File[], role: AssetRole) => {
      const imgs = files.filter(isImageFile);
      if (files.length && !imgs.length) {
        toast.warning('Those files aren’t images', { description: 'Use PNG, JPG, WebP or SVG files.' });
        return [];
      }
      if (!imgs.length) return [];
      setProgress(0);
      try {
        const assets = await uploadImages(gameId, imgs, role, setProgress);
        addAssets(assets);
        return assets;
      } catch (e: any) {
        toast.error('Upload failed', { description: e?.message ?? 'Please try again.' });
        return [];
      } finally {
        setProgress(null);
      }
    },
    [gameId, addAssets],
  );
  return { progress, busy: progress != null, upload };
}

/* ------------------------------------------------------------------ */
/* Layout helpers                                                       */
/* ------------------------------------------------------------------ */

/** Tracks an element's content size. */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** True when the page is being used with a touch screen. */
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const on = () => setCoarse(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return coarse;
}

/**
 * Enter commits a field *and leaves it*. While focus sits in an input the
 * browser owns Ctrl/Cmd+Z (it undoes the typing), so the page's own undo does
 * nothing — leaving the field hands the shortcut back.
 */
export function commitOnEnter(e: ReactKeyboardEvent) {
  if (e.key !== 'Enter' || e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  if (el instanceof HTMLInputElement && el.type !== 'checkbox' && el.type !== 'radio') el.blur();
}

export function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/* ------------------------------------------------------------------ */
/* Inline name                                                          */
/* ------------------------------------------------------------------ */

export function InlineName({ value, onCommit, className, 'aria-label': ariaLabel }: { value: string; onCommit: (v: string) => void; className?: string; 'aria-label'?: string }) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return (
    <input
      className={`cmp-inline-name ${className ?? ''}`}
      value={draft}
      aria-label={ariaLabel ?? 'Name'}
      spellCheck={false}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        const v = draft.trim();
        if (v && v !== value) onCommit(v);
        else setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          focused.current = false;
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Detail page header                                                   */
/* ------------------------------------------------------------------ */

export function DetailHeader({ comp, meta, actions, menu = [] }: { comp: Component; meta?: ReactNode; actions?: ReactNode; menu?: MenuItem[] }) {
  const navigate = useNavigate();
  const gameId = useGameId();
  const { rename, duplicate, remove } = useComponentActions();
  const game = useGame((s) => s.game);
  const Icon = KIND_META[comp.kind].icon;
  return (
    <header className="cmp-dhead">
      <IconButton icon={ChevronLeft} label="All components" tooltipPlacement="bottom" onClick={() => navigate(`/games/${gameId}/edit/components`)} />
      <div className="cmp-dhead__kind" aria-hidden>
        <Icon size={18} />
      </div>
      <div className="cmp-dhead__titles">
        <InlineName value={comp.name} onCommit={(v) => rename(comp, v)} aria-label={`${KIND_META[comp.kind].label} name`} />
        {meta && <div className="cmp-dhead__meta">{meta}</div>}
        {game && <MadeFrom game={game} componentId={comp.id} />}
      </div>
      <div className="cmp-dhead__actions">
        {actions}
        <MenuButton
          items={[
            ...menu,
            ...(menu.length ? [{ type: 'separator' as const }] : []),
            { label: `Duplicate ${KIND_META[comp.kind].label.toLowerCase()}`, icon: Copy, onSelect: () => duplicate(comp, { open: true }) },
            { label: `Delete ${KIND_META[comp.kind].label.toLowerCase()}`, icon: Trash2, danger: true, onSelect: () => remove(comp, { leave: true }) },
          ]}
        >
          <IconButton icon={MoreHorizontal} label="More actions" variant="secondary" tooltipPlacement="bottom" />
        </MenuButton>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Panel section                                                        */
/* ------------------------------------------------------------------ */

export function PanelSection({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`cmp-psec ${className ?? ''}`}>
      {(title || aside) && (
        <div className="cmp-psec__head">
          {title && <h3 className="cmp-psec__title">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Image slot: preview + upload / choose / remove, accepts dropped files */
/* ------------------------------------------------------------------ */

export function ImageSlot({
  game,
  assetId,
  onChange,
  role = 'image',
  pickerTitle = 'Choose an image',
  width = 64,
  height = 64,
  radius = 8,
  shape,
  emptyLabel = 'No image',
  allowClear = true,
  clearLabel = 'Remove image',
  extraItems,
  compact,
}: {
  game: Pick<Game, 'id' | 'assets'>;
  assetId: ID | null | undefined;
  onChange: (id: ID | null) => void;
  role?: AssetRole;
  pickerTitle?: string;
  width?: number;
  height?: number;
  radius?: number | string;
  shape?: 'hex';
  emptyLabel?: ReactNode;
  allowClear?: boolean;
  clearLabel?: string;
  extraItems?: MenuItem[];
  compact?: boolean;
}) {
  const url = urlOf(game, assetId);
  const { upload, progress, busy } = useUploader();
  const [over, setOver] = useState(false);

  const doUpload = async (files?: File[]) => {
    const f = files ?? (await pickFiles({ multiple: false }));
    if (!f.length) return;
    const [a] = await upload(f.slice(0, 1), role);
    if (a) onChange(a.id);
  };
  const doPick = async () => {
    const id = await pickAsset({ title: pickerTitle, role, current: assetId });
    if (id) onChange(id);
  };

  return (
    <div className={`cmp-slot ${compact ? 'cmp-slot--compact' : ''}`}>
      <button
        type="button"
        className={`cmp-slot__preview ${over ? 'is-over' : ''} ${url ? 'has-image' : ''} ${shape === 'hex' ? 'is-hex' : ''}`}
        style={{ width, height, borderRadius: radius }}
        aria-label={url ? 'Replace image' : 'Upload image'}
        onClick={() => void doUpload()}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void doUpload(Array.from(e.dataTransfer.files));
        }}
      >
        {url ? <img src={url} alt="" draggable={false} /> : <span className="cmp-slot__empty">{emptyLabel}</span>}
        {busy && (
          <span className="cmp-slot__busy">
            <Spinner size={18} />
          </span>
        )}
      </button>
      <div className="cmp-slot__actions">
        <div className="cmp-slot__row">
          <Button size="sm" icon={ImagePlus} onClick={() => void doUpload()} disabled={busy}>
            {url ? 'Replace' : 'Upload'}
          </Button>
          <Button size="sm" icon={Images} variant="ghost" onClick={() => void doPick()} disabled={busy}>
            Choose
          </Button>
          {extraItems && extraItems.length > 0 && (
            <MenuButton items={extraItems} placement="bottom-start">
              <IconButton icon={MoreHorizontal} label="More image options" size="sm" />
            </MenuButton>
          )}
        </div>
        {progress != null ? (
          <ProgressBar value={progress} className="cmp-slot__progress" />
        ) : (
          allowClear &&
          url && (
            <Button size="sm" variant="ghost" icon={X} className="cmp-slot__remove" onClick={() => onChange(null)}>
              {clearLabel}
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Popover                                                              */
/* ------------------------------------------------------------------ */

export function Popover({ anchor, onClose, children, className }: { anchor: DOMRect; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (ref.current) setPos(computePosition(anchor, ref.current.getBoundingClientRect(), 'bottom-start', 8));
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return (
    <Portal>
      <div ref={ref} className={`cmp-popover ${className ?? ''}`} style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, opacity: pos ? 1 : 0 }}>
        {children}
      </div>
    </Portal>
  );
}
