/**
 * The flat-page helpers in the panels (Q1): "Find the cards" (start section and grid), "Find the
 * board", "Snap to the artwork", "Skip empty spaces", and opening on the first card sheet. Each is
 * pressed by the user (or, for the first card sheet, announced), says what it found, and is one undo
 * step. None of them is shown — or would run (helpers.ts refuses) — on a photo page.
 */
import { useEffect, useState } from 'react';
import { Frame, ScanSearch, Sparkles } from 'lucide-react';
import { Button, Switch, toast } from '@/ui';
import type { CutGrid, CutKind, CutQuad, CutterDoc, Game, ID, PageRef } from '@/shared/types';
import { commit, goTo, select, setEmpties, undo, useCutter } from './store';
import { addFrame, addGrid, applyGroupShape, pageContent, pageDims, pageLabel, propagate, setFrameQuad, type PageDims } from './ops';
import { openPageSource } from './pageSource';
import { emptySpaces, findArtwork, findCardSheet, findGrid, snapToArtwork, type FoundGrid } from './helpers';

const noun = (k: CutKind) => (k === 'tokens' ? 'tokens' : k === 'cards' ? 'cards' : k === 'board' ? 'board' : k === 'cover' ? 'cover' : 'card back');
const psFor = (game: Game, at: PageRef) => openPageSource(game, game.sources.find((s) => s.id === at.sourceId)!);

/** Put what a helper found onto a grid (one undo step with whatever else the caller does). */
function placeFound(doc: CutterDoc, grid: CutGrid, found: FoundGrid, dims: (r: PageRef) => PageDims | null): boolean {
  const round = grid.round;
  // finding the same thing again is not an edit (no undo step for "nothing changed")
  const same = (Object.keys(found.geom) as (keyof typeof found.geom)[]).every((k) => JSON.stringify(grid[k]) === JSON.stringify(found.geom[k])) && grid.note?.text === found.note.text;
  if (same) return false;
  Object.assign(grid, found.geom, { fitted: true, note: found.note, removed: [] });
  const g = doc.groups.find((x) => x.id === grid.groupId);
  // the printed bleed becomes the group's trim when the group has none yet
  if (g && g.trimMm === 0 && found.bleedMm > 0) g.trimMm = found.bleedMm;
  propagate(doc, grid.id);
  if (round && g) applyGroupShape(doc, g.id, dims);
  return true;
}

