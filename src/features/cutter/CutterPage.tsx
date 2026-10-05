/**
 * The Cutter (v3): one workspace for every source of the game — PDF pages, flat scans and photos
 * in one strip, one stage, one Page panel, one undo stack, saved to cutter.json as you go.
 * Stage 3 covers framing. Groups, sizes, backs and making follow in the next stages; nothing here
 * is a placeholder button.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useParams, useSearchParams } from 'react-router';
import { Camera, Check, ChevronDown, ChevronLeft, ChevronUp, CloudOff, FilePlus2, FileText, Images, Layers, Loader2, Redo2, TriangleAlert, Undo2 } from 'lucide-react';
import { useGame } from '@/state/gameStore';
import { Button, Dialog, EmptyState, IconButton, Segmented, Spinner, toast } from '@/ui';
import { useEditorChrome } from '@/state/editorChrome';
import type { CutQuad, Game, PageRef, SourceDoc } from '@/shared/types';
import { quadBounds, rectQuad } from '@/shared/cutter/geom';
import { Stage, stageGestures, type BitmapProvider, type DragHandlers, type Pt } from './Stage';
import { FrameLayer } from './FrameLayer';
import { PagePanel } from './PagePanel';
import { PiecesView } from './PiecesView';
import { focusGroup, MakeBar } from './MakeBar';
import { useEmptySpaces, useStartOnCardSheet, useTrackEmpties } from './FlatHelpers';
import { importSlicerDrafts } from './importDrafts';
import { currentGroup } from './GroupPanel';
import { openPageSource, type PageSource } from './pageSource';
import { useRenderedThumb } from './thumbs';
import { ACCEPT, addFiles, useAddTasks } from './addSources';
import { checkpoint, closeCutter, commit, goTo, openCutter, patchDoc, redo, resolveConflict, retrySave, select, setDrawing, setMode, setPickBack, undo, useCutter } from './store';
import { addFrame, groupTint, KIND_NOUN, pageContent, pageDims, removeFrame, sameRef, setAnchors, setFrameQuad } from './ops';
import './cutter.css';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function CutterPage() {
  const { gameId } = useParams();
  const game = useGame((s) => s.game);
  const status = useCutter((s) => s.status);
  const error = useCutter((s) => s.error);

  useEffect(() => {
    if (gameId) void openCutter(gameId);
    return () => closeCutter();
  }, [gameId]);
  // one undo stack and one save indicator: the Cutter's (the shell hides its own meanwhile)
  useEffect(() => {
    useEditorChrome.setState({ ownsHistory: true, compactNav: true });
    return () => useEditorChrome.setState({ ownsHistory: false, compactNav: false });
  }, []);

  if (!game || game.id !== gameId) return null;
  if (status === 'error')
    return (
      <div className="cut-missing">
        <EmptyState icon={CloudOff} title="The cutter could not be opened" description={error ?? ''} actions={<Button onClick={() => gameId && void openCutter(gameId)}>Try again</Button>} />
      </div>
    );
  if (status !== 'ready')
    return (
      <div className="cut-missing">
        <Spinner size={26} />
      </div>
    );
  return <Workspace game={game} />;
}

function useMedia(q: string) {
  const [on, setOn] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}

/** Q7: the retired slicer's unsaved work in this browser comes in once, as groups that were never made. */
function useImportDrafts(game: Game) {
  useEffect(() => {
    const r = importSlicerDrafts(game, useCutter.getState().doc);
    if (!r) return;
    toast.success(`Brought in your unsaved slicer work: ${r.groups === 1 ? '1 group' : `${r.groups} groups`}`, {
      description: `${r.names.slice(0, 3).join(', ')}${r.names.length > 3 ? ` +${r.names.length - 3}` : ''} — nothing is made yet. Check them, then Make.`,
      action: { label: 'Undo', onClick: () => void undo() },
      duration: 9000,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** "Change the cut" (?group=) and a source card (?source=) open the Cutter there, once. */
function useOpenAt(game: Game) {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const group = params.get('group');
    const source = params.get('source');
    if (!group && !source) return;
    const doc = useCutter.getState().doc;
    if (group && doc.groups.some((g) => g.id === group)) {
      focusGroup(group);
      patchDoc((d) => void (d.view = { ...(d.view ?? { at: null, mode: 'pages' }), mode: 'pages', groupId: group }), { evenInConflict: true });
    } else if (source && game.sources.some((s) => s.id === source)) {
      if (doc.view?.mode === 'pieces') patchDoc((d) => void (d.view!.mode = 'pages'), { evenInConflict: true });
      const first = Object.values(doc.frames).filter((f) => f.at.sourceId === source).sort((a, b) => a.at.page - b.at.page)[0];
      goTo(first?.at ?? { sourceId: source, page: 0 });
    }
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/* ------------------------------------------------------------------ */

function firstPage(game: Game): PageRef | null {
  const s = game.sources.find((x) => x.pageCount > 0);
  return s ? { sourceId: s.id, page: 0 } : null;
}

function Workspace({ game }: { game: Game }) {
  useOpenAt(game);
  useImportDrafts(game);
  useStartOnCardSheet(game);
  // a roomy screen has the make bar as its own row; tablets keep the stage's height and float it
  const wideBar = useMedia('(min-width: 1281px) and (min-height: 760px)');
  const doc = useCutter((s) => s.doc);
  useTrackEmpties(game, doc);
  const drawing = useCutter((s) => s.drawing);
  const sel = useCutter((s) => s.sel);
  const viewAt = doc.view?.at;
  const at: PageRef | null = viewAt && pageDims(game, viewAt) ? viewAt : firstPage(game);
  const source = at ? game.sources.find((s) => s.id === at.sourceId) : undefined;
  const d = at ? pageDims(game, at) : null;
  const [sheet, setSheet] = useState<'peek' | 'open'>('open');
  const [dragOver, setDragOver] = useState(false);

  /* the page picture */
  const [ps, setPs] = useState<{ key: string; ps: PageSource } | null>(null);
  const srcKey = source ? `${source.id}:${JSON.stringify(source.pages.map((p) => [p.photo, p.dpi]))}` : '';
  useEffect(() => {
    if (!source) return;
    let alive = true;
    openPageSource(game, source)
      .then((p) => alive && setPs({ key: srcKey, ps: p }))
      .catch((e) => {
        console.warn('Could not open the file', e);
        toast.error('This file could not be opened', { description: e?.message });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);
  const pageSrc = ps?.key === srcKey ? ps.ps : null;
  const page = at?.page ?? 0;
  const bitmap = useMemo<BitmapProvider | null>(() => (pageSrc ? (ppu) => pageSrc.bitmapAt(page, ppu) : null), [pageSrc, page]);
  const levels = useMemo(() => (pageSrc ? pageSrc.levels(page) : [1]), [pageSrc, page]);

  /*
   * Photos: the colour of the light, measured from the paper inside the frames once they settle
   * (white balance for "look like a scan"). Measured data, not an edit: no undo step.
   */
  const lightKey =
    at && d?.photo
      ? Object.values(doc.frames)
          .filter((f) => sameRef(f.at, at) && !f.excluded && f.shape === 'rect')
          .map((f) => f.quad.flat().map((v) => Math.round(v / 8)).join(','))
          .sort()
          .join(';')
      : '';
  useEffect(() => {
    if (!lightKey || !pageSrc || !at) return;
    const t = window.setTimeout(() => {
      const quads = Object.values(useCutter.getState().doc.frames)
        .filter((f) => sameRef(f.at, at) && !f.excluded && f.shape === 'rect')
        .map((f) => f.quad);
      pageSrc
        .measureLight(at.page, quads)
        .then((gains) => {
          const g = useGame.getState().game;
          const p = g?.sources.find((s) => s.id === at.sourceId)?.pages[at.page];
          if (!p) return;
          const same = (a: typeof gains, b: typeof gains) => (!a && !b) || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 0.004));
          if (same(gains, p.gains ?? null)) return;
          useGame.getState().update(
            (gd) => {
              const pp = gd.sources.find((s) => s.id === at.sourceId)?.pages[at.page];
              if (pp) pp.gains = gains;
            },
            'Measure the light',
            { history: false },
          );
        })
        .catch(() => undefined);
    }, 900);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightKey, pageSrc]);

  /* drawing a frame by dragging */
  const [draft, setDraft] = useState<CutQuad | null>(null);
  const onBackgroundDrag = useCallback(
    (p: Pt): DragHandlers | null => {
      if (!useCutter.getState().drawing || !at || !d) return null;
      let q: CutQuad | null = null;
      return {
        onMove: (c) => {
          q = rectQuad(Math.min(p.x, c.x), Math.min(p.y, c.y), Math.abs(c.x - p.x), Math.abs(c.y - p.y)) as CutQuad;
          setDraft(q);
        },
        onEnd: () => {
          setDraft(null);
          const r = q;
          if (!r || Math.abs(r[2][0] - r[0][0]) < Math.min(d.w, d.h) * 0.02 || Math.abs(r[2][1] - r[0][1]) < Math.min(d.w, d.h) * 0.02) return;
          let id = '';
          commit('Draw a frame', (doc) => void (id = addFrame(doc, at, d, r).id));
          select({ frameId: id });
          setDrawing(false);
        },
        onCancel: () => setDraft(null),
        loupe: () => null,
      };
    },
    [at, d],
  );

  /* keyboard */
  useEffect(() => {
    // only text entry keeps its own keys: switches, sliders and segmented controls are <input>s too
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
      if (el.tagName !== 'INPUT') return false;
      return ['text', 'number', 'search', 'email', 'url', 'password', 'tel'].includes((el as HTMLInputElement).type);
    };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || document.querySelector('.ui-dialog-backdrop')) return;
      const s = useCutter.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        const isUndo = k === 'z' && !e.shiftKey;
        const isRedo = (k === 'z' && e.shiftKey) || k === 'y';
        // the Cutter's stack is the only one here (the shell leaves Ctrl+Z to us)
        if (isUndo || isRedo) {
          e.preventDefault();
          e.stopPropagation();
          const l = isUndo ? undo() : redo();
          if (l) toast(`${isUndo ? 'Undone' : 'Redone'}: ${l}`, { duration: 1400 });
        }
        return;
      }
      if (e.key === 'Escape') {
        if (s.pickBack) setPickBack(null);
        else if (s.drawing) setDrawing(false);
        else if (s.sel.frameId) select({ gridId: s.sel.gridId ?? null });
        else select({});
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.sel.frameId) {
        e.preventDefault();
        const id = s.sel.frameId;
        commit('Delete a frame', (doc) => removeFrame(doc, id));
        select({});
      } else if ((e.key === 'PageDown' || e.key === 'PageUp') && at && s.doc.view?.mode !== 'pieces') {
        e.preventDefault();
        // a drag belongs to its page: no changing page while a finger or button is down
        if (stageGestures.busy()) return;
        const all = game.sources.flatMap((x) => x.pages.map((_, i) => ({ sourceId: x.id, page: i })));
        const i = all.findIndex((r) => sameRef(r, at));
        const n = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'PageDown' ? 1 : -1)))];
        if (n) goTo(n);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [game, at]);

  /* arrow keys nudge the selected frame, or the page's selected grid */
  const nudgeStart = useRef(0);
  const onNudge = (dx: number, dy: number) => {
    const s = useCutter.getState();
    const now = Date.now();
    if (now - nudgeStart.current > 800) checkpoint('Nudge');
    nudgeStart.current = now;
    const move = (q: CutQuad) => q.map((p) => [p[0] + dx, p[1] + dy]) as CutQuad;
    if (s.sel.frameId) {
      const f = s.doc.frames[s.sel.frameId];
      if (f) patchDoc((doc) => setFrameQuad(doc, f.id, move(f.quad)));
    } else if (s.sel.gridId) {
      const g = s.doc.grids[s.sel.gridId];
      if (g) patchDoc((doc) => setAnchors(doc, g.id, move(g.anchors)));
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const first = await addFiles(game.id, files);
    if (first) goTo(first);
  };

  const content = at ? pageContent(doc, at) : null;
  const empties = useEmptySpaces(doc, at);
  // zoom in on a small frame only when the user asked for it (tapped its number)
  const selF = sel.frameId && sel.zoom ? doc.frames[sel.frameId] : undefined;
  const selFocus = useMemo(() => {
    if (!selF) return null;
    const b = quadBounds(selF.quad);
    return { key: selF.id, ...b };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selF?.id]);
  const pickBack = useCutter((s) => s.pickBack);
  const pickGroup = pickBack ? doc.groups.find((g) => g.id === pickBack) : undefined;
  const selGrid = (sel.gridId ? doc.grids[sel.gridId] : undefined) ?? content?.grids[content.grids.length - 1];
  const onBacks = !!selGrid?.backOf?.linked && sameRef(selGrid.at, at);
  const hint = !at || !d ? '' : pickGroup ? `Tap the piece that shows the back of “${pickGroup.name}” · Esc to stop` : drawing ? 'Drag on the page to draw a frame · Esc to stop' : sel.frameId ? 'Drag the corners onto the piece' : onBacks ? 'The backs follow the front page · drag them to line up · own handles in the panel' : !content?.frames.length ? 'What’s on this page? Choose in the panel' : d.photo ? 'Drag the 4 big handles onto the outer corners' : 'Drag the grid or its edges onto the pieces';

  const conflict = useCutter((s) => s.save.state === 'conflict');
  // leaving with edits that are not on the server asks first
  const blocker = useBlocker(({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && ['conflict', 'error'].includes(useCutter.getState().save.state));

  return (
    <div className={`cut ${dragOver ? 'is-drop' : ''} ${conflict ? 'is-conflict' : ''}`} onDragOver={(e) => (e.preventDefault(), setDragOver(true))} onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)} onDrop={onDrop} data-testid="cutter">
      <TopBar game={game} />
      {conflict && <ConflictBar />}
      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Leave without saving?"
        description={conflict ? 'This cut was changed on another device, so your latest edits here are not saved.' : 'Your latest edits could not be saved.'}
        footer={
          <>
            <Button onClick={() => blocker.reset?.()} data-testid="leave-stay">
              Stay
            </Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()} data-testid="leave-go">
              Leave without saving
            </Button>
          </>
        }
      />
      {!game.sources.length ? (
        <div className="cut-empty">
          <EmptyState
            icon={Layers}
            title="Add the files to cut from"
            description="PDFs, scans or photos of your game. Everything you add shows up here, ready to frame."
            actions={<AddButton game={game} primary />}
          />
        </div>
      ) : doc.view?.mode === 'pieces' ? (
        <PiecesView game={game} groupId={doc.view.groupId ?? (at ? currentGroup(doc, at, sel)?.id : undefined) ?? null} />
      ) : (
        <div className={`cut-body is-sheet-${sheet}`}>
          <Strip game={game} at={at} />
          <div className="cut-stagewrap">
            {at && d && (
              <Stage
                pageKey={`${at.sourceId}:${at.page}`}
                bitmap={bitmap}
                levels={levels}
                pageW={d.w}
                pageH={d.h}
                onBackgroundTap={() => !useCutter.getState().drawing && select({})}
                onBackgroundDrag={onBackgroundDrag}
                onNudge={onNudge}
                nudgeStep={d.units === 'mm' ? [0.1, 1] : [1, 10]}
                className={drawing ? 'is-drawing' : pickBack ? 'is-picking' : ''}
                reserveBottom={68}
                reserveTop={56}
                focus={selFocus}
                loupeMin={d.units === 'mm' ? 9 : 0}
                overlay={(o) => <FrameLayer o={o} doc={doc} dims={d} pageAt={at} numbers={content!.numbers} draft={draft} empties={empties} />}
              >
                {hint && (
                  <div className="cut-hint" data-testid="cut-hint">
                    <span>{hint}</span>
                  </div>
                )}
              </Stage>
            )}
            {/* the make bar floats in the band the stage keeps free at the bottom (beside the zoom), so framing keeps its height */}
            {!wideBar && <MakeBar game={game} floating />}
          </div>
          <aside className="cut-insp" aria-label="Page">
            <button type="button" className="cut-insp__grab" onClick={() => setSheet(sheet === 'open' ? 'peek' : 'open')} aria-expanded={sheet === 'open'} data-testid="sheet-toggle">
              <span className="cut-insp__grabbar" aria-hidden />
              {sheet === 'open' ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
              <span>{sheet === 'open' ? 'Hide the panel' : 'Show the panel'}</span>
            </button>
            <div className="cut-insp__scroll">{at && <PagePanel game={game} at={at} />}</div>
          </aside>
        </div>
      )}
      {game.sources.length > 0 && (doc.view?.mode === 'pieces' || wideBar) && <MakeBar game={game} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* top bar                                                              */
/* ------------------------------------------------------------------ */

function TopBar({ game }: { game: Game }) {
  // while a conflict pauses editing, there is nothing to undo either
  const paused = useCutter((s) => s.save.state === 'conflict');
  const past = useCutter((s) => (paused ? 0 : s.past.length));
  const future = useCutter((s) => (paused ? 0 : s.future.length));
  const pages = game.sources.reduce((n, s) => n + s.pageCount, 0);
  return (
    <header className="cut-top">
      <Link to={`/games/${game.id}/edit/sources`} className="cut-top__back">
        <ChevronLeft size={16} /> Sources
      </Link>
      <span className="cut-top__sep" aria-hidden />
      <h1 className="cut-top__title">Cutter</h1>
      <span className="cut-top__meta">
        {plural(game.sources.length, 'file')} · {plural(pages, 'page')}
      </span>
      <span className="cut-top__spacer" />
      <ModeSwitch game={game} />
      <SaveIndicator />
      <IconButton icon={Undo2} label="Undo" shortcut="Ctrl+Z" disabled={!past} onClick={() => { const l = undo(); if (l) toast(`Undone: ${l}`, { duration: 1400 }); }} tooltipPlacement="bottom" />
      <IconButton icon={Redo2} label="Redo" shortcut="Ctrl+Shift+Z" disabled={!future} onClick={() => { const l = redo(); if (l) toast(`Redone: ${l}`, { duration: 1400 }); }} tooltipPlacement="bottom" />
    </header>
  );
}

/** Pages (frame the pieces) | Pieces (the selected group's pieces, fronts & backs). */
function ModeSwitch({ game }: { game: Game }) {
  const mode = useCutter((s) => s.doc.view?.mode ?? 'pages');
  if (!game.sources.length) return null;
  return (
    <div className="cut-top__mode" data-testid="mode-switch">
      <Segmented<'pages' | 'pieces'>
        size="sm"
        aria-label="Show"
        value={mode}
        onChange={(m) => {
          if (m === 'pieces') {
            const s = useCutter.getState();
            const at = s.doc.view?.at;
            setMode('pieces', (at ? currentGroup(s.doc, at, s.sel)?.id : undefined) ?? s.doc.view?.groupId ?? s.doc.groups[0]?.id ?? null);
          } else setMode('pages');
        }}
        options={[
          { value: 'pages', label: 'Pages' },
          { value: 'pieces', label: 'Pieces' },
        ]}
      />
    </div>
  );
}

/** While a conflict is open nothing can be edited: take their version, or overwrite it with mine. */
function ConflictBar() {
  const [busy, setBusy] = useState(false);
  const run = async (c: 'theirs' | 'mine') => {
    setBusy(true);
    try {
      await resolveConflict(c);
      toast.success(c === 'theirs' ? 'Loaded the latest version' : 'Your version is saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cut-conflict" role="alert" data-testid="cut-conflict">
      <TriangleAlert size={18} aria-hidden />
      <div className="cut-conflict__text">
        <strong>This cut was changed on another device.</strong>
        <span>Your edits since then can’t be saved as they are. Editing is paused until you choose.</span>
      </div>
      <Button size="sm" loading={busy} onClick={() => void run('theirs')} data-testid="conflict-theirs">
        Reload their version
      </Button>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void run('mine')} data-testid="conflict-mine">
        Keep mine (overwrite)
      </Button>
    </div>
  );
}

function SaveIndicator() {
  const cut = useCutter((s) => s.save);
  const gameSave = useGame((s) => s.saveState);
  // one indicator for both: the cut (cutter.json) and the files added here (the game)
  const state = cut.state === 'saved' && (gameSave === 'dirty' || gameSave === 'saving') ? 'saving' : cut.state === 'saved' && gameSave === 'error' ? 'error' : cut.state;
  const save = { ...cut, state };
  const retry = () => {
    retrySave();
    void useGame.getState().flush();
  };
  if (save.state === 'saving')
    return (
      <span className="cut-save is-saving" data-testid="cut-save" data-state="saving">
        <Loader2 size={14} className="cut-spin" /> Saving…
      </span>
    );
  if (save.state === 'error')
    return (
      <span className="cut-save is-error" data-testid="cut-save" data-state="error">
        <CloudOff size={14} /> Not saved
        <Button size="sm" variant="ghost" onClick={retry}>
          Retry
        </Button>
      </span>
    );
  if (save.state === 'conflict')
    return (
      <span className="cut-save is-error" data-testid="cut-save" data-state="conflict">
        <TriangleAlert size={14} /> Not saved (changed elsewhere)
      </span>
    );
  return (
    <span className="cut-save" data-testid="cut-save" data-state="saved">
      <Check size={14} /> Saved
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* strip                                                               */
/* ------------------------------------------------------------------ */

function AddButton({ game, primary }: { game: Game; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          const first = await addFiles(game.id, files);
          if (first) goTo(first);
        }}
        data-testid="cut-file-input"
      />
      <Button variant={primary ? 'primary' : 'secondary'} size={primary ? 'md' : 'sm'} icon={FilePlus2} block={!primary} onClick={() => input.current?.click()} data-testid="cut-add">
        Add PDFs or images
      </Button>
    </>
  );
}

function Strip({ game, at }: { game: Game; at: PageRef | null }) {
  const doc = useCutter((s) => s.doc);
  const tasks = useAddTasks((s) => s.tasks);
  const cur = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cur.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [at?.sourceId, at?.page]);
  return (
    <nav className="cut-strip" aria-label="Pages">
      <div className="cut-strip__list">
        {game.sources.map((s) => (
          <div key={s.id} className="cut-strip__src">
            <div className="cut-strip__head" title={s.name}>
              {s.kind === 'pdf' ? <FileText size={13} aria-hidden /> : <Images size={13} aria-hidden />}
              <span className="cut-strip__name">{s.name}</span>
              <span className="cut-strip__n">{s.pageCount}</span>
            </div>
            {s.pages.map((p, i) => {
              const ref = { sourceId: s.id, page: i };
              const isCur = sameRef(ref, at);
              return <Thumb key={i} game={game} source={s} page={i} current={isCur} btnRef={isCur ? cur : undefined} doc={doc} />;
            })}
          </div>
        ))}
        {tasks.map((t) => ({ ...t, error: !!t.error })).map((t) => (
          <div key={t.id} className={`cut-strip__task ${t.error ? 'is-error' : ''}`}>
            {t.error ? <TriangleAlert size={14} /> : <Loader2 size={14} className="cut-spin" />}
            <span className="cut-strip__tasklabel">{t.label}</span>
            <span className="cut-strip__taskdetail">{t.detail}</span>
          </div>
        ))}
      </div>
      <div className="cut-strip__foot">
        <AddButton game={game} />
      </div>
    </nav>
  );
}

function Thumb({ game, source, page, current, btnRef, doc }: { game: Game; source: SourceDoc; page: number; current: boolean; btnRef?: React.RefObject<HTMLButtonElement | null>; doc: ReturnType<typeof useCutter.getState>['doc'] }) {
  const p = source.pages[page];
  const own = useRef<HTMLButtonElement>(null);
  const el = btnRef ?? own;
  const changed = useCutter((s) => !!s.marked[`${source.id}:${page}`]);
  const url = useRenderedThumb(game, source, page, el);
  const ref = { sourceId: source.id, page };
  const frames = Object.values(doc.frames).filter((f) => sameRef(f.at, ref));
  // what this page really makes: empty spaces a grid skips are not counted
  const empties = useCutter((st) => st.empties);
  const inFrames = frames.filter((f) => !f.excluded && !(empties[f.id] && !f.keep));
  const g = frames[0] ? doc.groups.find((x) => x.id === frames[0].groupId) : undefined;
  const noun = g ? KIND_NOUN[g.kind] : ['frame', 'frames'];
  const isImage = source.kind === 'images';
  // a mixed page counts each kind: "16 tokens · 1 card"
  const kinds = new Map<string, number>();
  for (const f of inFrames) {
    const k = f.side === 'back' ? 'backs' : (doc.groups.find((x) => x.id === f.groupId)?.kind ?? 'cards');
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  const nounOf = (k: string): [string, string] => (k === 'backs' ? ['back', 'backs'] : KIND_NOUN[k as keyof typeof KIND_NOUN]);
  const byKind = kinds.size ? [...kinds].map(([k, n]) => plural(n, nounOf(k)[0], nounOf(k)[1])).join(' · ') : plural(0, noun[0], noun[1]);
  const w = isImage ? (p.px?.w ?? 3) : p.widthMm;
  const h = isImage ? (p.px?.h ?? 4) : p.heightMm;
  return (
    <button ref={el} type="button" className={`cut-thumb ${current ? 'is-current' : ''}`} onClick={() => goTo(ref)} aria-current={current || undefined} data-testid="cut-thumb">
      <span className="cut-thumb__paper" style={{ aspectRatio: `${w} / ${h}` }}>
        {url ? <img src={url} alt="" draggable={false} loading="lazy" /> : <FileText size={18} />}
        {changed && (
          <span className="cut-thumb__changed" title="Changed by an edit on another page" data-testid="thumb-changed">
            Changed
          </span>
        )}
        {isImage && (
          <span className="cut-thumb__kind" title={p.photo ? 'A photo' : 'A flat scan'}>
            {p.photo ? <Camera size={11} /> : <FileText size={11} />}
          </span>
        )}
      </span>
      <span className="cut-thumb__meta">
        <span className="cut-thumb__num">{isImage ? (p.name?.replace(/\.[a-z0-9]+$/i, '') ?? page + 1) : page + 1}</span>
        {frames.length ? (
          <span className={`cut-thumb__tag cut-t${groupTint(doc, frames[0].groupId)}`} title={byKind}>
            {byKind}
          </span>
        ) : (
          <span className="cut-thumb__tag is-empty">Not used</span>
        )}
      </span>
    </button>
  );
}
