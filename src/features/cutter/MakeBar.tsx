/**
 * The make bar: one row per group with what it still needs, "Made ✓ · View" or "Changed · Update",
 * a Make button per group and one "Make all ready". Progress shows in the run dialog; a single make
 * ends with a toast, Make all with one summary — and you stay in the Cutter either way. A group with
 * backs whose pairs were never checked opens Pieces first. Making never touches the table (Q3).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, CircleAlert, Copy, Hammer, MoreHorizontal, RefreshCw, Scissors } from 'lucide-react';
import { Button, IconButton, MenuButton, toast, type MenuItem } from '@/ui';
import type { CutGroup, CutterDoc, Game, ID } from '@/shared/types';
import { groupSignature } from '@/shared/cutter/doc';
import { planGroup } from '@/shared/cutter/pieces';
import { RunDialog, type RunState } from './RunDialog';
import { goTo, patchDoc, select, setMode, useCutter } from './store';
import { groupTint, KIND_NOUN } from './ops';
import { CancelledError, makeGroup, storeEnv, type CancelToken, type MakeResult } from './make';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type GroupStatus =
  | { kind: 'blocked'; text: string }
  | { kind: 'ready'; text: string }
  | { kind: 'made'; text: string }
  | { kind: 'changed'; text: string };

/** Short words for what a group still needs. */
function need(blocker: string): string {
  if (/size/i.test(blocker)) return 'needs a size';
  if (/no pieces|nothing|left out/i.test(blocker)) return 'no pieces yet';
  if (/twisted/i.test(blocker)) return 'a frame is twisted';
  if (/shows the back/i.test(blocker)) return 'needs its back';
  if (/deck this back/i.test(blocker)) return 'needs a deck';
  if (/no longer exists/i.test(blocker)) return 'a page is missing';
  return blocker.replace(/\.$/, '').toLowerCase();
}

/** Is what the group made still in the game? */
function madeExists(game: Game, g: CutGroup) {
  const m = g.made;
  if (!m) return false;
  if (g.kind === 'cover') return true;
  if (m.componentId) return game.components.some((c) => c.id === m.componentId);
  return false;
}

export function groupStatus(doc: CutterDoc, game: Game, g: CutGroup, empties?: Record<ID, true>): GroupStatus {
  const plan = planGroup(doc, g, game.sources, { isBlank: (f) => !!empties?.[f.id] });
  const total = plan.pieces.reduce((n, p) => n + p.count, 0);
  const noun = KIND_NOUN[g.kind];
  const what = g.kind === 'cards' || g.kind === 'tokens' ? plural(total, noun[0], noun[1]) : g.kind === 'board' ? plural(plan.pieces.length || 1, 'board') : noun[0];
  if (plan.blockers.length) return { kind: 'blocked', text: need(plan.blockers[0]) };
  if (madeExists(game, g)) return g.made!.signature && g.made!.signature === groupSignature(doc, g.id) ? { kind: 'made', text: what } : { kind: 'changed', text: what };
  return { kind: 'ready', text: what };
}

/** Pairs of a group with backs must be looked at once before its first make. */
let gateToast: number | null = null;
const dropGateToast = () => {
  if (gateToast != null) toast.dismiss(gateToast);
  gateToast = null;
};
const needsPairCheck = (g: CutGroup) => (g.kind === 'cards' || g.kind === 'tokens') && g.backs.mode !== 'none' && !g.backs.checked;

/** Where "View" goes for what a group made. */
function viewPath(game: Game, g: CutGroup) {
  if (g.kind === 'cover') return `/games/${game.id}/edit`;
  if (g.kind === 'tokens' && (g.made?.pieceIds.length ?? 0) > 1) return `/games/${game.id}/edit/components`;
  return g.made?.componentId ? `/games/${game.id}/edit/components/${g.made.componentId}` : `/games/${game.id}/edit/components`;
}

