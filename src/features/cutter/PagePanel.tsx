/**
 * The Page panel: what's on this page and how it is framed. With nothing framed it asks one
 * question — what's here, and how many rows × columns — and never guesses (owner ruling; the flat-
 * page helpers come in a later stage and never on photos). With a grid it holds the grid's
 * settings; with a frame selected, that frame's.
 */
import { useRef, useState, type ReactNode } from 'react';
import { produce } from 'immer';
import { Copy, Grid3x3, Link2, Minus, MousePointerSquareDashed, Plus, RotateCcw, RotateCw, Sparkles, SquareDashed, Trash2, Undo2, Unlink2, X } from 'lucide-react';
import { Button, NumberField, Segmented, Select, Slider, Switch, toast } from '@/ui';
import type { CutKind, CutterDoc, Game, PageRef } from '@/shared/types';
import { cellCount, GRID_MAX } from '@/shared/cutter/grid';
import { commit, goTo, select, setDrawing, useCutter } from './store';
import {
  addFrame,
  addGrid,
  copyPage,
  deleteGrid,
  groupTint,
  KIND_LABEL,
  KIND_NOUN,
  linkedGrids,
  groupLabel,
  groupPages,
  pageLabel,
  moveToGroup,
  setFrameSame,
  setGridSame,
  pageContent,
  pageDims,
  putBack,
  removeFrame,
  restoreCells,
  sameRef,
  setFrameShape,
  setBackOffset,
  setGridBacks,
  setGridParams,
  setPageKind,
  toggleExcluded,
  turnFrame,
  unlinkGrid,
  useGridOn,
  type PageDims,
} from './ops';
import { asImageSet, setPagePhoto } from './addSources';
import { GroupOverviewTop, GroupPanel } from './GroupPanel';
import { usePreview } from './previews';
import { DEFAULT_CLEAN } from '@/shared/cutter/doc';
import { PageThumbImg } from './thumbs';
import { FindButton, GridHelpers, SnapButton, useEmptySpaces } from './FlatHelpers';

const KINDS: { value: CutKind; label: ReactNode; title: string }[] = [
  { value: 'cards', label: 'Cards', title: 'Cards' },
  { value: 'tokens', label: 'Tokens', title: 'Tokens' },
  { value: 'board', label: 'Board', title: 'Board' },
  // "Back" in a narrow panel, so the five choices stay on one row
  {
    value: 'back',
    label: (
      <>
        <span className="cut-long">Card back</span>
        <span className="cut-short">Back</span>
      </>
    ),
    title: 'Card back',
  },
  { value: 'cover', label: 'Cover', title: 'Cover' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Slider bursts: one undo step per burst of changes. */
export function useBurst() {
  const last = useRef(0);
  return (label: string, recipe: Parameters<typeof commit>[1]) => {
    const now = Date.now();
    if (now - last.current > 700) commit(label, recipe);
    else useCutter.setState((s) => ({ doc: produceNoUndo(s.doc, recipe) }));
    last.current = now;
  };
}
const produceNoUndo = (doc: CutterDoc, recipe: Parameters<typeof commit>[1]) => produce(doc, recipe);

export function Stepper({ label, value, min, max, onChange, testid }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; testid: string }) {
  return (
    <div className="cut-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)} data-testid={`${testid}-minus`}>
        <Minus size={16} />
      </button>
      <span className="cut-stepper__n" aria-live="polite" data-testid={`${testid}-n`}>
        {value}
      </span>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)} data-testid={`${testid}-plus`}>
        <Plus size={16} />
      </button>
    </div>
  );
}

