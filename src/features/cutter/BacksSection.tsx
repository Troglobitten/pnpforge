/**
 * The group's Backs: no backs (the deck's colour), one back for all (a frame picked on any page),
 * or each its own — filled by a rule the user picks (turned over on the next page or photo, a page
 * of backs per front page, or by hand) and changeable pair by pair in Pieces. Nothing is ever
 * paired by look, a back goes on one piece (unless the user gave several front pages the same
 * backs page), and leaving a rule removes the back grids it made.
 */
import { AlertTriangle, ArrowRight, Hand, ListOrdered, MousePointerClick, X } from 'lucide-react';
import { Button, Segmented, Select, toast } from '@/ui';
import type { BackFlip, CutBacksRule, CutGroup, CutterDoc, Game, ID, PageRef } from '@/shared/types';
import { mirrorAxis } from '@/shared/cutter/grid';
import { commit, setMode, setPickBack, undo, useCutter } from './store';
import { applyBacksPage, applyTurnedOver, backsReport, dropRuleGrids, frontPagesOf, pageDims, pageKey, pageLabel, pairsSignature, setBacksMode, setHandRule } from './ops';
import { markPages } from './announce';
import { usePreview } from './previews';
import { piecesOf } from './PiecesView';

type Mode = CutGroup['backs']['mode'];
type RuleKind = 'turned-over' | 'backs-page' | 'hand';
type BacksMap = Record<string, PageRef | null>;

