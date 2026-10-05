/**
 * Dice chrome on the table:
 *  - <DiceSelectionBar> "Roll N dice" for a selection of dice (touch-friendly, no keyboard needed)
 *  - <RollReadout> the values and total of the last multi-dice roll, beside the landed group
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Dices, X } from 'lucide-react';
import type { DieEntity, DieFace, Entity } from '@/shared/types';
import { assetUrlById } from '@/api/client';
import { Button, IconButton, Kbd } from '@/ui';
import { getComponent, inZone, isEndless, unionRects, worldAABB, zoneTakes } from '../engine';
import { DEFAULT_FACES } from '../dice/DieView';
import { useCtl, useUi } from './store';

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDie = (e: Entity | undefined): e is DieEntity => e?.kind === 'die';

/* ------------------------------------------------------------------ */
/* Selection bar                                                        */
/* ------------------------------------------------------------------ */

export function DiceSelectionBar() {
  const ctl = useCtl();
  const coarse = ctl.coarsePointer;
  // a joined id list: re-renders only when the selected dice change, not on every commit
  const key = useUi((s) => {
    if (s.mode !== 'play' || s.ghost) return '';
    const ids = Object.keys(s.selection).filter((id) => isDie(s.state.entities[id]) && !s.state.entities[id].locked);
    // on touch the bar appears with the first die, to say how to pick more (there is no Shift)
    return ids.length > (coarse ? 0 : 1) ? ids.join('|') : '';
  });
  const entities = useUi((s) => (key ? s.state.entities : null));
  const el = useRef<HTMLDivElement>(null);
  const dodge = useRef(0);

  // Never sit on a die: slide sideways to the nearest clear spot above the hand.
  useLayoutEffect(() => {
    if (!key) return;
    const place = () => {
      const node = el.current;
      const root = ctl.root;
      if (!node || !root) return;
      const b0 = node.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const left = b0.left - dodge.current;
      const right = b0.right - dodge.current;
      const dice = [...root.querySelectorAll<HTMLElement>('.play-world .play-ent--die .play-ent__body')].map((d) => d.getBoundingClientRect());
      const hits = (dx: number) => dice.some((d) => d.right > left + dx - 8 && d.left < right + dx + 8 && d.bottom > b0.top - 8 && d.top < b0.bottom + 8);
      const lo = r.left + 16 - left;
      const hi = r.right - 76 - right;
      let best = 0;
      if (hits(0)) {
        best = NaN;
        for (let k = 1; k <= 30 && Number.isNaN(best); k++) {
          const step = k * 24;
          if (-step >= lo && !hits(-step)) best = -step;
          else if (step <= hi && !hits(step)) best = step;
        }
        if (Number.isNaN(best)) best = 0;
      }
      if (best !== dodge.current) {
        dodge.current = best;
        node.style.setProperty('--dodge', `${best}px`);
      }
    };
    place();
    const off = ctl.subscribeCamera(place);
    return () => {
      off();
    };
  }, [key, entities, ctl]);

  if (!key) return null;
  const ids = key.split('|');
  return (
    <div ref={el} className="play-dicebar" data-ui role="toolbar" aria-label="Selected dice" style={{ '--dodge': `${dodge.current}px` } as CSSProperties}>
      {ids.length > 1 && (
        <Button variant="primary" icon={Dices} onClick={() => ctl.roll(ids)}>
          Roll {ids.length} dice
        </Button>
      )}
      {coarse && <span className="play-dicebar__hint">{ids.length > 1 ? 'Tap dice to add or remove' : 'Tap other dice to throw them together'}</span>}
      <Kbd keys="R" className="play-dicebar__kbd" />
      <IconButton icon={X} label="Clear selection" shortcut="Esc" onClick={() => ctl.clearSelection()} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Results readout                                                      */
/* ------------------------------------------------------------------ */

const SHOW_AFTER_MS = 900; // the dice have landed (tumbles run 720–860 ms)
const STAY_MS = 7000;

interface Result {
  text: string;
  image?: string;
  num: number | null;
}
interface Group {
  key: string;
  name: string;
  color: string;
  ink: string;
  results: Result[];
}

function faceResult(f: DieFace | undefined, i: number, url: (id: string | null) => string | undefined): Result {
  const label = f?.label?.trim();
  if (label) {
    const n = Number(label.replace(/^\+/, ''));
    return { text: label, num: /^[+-]?\d+(\.\d+)?$/.test(label) ? n : null };
  }
  if (f?.image) return { text: f.value != null ? String(f.value) : '', image: url(f.image), num: f.value ?? null };
  const v = f?.value ?? i + 1;
  return { text: String(v), num: v };
}

/** A big pool of one type reads better as "6 ×3  5 ×2" than as fifteen chips. */
function chipsOf(results: Result[]): (Result & { count: number })[] {
  if (results.length <= 5) return results.map((r) => ({ ...r, count: 1 }));
  const out: (Result & { count: number })[] = [];
  for (const r of results) {
    const same = out.find((o) => o.text === r.text && o.image === r.image);
    if (same) same.count++;
    else out.push({ ...r, count: 1 });
  }
  return out;
}

export function RollReadout() {
  const ctl = useCtl();
  const rr = useUi((s) => s.rollReadout);
  const entities = useUi((s) => (s.rollReadout ? s.state.entities : null));
  const game = useUi((s) => s.game);
  const [visible, setVisible] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [hover, setHover] = useState(false);
  const el = useRef<HTMLDivElement>(null);

  // still showing that roll? (undo, a re-roll or a removed die makes the readout stale)
  const valid = !!rr && !!entities && rr.ids.every((id, i) => isDie(entities[id]) && (entities[id] as DieEntity).rollSeq === rr.seqs[i]);
  useEffect(() => {
    if (rr && !valid) ctl.ui.setState({ rollReadout: null });
  }, [rr, valid, ctl]);

  useEffect(() => {
    setVisible(null);
    setLeaving(false);
    if (!rr) return;
    const t = window.setTimeout(() => setVisible(rr.seq), reduceMotion() ? 60 : SHOW_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [rr?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = !!rr && valid && visible === rr.seq;
  const dismiss = () => {
    if (!rr) return;
    const seq = rr.seq;
    setLeaving(true);
    window.setTimeout(() => {
      if (ctl.ui.getState().rollReadout?.seq === seq) ctl.ui.setState({ rollReadout: null });
    }, reduceMotion() ? 0 : 160);
  };

  // leaves on its own; pointing at it keeps it
  useEffect(() => {
    if (!shown || hover || leaving) return;
    const t = window.setTimeout(dismiss, STAY_MS);
    return () => window.clearTimeout(t);
  }, [shown, hover, leaving]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = useMemo(() => {
    if (!shown || !rr || !entities) return null;
    const url = (id: string | null) => assetUrlById(game, id);
    const groups = new Map<string, Group>();
    for (const id of rr.ids) {
      const d = entities[id] as DieEntity;
      const comp = getComponent(game, d.componentId);
      const dc = comp?.kind === 'dice' ? comp : null;
      const faces = dc?.faces.length ? dc.faces : DEFAULT_FACES;
      let g = groups.get(d.componentId);
      if (!g) {
        g = { key: d.componentId, name: dc?.name?.trim() || `d${faces.length}`, color: dc?.color ?? '#f1ebdd', ink: dc?.inkColor ?? '#2a241c', results: [] };
        groups.set(d.componentId, g);
      }
      g.results.push(faceResult(faces[d.face], d.face, url));
    }
    // in the game's own component order, whatever order the dice were picked up in
    const rank = new Map(game.components.map((c, i) => [c.id, i]));
    const list = [...groups.values()].sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    // highest first inside a group: "any sixes?" reads at a glance
    for (const g of list) g.results.sort((a, b) => (b.num ?? -Infinity) - (a.num ?? -Infinity));
    const all = list.flatMap((g) => g.results);
    const nums = all.filter((r) => r.num != null);
    const total = nums.reduce((s, r) => s + (r.num as number), 0);
    return { groups: list, total: nums.length ? Math.round(total * 100) / 100 : null, partial: nums.length > 0 && nums.length < all.length, count: all.length };
  }, [shown, rr, entities, game]);

  // Beside the landed group — above it, else below, else to a side — clear of the chrome, and
  // following the camera without re-rendering.
  useLayoutEffect(() => {
    if (!data || !rr) return;
    const place = () => {
      const node = el.current;
      const table = ctl.root;
      if (!node || !table) return;
      const s = ctl.state;
      const boxes = rr.ids.map((id) => s.entities[id]).filter(Boolean).map((e) => worldAABB(ctl.game, e as Entity));
      let b = unionRects(boxes);
      if (!b) return;
      // dice resting in a tray: the readout sits clear of the whole tray, not over part of it
      const dice = rr.ids.map((id) => s.entities[id]).filter(Boolean) as Entity[];
      for (const id of s.order) {
        const z = s.entities[id];
        if (z?.kind !== 'zone' || isEndless(z) || !zoneTakes(z, 'dice') || !dice.every((d) => inZone(z, d))) continue;
        b = unionRects([b, worldAABB(ctl.game, z)])!;
      }
      const r = ctl.rect;
      const ins = ctl.insets();
      const a = ctl.worldToScreen({ x: b.x, y: b.y });
      const z = ctl.worldToScreen({ x: b.x + b.w, y: b.y + b.h });
      const g = { l: a.x - r.left, t: a.y - r.top, r: z.x - r.left, b: z.y - r.top };
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      const gap = 14;
      const lo = { x: ins.l, y: ins.t - 20 };
      const hi = { x: r.width - ins.r - w, y: r.height - ins.b - h };
      const cx = (g.l + g.r) / 2 - w / 2;
      const cy = (g.t + g.b) / 2 - h / 2;
      const cands = [
        { x: cx, y: g.t - gap - h },
        { x: cx, y: g.b + gap },
        { x: g.r + gap, y: cy },
        { x: g.l - gap - w, y: cy },
        // a big spread group can fill the middle of the screen: then a corner of the free table
        { x: lo.x, y: lo.y },
        { x: hi.x, y: lo.y },
        { x: lo.x, y: hi.y },
        { x: hi.x, y: hi.y },
      ];
      // cards, tokens, counters, notes on screen: the readout would rather not hide a deck either
      const pieces = [...table.querySelectorAll<HTMLElement>('.play-world .play-ent:not(.play-ent--die):not(.is-fixed) .play-ent__body')]
        .map((p) => p.getBoundingClientRect())
        .filter((q) => q.width > 0)
        .map((q) => ({ l: q.left - r.left, t: q.top - r.top, r: q.right - r.left, b: q.bottom - r.top }));
      const clampX = (x: number) => Math.min(Math.max(x, lo.x), Math.max(lo.x, hi.x));
      const clampY = (y: number) => Math.min(Math.max(y, lo.y), Math.max(lo.y, hi.y));
      // first spot that fits without being pushed back over the dice
      let best = cands[0];
      let bestCost = Infinity;
      for (const [i, c] of cands.entries()) {
        const p = { x: clampX(c.x), y: clampY(c.y) };
        const overlapX = Math.max(0, Math.min(p.x + w, g.r) - Math.max(p.x, g.l));
        const overlapY = Math.max(0, Math.min(p.y + h, g.b) - Math.max(p.y, g.t));
        // prefer above, then below: a readout slid sideways a little still reads as "about these dice"
        let covered = 0;
        for (const q of pieces) covered += Math.max(0, Math.min(p.x + w, q.r) - Math.max(p.x, q.l)) * Math.max(0, Math.min(p.y + h, q.b) - Math.max(p.y, q.t));
        const cost = overlapX * overlapY * 10 + covered * 0.6 + Math.hypot(p.x - c.x, p.y - c.y) + i * 60;
        if (cost < bestCost - 0.5) {
          bestCost = cost;
          best = p;
        }
      }
      node.style.transform = `translate(${Math.round(best.x)}px, ${Math.round(best.y)}px)`;
    };
    place();
    const off = ctl.subscribeCamera(place);
    return () => {
      off();
    };
  }, [data, rr, ctl]);

  if (!data) return null;
  return (
    <div
      ref={el}
      className={`play-rolls ${leaving ? 'is-leaving' : ''}`}
      role="status"
      aria-live="polite"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
    >
      <div className={`play-rolls__inner ${data.count > 8 ? 'is-dense' : ''}`}>
        <div className="play-rolls__groups">
          {data.groups.map((g) => (
            <div key={g.key} className="play-rolls__group">
              <span className="play-rolls__name">
                {g.name}
                {g.results.length > 1 && <em> ×{g.results.length}</em>}
              </span>
              <span className="play-rolls__chips">
                {chipsOf(g.results).map((res, i) => (
                  <span key={i} className={`play-rolls__chip ${res.text.length > 3 ? 'is-wide' : ''}`} style={{ background: g.color, color: g.ink }}>
                    {res.image ? <img src={res.image} alt={res.text || 'image face'} /> : res.text}
                    {res.count > 1 && <small className="play-rolls__times">×{res.count}</small>}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        {data.total != null && (
          <div className="play-rolls__total" title={data.partial ? 'Sum of the numbered results' : undefined}>
            <span>{data.partial ? 'Sum of numbers' : 'Total'}</span>
            <strong>{data.total}</strong>
          </div>
        )}
        <IconButton icon={X} label="Dismiss" size="sm" className="play-rolls__close" tooltip={false} data-ui onClick={dismiss} />
      </div>
    </div>
  );
}