export function PagePanel({ game, at }: { game: Game; at: PageRef }) {
  const doc = useCutter((s) => s.doc);
  const sel = useCutter((s) => s.sel);
  const drawing = useCutter((s) => s.drawing);
  const burst = useBurst();
  const d = pageDims(game, at);
  const source = game.sources.find((s) => s.id === at.sourceId);
  const page = source?.pages[at.page];
  if (!d || !source || !page) return null;
  const { grids, frames, numbers } = pageContent(doc, at);
  const grid = grids.find((g) => g.id === sel.gridId) ?? grids[grids.length - 1];
  const frame = sel.frameId ? doc.frames[sel.frameId] : undefined;
  const isImage = source.kind === 'images' || source.kind === 'image';
  const adding = useCutter((s) => s.addingGrid);

  return (
    <div className="cut-panel" data-testid="page-panel">
      <GroupOverviewTop game={game} at={at} />
      <PageHead game={game} at={at} d={d} isImage={isImage} />

      {frame && sameRef(frame.at, at) ? (
        <FrameSection game={game} doc={doc} frameId={frame.id} n={numbers.get(frame.id) ?? 0} d={d} />
      ) : !frames.length ? (
        <StartSection key={`${at.sourceId}:${at.page}`} game={game} doc={doc} at={at} d={d} />
      ) : (
        <>
          {grids.length > 1 && <GridTabs doc={doc} grids={grids.map((g) => g.id)} current={grid?.id} />}
          {grid && <GridSection game={game} doc={doc} gridId={grid.id} d={d} burst={burst} />}
          <FramesSummary doc={doc} at={at} />
        </>
      )}

      {d.photo && !!frames.length && <CleanSection game={game} doc={doc} at={at} burst={burst} />}

      {!!frames.length && !frame && adding && <StartSection key={`a${at.sourceId}:${at.page}`} game={game} doc={doc} at={at} d={d} another />}

      {!!frames.length && !frame && (
        <section className="cut-sec">
          <h3 className="cut-sec__title">Add to this page</h3>
          <div className="cut-row">
            <Button size="sm" icon={Grid3x3} variant={adding ? 'primary' : 'secondary'} aria-pressed={adding} onClick={() => useCutter.setState({ addingGrid: !adding })} data-testid="add-grid">
              Another grid
            </Button>
            <Button size="sm" icon={Plus} onClick={() => {
                let id = '';
                commit('Add a frame', (doc) => void (id = addFrame(doc, at, d, null).id));
                select({ frameId: id });
              }} data-testid="add-frame">
              Add a frame
            </Button>
            <Button size="sm" variant={drawing ? 'primary' : 'secondary'} icon={SquareDashed} onClick={() => setDrawing(!drawing)} aria-pressed={drawing} data-testid="draw-frame">
              {drawing ? 'Drawing… (Esc)' : 'Draw a frame'}
            </Button>
          </div>
          <p className="cut-muted">Cards and tokens on one sheet? Add another grid for the tokens — each kind is its own group.</p>
        </section>
      )}

      <GroupPanel game={game} at={at} />
    </div>
  );
}

/** Several grids on one page (cards and tokens, say): pick the one to set up. */
function GridTabs({ doc, grids, current }: { doc: CutterDoc; grids: string[]; current?: string }) {
  return (
    <div className="cut-gridtabs" role="tablist" aria-label="Grids on this page">
      {grids.map((id) => {
        const g = doc.grids[id];
        const group = doc.groups.find((x) => x.id === g.groupId);
        return (
          <button key={id} type="button" role="tab" aria-selected={id === current} className={`cut-gridtab cut-t${groupTint(doc, g.groupId)} ${id === current ? 'is-on' : ''}`} onClick={() => select({ gridId: id })} data-testid="grid-tab">
            <span className="cut-swatch" aria-hidden /> {group ? groupLabel(group) : 'Grid'} · {g.rows}×{g.cols}
          </button>
        );
      })}
    </div>
  );
}

function PageHead({ game, at, d, isImage }: { game: Game; at: PageRef; d: PageDims; isImage: boolean }) {
  const source = game.sources.find((s) => s.id === at.sourceId)!;
  // an image added before v3: switching it to a photo turns the source into an image set first
  const older = source.kind === 'image';
  const page = source.pages[at.page];
  const title = isImage ? (page.name ?? `Image ${at.page + 1}`) : `Page ${at.page + 1}`;
  const meta = isImage ? (d.photo ? `Photo · ${page.px?.w} × ${page.px?.h} px` : `Flat scan · ${Math.round(d.w * (d.mmPerUnit ?? 0))} × ${Math.round(d.h * (d.mmPerUnit ?? 0))} mm at ${page.dpi ?? 300} dpi`) : `${source.name} · ${Math.round(d.w)} × ${Math.round(d.h)} mm`;
  // one undo step: the page flag and its grids (the photo corners are kept while it is a scan)
  const setPhoto = (v: boolean) => {
    if (older) {
      if (!asImageSet(game.id, source.id)) return;
      if (!v) setPagePhoto(at, false);
      return;
    }
    setPagePhoto(at, v);
  };
  return (
    <section className="cut-sec cut-sec--head">
      <div className="cut-head">
        <h2 className="cut-head__title" title={title}>
          {title}
        </h2>
        <span className="cut-head__meta">{meta}</span>
      </div>
      {isImage && (
        <div className="cut-photo">
          <Switch checked={d.photo} onChange={setPhoto} label="This is a photo" />
          <p className="cut-muted">{d.photo ? 'Taken with a camera: the frames follow the perspective, and the pieces are straightened.' : 'A flat scan: square frames and a known size (300 dpi).'}</p>
        </div>
      )}
    </section>
  );
}

/** A new grid starts from these rows × columns unless the user set others. */
const startDefault = (kind: CutKind) => (kind === 'cards' || kind === 'tokens' ? { rows: 3, cols: 3 } : { rows: 1, cols: 1 });