export const FLIPS: { value: BackFlip; label: string; title: string }[] = [
  { value: 'long', label: 'Long edge', title: 'Turned over on the long edge' },
  { value: 'short', label: 'Short edge', title: 'Turned over on the short edge' },
  { value: 'none', label: 'Not mirrored', title: 'Same place on both sides' },
];
export const PAGE_FLIPS: { value: BackFlip; label: string }[] = [
  { value: 'none', label: 'In order' },
  { value: 'long', label: 'Mirrored (long)' },
  { value: 'short', label: 'Mirrored (short)' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "pages 4, 6 and 8" (or the names as they are). */
function pageList(pages: string[]) {
  const nums = pages.every((p) => /^page \d+$/.test(p)) ? pages.map((p) => p.slice(5)) : null;
  const items = nums ?? pages;
  const joined = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
  return nums ? `${nums.length > 1 ? 'pages' : 'page'} ${joined}` : joined;
}

/** Toasts about pairs ("piece 1 has no back now"): gone as soon as the pairs change again. */
const pairToasts: number[] = [];
let pairsAt: unknown = null;
export function pairToast(id: number) {
  pairToasts.push(id);
  pairsAt = useCutter.getState().doc.groups;
}
// any later change to the groups (a rule, a flip, undo, redo) makes those messages stale
useCutter.subscribe((s) => {
  if (pairToasts.length && s.doc.groups !== pairsAt) clearPairToasts();
});
function clearPairToasts() {
  while (pairToasts.length) toast.dismiss(pairToasts.pop()!);
}

/** The piece number a front has in Pieces (1-based). */
export function pieceNumber(doc: CutterDoc, group: CutGroup, frontId: ID) {
  return piecesOf(doc, group).findIndex((p) => p.frames.some((f) => f.id === frontId)) + 1;
}

/** The backs-page map in force (older documents: one page for every front page). */
export function currentMap(doc: CutterDoc, group: CutGroup): BacksMap {
  const r = group.backs.rule;
  const fronts = frontPagesOf(doc, group.id);
  if (r?.kind !== 'backs-page') return Object.fromEntries(fronts.map((p) => [pageKey(p), null]));
  if (r.map) return Object.fromEntries(fronts.map((p) => [pageKey(p), r.map![pageKey(p)] ?? null]));
  return Object.fromEntries(fronts.map((p) => [pageKey(p), r.page]));
}

/** Apply a backs rule as one undo step, and say what it did. */
export function applyRule(game: Game, group: CutGroup, kind: RuleKind, flip: BackFlip, map?: BacksMap) {
  const dims = (r: PageRef) => pageDims(game, r);
  const count = (id: string) => game.sources.find((s) => s.id === id)?.pageCount ?? 0;
  let result: { skipped?: string[]; lost: ID[] } = { lost: [] };
  const before = useCutter.getState().doc;
  const label = kind === 'turned-over' ? 'Backs: turned over on the next page' : kind === 'backs-page' ? 'Backs: a page of backs' : 'Backs: paired by hand';
  clearPairToasts();
  commit(label, (d) => {
    const doc = d as CutterDoc;
    if (kind === 'turned-over') result = applyTurnedOver(doc, group.id, flip, dims, count);
    else if (kind === 'backs-page') result = applyBacksPage(doc, group.id, map ?? {}, flip, dims);
    else {
      dropRuleGrids(doc, group.id, null);
      setHandRule(doc, group.id);
    }
  });
  const after = useCutter.getState().doc;
  const g = after.groups.find((x) => x.id === group.id)!;
  // the pages whose backs changed (made, moved or removed)
  const touched = new Map<string, PageRef>();
  for (const id of new Set([...Object.keys(before.grids), ...Object.keys(after.grids)])) {
    const x = after.grids[id] ?? before.grids[id];
    if (x.groupId === group.id && (x.backOf || x.backs) && before.grids[id] !== after.grids[id]) touched.set(pageKey(x.at), x.at);
  }
  markPages([...touched.values()]);
  const removed = Object.values(before.grids).filter((x) => x.groupId === group.id && (x.backOf || x.byRule) && !after.grids[x.id]);
  if (result.lost.length) {
    const nums = result.lost.map((id) => pieceNumber(after, g, id)).filter((n) => n > 0).sort((a, b) => a - b);
    pairToast(
      toast(`${nums.length === 1 ? `Piece ${nums[0]} has` : `Pieces ${nums.join(', ')} have`} no back`, {
        kind: 'warning',
        description: `${nums.length === 1 ? 'Its back is' : 'Their backs are'} paired by hand with another piece — a back goes on one piece. Pick another in Pieces.`,
        duration: 7000,
      }),
    );
  } else if (kind === 'turned-over') {
    const pages = [...touched.values()].filter((p) => Object.values(after.grids).some((x) => x.backOf && x.groupId === group.id && pageKey(x.at) === pageKey(p))).map((p) => pageLabel(game, p));
    const said = pageList(pages);
    if (pages.length)
      toast(`Backs on ${said}`, {
        description: result.skipped?.length ? `No page to turn over for ${result.skipped.join(', ')}.` : 'Each front is paired with the piece behind it — check them in Pieces.',
        duration: 5000,
      });
  } else if (removed.length) {
    const pages = [...new Set(removed.map((x) => pageLabel(game, x.at)))];
    toast(`Removed the backs on ${pageList(pages)}`, { description: 'The rule that made them is no longer used.', action: { label: 'Undo', onClick: () => void undo() }, duration: 6000 });
  }
}

/** How the rule places backs, in words that match what happens on this group's pages. */
function placeWords(doc: CutterDoc, group: CutGroup): string {
  const r = group.backs.rule;
  if (!r || r.kind === 'hand') return '';
  const grids = Object.values(doc.grids).filter((x) => x.groupId === group.id && (r.kind === 'turned-over' ? x.backOf : x.backs));
  if (!grids.length) return '';
  const axes = new Set(
    grids.map((x) => {
      const size = r.kind === 'turned-over' ? x.backOf?.page : (r as Extract<CutBacksRule, { kind: 'backs-page' }>).size;
      const axis = size ? mirrorAxis(size.w, size.h, r.flip) : null;
      // a single row (or column) has nothing to swap across it
      if (axis === 'y' && x.rows === 1) return null;
      if (axis === 'x' && x.cols === 1) return null;
      return axis;
    }),
  );
  if (axes.size > 1) return 'pairs by place';
  const a = [...axes][0];
  return a === 'x' ? 'pairs by place, left and right swapped' : a === 'y' ? 'pairs by place, top and bottom swapped' : 'pairs by place, same position';
}

export function BacksSection({ game, doc, group }: { game: Game; doc: CutterDoc; group: CutGroup }) {
  const picking = useCutter((s) => s.pickBack === group.id);
  const b = group.backs;
  const rule = b.rule?.kind ?? 'hand';
  const flip: BackFlip = b.rule && b.rule.kind !== 'hand' ? b.rule.flip : 'long';
  const backs = Object.values(doc.frames).filter((f) => f.groupId === group.id && f.side === 'back');
  const byHand = (b.handPaired ?? []).filter((id) => doc.frames[id]).length;
  const checked = b.checked === pairsSignature(group);
  const shared = b.sharedFrameId ? doc.frames[b.sharedFrameId] : undefined;
  const sharedUrl = usePreview(game, doc, shared, group, 160);
  const rep = backsReport(doc, group);

  const setModeTo = (m: Mode) => {
    if (m === 'each' && !b.rule) return commit('Each has its own back', (d) => setHandRule(d as CutterDoc, group.id));
    commit(m === 'none' ? 'No backs' : m === 'same' ? 'One back for all' : 'Each has its own back', (d) => setBacksMode(d as CutterDoc, group.id, m));
    if (m === 'same' && !shared) setPickBack(group.id);
    else setPickBack(null);
  };

  // pages that could hold backs: every page with no fronts of this group
  const fronts = frontPagesOf(doc, group.id);
  const frontKeys = new Set(fronts.map(pageKey));
  const candidates = game.sources.flatMap((s) => s.pages.map((_, i) => ({ sourceId: s.id, page: i }))).filter((r) => !frontKeys.has(pageKey(r)));
  const map = currentMap(doc, group);
  const pickFor = (front: PageRef, v: string) => applyRule(game, group, 'backs-page', flip, { ...map, [pageKey(front)]: v ? (candidates.find((r) => pageKey(r) === v) ?? null) : null });
  /** Each front page gets the next candidate page after the first front page's choice. */
  const inOrder = () => {
    const start = map[pageKey(fronts[0])];
    const i0 = start ? candidates.findIndex((r) => pageKey(r) === pageKey(start)) : 0;
    applyRule(game, group, 'backs-page', flip, Object.fromEntries(fronts.map((p, i) => [pageKey(p), candidates[i0 + i] ?? null])));
  };
  const sameForAll = () => {
    const first = map[pageKey(fronts[0])];
    if (first) applyRule(game, group, 'backs-page', flip, Object.fromEntries(fronts.map((p) => [pageKey(p), first])));
  };
  /** First choice of a backs page: this group's own backs grid, else the page after the first front page. */
  const firstMap = (): BacksMap => {
    const own = candidates.find((r) => Object.values(doc.grids).some((g) => g.groupId === group.id && g.backs && pageKey(g.at) === pageKey(r)));
    const next = fronts[0] ? candidates.find((r) => r.sourceId === fronts[0].sourceId && r.page === fronts[0].page + 1) : undefined;
    const pick = own ?? next ?? candidates[0] ?? null;
    return Object.fromEntries(fronts.map((p, i) => [pageKey(p), i === 0 ? pick : null]));
  };

  const status = (() => {
    if (rule === 'hand' && !backs.length) return 'Frame the backs (a grid with “These are backs” on), then pair each front in Pieces.';
    const parts = [`${rep.distinct} of ${plural(rep.fronts, 'piece')} have their own back`];
    if (rep.shared) parts.push(`${rep.shared} share a back`);
    if (rep.fronts - rep.withBack) parts.push(`${rep.fronts - rep.withBack} without`);
    if (byHand) parts.push(`${byHand} paired by hand`);
    const words = placeWords(doc, group);
    if (words) parts.push(words);
    return parts.join(' · ') + '.';
  })();

  return (
    <div className="cut-field cut-backs" data-testid="backs-section">
      <div className="cut-field__label">Backs</div>
      <Segmented<Mode>
        size="sm"
        aria-label="Backs"
        value={b.mode}
        onChange={setModeTo}
        options={[
          { value: 'none', label: 'No backs' },
          { value: 'same', label: 'One for all' },
          { value: 'each', label: 'Each its own' },
        ]}
      />
      {b.mode === 'none' && <p className="cut-muted">The pieces get the deck’s plain back colour.</p>}

      {b.mode === 'same' && (
        <div className="cut-backs__same">
          {shared ? (
            <span className="cut-backs__img" data-testid="shared-back">
              {sharedUrl ? <img src={sharedUrl} alt="The back" draggable={false} /> : <span className="cut-piece__wait" />}
            </span>
          ) : b.assetId ? (
            <span className="cut-muted">An uploaded image.</span>
          ) : null}
          <div className="cut-col">
            {picking ? (
              <>
                <p className="cut-backs__pick" data-testid="pick-back-hint">
                  <MousePointerClick size={15} aria-hidden /> Tap the piece that shows the back — on any page or photo.
                </p>
                <Button size="sm" icon={X} onClick={() => setPickBack(null)} data-testid="pick-back-cancel">
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <p className="cut-muted">{shared ? `From ${pageLabel(game, shared.at)}. Every piece gets this back.` : 'Every piece gets the same back. Which piece shows it?'}</p>
                <Button size="sm" icon={MousePointerClick} onClick={() => setPickBack(group.id)} data-testid="pick-back">
                  {shared ? 'Pick another' : 'Pick it on the page'}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {b.mode === 'each' && (
        <>
          <label className="cut-field">
            <span className="cut-field__label">Pairs come from</span>
            <Select<RuleKind>
              value={rule}
              onChange={(k) => {
                if (k === rule) return;
                if (k === 'backs-page') {
                  if (!candidates.length) return void toast('Every page holds fronts of this group — add the page of backs first.');
                  applyRule(game, group, k, 'none', firstMap());
                } else applyRule(game, group, k, k === 'turned-over' ? 'long' : flip);
              }}
              options={[
                { value: 'turned-over', label: 'Turned over on the next page' },
                { value: 'backs-page', label: 'A page of backs' },
                { value: 'hand', label: 'By hand, in Pieces' },
              ]}
              data-testid="backs-rule"
            />
          </label>
          {rule === 'backs-page' && (
            <div className="cut-field" data-testid="backs-pages">
              <div className="cut-field__label">{fronts.length > 1 ? 'The backs of each page are on' : 'The backs are on'}</div>
              <div className="cut-backs__map">
                {fronts.map((p) => (
                  <label key={pageKey(p)} className="cut-backs__row">
                    {fronts.length > 1 && <span className="cut-backs__front">{pageLabel(game, p)}</span>}
                    <Select<string>
                      value={map[pageKey(p)] ? pageKey(map[pageKey(p)]!) : ''}
                      onChange={(v) => pickFor(p, v)}
                      options={[{ value: '', label: 'No backs' }, ...candidates.map((r) => ({ value: pageKey(r), label: pageLabel(game, r) }))]}
                      data-testid="backs-page"
                    />
                  </label>
                ))}
              </div>
              {fronts.length > 1 && (
                <div className="cut-row">
                  <Button size="sm" icon={ListOrdered} onClick={inOrder} data-testid="backs-in-order">
                    Next pages in order
                  </Button>
                  <Button size="sm" variant="ghost" onClick={sameForAll} disabled={!map[pageKey(fronts[0])]} data-testid="backs-same-page">
                    Same page for all
                  </Button>
                </div>
              )}
              {rep.reused.map((u) => (
                <p key={pageKey(u.at)} className="cut-backs__warn" data-testid="backs-reused">
                  <AlertTriangle size={14} aria-hidden /> {pageLabel(game, u.at)}’s backs are used for {u.pages} pages — each of its backs goes on {u.pages} pieces.
                </p>
              ))}
            </div>
          )}
          {rule !== 'hand' && (
            <div className="cut-field">
              <div className="cut-field__label">{rule === 'turned-over' ? 'Turned over on the' : 'The backs are'}</div>
              <Segmented<BackFlip> size="sm" aria-label={rule === 'turned-over' ? 'How the sheet turns over' : 'How the backs are laid out'} value={flip} onChange={(f) => applyRule(game, group, rule, f, rule === 'backs-page' ? map : undefined)} options={rule === 'turned-over' ? FLIPS : PAGE_FLIPS} />
            </div>
          )}
          <p className="cut-muted" data-testid="backs-status">
            {status}
          </p>
          {rep.unused > 0 && (
            <p className="cut-backs__warn" data-testid="backs-unused">
              <AlertTriangle size={14} aria-hidden /> {plural(rep.unused, 'back')} not on any piece.
            </p>
          )}
        </>
      )}

      {b.mode !== 'none' && (
        <Button size="sm" variant={checked ? 'ghost' : 'secondary'} icon={b.mode === 'each' && rule === 'hand' ? Hand : ArrowRight} onClick={() => setMode('pieces', group.id)} data-testid="check-pairs">
          {checked ? 'Pairs checked — see them' : b.mode === 'each' && rule === 'hand' ? 'Pair them in Pieces' : 'Check the fronts & backs'}
        </Button>
      )}
    </div>
  );
}
