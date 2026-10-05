/**
 * "Join into one board" (§3g): a Board group with 2+ frames becomes one board — direction, the parts
 * in order, overlap and shift per seam, the printed bleed, and a preview of the whole board with a
 * close look at every seam. On flat pages the seams can be measured (the slicer's glue-tab trim +
 * overlap); photos are joined by eye only (owner ruling Q6). Feeds Make / Update like any group.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Ruler } from 'lucide-react';
import { Button, NumberField, Segmented, Switch, toast } from '@/ui';
import type { CutFrame, CutGroup, CutterDoc, Game } from '@/shared/types';
import { groupSize, joinParts, seamsFor, type Seam } from '@/shared/cutter/pieces';
import { commit, patchDoc, undo, useCutter } from './store';
import { pageLabel } from './ops';
import { openPageSource, type PageSource } from './pageSource';
import { renderJoined } from './make';
import { measureSeams } from './helpers';
import { useBurst } from './PagePanel';

const r1 = (v: number) => Math.round(v * 10) / 10;

async function sourcesFor(game: Game, frames: CutFrame[]) {
  const ps = new Map<string, PageSource>();
  for (const f of frames) if (!ps.has(f.at.sourceId)) ps.set(f.at.sourceId, await openPageSource(game, game.sources.find((s) => s.id === f.at.sourceId)!));
  return (f: CutFrame) => ps.get(f.at.sourceId)!;
}

export function JoinPanel({ game, doc, group }: { game: Game; doc: CutterDoc; group: CutGroup }) {
  const burst = useBurst();
  const parts = joinParts(doc, group);
  const seams = group.join ? seamsFor(doc, group, parts) : [];
  const photo = parts.some((f) => game.sources.find((s) => s.id === f.at.sourceId)?.pages[f.at.page]?.photo && game.sources.find((s) => s.id === f.at.sourceId)?.kind === 'images');
  const j = group.join;
  const [busy, setBusy] = useState(false);
  if (parts.length < 2) return null;

  const setJoin = (on: boolean) => {
    commit(on ? 'Join into one board' : 'Separate boards', (d) => {
      const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
      if (!on) return void delete g.join;
      // the parts in reading order: by file and page, then left to right on the same page
      const rank = (f: CutFrame) => game.sources.findIndex((x) => x.id === f.at.sourceId);
      const cx = (f: CutFrame) => (f.quad[0][0] + f.quad[1][0] + f.quad[2][0] + f.quad[3][0]) / 4;
      const order = [...parts].sort((a, b) => rank(a) - rank(b) || a.at.page - b.at.page || cx(a) - cx(b));
      g.order = order.map((f) => f.id);
      g.join = { dir: 'h', joins: order.slice(1).map((f, i) => ({ key: `${order[i].id}>${f.id}`, overlap: 0, shift: 0, pending: true })), bleed: 0 };
    });
    if (on && !photo) void measure(false);
  };

  /** Flat pages only: shave the glue tab and find the overlap, as one undo step. `force`: re-measure
   * every seam (the button). Otherwise seams the user set by hand are left exactly as they are. */
  const measure = async (force: boolean) => {
    if (photo || busy) return;
    setBusy(true);
    try {
      const cur = useCutter.getState().doc;
      const g = cur.groups.find((x) => x.id === group.id)!;
      const ps = joinParts(cur, g);
      const src = await sourcesFor(game, ps);
      const r = await measureSeams(
        ps.map((f) => ({ page: f.at.page, ps: src(f), quad: f.quad })),
        g.join?.dir ?? 'h',
      );
      commit('Measure the seams', (d) => {
        const dd = d as CutterDoc;
        const gg = dd.groups.find((x) => x.id === group.id)!;
        if (!gg.join) return;
        ps.forEach((f, i) => {
          const fr = dd.frames[f.id];
          if (fr) {
            fr.quad = r.quads[i];
            fr.onGrid = false;
          }
        });
        const before = seamsFor(dd, gg);
        gg.join.joins = r.joins.map((m, i) => {
          const key = `${ps[i].id}>${ps[i + 1].id}`;
          const old = before.find((x) => x.key === key);
          // what the user set by hand stays put unless they asked for a fresh measurement
          if (!force && old && old.auto === false && !old.pending) return { ...old, key };
          return { key, overlap: m.overlap, shift: m.shift, auto: true, pending: false, ...(m.line.a || m.line.b ? { line: m.line } : {}) };
        });
      });
      const words = (useCutter.getState().doc.groups.find((x) => x.id === group.id)?.join?.joins ?? r.joins).map((m, i) => `seam ${i + 1}: overlap ${r1(m.overlap)} mm${m.shift ? `, shift ${r1(m.shift)} mm` : ''}${m.line?.a || m.line?.b ? ', a printed cut line painted over' : ''}`).join(' · ');
      toast(`Seams measured — ${words}`, { description: 'The glue tab is trimmed off. Check the seam preview; every number can be changed.', action: { label: 'Undo', onClick: () => void undo() }, duration: 7000 });
    } catch (e) {
      toast.error('The seams could not be measured', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Change one seam: the stored list is always the derived one, so nothing stale is written back. */
  const setSeam = (i: number, patch: { overlap?: number; shift?: number }, label: string) =>
    burst(label, (d) => {
      const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
      if (!g.join) return;
      const now = seamsFor(d as CutterDoc, g);
      now[i] = { ...now[i], ...patch, auto: false, pending: false };
      g.join.joins = now;
    });

  const move = (i: number, by: number) =>
    commit('Reorder the board parts', (d) => {
      const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
      const ids = parts.map((f) => f.id);
      [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
      g.order = ids;
    });

  return (
    <div className="cut-field cut-join" data-testid="join-panel">
      <SeamKeeper group={group} parts={parts} seams={seams} photo={photo} onMeasure={() => void measure(false)} />
      <Switch checked={!!j} onChange={setJoin} label="Join into one board" data-testid="join-switch" />
      {!j && <p className="cut-muted">{parts.length} frames make {parts.length} boards. Join them when they are parts of one board (halves printed on separate pages, or photographed in pieces).</p>}
      {j && (
        <>
          <div className="cut-field">
            <div className="cut-field__label">The parts go</div>
            <Segmented<'h' | 'v'> size="sm" aria-label="The parts go" value={j.dir} onChange={(v) => commit('Join direction', (d) => void ((d as CutterDoc).groups.find((x) => x.id === group.id)!.join!.dir = v))} options={[{ value: 'h', label: 'Side by side' }, { value: 'v', label: 'Top to bottom' }]} />
          </div>
          <ol className="cut-join__parts">
            {parts.map((f, i) => (
              <li key={f.id} className="cut-join__part">
                <span className="cut-join__n">{i + 1}</span>
                <span className="cut-join__where">{pageLabel(game, f.at)}</span>
                <button type="button" className="cut-pt__btn" aria-label="Earlier" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={15} />
                </button>
                <button type="button" className="cut-pt__btn" aria-label="Later" disabled={i === parts.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={15} />
                </button>
              </li>
            ))}
          </ol>
          {seams.map((s, i) => (
            <div key={s.key} className={`cut-join__seam ${s.pending ? 'is-pending' : ''}`} data-testid="join-seam">
              <div className="cut-field__label">
                <span>
                  Seam {i + 1} · parts {i + 1}–{i + 2}
                </span>
                <span className="cut-field__val">{s.pending ? 'not set yet' : s.auto ? 'measured' : 'set by hand'}</span>
              </div>
              <div className="cut-2col">
                <label className="cut-field cut-join__num">
                  <span className="cut-field__label">Overlap</span>
                  <NumberField size="sm" value={s.overlap} min={-20} max={120} step={0.1} precision={1} unit="mm" aria-label={`Overlap of seam ${i + 1}`} onChange={(v) => setSeam(i, { overlap: v }, 'Seam overlap')} />
                </label>
                <label className="cut-field cut-join__num">
                  <span className="cut-field__label">Shift along it</span>
                  <NumberField size="sm" value={s.shift} min={-60} max={60} step={0.1} precision={1} unit="mm" aria-label={`Shift of seam ${i + 1}`} onChange={(v) => setSeam(i, { shift: v }, 'Seam shift')} />
                </label>
              </div>
            </div>
          ))}
          <div className="cut-field">
            <div className="cut-field__label">Bleed around the board</div>
            <NumberField size="sm" value={j.bleed} min={0} max={10} step={0.5} precision={1} unit="mm" aria-label="Bleed around the board" onChange={(v) => burst('Board bleed', (d) => void ((d as CutterDoc).groups.find((x) => x.id === group.id)!.join!.bleed = v))} />
          </div>
          {photo ? (
            <p className="cut-muted" data-testid="join-photo-note">Photos are joined by eye: set each seam’s overlap and shift and watch the preview. Seams are measured on flat pages only.</p>
          ) : (
            <Button size="sm" icon={Ruler} onClick={() => void measure(true)} disabled={busy} data-testid="join-measure">
              {busy ? 'Measuring…' : 'Measure the seams again'}
            </Button>
          )}
          <JoinPreview game={game} doc={doc} group={group} parts={parts} seams={seams} />
        </>
      )}
    </div>
  );
}

/**
 * Keeps what is saved equal to what is shown: whenever the parts change (added, removed, reordered),
 * the stored seam list is rewritten from them (no undo step of its own — the part edit was the step).
 * On flat pages a new seam is measured straight away; on photos it waits for the user, marked
 * "not set yet".
 */
function SeamKeeper({ group, parts, seams, photo, onMeasure }: { group: CutGroup; parts: CutFrame[]; seams: Seam[]; photo: boolean; onMeasure: () => void }) {
  const measured = useRef('');
  const pending = seams.some((s) => s.pending);
  const partsKey = parts.map((f) => f.id).join(',');
  useEffect(() => {
    if (!group.join || photo || !pending || measured.current === partsKey) return;
    measured.current = partsKey;
    onMeasure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, partsKey, photo]);
  return null;
}

/** The joined board, small, with a close look at each seam. */
function JoinPreview({ game, doc, group, parts, seams }: { game: Game; doc: CutterDoc; group: CutGroup; parts: CutFrame[]; seams: Seam[] }) {
  const [img, setImg] = useState<{ url: string; W: number; H: number; seams: { x: number; y: number }[]; crops: string[] } | null>(null);
  const size = groupSize(doc, group, game.sources);
  const key = JSON.stringify([group.join?.dir, group.join?.bleed, seams, parts.map((f) => [f.at, f.quad]), size, doc.clean]);
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const src = await sourcesFor(game, parts);
        const paths = { crop: 0, warp: 0, photo: 0 };
        const dpi = 60;
        const j = await renderJoined({ frames: parts }, group, src, paths, size, seams, dpi, (f) => {
          const c = doc.clean[f.at.sourceId];
          return c ? { color: c.color, flatten: c.flatten, cornerMm: 0 } : undefined;
        });
        const k = j.canvas.width / j.W;
        const horiz = group.join!.dir === 'h';
        const marks = j.pos.slice(1).map((p) => ({ x: horiz ? p.x : 0, y: horiz ? 0 : p.y }));
        // a 40 mm window across every seam, from the same render
        const crops = marks.map((s) => {
          const c = document.createElement('canvas');
          const win = 40 * k;
          c.width = Math.round(horiz ? win : j.canvas.width);
          c.height = Math.round(horiz ? j.canvas.height : win);
          c.getContext('2d')!.drawImage(j.canvas, horiz ? s.x * k - win / 2 : 0, horiz ? 0 : s.y * k - win / 2, c.width, c.height, 0, 0, c.width, c.height);
          return c.toDataURL('image/jpeg', 0.85);
        });
        const url = j.canvas.toDataURL('image/jpeg', 0.8);
        j.canvas.width = j.canvas.height = 0;
        if (alive) setImg({ url, W: j.W, H: j.H, seams: marks, crops });
      } catch {
        if (alive) setImg(null);
      }
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!img) return <div className="cut-join__preview is-wait" />;
  return (
    <div className="cut-join__preview" data-testid="join-preview">
      <div className="cut-join__whole">
        <img src={img.url} alt="The joined board" draggable={false} />
        {img.seams.map((s, i) => (
          <span key={i} className={`cut-join__mark ${group.join!.dir === 'h' ? 'is-v' : 'is-h'}`} style={group.join!.dir === 'h' ? { left: `${(s.x / img.W) * 100}%` } : { top: `${(s.y / img.H) * 100}%` }} />
        ))}
      </div>
      <p className="cut-muted" data-testid="join-size">
        The board: {r1(img.W)} × {r1(img.H)} mm{group.join!.bleed > 0 ? `, after trimming ${r1(group.join!.bleed)} mm of bleed` : ' — including any bleed printed around the art'}
      </p>
      <div className="cut-join__seams">
        {img.crops.map((u, i) => (
          <figure key={i} className="cut-join__crop">
            <img src={u} alt={`Seam ${i + 1}, close up`} draggable={false} />
            <figcaption>Seam {i + 1}, close up</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