/** Start section, flat pages: find the pieces instead of placing a grid by hand. */
export function FindButton({ game, at, d, kind, into, onDone }: { game: Game; at: PageRef; d: PageDims; kind: CutKind; into: { groupId?: ID; name: string }; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  if (d.photo) return null;
  const grid = kind === 'cards' || kind === 'tokens';
  const run = async () => {
    setBusy(true);
    try {
      const ps = await psFor(game, at);
      const dims = (r: PageRef) => pageDims(game, r);
      if (grid) {
        const found = await findGrid(ps, at.page, kind);
        if (!found) {
          toast('No regular grid found on this page', { kind: 'warning', description: `Nothing here looks like rows of ${noun(kind)} (no crop marks, gaps or cut lines). Frame them with rows × columns instead.`, duration: 6000 });
          return;
        }
        let id = '';
        commit(`Find the ${noun(kind)}`, (doc) => {
          const dd = doc as CutterDoc;
          const g = addGrid(dd, at, d, kind, found.geom.rows, found.geom.cols, into);
          id = g.id;
          placeFound(dd, dd.grids[g.id], found, dims);
        });
        select({ gridId: id });
        toast.success(found.note.text.split('. ')[0] + '.', { action: { label: 'Undo', onClick: () => void undo() }, duration: 6000 });
      } else {
        const q = await findArtwork(ps, at.page);
        if (!q) {
          toast(`No ${noun(kind)} artwork found`, { kind: 'warning', description: 'Draw the frame yourself.', duration: 5000 });
          return;
        }
        let id = '';
        commit(`Find the ${noun(kind)}`, (doc) => {
          id = addFrame(doc as CutterDoc, at, d, q, kind, into.groupId ? undefined : into.name).id;
          if (into.groupId) moveInto(doc as CutterDoc, id, into.groupId);
        });
        select({ frameId: id });
        toast.success(`Found the ${noun(kind)}’s artwork on ${pageLabel(game, at)}`, { description: 'The frame hugs the printed art, including any bleed printed around it — trim that off with the group’s bleed (or the Join panel’s).', action: { label: 'Undo', onClick: () => void undo() }, duration: 6000 });
      }
      onDone?.();
    } catch (e) {
      toast.error('The page could not be read', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="primary" icon={ScanSearch} block onClick={() => void run()} disabled={busy} data-testid="find-pieces">
      {busy ? 'Looking…' : grid ? `Find the ${noun(kind)}` : `Find the ${noun(kind)}`}
    </Button>
  );
}

function moveInto(doc: CutterDoc, frameId: ID, groupId: ID) {
  const f = doc.frames[frameId];
  const before = f?.groupId;
  if (!f) return;
  f.groupId = groupId;
  if (before && !Object.values(doc.frames).some((x) => x.groupId === before)) doc.groups = doc.groups.filter((g) => g.id !== before);
}

/** Grid section, flat pages: what was found, find again, skip empty spaces. */
export function GridHelpers({ game, doc, grid, d }: { game: Game; doc: CutterDoc; grid: CutGrid; d: PageDims }) {
  const [busy, setBusy] = useState(false);
  const group = doc.groups.find((g) => g.id === grid.groupId);
  const empties = useEmptySpaces(doc, grid.at, grid.id);
  if (d.photo || !group) return null;
  const kind = group.kind;
  const again = async () => {
    setBusy(true);
    try {
      const ps = await psFor(game, grid.at);
      const found = await findGrid(ps, grid.at.page, kind, group.size ?? undefined);
      if (!found) return void toast('Nothing new found — the grid stays as it is', { kind: 'warning' });
      let changed = false;
      commit(`Find the ${noun(kind)} again`, (dd) => void (changed = placeFound(dd as CutterDoc, (dd as CutterDoc).grids[grid.id], found, (r) => pageDims(game, r))));
      if (changed) toast.success(found.note.text.split('. ')[0] + '.', { action: { label: 'Undo', onClick: () => void undo() }, duration: 6000 });
      else toast('The grid already sits where the page says — nothing changed', { duration: 4000 });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cut-field cut-helpers" data-testid="grid-helpers">
      {grid.note && (
        <p className={`cut-note is-${grid.note.tone}`} data-testid="grid-note">
          <Sparkles size={14} aria-hidden /> {grid.note.text}
        </p>
      )}
      {(kind === 'cards' || kind === 'tokens') && (
        <Button size="sm" icon={ScanSearch} onClick={() => void again()} disabled={busy} data-testid="find-again">
          {busy ? 'Looking…' : `Find the ${noun(kind)} again`}
        </Button>
      )}
      <Switch checked={!!grid.skipBlank} onChange={(v) => commit(v ? 'Skip empty spaces' : 'Keep empty spaces', (dd) => void ((dd as CutterDoc).grids[grid.id].skipBlank = v || undefined))} label="Skip empty spaces" data-testid="skip-empty" />
      <p className="cut-muted" data-testid="empty-count">
        {grid.skipBlank ? (empties.size ? `${empties.size} empty ${empties.size === 1 ? 'space is' : 'spaces are'} left out when making (hatched on the page).` : 'No empty spaces on this page.') : 'Frames with nothing printed in them are made too.'}
      </p>
    </div>
  );
}

/** Frame section, flat pages: snap the frame to the printed artwork under it. */
export function SnapButton({ game, frameId, d }: { game: Game; frameId: ID; d: PageDims }) {
  const [busy, setBusy] = useState(false);
  if (d.photo) return null;
  const run = async () => {
    const f = useCutter.getState().doc.frames[frameId];
    if (!f) return;
    setBusy(true);
    try {
      const q = await snapToArtwork(await psFor(game, f.at), f.at.page, f.quad);
      if (!q) return void toast('No artwork found around this frame', { kind: 'warning' });
      commit('Snap to the artwork', (doc) => {
        setFrameQuad(doc as CutterDoc, frameId, q as CutQuad);
        (doc as CutterDoc).frames[frameId].onGrid = false;
      });
      toast.success('Snapped to the artwork', { action: { label: 'Undo', onClick: () => void undo() } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" icon={Frame} onClick={() => void run()} disabled={busy} data-testid="snap-artwork">
      Snap to the artwork
    </Button>
  );
}

/** The frames of flat grids with "skip empty spaces" on that have nothing printed in them. */
export function useEmptySpaces(doc: CutterDoc, at: PageRef | null, onlyGrid?: ID): Set<string> {
  const empties = useCutter((s) => s.empties);
  const out = new Set<string>();
  for (const id of Object.keys(empties)) {
    const f = doc.frames[id];
    if (!f || (at && (f.at.sourceId !== at.sourceId || f.at.page !== at.page)) || (onlyGrid && f.gridId !== onlyGrid)) continue;
    out.add(id);
  }
  return out;
}

/**
 * Every empty space of the whole cut (flat grids with "skip empty spaces" on), kept in the store so
 * the group counts, the make bar and the page all say what Make will really produce.
 */
export function useTrackEmpties(game: Game, doc: CutterDoc) {
  const grids = Object.values(doc.grids).filter((g) => g.skipBlank);
  const key = JSON.stringify(
    grids.map((g) => [g.id, g.at, Object.values(doc.frames).filter((f) => f.gridId === g.id).map((f) => [f.id, f.quad.map((p) => p.map((v) => Math.round(v * 10)))]), doc.groups.find((x) => x.id === g.groupId)?.trimMm]),
  );
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: Record<string, true> = {};
      for (const g of grids) {
        const d = pageDims(game, g.at);
        if (!d || d.photo) continue;
        try {
          const ps = await psFor(game, g.at);
          const trim = doc.groups.find((x) => x.id === g.groupId)?.trimMm ?? 0;
          const frames = Object.values(doc.frames).filter((f) => f.gridId === g.id && f.side === 'front' && !f.keep);
          for (const id of await emptySpaces(ps, g.at.page, frames, trim)) out[id] = true;
        } catch {
          /* unreadable page: count nothing as empty */
        }
      }
      if (alive) setEmpties(out);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** A fresh PDF opens on its first card sheet — said so, and only when nothing is framed yet. */
export function useStartOnCardSheet(game: Game) {
  useEffect(() => {
    const s = useCutter.getState();
    if (s.doc.view?.at || Object.keys(s.doc.frames).length) return;
    const src = game.sources.find((x) => x.kind === 'pdf');
    if (!src) return;
    let alive = true;
    void (async () => {
      const ps = await openPageSource(game, src);
      const p = await findCardSheet(ps);
      const now = useCutter.getState();
      // the user moved on (or framed something) meanwhile: leave them where they are
      if (!alive || p == null || p === 0 || Object.keys(now.doc.frames).length || (now.doc.view?.at && !(now.doc.view.at.sourceId === src.id && now.doc.view.at.page === 0))) return;
      goTo({ sourceId: src.id, page: p });
      toast(`Opened on page ${p + 1} — the first card sheet`, { description: 'Pages before it hold no cards (a cover, the rules).', duration: 5000 });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