/** "Keepers · page 3, 5" — the pages only when the name does not already say them. */
function groupWithPages(game: Game, doc: CutterDoc, g: CutterDoc['groups'][number]) {
  const labels = groupPages(doc, g.id, game).map((p) => pageLabel(game, p));
  if (!labels.length) return `${groupLabel(g)} · empty`;
  const lower = g.name.toLowerCase();
  const said = labels.every((l) => lower.includes(l.toLowerCase()));
  return said ? groupLabel(g) : `${groupLabel(g)} · ${labels.length > 3 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3}` : labels.join(', ')}`;
}

function StartSection({ game, doc, at, d, another }: { game: Game; doc: CutterDoc; at: PageRef; d: PageDims; another?: boolean }) {
  const kind = useCutter((s) => s.startKind);
  const rows = useCutter((s) => s.startRows);
  const cols = useCutter((s) => s.startCols);
  const set = (p: Partial<{ startKind: CutKind; startRows: number; startCols: number }>) => useCutter.setState(p);
  const source = game.sources.find((s) => s.id === at.sourceId)!;
  const noun = KIND_NOUN[kind];
  const n = rows * cols;
  // where the frames go: a new group named from this page, unless the user picks one
  const newName = `${KIND_LABEL[kind]} — ${pageLabel(game, at)}`;
  const [into, setInto] = useState<string>('new');
  const target = into === 'new' ? null : doc.groups.find((g) => g.id === into);

  // photos: the photo before with frames (copies, never linked)
  let prevPhoto: PageRef | null = null;
  if (d.photo)
    for (let p = at.page - 1; p >= 0; p--) {
      const ref = { sourceId: at.sourceId, page: p };
      const pd = pageDims(game, ref);
      if (pd?.photo && pageContent(doc, ref).frames.length) {
        prevPhoto = ref;
        break;
      }
    }
  // flat pages: the page before of the same size with a grid (linked)
  let prevGrid: { at: PageRef; gridId: string } | null = null;
  if (!d.photo && d.sizeKey)
    for (let p = at.page - 1; p >= 0; p--) {
      const ref = { sourceId: at.sourceId, page: p };
      const g = pageContent(doc, ref).grids[0];
      if (g && pageDims(game, ref)?.sizeKey === d.sizeKey) {
        prevGrid = { at: ref, gridId: g.id };
        break;
      }
    }

  const label = (r: PageRef) => (source.kind === 'images' ? (source.pages[r.page].name ?? `image ${r.page + 1}`) : `page ${r.page + 1}`);
  return (
    <section className="cut-sec" data-testid={another ? 'start-another' : 'start'}>
      <h3 className="cut-sec__title">{another ? 'Another grid on this page' : 'What’s on this page?'}</h3>
      <Segmented<CutKind> size="sm" aria-label="What's on this page" value={kind} onChange={(k) => set({ startKind: k, ...(k === 'board' || k === 'cover' || k === 'back' ? { startRows: 1, startCols: 1 } : {}) })} options={KINDS} />
      <div className="cut-field">
        <div className="cut-field__label">Rows × columns</div>
        <div className="cut-rc">
          <Stepper label="Rows" value={rows} min={1} max={GRID_MAX} onChange={(v) => set({ startRows: v })} testid="start-rows" />
          <X size={14} className="cut-rc__x" aria-hidden />
          <Stepper label="Columns" value={cols} min={1} max={GRID_MAX} onChange={(v) => set({ startCols: v })} testid="start-cols" />
        </div>
        {(rows !== startDefault(kind).rows || cols !== startDefault(kind).cols) && (
          <p className="cut-muted cut-kept" data-testid="start-kept">
            {rows} × {cols}, as you set it last.{' '}
            <button type="button" className="cut-textbtn" onClick={() => set({ startRows: startDefault(kind).rows, startCols: startDefault(kind).cols })} data-testid="start-reset">
              Start from {startDefault(kind).rows} × {startDefault(kind).cols}
            </button>
          </p>
        )}
      </div>
      <label className="cut-field" data-testid="start-into">
        <span className="cut-field__label">Goes into</span>
        <Select<string>
          value={target ? into : 'new'}
          onChange={setInto}
          options={[{ value: 'new', label: `A new group: ${newName}` }, ...doc.groups.map((g) => ({ value: g.id, label: groupWithPages(game, doc, g) }))]}
        />
      </label>
      <FindButton game={game} at={at} d={d} kind={kind} into={target ? { groupId: target.id, name: target.name } : { name: newName }} onDone={() => useCutter.setState({ addingGrid: false })} />
      <Button variant={d.photo ? 'primary' : 'secondary'} icon={Grid3x3} block onClick={() => {
          let id = '';
          commit(`Frame ${plural(n, noun[0], noun[1])}`, (doc) => void (id = addGrid(doc as CutterDoc, at, d, kind, rows, cols, target ? { groupId: target.id, name: target.name } : { name: newName }).id));
          select({ gridId: id });
          useCutter.setState({ addingGrid: false });
        }} data-testid="start-grid">
        Frame {plural(n, noun[0], noun[1])}
      </Button>
      <p className="cut-muted">{d.photo ? 'A grid appears on the photo — drag its four corners onto the outer corners of the pieces.' : 'A grid appears on the page — drag it onto the pieces, or its edges and corners to fit.'}</p>
      {!another && <div className="cut-or">or</div>}
      {!another && (
      <div className="cut-col">
        {prevPhoto && (
          <Button icon={Copy} block onClick={() => {
            commit('Same frames as the previous photo', (doc) => copyPage(doc as CutterDoc, prevPhoto!, pageDims(game, prevPhoto!)!, at, d));
            const gs = [...new Set(pageContent(useCutter.getState().doc, at).frames.map((f) => f.groupId))].map((id) => useCutter.getState().doc.groups.find((g) => g.id === id)).filter(Boolean);
            if (gs.length) toast(`Into ${gs.map((g) => groupLabel(g!)).join(' and ')}`, { description: 'The same group as the photo before — change it under “Goes into”.' });
          }} data-testid="same-as-prev">
            Same frames as {label(prevPhoto)}
          </Button>
        )}
        {prevPhoto && <p className="cut-muted">A copy of its grid and frames, placed the same. Pieces left out there start back in here.</p>}
        {prevGrid && (
          <Button icon={Link2} block onClick={() => commit(`Same grid as ${label(prevGrid!.at)}`, (doc) => void useGridOn(doc as CutterDoc, prevGrid!.gridId, [at]))} data-testid="same-grid-as">
            Same grid as {label(prevGrid.at)} (linked)
          </Button>
        )}
        <Button icon={MousePointerSquareDashed} block onClick={() => setDrawing(true)} data-testid="start-draw">
          Draw one frame
        </Button>
      </div>
      )}
    </section>
  );
}

function GridSection({ game, doc, gridId, d, burst }: { game: Game; doc: CutterDoc; gridId: string; d: PageDims; burst: ReturnType<typeof useBurst> }) {
  const g = doc.grids[gridId];
  const group = g ? doc.groups.find((x) => x.id === g.groupId) : undefined;
  // hooks first: this section has two shapes (a normal grid, a linked back grid)
  const empties = useEmptySpaces(doc, g?.at ?? null, gridId);
  if (!g || !group) return null;
  if (g.backOf?.linked) return <BackGridSection game={game} doc={doc} gridId={gridId} d={d} />;
  const n = cellCount(g) - g.removed.length - (g.skipBlank ? empties.size : 0);
  const noun: [string, string] = g.backs || g.backOf ? ['back', 'backs'] : KIND_NOUN[group.kind];
  const links = linkedGrids(doc, g.id);
  const source = game.sources.find((s) => s.id === g.at.sourceId)!;
  // flat pages of the same paper size in this file that have nothing on them yet
  const samePages =
    !d.photo && d.sizeKey
      ? source.pages
          .map((_, i) => ({ sourceId: source.id, page: i }))
          .filter((r) => r.page !== g.at.page && pageDims(game, r)?.sizeKey === d.sizeKey && !pageContent(doc, r).frames.length)
      : [];
  const set = (label: string, next: Parameters<typeof setGridParams>[2]) => commit(label, (doc) => setGridParams(doc as CutterDoc, g.id, next, d));
  const gapLabel = (share: number, along: 'x' | 'y') => {
    if (d.mmPerUnit == null || !g.square) return `${Math.round(share * 100)}%`;
    // a square grid on a flat page: the gap in mm
    const q = g.anchors;
    const W = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
    const H = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
    const cw = W / (g.cols + (g.cols - 1) * g.gapX);
    const ch = H / (g.rows + (g.rows - 1) * g.gapY);
    return `${((along === 'x' ? cw : ch) * share * d.mmPerUnit).toFixed(1)} mm`;
  };
  return (
    <section className={`cut-sec cut-t${groupTint(doc, g.groupId)}`} data-testid="grid-section">
      <h3 className="cut-sec__title">
        <span className="cut-swatch" aria-hidden /> Grid · {plural(n, noun[0], noun[1])}
      </h3>
      <GroupPick doc={doc} value={g.groupId} photo={d.photo} label="Goes into" onPick={(target) => commit('Move the grid to another group', (doc) => void moveToGroup(doc as CutterDoc, { gridId: g.id }, target, (r) => pageDims(game, r)))} testid="grid-group" pageName={pageLabel(game, g.at)} />
      {group.kind === 'tokens' && (
        <div className="cut-field">
          <div className="cut-field__label">The pieces in this grid are</div>
          <Segmented<'same' | 'different'>
            size="sm"
            aria-label="The pieces in this grid are"
            value={g.same ? 'same' : 'different'}
            onChange={(v) => commit(v === 'same' ? 'All the same token' : 'All different tokens', (doc) => setGridSame(doc as CutterDoc, g.id, v === 'same'))}
            options={[
              { value: 'same', label: `All the same ×${n}` },
              { value: 'different', label: 'All different' },
            ]}
          />
          <p className="cut-muted">{g.same ? `One token, ${n} of them in the game. You say which are the same — nothing is matched by looks.` : `${n} different tokens, one of each. Tap a number to make one frame the same as another.`}</p>
        </div>
      )}
      <div className="cut-field">
        <div className="cut-field__label">Rows × columns</div>
        <div className="cut-rc">
          <Stepper label="Rows" value={g.rows} min={1} max={GRID_MAX} onChange={(v) => set(`${v} rows`, { rows: v })} testid="rows" />
          <X size={14} className="cut-rc__x" aria-hidden />
          <Stepper label="Columns" value={g.cols} min={1} max={GRID_MAX} onChange={(v) => set(`${v} columns`, { cols: v })} testid="cols" />
        </div>
      </div>
      {g.cols > 1 && (
        <div className="cut-field">
          <div className="cut-field__label">
            <span>Space between columns</span>
            <span className="cut-field__val">{gapLabel(g.gapX, 'x')}</span>
          </div>
          <Slider aria-label="Space between columns" min={0} max={0.8} step={0.005} value={g.gapX} onChange={(v) => burst('Space between columns', (doc) => setGridParams(doc as CutterDoc, g.id, { gapX: v }, d))} />
        </div>
      )}
      {g.rows > 1 && (
        <div className="cut-field">
          <div className="cut-field__label">
            <span>Space between rows</span>
            <span className="cut-field__val">{gapLabel(g.gapY, 'y')}</span>
          </div>
          <Slider aria-label="Space between rows" min={0} max={0.8} step={0.005} value={g.gapY} onChange={(v) => burst('Space between rows', (doc) => setGridParams(doc as CutterDoc, g.id, { gapY: v }, d))} />
        </div>
      )}
      <div className="cut-switches">
        <Switch checked={g.square} onChange={(v) => set(v ? 'Keep it square' : 'Free corners', { square: v })} label="Keep it square" />
        <p className="cut-muted">{g.square ? 'The grid stays a rectangle. Turn it off for a sheet photographed at an angle or printed skewed.' : 'Each corner moves on its own, for pieces seen at an angle.'}</p>
        {group.kind === 'tokens' && <Switch checked={g.round} onChange={(v) => set(v ? 'Round pieces' : 'Square pieces', { round: v })} label="Round pieces" />}
        {(group.kind === 'cards' || group.kind === 'tokens') && (
          <>
            <Switch
              checked={!!(g.backs || g.backOf)}
              onChange={(v) =>
                commit(v ? 'These are backs' : 'These are fronts', (doc) => {
                  const cd = doc as CutterDoc;
                  if (!v) delete cd.grids[g.id].backOf;
                  setGridBacks(cd, g.id, v);
                })
              }
              label="These are backs"
              data-testid="grid-backs"
            />
            {(g.backs || g.backOf) && (
              <p className="cut-muted">
                {g.backOf ? `The backs of ${pageLabel(game, doc.grids[g.backOf.gridId]?.at ?? g.at)}, turned over — its own handles, laid out mirrored to start with.` : 'The backs of this group’s pieces. Pair them under Backs, or by hand in Pieces.'}
              </p>
            )}
          </>
        )}
      </div>
      <div className="cut-row">
        <Button size="sm" icon={RotateCcw} onClick={() => set('Turn all left', { turn: (g.turn + 3) % 4 })} data-testid="turn-all-left">
          Turn all left
        </Button>
        <Button size="sm" icon={RotateCw} onClick={() => set('Turn all right', { turn: (g.turn + 1) % 4 })} data-testid="turn-all-right">
          Turn all right
        </Button>
      </div>
      <GridHelpers game={game} doc={doc} grid={g} d={d} />
      {!!g.removed.length && (
        <Button size="sm" variant="ghost" icon={Undo2} onClick={() => commit('Put removed frames back', (doc) => restoreCells(doc as CutterDoc, g.id))}>
          Put {plural(g.removed.length, 'removed frame')} back
        </Button>
      )}
      {!d.photo && (links.length > 1 || samePages.length > 0) && (
        <div className="cut-link" data-testid="link-box">
          {links.length > 1 ? (
            <>
              <p className="cut-muted">
                <Link2 size={13} aria-hidden /> Linked with {plural(links.length - 1, 'other page')} — moving this grid moves them all.
              </p>
              <Button size="sm" variant="ghost" icon={Unlink2} onClick={() => commit('Unlink this page', (doc) => unlinkGrid(doc as CutterDoc, g.id))} data-testid="unlink">
                Unlink this page
              </Button>
            </>
          ) : null}
          {samePages.length > 0 && <UseOnPages key={g.id} game={game} gridId={g.id} pages={samePages} sizeName={pageSizeName(d)} />}
        </div>
      )}
      <Button size="sm" variant="ghost" icon={Trash2} className="cut-danger" onClick={() => commit('Remove the grid', (doc) => deleteGrid(doc as CutterDoc, g.id))} data-testid="remove-grid">
        Remove this grid
      </Button>
    </section>
  );
}

/** "Use this grid on…": pick the pages (same paper size, nothing framed yet); they get linked copies. */
function UseOnPages({ game, gridId, pages, sizeName }: { game: Game; gridId: string; pages: PageRef[]; sizeName: string }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  if (!open)
    return (
      <Button size="sm" icon={Link2} onClick={() => setOpen(true)} data-testid="use-on">
        Use this grid on other {sizeName} pages…
      </Button>
    );
  const toggle = (p: number) => setChosen((c) => {
    const n = new Set(c);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  const apply = () => {
    const list = pages.filter((r) => chosen.has(r.page));
    commit(`Use this grid on ${plural(list.length, 'page')}`, (doc) => void useGridOn(doc as CutterDoc, gridId, list));
    setOpen(false);
    setChosen(new Set());
  };
  return (
    <div className="cut-useon" data-testid="use-on-picker">
      <div className="cut-field__label">
        <span>Which pages have the same layout?</span>
      </div>
      <div className="cut-chips" role="group" aria-label="Pages">
        {pages.map((r) => (
          <button key={r.page} type="button" className={`cut-chip ${chosen.has(r.page) ? 'is-on' : ''}`} aria-pressed={chosen.has(r.page)} aria-label={`Page ${r.page + 1}`} onClick={() => toggle(r.page)} data-testid="use-on-page" data-page={r.page + 1}>
            <PageThumbImg game={game} source={game.sources.find((x) => x.id === r.sourceId)!} page={r.page} className="cut-chip__pic" />
            <span className="cut-chip__n">{r.page + 1}</span>
          </button>
        ))}
      </div>
      <div className="cut-row">
        <Button size="sm" variant="ghost" onClick={() => setChosen(new Set(chosen.size === pages.length ? [] : pages.map((r) => r.page)))}>
          {chosen.size === pages.length ? 'None' : 'All'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon={Link2} disabled={!chosen.size} onClick={apply} data-testid="use-on-apply">
          {chosen.size ? `Use on ${plural(chosen.size, 'page')}` : 'Pick pages'}
        </Button>
      </div>
    </div>
  );
}

function pageSizeName(d: PageDims) {
  if (d.sizeKey === '210x297' || d.sizeKey === '297x210') return 'A4';
  if (d.sizeKey === '216x279' || d.sizeKey === '279x216') return 'Letter';
  return 'same-size';
}

function FramesSummary({ doc, at }: { doc: CutterDoc; at: PageRef }) {
  const { frames } = pageContent(doc, at);
  const out = frames.filter((f) => f.excluded).length;
  return (
    <section className="cut-sec">
      <p className="cut-summary" data-testid="frames-summary">
        {plural(frames.length, 'frame')}
        {out ? ` · ${out} left out` : ''}
      </p>
      <p className="cut-muted">Tap a frame to leave it out (tap again to put it back). Tap its number to adjust that frame on its own.</p>
    </section>
  );
}

function FrameSection({ game, doc, frameId, n, d }: { game: Game; doc: CutterDoc; frameId: string; n: number; d: PageDims }) {
  const f = doc.frames[frameId];
  const group = f ? doc.groups.find((g) => g.id === f.groupId) : undefined;
  const preview = usePreview(game, doc, f, group, 320);
  if (!f) return null;
  // other pieces of the group, as the user numbers them, for "same as"
  const others = group
    ? Object.values(doc.frames)
        .filter((x) => x.groupId === group.id && x.id !== f.id && x.side === 'front')
        .map((x) => {
          const p = game.sources.find((s) => s.id === x.at.sourceId);
          const nn = pageContent(doc, x.at).numbers.get(x.id);
          const where = sameRef(x.at, f.at) ? '' : ` (${p?.kind === 'images' ? (p.pages[x.at.page]?.name ?? '') : `page ${x.at.page + 1}`})`;
          return { value: x.id, label: `Frame ${nn}${where}` };
        })
    : [];
  const sameAs = f.same ?? '';
  return (
    <section className={`cut-sec cut-t${groupTint(doc, f.groupId)}`} data-testid="frame-section">
      <h3 className="cut-sec__title">
        <span className="cut-swatch" aria-hidden /> Frame {n}
        {group ? ` · ${group.name}` : ''}
      </h3>
      {preview && (
        <div className={`cut-framepreview ${f.shape === 'round' ? 'is-round' : ''}`}>
          <img src={preview} alt={`Frame ${n}, straightened`} data-testid="frame-preview" />
        </div>
      )}
      <p className="cut-muted">{d.photo ? 'Drag its corners onto the corners of the piece — the loupe shows the detail.' : 'Drag its corners, or drag it to move it. Arrow keys nudge it.'}</p>
      <GroupPick doc={doc} value={f.groupId} photo={d.photo} label="Group" onPick={(target) => commit('Move a frame to another group', (doc) => void moveToGroup(doc as CutterDoc, { frameId: f.id }, target, (r) => pageDims(game, r)))} testid="frame-group" pageName={pageLabel(game, f.at)} />
      {group && (group.kind === 'tokens' || group.kind === 'cards') && f.side === 'front' && (
        <div className="cut-2col">
          <label className="cut-field">
            <span className="cut-field__label">Same piece as</span>
            <Select<string> value={sameAs} onChange={(v) => commit(v ? 'Same piece as another' : 'Its own piece', (doc) => setFrameSame(doc as CutterDoc, f.id, v || null))} options={[{ value: '', label: 'None — its own piece' }, ...others]} />
          </label>
          <div className="cut-field">
            <span className="cut-field__label">Copies</span>
            <Stepper label="Copies" value={f.copies ?? 1} min={1} max={99} onChange={(v) => commit(`×${v}`, (doc) => void ((doc as CutterDoc).frames[f.id].copies = v > 1 ? v : undefined))} testid="copies" />
          </div>
        </div>
      )}
      <div className="cut-row">
        <Button size="sm" icon={RotateCcw} onClick={() => commit('Turn a piece', (doc) => turnFrame(doc as CutterDoc, f.id, -1))} data-testid="turn-left">
          Turn left
        </Button>
        <Button size="sm" icon={RotateCw} onClick={() => commit('Turn a piece', (doc) => turnFrame(doc as CutterDoc, f.id, 1))} data-testid="turn-right">
          Turn right
        </Button>
        <SnapButton game={game} frameId={f.id} d={d} />
      </div>
      <div className="cut-switches">
        <Switch checked={!!f.excluded} onChange={() => commit(f.excluded ? 'Put a piece back in' : 'Leave a piece out', (doc) => toggleExcluded(doc as CutterDoc, f.id))} label="Leave it out" />
        {!f.onGrid && <Switch checked={f.shape === 'round'} onChange={(v) => commit(v ? 'Round frame' : 'Square frame', (doc) => setFrameShape(doc as CutterDoc, f.id, v ? 'round' : 'rect'))} label="Round" />}
      </div>
      <div className="cut-row">
        {!f.onGrid && f.gridId && f.cell != null && (
          <Button size="sm" icon={Grid3x3} onClick={() => commit('Put the frame back on the grid', (doc) => putBack(doc as CutterDoc, f.id))} data-testid="put-back">
            Back on the grid
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={Trash2} className="cut-danger" onClick={() => (commit('Delete a frame', (doc) => removeFrame(doc as CutterDoc, f.id)), select({}))} data-testid="delete-frame">
          Delete frame
        </Button>
      </div>
      <Button size="sm" variant="secondary" block onClick={() => select({ gridId: f.gridId ?? null })} data-testid="frame-done">
        Done
      </Button>
    </section>
  );
}

/** A linked back grid (a duplex sheet): it follows its front grid, mirrored; only the printed offset is its own. */
function BackGridSection({ game, doc, gridId, d }: { game: Game; doc: CutterDoc; gridId: string; d: PageDims }) {
  const burst = useBurst();
  const g = doc.grids[gridId];
  const b = g.backOf!;
  const front = doc.grids[b.gridId];
  const mm = d.units === 'mm';
  // leaving the field without typing gives back the rounded value it shows: that is not an edit
  const same = (v: number, cur: number) => Math.abs(v - cur) < (mm ? 0.005 : 0.5);
  const flipName = { long: 'turned over on the long edge', short: 'turned over on the short edge', none: 'not mirrored' }[b.flip];
  return (
    <section className={`cut-sec cut-t${groupTint(doc, g.groupId)}`} data-testid="back-grid-section">
      <h3 className="cut-sec__title">
        <span className="cut-swatch is-back" aria-hidden /> Backs · {plural(cellCount(g) - g.removed.length, 'back')}
      </h3>
      <p className="cut-muted">
        The backs of {front ? pageLabel(game, front.at) : 'another page'}, printed on the other side ({flipName}). This grid follows that page’s grid, mirrored — change the grid there.
      </p>
      <div className="cut-field">
        <div className="cut-field__label">
          <span>Printed off by</span>
          <span className="cut-field__val">drag the grid, or type it</span>
        </div>
        <div className="cut-2col">
          <NumberField size="sm" value={b.dx} step={mm ? 0.1 : 1} precision={mm ? 2 : 0} unit={mm ? 'mm' : 'px'} aria-label="Backs shifted across" onChange={(v) => same(v, b.dx) || burst('Shift the backs', (doc) => setBackOffset(doc as CutterDoc, g.id, v, (doc as CutterDoc).grids[g.id].backOf!.dy))} />
          <NumberField size="sm" value={b.dy} step={mm ? 0.1 : 1} precision={mm ? 2 : 0} unit={mm ? 'mm' : 'px'} aria-label="Backs shifted down" onChange={(v) => same(v, b.dy) || burst('Shift the backs', (doc) => setBackOffset(doc as CutterDoc, g.id, (doc as CutterDoc).grids[g.id].backOf!.dx, v))} />
        </div>
      </div>
      <div className="cut-row">
        {(b.dx !== 0 || b.dy !== 0) && (
          <Button size="sm" icon={RotateCcw} onClick={() => commit('Backs not shifted', (doc) => setBackOffset(doc as CutterDoc, g.id, 0, 0))} data-testid="back-offset-reset">
            No shift
          </Button>
        )}
        {front && (
          <Button size="sm" icon={Grid3x3} onClick={() => (goTo(front.at), select({ gridId: front.id }))} data-testid="back-go-front">
            Show the fronts
          </Button>
        )}
      </div>
      <div className="cut-backs__own">
        <p className="cut-muted">Back page printed skewed or scaled? Give this grid its own corners and fit them to the backs.</p>
        <Button size="sm" icon={Unlink2} onClick={() => commit('Backs with their own handles', (doc) => void ((doc as CutterDoc).grids[g.id].backOf!.linked = false))} data-testid="back-unlink">
          Give it its own handles
        </Button>
      </div>
    </section>
  );
}

/** Pick a group: any existing one, or a new group of a kind. */
function GroupPick({ doc, value, photo, label, onPick, testid, pageName }: { doc: CutterDoc; value: string; photo: boolean; label: string; onPick: (t: string | { kind: CutKind; photo: boolean; name?: string }) => void; testid: string; pageName?: string }) {
  return (
    <label className="cut-field" data-testid={testid}>
      <span className="cut-field__label">{label}</span>
      <Select<string>
        value={value}
        onChange={(v) => (v.startsWith('new:') ? onPick({ kind: v.slice(4) as CutKind, photo, name: pageName ? `${KIND_LABEL[v.slice(4) as CutKind]} — ${pageName}` : undefined }) : onPick(v))}
        options={[...doc.groups.map((g) => ({ value: g.id, label: groupLabel(g) })), ...KINDS.map((k) => ({ value: `new:${k.value}`, label: `+ New group of ${k.title.toLowerCase()}` }))]}
      />
    </label>
  );
}

/**
 * "Look like a scan" — photos only. The light is measured from the paper inside the frames (the
 * photo's white balance); colour & brightness and evening out the light are the user's to adjust.
 */
function CleanSection({ game, doc, at, burst }: { game: Game; doc: CutterDoc; at: PageRef; burst: ReturnType<typeof useBurst> }) {
  const c = doc.clean[at.sourceId] ?? DEFAULT_CLEAN;
  const source = game.sources.find((s) => s.id === at.sourceId)!;
  const page = source.pages[at.page];
  const donor = !page.gains ? source.pages.find((p) => p.photo && p.gains && p.index !== page.index) : undefined;
  const set = (label: string, patch: Partial<typeof c>) =>
    burst(label, (d) => {
      const cd = d as CutterDoc;
      cd.clean[at.sourceId] = { ...(cd.clean[at.sourceId] ?? DEFAULT_CLEAN), ...patch };
    });
  const pct = (v: number) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`);
  return (
    <section className="cut-sec" data-testid="clean-section">
      <h3 className="cut-sec__title">
        <Sparkles size={15} aria-hidden /> Look like a scan
      </h3>
      <p className="cut-muted" data-testid="light-status">
        {page.gains ? 'Light measured from the paper of the pieces in this photo.' : donor ? `No paper to measure here — using the light of ${donor.name ?? 'another photo'}.` : 'The light is measured from the paper once pieces are framed.'}
      </p>
      <div className="cut-field">
        <div className="cut-field__label">
          <span>Fix colours and brightness</span>
          <span className="cut-field__val">{pct(c.color)}</span>
        </div>
        <Slider aria-label="Fix colours and brightness" min={0} max={1} step={0.05} value={c.color} onChange={(v) => set('Colours and brightness', { color: v })} />
      </div>
      <div className="cut-field">
        <div className="cut-field__label">
          <span>Even out shadows and light</span>
          <span className="cut-field__val">{pct(c.flatten)}</span>
        </div>
        <Slider aria-label="Even out shadows and light" min={0} max={1} step={0.05} value={c.flatten} onChange={(v) => set('Shadows and light', { flatten: v })} />
      </div>
      <p className="cut-muted">For every photo in “{source.name}”. Trim and corners are set per group, below.</p>
      <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => commit('Back to automatic', (d) => void ((d as CutterDoc).clean[at.sourceId] = { ...DEFAULT_CLEAN }))} data-testid="clean-auto">
        Back to automatic
      </Button>
    </section>
  );
}
