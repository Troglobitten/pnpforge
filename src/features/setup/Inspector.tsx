/**
 * Settings for the current selection — or, with nothing selected, an overview of the
 * starting table: warnings with one-tap fixes, the starting view and a few tips.
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Camera,
  CircleAlert,
  Copy,
  Crosshair,
  Eye,
  Info,
  Lock,
  RotateCcw,
  RotateCw,
  Search,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
  Box,
  Coins,
  Dices,
  Infinity as InfinityIcon,
  Layers,
  LayoutGrid,
  SquareDashed,
  type LucideIcon,
} from 'lucide-react';
import type { Entity, Game, ID, StackEntity, StackLayout, TableState, ZoneAccept, ZoneEntity, ZoneGrid, ZonePieceMode } from '@/shared/types';
import { Button, ColorField, Field, IconButton, NumberField, Segmented, Select, Switch, TextArea, TextInput } from '@/ui';
import { GRID_PAD, ZONE_ACCEPTS, cardName, getComponent, getDeck, ops, pieceModeOf, withGrid, zoneAccepts } from '@/features/play/engine';
import type { TableController } from '@/features/play/table/controller';
import { ZONE_COLORS, cellPresets, stackFace, type Align } from './lib/place';
import { isStartCamera, type SetupWarning } from './lib/warnings';
import { Thumb } from './Palette';
import { PIECE_MATERIALS, PLAYER_COLORS } from '@/features/play/pieces/model';

export interface SetupActions {
  commit: (next: TableState, label: string, coalesceKey?: string) => void;
  arrange: () => void;
  saveStartView: () => void;
  goToStartView: () => void;
  clearStartView: () => void;
  fixWarning: (w: SetupWarning) => void;
  showIds: (ids: ID[]) => void;
  remove: (ids: ID[]) => void;
  duplicate: (ids: ID[]) => void;
  order: (ids: ID[], how: 'front' | 'forward' | 'backward' | 'back') => void;
  align: (ids: ID[], how: Align | 'dist-x' | 'dist-y') => void;
}

interface Props {
  game: Game;
  state: TableState;
  ids: ID[];
  ctl: TableController | null;
  warnings: SetupWarning[];
  actions: SetupActions;
  onClose?: () => void;
}

const KIND_LABEL: Record<Entity['kind'], string> = { stack: 'Cards', board: 'Board', token: 'Tokens', die: 'Die', piece: 'Game piece', counter: 'Counter', zone: 'Zone', note: 'Note' };

export function Inspector({ game, state, ids, ctl, warnings, actions, onClose }: Props) {
  const ents = ids.map((id) => state.entities[id]).filter(Boolean) as Entity[];
  return (
    <div className="setup-insp" data-ui>
      {onClose && <IconButton icon={X} label="Close" className="setup-insp__close" size="sm" onClick={onClose} />}
      {ents.length === 0 ? (
        <Overview game={game} state={state} warnings={warnings} actions={actions} />
      ) : ents.length === 1 ? (
        <Single game={game} state={state} e={ents[0]} ctl={ctl} actions={actions} />
      ) : (
        <Multi game={game} state={state} ents={ents} ctl={ctl} actions={actions} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                             */
/* ------------------------------------------------------------------ */

const LEVEL_ICON: Record<SetupWarning['level'], LucideIcon> = { error: CircleAlert, warning: TriangleAlert, info: Info };