export function MakeBar({ game, floating }: { game: Game; floating?: boolean }) {
  const doc = useCutter((s) => s.doc);
  const paused = useCutter((s) => s.save.state === 'conflict');
  const navigate = useNavigate();
  const [run, setRun] = useState<RunState | null>(null);
  const cancel = useRef<CancelToken>({ cancelled: false });
  const [busy, setBusy] = useState(false);
  const empties = useCutter((s) => s.empties);
  if (!doc.groups.length) return null;
  const rows = doc.groups.map((g) => ({ g, st: groupStatus(doc, game, g, empties) }));
  const todo = rows.filter((r) => r.st.kind === 'ready' || r.st.kind === 'changed');

  /** Make one group (no dialog afterwards: a toast, you stay here). */
  const makeOne = async (groupId: ID, opts: { separate?: boolean; quiet?: boolean; onProgress?: (v: number, label: string) => void } = {}): Promise<MakeResult | null> => {
    const g = useCutter.getState().doc.groups.find((x) => x.id === groupId);
    if (!g) return null;
    const r = await makeGroup({
      env: storeEnv(),
      doc: useCutter.getState().doc,
      groupId,
      separate: opts.separate,
      cancel: cancel.current,
      onProgress: (p) => opts.onProgress?.(p.value, p.label),
    });
    // what was made is recorded on the group (not an undoable edit: undo keeps it); a separate
    // copy is a one-off — the group keeps updating what it made before
    if (!opts.separate)
      patchDoc((d) => {
        const dg = d.groups.find((x) => x.id === groupId);
        if (dg) dg.made = r.group.made;
      });
    return r;
  };

  const check = (g: CutGroup) => {
    if (!needsPairCheck(g)) return true;
    setMode('pieces', g.id);
    gateToast = toast(`Check the fronts & backs of “${g.name}” first`, { description: 'Look at each front beside its back, press “The pairs look right”, then Make.', duration: 6000 });
    return false;
  };

  const doneWords = (g: CutGroup, r: MakeResult) => {
    const n = r.total;
    const noun = KIND_NOUN[g.kind];
    if (g.kind === 'cards') return `${r.updated ? 'Updated' : 'Made'} ${plural(n, 'card')} in ${g.name}`;
    if (g.kind === 'tokens') return r.pieceIds.length === 1 ? `${r.updated ? 'Updated' : 'Made'} ${g.name} ×${n}` : `${r.updated ? 'Updated' : 'Made'} ${r.pieceIds.length} tokens in ${g.name} (${n} in all)`;
    if (g.kind === 'board') return `${r.updated ? 'Updated' : 'Made'} ${g.name}`;
    return `${r.updated ? 'Updated' : 'Set'} the ${noun[0]}`;
  };

  const single = async (g: CutGroup, separate = false) => {
    if (busy || !check(g)) return;
    dropGateToast();
    cancel.current = { cancelled: false };
    setBusy(true);
    const title = `${separate ? 'Making a copy of' : g.made ? 'Updating' : 'Making'} ${g.name}`;
    setRun({ phase: 'running', title, progress: { value: 0, label: 'Starting…' } });
    try {
      const r = await makeOne(g.id, { separate, onProgress: (value, label) => setRun({ phase: 'running', title, progress: { value, label } }) });
      setRun(null);
      if (r && separate) toast.success(`Made a separate copy: ${r.group.name}`, { description: `A one-off. Updates still go to ${g.name}.`, action: { label: 'View', onClick: () => navigate(viewPath(game, { ...g, made: r.group.made })) }, duration: 7000 });
      else if (r) toast.success(doneWords(g, r), { action: { label: g.kind === 'cards' ? 'View deck' : 'View', onClick: () => navigate(viewPath(game, { ...g, made: r.group.made })) }, duration: 6000 });
    } catch (e) {
      if (e instanceof CancelledError) setRun(null);
      else setRun({ phase: 'error', title: `${g.name} could not be made`, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const all = async () => {
    if (busy) return;
    const groups = todo.map((r) => r.g);
    const unchecked = groups.find(needsPairCheck);
    if (unchecked) return void check(unchecked);
    dropGateToast();
    cancel.current = { cancelled: false };
    setBusy(true);
    const lines: string[] = [];
    const failed: string[] = [];
    const previews: { url: string; aspect: number }[] = [];
    try {
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const title = `Making ${i + 1} of ${groups.length} — ${g.name}`;
        setRun({ phase: 'running', title, progress: { value: i / groups.length, label: 'Starting…' } });
        try {
          const r = await makeOne(g.id, { onProgress: (v, label) => setRun({ phase: 'running', title, progress: { value: (i + v) / groups.length, label } }) });
          if (r) {
            lines.push(doneWords(g, r));
            previews.push(...r.previews.slice(0, Math.max(1, Math.ceil(7 / groups.length))));
          }
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          failed.push(`${g.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setRun({
        phase: 'done',
        title: failed.length ? `Made ${plural(lines.length, 'group')} · ${failed.length} could not be made` : `Made ${plural(lines.length, 'group')}`,
        description: [...lines, ...failed.map((f) => `Not made — ${f}`)].join(' · '),
        previews,
        actions: (
          <>
            <Button onClick={() => setRun(null)} data-testid="summary-keep">
              Keep cutting
            </Button>
            <Button variant="primary" onClick={() => navigate(`/games/${game.id}/edit/components`)} data-testid="summary-view">
              View components
            </Button>
          </>
        ),
      });
    } catch (e) {
      if (e instanceof CancelledError) {
        setRun(lines.length ? { phase: 'done', title: `Stopped — made ${plural(lines.length, 'group')}`, description: lines.join(' · '), previews, actions: <Button onClick={() => setRun(null)}>Keep cutting</Button> } : null);
      } else setRun({ phase: 'error', title: 'Make all stopped', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`cut-make ${floating ? 'is-floating' : ''}`} data-testid="make-bar" role="region" aria-label="Make" onPointerDown={(e) => e.stopPropagation()}>
      <span className="cut-make__label">
        <Hammer size={15} aria-hidden /> Make
      </span>
      <div className="cut-make__scroller">
      <MoreRows count={rows.length} side="left" />
      <ul className="cut-make__rows" data-testid="make-rows">
        {rows.map(({ g, st }) => {
          const menu: MenuItem[] = [
            { label: 'Show on the pages', icon: Scissors, onSelect: () => (setMode('pages', g.id), focusGroup(g.id)) },
            ...(g.made && madeExists(game, g) ? [{ label: 'Make a separate copy instead', icon: Copy, hint: 'A one-off copy — Updates keep going to what it made', disabled: st.kind === 'blocked' || busy, onSelect: () => void single(g, true) } as MenuItem] : []),
          ];
          return (
            <li key={g.id} className={`cut-make__row cut-t${groupTint(doc, g.id)} is-${st.kind}`} data-testid="make-row" data-group={g.id} data-status={st.kind}>
              <span className="cut-swatch" aria-hidden />
              <button type="button" className="cut-make__name" onClick={() => focusGroup(g.id)} title={`Show ${g.name}`}>
                {g.name}
              </button>
              <span className="cut-make__status" data-testid="make-status">
                {st.kind === 'blocked' && (
                  <>
                    <CircleAlert size={13} aria-hidden /> {st.text}
                  </>
                )}
                {st.kind === 'ready' && (
                  <>
                    {st.text} <Check size={13} aria-hidden />
                  </>
                )}
                {st.kind === 'made' && (
                  <>
                    Made <Check size={13} aria-hidden /> ·{' '}
                    <button type="button" className="cut-textbtn" onClick={() => navigate(viewPath(game, g))} data-testid="make-view">
                      View
                    </button>
                  </>
                )}
                {st.kind === 'changed' && <>Changed</>}
              </span>
              {st.kind === 'ready' && (
                <Button size="sm" variant="secondary" onClick={() => void single(g)} disabled={busy || paused} data-testid="make-one">
                  Make
                </Button>
              )}
              {st.kind === 'changed' && (
                <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void single(g)} disabled={busy || paused} data-testid="make-update">
                  Update
                </Button>
              )}
              <MenuButton items={menu} placement="top-end">
                <IconButton icon={MoreHorizontal} label={`More for ${g.name}`} size="sm" />
              </MenuButton>
            </li>
          );
        })}
      </ul>
      <MoreRows count={rows.length} side="right" />
      </div>
      {rows.length > 1 && <Button variant="primary" size="sm" onClick={() => void all()} disabled={!todo.length || busy || paused} data-testid="make-all">
        {todo.length ? `Make all ready (${todo.length})` : rows.every((r) => r.st.kind === 'made') ? 'All made' : 'Nothing ready to make'}
      </Button>}
      <RunDialog state={run} onCancel={() => (cancel.current.cancelled = true)} onClose={() => setRun(null)} />
    </div>
  );
}

/**
 * Rows that don't fit (a tablet's floating bar): a fade and "+N ›" at the edge that scrolls to them.
 * Renders nothing while everything fits.
 */
function MoreRows({ count, side }: { count: number; side: 'left' | 'right' }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  useEffect(() => {
    const ul = ref.current?.parentElement?.querySelector<HTMLUListElement>('.cut-make__rows');
    if (!ul) return;
    const measure = () => {
      const box = ul.getBoundingClientRect();
      let left = 0;
      let right = 0;
      // a row counts as hidden when it starts past the edge (a row half in view is still readable)
      for (const li of Array.from(ul.children)) {
        const r = li.getBoundingClientRect();
        if (r.left > box.right - 24) right++;
        else if (r.right < box.left + 24) left++;
      }
      setHidden((h) => (h.left === left && h.right === right ? h : { left, right }));
    };
    measure();
    ul.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => {
      ul.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [count]);
  /** Scroll so the next row that does not fit starts at the edge — never half a row. */
  const scroll = (dir: number) => {
    const ul = ref.current?.parentElement?.querySelector<HTMLUListElement>('.cut-make__rows');
    if (!ul) return;
    const box = ul.getBoundingClientRect();
    const items = Array.from(ul.children) as HTMLElement[];
    const next = dir > 0 ? items.find((li) => li.getBoundingClientRect().left > box.right - 24) : [...items].reverse().find((li) => li.getBoundingClientRect().right < box.left + 24);
    if (!next) return;
    ul.scrollTo({ left: next.offsetLeft - (ul.firstElementChild as HTMLElement).offsetLeft, behavior: 'smooth' });
  };
  return (
    <span ref={ref} className="cut-make__more-anchor">
      {side === 'left' && hidden.left > 0 && (
        <button type="button" className="cut-make__more is-left" onClick={() => scroll(-1)} aria-label={`${hidden.left} more groups to the left`} data-testid="make-more-left">
          ‹ {hidden.left}
        </button>
      )}
      {side === 'right' && hidden.right > 0 && (
        <button type="button" className="cut-make__more is-right" onClick={() => scroll(1)} aria-label={`${hidden.right} more groups`} data-testid="make-more">
          +{hidden.right} ›
        </button>
      )}
    </span>
  );
}

/** Go to a group's first page with its grid selected. */
export function focusGroup(groupId: ID) {
  const doc = useCutter.getState().doc;
  const f = Object.values(doc.frames)
    .filter((x) => x.groupId === groupId)
    .sort((a, b) => a.at.page - b.at.page || (a.cell ?? 0) - (b.cell ?? 0))[0];
  if (!f) return;
  if (doc.view?.mode === 'pieces') setMode('pages');
  goTo(f.at);
  select(f.gridId ? { gridId: f.gridId } : { frameId: f.id });
}