function Overview({ game, state, warnings, actions }: { game: Game; state: TableState; warnings: SetupWarning[]; actions: SetupActions }) {
  const pieces = state.order.length;
  const cards = state.order.reduce((n, id) => {
    const e = state.entities[id];
    return e?.kind === 'stack' ? n + e.cards.length : n;
  }, 0);
  const cam = state.camera;
  const hasView = isStartCamera(cam);
  return (
    <>
      <header className="setup-insp__head">
        <h2 className="setup-insp__title">Starting table</h2>
        <p className="setup-insp__sub">
          Every new game begins exactly like this. {pieces} piece{pieces === 1 ? '' : 's'}
          {cards ? ` · ${cards} card${cards === 1 ? '' : 's'}` : ''}.
        </p>
      </header>

      <section className="setup-insp__sec">
        <h3 className="setup-insp__h">Checks</h3>
        {warnings.length === 0 ? (
          <p className="setup-ok">
            {pieces ? 'Looks ready to play: every component is on the table once.' : 'Nothing on the table yet.'}
          </p>
        ) : (
          <ul className="setup-warns">
            {warnings.map((w) => {
              const Icon = LEVEL_ICON[w.level];
              return (
                <li key={w.key} className={`setup-warn is-${w.level}`}>
                  <Icon size={16} className="setup-warn__icon" aria-hidden />
                  <div className="setup-warn__body">
                    <div className="setup-warn__title">{w.title}</div>
                    {w.detail && <div className="setup-warn__detail">{w.detail}</div>}
                    <div className="setup-warn__actions">
                      {w.fix && (
                        <Button size="sm" variant={w.level === 'info' ? 'secondary' : 'primary'} onClick={() => actions.fixWarning(w)}>
                          {w.fix.label}
                        </Button>
                      )}
                      {w.entityIds?.length ? (
                        <Button size="sm" variant="ghost" icon={Eye} onClick={() => actions.showIds(w.entityIds!)}>
                          Show
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="setup-insp__sec">
        <h3 className="setup-insp__h">Starting view</h3>
        <p className="setup-insp__p">
          {hasView
            ? 'A new game opens framed on the dashed rectangle, scaled to fit the player’s screen.'
            : 'A new game opens zoomed to show everything. Pan and zoom the table, then save the view players should start with.'}
        </p>
        <div className="setup-insp__btns">
          <Button size="sm" variant={hasView ? 'secondary' : 'primary'} icon={Camera} onClick={actions.saveStartView}>
            {hasView ? 'Use this view instead' : 'Use this view as the starting view'}
          </Button>
          {hasView && (
            <>
              <Button size="sm" variant="ghost" icon={Crosshair} onClick={actions.goToStartView}>
                Go to it
              </Button>
              <Button size="sm" variant="ghost" icon={X} onClick={actions.clearStartView}>
                Show everything instead
              </Button>
            </>
          )}
        </div>
      </section>

      <section className="setup-insp__sec">
        <h3 className="setup-insp__h">How to</h3>
        <ul className="setup-tips">
          <li>
            <b>Tap</b> a piece to change its settings; <b>drag</b> to move it.
          </li>
          <li>
            <b>Right-click</b> or <b>long-press</b> for more: duplicate, order, remove.
          </li>
          <li>
            <b>Shift-drag</b> or the <b>select tool</b> picks several pieces at once.
          </li>
          <li>
            <b>Arrow keys</b> nudge · <b>Ctrl+D</b> duplicates · <b>[ ]</b> send back / bring to front · <b>Q E</b> rotate.
          </li>
        </ul>
        {game.components.length > 0 && (
          <Button size="sm" variant="ghost" icon={Wand2} onClick={actions.arrange}>
            Arrange unplaced pieces automatically
          </Button>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* One piece                                                            */
/* ------------------------------------------------------------------ */

function entityTitle(game: Game, e: Entity): string {
  switch (e.kind) {
    case 'stack': {
      const top = e.cards[e.cards.length - 1];
      return e.name || (top ? (e.cards.length === 1 ? cardName(game, top) : getDeck(game, top.deckId)?.name) : undefined) || 'Cards';
    }
    case 'counter':
      return e.label || 'Counter';
    case 'zone':
      return e.label || 'Zone';
    case 'note':
      return 'Note';
    default:
      return getComponent(game, e.componentId)?.name ?? KIND_LABEL[e.kind];
  }
}

function Single({ game, state, e, ctl, actions }: { game: Game; state: TableState; e: Entity; ctl: TableController | null; actions: SetupActions }) {
  const set = (fn: (x: Entity) => Entity, label: string, key?: string) => actions.commit(ops.updateEntity(state, e.id, fn), label, key ? `${key}:${e.id}` : undefined);
  const comp = 'componentId' in e ? getComponent(game, e.componentId) : e.kind === 'stack' ? getDeck(game, e.cards[e.cards.length - 1]?.deckId) : undefined;
  return (
    <>
      <header className="setup-insp__head is-piece">
        {comp ? <Thumb game={game} c={comp} /> : null}
        <div>
          <div className="setup-insp__kind">{e.kind === 'zone' && e.grid ? (e.grid.endless ? 'Endless grid' : 'Grid') : KIND_LABEL[e.kind]}</div>
          <h2 className="setup-insp__title">{entityTitle(game, e)}</h2>
        </div>
      </header>

      <section className="setup-insp__sec">
        {e.kind === 'stack' && <StackFields game={game} st={e} ctl={ctl} set={set} actions={actions} state={state} />}

        {e.kind === 'board' && (
          <>
            <p className="setup-insp__p">
              {comp?.kind === 'board' ? `${Math.round(comp.width)} × ${Math.round(comp.height)} mm` : 'Board'} · boards always sit underneath everything else.
            </p>
          </>
        )}

        {e.kind === 'token' && (
          <>
            <Switch
              checked={!!e.infinite}
              onChange={(v) => set((x) => ({ ...x, infinite: v || undefined, count: v ? 1 : Math.max(1, (x as typeof e).count) }) as Entity, v ? 'Make supply' : 'Make token pile')}
              label={
                <span>
                  Infinite supply
                  <span className="setup-insp__hint">Players can always take one more — it never runs out.</span>
                </span>
              }
            />
            {!e.infinite && (
              <Field label="How many tokens">
                <NumberField value={e.count} min={1} max={999} onChange={(v) => set((x) => ({ ...x, count: Math.max(1, Math.round(v)) }) as Entity, 'Token count', 'count')} />
              </Field>
            )}
            <Field label="Showing">
              <Segmented
                value={e.faceUp ? 'up' : 'down'}
                onChange={(v) => set((x) => ({ ...x, faceUp: v === 'up' }) as Entity, 'Flip token')}
                options={[
                  { value: 'up', label: 'Front' },
                  { value: 'down', label: 'Back' },
                ]}
              />
            </Field>
          </>
        )}

        {e.kind === 'piece' && (
          <>
            <Switch
              checked={!!e.infinite}
              onChange={(v) => set((x) => ({ ...x, infinite: v || undefined }) as Entity, v ? 'Make supply' : 'Make single piece')}
              label={
                <span>
                  Infinite supply
                  <span className="setup-insp__hint">A bowl of them: players drag out as many as they need — it never runs out.</span>
                </span>
              }
            />
            {comp?.kind === 'piece' && (
              <>
                <Field
                  label="Colour"
                  hint={e.color ? undefined : 'Same as the component. Pick another to change just this one.'}
                >
                  <ColorField
                    value={e.color ?? comp.color}
                    swatches={PLAYER_COLORS.map((c) => c.hex)}
                    onChange={(v) => set((x) => ({ ...x, color: v.toLowerCase() === comp.color.toLowerCase() ? undefined : v }) as Entity, 'Piece colour', 'color')}
                  />
                </Field>
                <Field label="Material">
                  <Segmented
                    value={e.material ?? comp.material}
                    onChange={(v) => set((x) => ({ ...x, material: v === comp.material ? undefined : v }) as Entity, 'Piece material')}
                    options={PIECE_MATERIALS.map((m) => ({ value: m.id, label: m.label }))}
                  />
                </Field>
                {(e.color || e.material) && (
                  <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => set((x) => ({ ...x, color: undefined, material: undefined }) as Entity, 'Reset piece look')}>
                    Use the component’s look
                  </Button>
                )}
              </>
            )}
          </>
        )}

        {e.kind === 'die' && (
          <Field label="Starting face">
            <Select
              value={String(e.face)}
              onChange={(v) => set((x) => ({ ...x, face: Number(v) }) as Entity, 'Set die')}
              options={(comp?.kind === 'dice' && comp.faces.length ? comp.faces : [1, 2, 3, 4, 5, 6].map((value) => ({ value }))).map((f, i) => ({
                value: String(i),
                label: ('label' in f && f.label) || String(f.value ?? i + 1),
              }))}
            />
          </Field>
        )}

        {e.kind === 'counter' && (
          <>
            <Field label="Label">
              <TextInput value={e.label} onChange={(ev) => set((x) => ({ ...x, label: ev.target.value }) as Entity, 'Rename counter', 'label')} />
            </Field>
            <Field label="Starting value">
              <NumberField value={e.value} min={e.min} max={e.max} step={e.step || 1} onChange={(v) => set((x) => ({ ...x, value: Math.min(e.max, Math.max(e.min, v)) }) as Entity, 'Counter value', 'value')} />
            </Field>
            <div className="setup-insp__row2">
              <Field label="Min">
                <NumberField size="sm" value={e.min} max={e.max} onChange={(v) => set((x) => ({ ...x, min: v, value: Math.max(v, (x as typeof e).value) }) as Entity, 'Counter range', 'min')} />
              </Field>
              <Field label="Max">
                <NumberField size="sm" value={e.max} min={e.min} onChange={(v) => set((x) => ({ ...x, max: v, value: Math.min(v, (x as typeof e).value) }) as Entity, 'Counter range', 'max')} />
              </Field>
            </div>
            <Field label="Each tap changes it by">
              <NumberField size="sm" value={e.step} min={1} onChange={(v) => set((x) => ({ ...x, step: Math.max(1, v) }) as Entity, 'Counter step', 'step')} />
            </Field>
            <Field label="Colour">
              <ColorField value={e.color} onChange={(v) => set((x) => ({ ...x, color: v }) as Entity, 'Counter colour', 'color')} />
            </Field>
          </>
        )}

        {e.kind === 'zone' && <ZoneFields game={game} z={e} set={set} />}

        {e.kind === 'note' && (
          <>
            <Field label="Text">
              <TextArea rows={4} value={e.text} placeholder="Write a reminder for the player" onChange={(ev) => set((x) => ({ ...x, text: ev.target.value }) as Entity, 'Edit note', 'text')} />
            </Field>
            <SizeFields e={e} set={set} />
            <Field label="Colour">
              <ColorField value={e.color} swatches={ops.NOTE_COLORS} onChange={(v) => set((x) => ({ ...x, color: v }) as Entity, 'Note colour', 'color')} />
            </Field>
          </>
        )}
      </section>

      <Arrange game={game} ents={[e]} ctl={ctl} actions={actions} />
    </>
  );
}

const ACCEPT_OPTS: { value: ZoneAccept; label: string; icon: LucideIcon }[] = [
  { value: 'cards', label: 'Cards', icon: Layers },
  { value: 'tokens', label: 'Tokens', icon: Coins },
  { value: 'pieces', label: 'Pieces', icon: Box },
  { value: 'dice', label: 'Dice', icon: Dices },
];

const MODE_HINT: Record<ZonePieceMode, string> = {
  stack: 'Tokens of one kind pile up with a count. Pieces and dice line up neatly.',
  pool: 'Each one stays separate, gathered in neat rows that close up when one is taken.',
  free: 'Stays where it’s dropped — kept inside the zone and clear of the others. Good for a dice tray.',
};

type SetFn = (fn: (x: Entity) => Entity, label: string, key?: string) => void;

/** What a zone is, what it takes and how things settle in it. Every change shows on the table at once. */
function ZoneFields({ game, z, set }: { game: Game; z: ZoneEntity; set: SetFn }) {
  const g = z.grid;
  const kind = g ? (g.endless ? 'endless' : 'grid') : 'area';
  const accepts = zoneAccepts(z);
  const others = accepts.filter((a) => a !== 'cards');
  const mode = pieceModeOf(z);
  const setZ = (fn: (x: ZoneEntity) => ZoneEntity, label: string, key?: string) => set((x) => fn(x as ZoneEntity) as Entity, label, key);
  const setGrid = (patch: Partial<ZoneGrid>, label: string, key?: string) => setZ((x) => (x.grid ? withGrid(x, { ...x.grid, ...patch }) : x), label, key);
  const presets = cellPresets(game);
  const preset = g ? presets.find((p) => p.value === g.preset && Math.abs(p.w - g.cellW) < 0.05 && Math.abs(p.h - g.cellH) < 0.05) : undefined;
  const r1 = (v: number) => Math.round(v * 10) / 10;

  const changeKind = (k: 'area' | 'grid' | 'endless') =>
    setZ((x) => {
      if (k === 'area') {
        const n = withGrid(x, undefined);
        return x.grid?.endless ? { ...n, w: Math.max(40, n.w + 12), h: Math.max(40, n.h + 12) } : n;
      }
      const base = x.grid ?? { ...(presets[0] ? { cellW: presets[0].w, cellH: presets[0].h, preset: presets[0].value } : { cellW: 63.5, cellH: 88.9, preset: 'card:poker' }), gapX: 4, gapY: 4, cols: 1, rows: 1 };
      if (k === 'endless') return withGrid(x, { ...base, endless: true });
      // an area becoming a grid keeps roughly its size: as many cells as fit
      const fit = (size: number, cell: number, gap: number) => Math.max(1, Math.floor((size - 2 * GRID_PAD + gap) / (cell + gap)));
      const cols = x.grid ? base.cols : fit(x.w, base.cellW, base.gapX);
      const rows = x.grid ? base.rows : fit(x.h, base.cellH, base.gapY);
      return withGrid({ ...x, grid: undefined }, { ...base, endless: undefined, cols, rows });
    }, k === 'area' ? 'Make area' : k === 'grid' ? 'Make grid' : 'Make endless grid');

  return (
    <>
      <Field label="Label" hint={g?.endless ? 'Shown in the editor only — players just see the grid.' : undefined}>
        <TextInput value={z.label} placeholder="e.g. Discard" onChange={(ev) => setZ((x) => ({ ...x, label: ev.target.value }), 'Rename zone', 'label')} />
      </Field>
      <Field
        label="Type"
        hint={kind === 'area' ? 'One area; things dropped in it follow the rules below.' : kind === 'grid' ? 'Rows and columns of cells. Drag a corner to add or remove cells.' : 'Cells across the whole table. Move the marked cell to line it up.'}
      >
        <Segmented
          value={kind}
          onChange={changeKind}
          options={[
            { value: 'area', label: 'Area', icon: SquareDashed },
            { value: 'grid', label: 'Grid', icon: LayoutGrid },
            { value: 'endless', label: 'Endless', icon: InfinityIcon },
          ]}
        />
      </Field>
      <Field label="Takes" hint="Anything else dropped here lands as if on the bare table.">
        <div className="setup-accepts" role="group" aria-label="What the zone takes">
          {ACCEPT_OPTS.map((o) => {
            const on = accepts.includes(o.value);
            const last = on && accepts.length === 1;
            const Icon = o.icon;
            return (
              <button
                key={o.value}
                type="button"
                className={`setup-accept ${on ? 'is-on' : ''}`}
                aria-pressed={on}
                disabled={last}
                title={last ? 'A zone takes at least one kind of thing' : undefined}
                onClick={() => setZ((x) => ({ ...x, accepts: on ? accepts.filter((a) => a !== o.value) : ZONE_ACCEPTS.filter((a) => a === o.value || accepts.includes(a)) }), 'What the zone takes')}
              >
                <Icon size={15} aria-hidden />
                {o.label}
              </button>
            );
          })}
        </div>
      </Field>

      {kind === 'area' && accepts.includes('cards') && (
        <Field label="Cards dropped here" hint={z.snap === 'pile' ? 'Gather into one neat pile.' : z.snap === 'row' ? 'Line up side by side.' : 'Stay where they are dropped.'}>
          <Segmented
            value={z.snap}
            onChange={(v) => setZ((x) => ({ ...x, snap: v }), 'Zone snapping')}
            options={[
              { value: 'pile', label: 'Pile' },
              { value: 'row', label: 'Row' },
              { value: 'free', label: 'Free' },
            ]}
          />
        </Field>
      )}
      {kind === 'area' && others.length > 0 && (
        <Field
          label={`${others.map((a, i) => (i === 0 ? a[0].toUpperCase() + a.slice(1) : a)).join(', ').replace(/, ([^,]*)$/, ' and $1')} dropped here`}
          hint={MODE_HINT[mode]}
        >
          <Segmented
            value={mode}
            onChange={(v) => setZ((x) => ({ ...x, pieceMode: v }), 'Zone arrangement')}
            options={[
              { value: 'stack', label: 'Stack' },
              { value: 'pool', label: 'Pool' },
              { value: 'free', label: 'Free' },
            ]}
          />
        </Field>
      )}

      {g && (
        <>
          <Field label="Cell size">
            <Select
              value={preset ? preset.value : 'custom'}
              onChange={(v) => {
                const p = presets.find((q) => q.value === v);
                if (p) setGrid({ cellW: p.w, cellH: p.h, preset: p.value }, 'Cell size');
              }}
              options={[...(preset ? [] : [{ value: 'custom', label: `Custom · ${r1(g.cellW)} × ${r1(g.cellH)} mm` }]), ...presets.map((p) => ({ value: p.value, label: p.label }))]}
            />
          </Field>
          <div className="setup-insp__row2">
            <Field label="Cell width">
              <NumberField size="sm" unit="mm" precision={1} step={0.5} value={r1(g.cellW)} min={4} max={1000} onChange={(v) => setGrid({ cellW: v, preset: 'custom' }, 'Cell size', 'cellW')} />
            </Field>
            <Field label="Cell height">
              <NumberField size="sm" unit="mm" precision={1} step={0.5} value={r1(g.cellH)} min={4} max={1000} onChange={(v) => setGrid({ cellH: v, preset: 'custom' }, 'Cell size', 'cellH')} />
            </Field>
          </div>
          <div className="setup-insp__row2">
            <Field label="Spacing across">
              <NumberField size="sm" unit="mm" precision={1} step={0.5} value={r1(g.gapX)} min={0} max={500} onChange={(v) => setGrid({ gapX: v }, 'Grid spacing', 'gapX')} />
            </Field>
            <Field label="Spacing down">
              <NumberField size="sm" unit="mm" precision={1} step={0.5} value={r1(g.gapY)} min={0} max={500} onChange={(v) => setGrid({ gapY: v }, 'Grid spacing', 'gapY')} />
            </Field>
          </div>
          {!g.endless ? (
            <div className="setup-insp__row2">
              <Field label="Columns">
                <NumberField size="sm" value={g.cols} min={1} max={60} onChange={(v) => setGrid({ cols: Math.round(v) }, 'Grid size', 'cols')} />
              </Field>
              <Field label="Rows">
                <NumberField size="sm" value={g.rows} min={1} max={60} onChange={(v) => setGrid({ rows: Math.round(v) }, 'Grid size', 'rows')} />
              </Field>
            </div>
          ) : (
            <div className="setup-insp__row2">
              <Field label="Origin across">
                <NumberField size="sm" unit="mm" precision={1} step={0.5} value={r1(z.x)} onChange={(v) => setZ((x) => ({ ...x, x: v }), 'Move grid', 'ox')} />
              </Field>
              <Field label="Origin down">
                <NumberField size="sm" unit="mm" precision={1} step={0.5} value={r1(z.y)} onChange={(v) => setZ((x) => ({ ...x, y: v }), 'Move grid', 'oy')} />
              </Field>
            </div>
          )}
          <p className="setup-insp__p">
            {g.endless ? `Cells every ${r1(g.cellW + g.gapX)} × ${r1(g.cellH + g.gapY)} mm, across the whole table.` : `${g.cols * g.rows} cells · ${Math.round(z.w)} × ${Math.round(z.h)} mm.`} Items snap to the cell under their centre; a
            card on a taken cell goes on top, pieces move to the nearest free one.
          </p>
        </>
      )}

      {kind === 'area' && <SizeFields e={z} set={set} />}
      {accepts.includes('cards') && (
        <Field label="Turn cards">
          <Segmented
            value={z.forceFace ?? 'keep'}
            onChange={(v) => setZ((x) => ({ ...x, forceFace: v === 'keep' ? undefined : v }), 'Zone facing')}
            options={[
              { value: 'keep', label: 'Keep side' },
              { value: 'up', label: 'Face up' },
              { value: 'down', label: 'Face down' },
            ]}
          />
        </Field>
      )}
      <Field label="Colour">
        <ColorField value={z.color} swatches={ZONE_COLORS} onChange={(v) => setZ((x) => ({ ...x, color: v }), 'Zone colour', 'color')} />
      </Field>
    </>
  );
}

function SizeFields({ e, set }:{ e: Extract<Entity, { kind: 'zone' | 'note' }>; set: (fn: (x: Entity) => Entity, label: string, key?: string) => void }) {
  return (
    <div className="setup-insp__row2">
      <Field label="Width">
        <NumberField size="sm" unit="mm" value={Math.round(e.w)} min={20} max={2000} onChange={(v) => set((x) => ({ ...x, w: Math.max(20, v) }) as Entity, 'Resize', 'w')} />
      </Field>
      <Field label="Height">
        <NumberField size="sm" unit="mm" value={Math.round(e.h)} min={20} max={2000} onChange={(v) => set((x) => ({ ...x, h: Math.max(20, v) }) as Entity, 'Resize', 'h')} />
      </Field>
    </div>
  );
}

const LAYOUTS: { value: StackLayout; label: string }[] = [
  { value: 'pile', label: 'Pile' },
  { value: 'row', label: 'Row' },
  { value: 'fan', label: 'Fan' },
  { value: 'grid', label: 'Grid' },
];

function StackFields({
  game,
  st,
  ctl,
  set,
  actions,
  state,
}: {
  game: Game;
  st: StackEntity;
  ctl: TableController | null;
  set: (fn: (x: Entity) => Entity, label: string, key?: string) => void;
  actions: SetupActions;
  state: TableState;
}) {
  const face = stackFace(st);
  const deck = getDeck(game, st.cards[st.cards.length - 1]?.deckId);
  const n = st.cards.length;
  return (
    <>
      <Field label="Name" hint={deck && !st.name ? `Shown as “${deck.name}”` : undefined}>
        <TextInput value={st.name ?? ''} placeholder={deck?.name ?? 'Stack name'} onChange={(ev) => set((x) => ({ ...x, name: ev.target.value || undefined }) as Entity, 'Rename stack', 'name')} />
      </Field>
      <div className="setup-insp__stat">
        <span>
          {n} card{n === 1 ? '' : 's'}
          {deck ? ` from ${deck.name}` : ''}
        </span>
        <Button size="sm" variant="ghost" icon={Search} onClick={() => ctl?.browse(st.id)}>
          Look through
        </Button>
      </div>
      {n > 1 && (
        <Switch
          checked={!!st.shuffleOnStart}
          onChange={(v) => set((x) => ({ ...x, shuffleOnStart: v || undefined }) as Entity, v ? 'Shuffle on start' : 'Keep card order')}
          label={
            <span>
              Shuffle when the game starts
              <span className="setup-insp__hint">{st.shuffleOnStart ? 'Every new game deals from a freshly shuffled stack.' : 'Cards stay in the order you see here.'}</span>
            </span>
          }
        />
      )}
      <Field label="Cards start" hint={face === 'mixed' ? `Mixed: ${st.cards.filter((c) => c.faceUp).length} face up. Pick one to make them all the same.` : undefined}>
        <Segmented
          value={face}
          onChange={(v) => v !== 'mixed' && actions.commit(ops.setStackFace(state, st.id, v === 'up'), v === 'up' ? 'Start face up' : 'Start face down')}
          options={[
            { value: 'down', label: 'Face down' },
            { value: 'up', label: 'Face up' },
          ]}
        />
      </Field>
      {n > 1 && (
        <Field label="Laid out as">
          <Segmented value={st.layout} onChange={(v) => ctl?.setLayout(st.id, v)} options={LAYOUTS} />
        </Field>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Several pieces                                                       */
/* ------------------------------------------------------------------ */

function Multi({ game, state, ents, ctl, actions }: { game: Game; state: TableState; ents: Entity[]; ctl: TableController | null; actions: SetupActions }) {
  const ids = ents.map((e) => e.id);
  const kinds = new Map<string, number>();
  for (const e of ents) kinds.set(KIND_LABEL[e.kind], (kinds.get(KIND_LABEL[e.kind]) ?? 0) + 1);
  const stacks = ents.filter((e): e is StackEntity => e.kind === 'stack');
  const shuffleAll = stacks.length > 0 && stacks.every((s) => s.shuffleOnStart);
  const faces = new Set(stacks.map(stackFace));
  const face = faces.size === 1 ? [...faces][0] : 'mixed';
  const al = (icon: LucideIcon, label: string, how: Align | 'dist-x' | 'dist-y', disabled = false) => (
    <IconButton icon={icon} label={label} size="sm" disabled={disabled} onClick={() => actions.align(ids, how)} />
  );
  return (
    <>
      <header className="setup-insp__head">
        <div className="setup-insp__kind">Selection</div>
        <h2 className="setup-insp__title">{ents.length} pieces</h2>
        <p className="setup-insp__sub">{[...kinds].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ')}</p>
      </header>
      {stacks.length > 0 && (
        <section className="setup-insp__sec">
          <h3 className="setup-insp__h">
            {stacks.length} stack{stacks.length === 1 ? '' : 's'} of cards
          </h3>
          <Switch
            checked={shuffleAll}
            onChange={(v) => {
              let s = state;
              for (const st of stacks) s = ops.updateEntity(s, st.id, (x) => ({ ...x, shuffleOnStart: v || undefined }) as Entity);
              actions.commit(s, v ? 'Shuffle on start' : 'Keep card order');
            }}
            label="Shuffle when the game starts"
          />
          <Field label="Cards start">
            <Segmented
              value={face}
              onChange={(v) => {
                if (v === 'mixed') return;
                let s = state;
                for (const st of stacks) s = ops.setStackFace(s, st.id, v === 'up');
                actions.commit(s, v === 'up' ? 'Start face up' : 'Start face down');
              }}
              options={[
                { value: 'down', label: 'Face down' },
                { value: 'up', label: 'Face up' },
              ]}
            />
          </Field>
        </section>
      )}
      <section className="setup-insp__sec">
        <h3 className="setup-insp__h">Align</h3>
        <div className="setup-insp__tools">
          {al(AlignStartVertical, 'Align left edges', 'left')}
          {al(AlignCenterVertical, 'Align centres (vertical line)', 'hcenter')}
          {al(AlignEndVertical, 'Align right edges', 'right')}
          {al(AlignStartHorizontal, 'Align top edges', 'top')}
          {al(AlignCenterHorizontal, 'Align middles (horizontal line)', 'vcenter')}
          {al(AlignEndHorizontal, 'Align bottom edges', 'bottom')}
          {al(AlignHorizontalDistributeCenter, 'Space evenly left to right', 'dist-x', ents.length < 3)}
          {al(AlignVerticalDistributeCenter, 'Space evenly top to bottom', 'dist-y', ents.length < 3)}
        </div>
      </section>
      <Arrange game={game} ents={ents} ctl={ctl} actions={actions} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Shared: rotate / lock / order / duplicate / remove                   */
/* ------------------------------------------------------------------ */

function Arrange({ game, ents, ctl, actions }: { game: Game; ents: Entity[]; ctl: TableController | null; actions: SetupActions }) {
  void game;
  const ids = ents.map((e) => e.id);
  const norm = (r: number) => String((((Math.round(r) % 360) + 360) % 360));
  const rots = new Set(ents.map((e) => norm(e.rot)));
  const rot = rots.size === 1 ? [...rots][0] : '';
  const locked = ents.every((e) => e.locked);
  const onlyStacks = ents.every((e) => e.kind === 'stack');
  const boardOnly = ents.every((e) => e.kind === 'board');
  return (
    <section className="setup-insp__sec">
      <h3 className="setup-insp__h">Placement</h3>
      <Field label="Rotation">
        <div className="setup-insp__rot">
          <Segmented
            size="sm"
            value={rot as '0' | '90' | '180' | '270'}
            onChange={(v) => ctl?.setRotation(ids, Number(v))}
            options={[
              { value: '0', label: '0°' },
              { value: '90', label: '90°' },
              { value: '180', label: '180°' },
              { value: '270', label: '270°' },
            ]}
          />
          <IconButton icon={RotateCcw} label="Rotate left" shortcut="Q" size="sm" onClick={() => ctl?.rotate(ids, -90)} />
          <IconButton icon={RotateCw} label="Rotate right" shortcut="E" size="sm" onClick={() => ctl?.rotate(ids, 90)} />
        </div>
      </Field>
      <Switch
        checked={locked}
        onChange={(v) => actions.commit(ops.setLocked(ctl?.state ?? ({} as TableState), ids, v), v ? 'Lock' : 'Unlock')}
        label={
          <span>
            <Lock size={13} aria-hidden /> Locked in place
            <span className="setup-insp__hint">{boardOnly ? 'Recommended for boards: players can’t nudge them by accident.' : 'Players can’t move it by accident. Dragging it pans the table.'}</span>
          </span>
        }
      />
      <Field label="Stacking order">
        <div className="setup-insp__tools">
          <IconButton icon={ArrowUpToLine} label="Bring to front" shortcut="]" size="sm" onClick={() => actions.order(ids, 'front')} />
          <IconButton icon={ArrowUp} label="Bring forward" size="sm" onClick={() => actions.order(ids, 'forward')} />
          <IconButton icon={ArrowDown} label="Send backward" size="sm" onClick={() => actions.order(ids, 'backward')} />
          <IconButton icon={ArrowDownToLine} label="Send to back" shortcut="[" size="sm" onClick={() => actions.order(ids, 'back')} />
        </div>
      </Field>
      <div className="setup-insp__btns">
        <Button
          size="sm"
          variant="secondary"
          icon={Copy}
          disabled={onlyStacks}
          title={onlyStacks ? 'A deck can only be on the table once — its cards would be duplicated. Split it instead.' : 'Ctrl+D'}
          onClick={() => actions.duplicate(ids)}
        >
          Duplicate
        </Button>
        <Button size="sm" variant="ghost" icon={Eye} onClick={() => actions.showIds(ids)}>
          Zoom to
        </Button>
        <Button size="sm" variant="danger" icon={Trash2} onClick={() => actions.remove(ids)}>
          Remove from table
        </Button>
      </div>
      {onlyStacks && <p className="setup-insp__hint">Decks can’t be duplicated — that would copy their cards. Use “Arrange as → Split in half” to divide one.</p>}
    </section>
  );
}
