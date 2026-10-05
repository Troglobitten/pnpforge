/**
 * The Group panel: what the selected frames make, and everything the make needs — kind, name,
 * colour, size (from the page on flat pages; chosen, typed or measured on photos), trim and corners,
 * tokens' "same" pieces and counts, a straightened preview of the pieces, and what is still missing.
 * Making itself comes with the make bar (stage 6).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Circle, Hexagon, Ruler, Square } from 'lucide-react';
import { Button, NumberField, Segmented, Select, TextInput, toast } from '@/ui';
import type { CutGroup, CutKind, CutterDoc, Game, PageRef, TokenShape } from '@/shared/types';
import { planGroup } from '@/shared/cutter/pieces';
import { commit, goTo, select, useCutter } from './store';
import { applyGroupShape, fitGridsToSize, groupLabel, groupPages, groupTint, KIND_LABEL, KIND_NOUN, pageContent, pageDims, pageLabel, sameRef, setGroupKind } from './ops';
import { commitGroupChange, useGroupBurst } from './announce';
import { PHOTO_CORNER_MM, PHOTO_TRIM_MM } from '@/shared/cutter/pieces';
import { fmtMm, measureGroup, presetOf, presetsFor, sizeInfo } from './sizes';
import { usePreview } from './previews';
import { useBurst } from './PagePanel';
import { BacksSection } from './BacksSection';
import { JoinPanel } from './JoinPanel';
import { pairsSignature } from './ops';
import { setMode } from './store';

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

/** The group the panel shows: the selected frame's, the selected grid's, or this page's last one. */
export function currentGroup(doc: CutterDoc, at: PageRef, sel: { frameId?: string | null; gridId?: string | null }): CutGroup | undefined {
  const byId = (id: string | undefined) => (id ? doc.groups.find((g) => g.id === id) : undefined);
  if (sel.frameId && doc.frames[sel.frameId]) return byId(doc.frames[sel.frameId].groupId);
  if (sel.gridId && doc.grids[sel.gridId] && sameRef(doc.grids[sel.gridId].at, at)) return byId(doc.grids[sel.gridId].groupId);
  const { grids, frames } = pageContent(doc, at);
  return byId(grids[grids.length - 1]?.groupId ?? frames[frames.length - 1]?.groupId);
}

export function GroupPanel({ game, at }: { game: Game; at: PageRef }) {
  const doc = useCutter((s) => s.doc);
  const sel = useCutter((s) => s.sel);
  const group = currentGroup(doc, at, sel);
  if (!group) return null;
  return <GroupBody key={group.id} game={game} doc={doc} group={group} at={at} />;
}

/** The overview at the top of the panel: one line, opens to a row per group. */
export function GroupOverviewTop({ game, at }: { game: Game; at: PageRef }) {
  const doc = useCutter((s) => s.doc);
  const sel = useCutter((s) => s.sel);
  if (!doc.groups.length) return null;
  return <GroupOverview game={game} doc={doc} current={currentGroup(doc, at, sel)?.id ?? ''} />;
}

/** What each group will become, which pages feed it, its size and whether it's ready — one line, opens to rows. */
function GroupOverview({ game, doc, current }: { game: Game; doc: CutterDoc; current: string }) {
  const open = useCutter((s) => s.overview);
  const rows = doc.groups.map((g) => {
    const plan = planGroup(doc, g, game.sources);
    const info = sizeInfo(doc, g, game);
    const total = plan.pieces.reduce((n, p) => n + p.count, 0);
    const becomes =
      g.kind === 'cards'
        ? `a deck of ${plural(total, 'card')}`
        : g.kind === 'tokens'
          ? `${plural(total, 'token')}${plan.pieces.length > 1 ? ` (${plan.pieces.length} kinds)` : ''}`
          : g.kind === 'board'
            ? plan.pieces.length > 1 ? `${plan.pieces.length} boards` : 'a board'
            : g.kind === 'back'
              ? 'a deck’s card back'
              : 'the game’s cover';
    const pages = groupPages(doc, g.id, game).map((p) => pageLabel(game, p));
    const ready = !plan.blockers.length && plan.pieces.length > 0;
    const status = !plan.pieces.length ? 'No pieces yet' : !info.size ? 'Needs a size' : ready ? 'Ready' : plan.blockers[0];
    return { g, becomes, pages, info, ready, status };
  });
  if (!rows.length) return null;
  const waiting = rows.filter((r) => !r.ready).length;
  const go = (id: string) => {
    const f = Object.values(doc.frames).find((x) => x.groupId === id);
    if (!f) return;
    goTo(f.at);
    select(f.gridId ? { gridId: f.gridId } : { frameId: f.id });
  };
  return (
    <section className="cut-sec cut-overview" data-testid="group-overview">
      <button type="button" className="cut-overview__toggle" aria-expanded={open} onClick={() => useCutter.setState({ overview: !open })} data-testid="overview-toggle">
        <span className="cut-overview__dots" aria-hidden>
          {rows.slice(0, 6).map((r) => (
            <span key={r.g.id} className={`cut-swatch cut-t${groupTint(doc, r.g.id)}`} />
          ))}
        </span>
        <span className="cut-overview__line">
          <strong>{plural(rows.length, 'group')}</strong> · {waiting ? `${waiting} not ready yet` : 'all ready'}
        </span>
        <span className="cut-overview__more">{open ? 'Hide' : 'Show all'}</span>
      </button>
      {open && (
        <ul className="cut-overview__list">
          {rows.map((r) => (
            <li key={r.g.id}>
              <button type="button" className={`cut-overview__row cut-t${groupTint(doc, r.g.id)} ${r.g.id === current ? 'is-current' : ''}`} onClick={() => go(r.g.id)} data-testid="overview-row">
                <span className="cut-swatch" aria-hidden />
                <span className="cut-overview__main">
                  <span className="cut-overview__name">{groupLabel(r.g)}</span>
                  <span className="cut-overview__sub">
                    Becomes {r.becomes} · from {r.pages.join(', ') || 'no page yet'}
                  </span>
                  <span className="cut-overview__sub">
                    {r.info.size ? `${fmtMm(r.info.size.w)} × ${fmtMm(r.info.size.h)} mm${r.info.from === 'page' ? ' from the page' : ''}` : 'Size not set'}
                  </span>
                </span>
                <span className={`cut-overview__status ${r.ready ? 'is-ready' : 'is-todo'}`}>{r.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GroupBody({ game, doc, group, at }: { game: Game; doc: CutterDoc; group: CutGroup; at: PageRef }) {
  const burst = useGroupBurst(game, at, group.id);
  const change = (label: string, recipe: Parameters<typeof commitGroupChange>[4]) => commitGroupChange(game, at, group.id, label, recipe);
  const fromPages = groupPages(doc, group.id, game);
  const tint = groupTint(doc, group.id);
  const dims = (r: PageRef) => pageDims(game, r);
  const empties = useCutter((s) => s.empties);
  const plan = planGroup(doc, group, game.sources, { isBlank: (f) => !!empties[f.id] });
  const frames = Object.values(doc.frames).filter((f) => f.groupId === group.id);
  const fronts = frames.filter((f) => f.side === 'front' && !f.excluded);
  const pages = new Set(frames.map((f) => `${f.at.sourceId}:${f.at.page}`)).size;
  const noun = KIND_NOUN[group.kind];
  const info = sizeInfo(doc, group, game);
  const total = plan.pieces.reduce((n, p) => n + p.count, 0);
  const summary =
    group.kind === 'tokens'
      ? `${plural(plan.pieces.length, 'kind')} of token · ${total} in all`
      : group.kind === 'cards'
        ? `${plural(total, 'card')}${plan.pieces.length !== total ? ` (${plan.pieces.length} different)` : ''}`
        : plural(plan.pieces.length || fronts.length, noun[0], noun[1]);

  return (
    <section className={`cut-sec cut-group cut-t${tint}`} data-testid="group-panel">
      <div className="cut-group__head">
        <span className="cut-group__label">Group</span>
        <GroupSwitcher doc={doc} current={group.id} />
      </div>
      <div className="cut-group__name">
        <span className="cut-swatch cut-swatch--lg" aria-hidden />
        <NameField group={group} />
      </div>
      <p className="cut-muted" data-testid="group-summary">
        {summary} · {plural(pages, 'page')}
      </p>
      {fromPages.length > 1 && (
        <p className="cut-muted cut-group__from" data-testid="group-from">
          From {fromPages.map((p) => pageLabel(game, p)).join(', ')} — changes here apply to all of them.
        </p>
      )}

      <div className="cut-field">
        <div className="cut-field__label">These are</div>
        <Segmented<CutKind> size="sm" aria-label="What this group makes" value={group.kind} onChange={(k) => change(`Make it ${KIND_LABEL[k].toLowerCase()}`, (d) => setGroupKind(d as CutterDoc, group.id, k, dims))} options={KINDS} />
      </div>

      <div className="cut-field">
        <div className="cut-field__label">Colour</div>
        <div className="cut-swatches" role="radiogroup" aria-label="Colour">
          {[0, 1, 2, 3, 4, 5].map((c) => (
            <button key={c} type="button" role="radio" aria-checked={tint === c} aria-label={`Colour ${c + 1}`} className={`cut-swatchbtn cut-t${c} ${tint === c ? 'is-on' : ''}`} onClick={() => commit('Change the colour', (d) => void ((d as CutterDoc).groups.find((g) => g.id === group.id)!.color = c))} />
          ))}
        </div>
      </div>

      <SizeSection game={game} doc={doc} group={group} info={info} at={at} />

      {group.kind === 'tokens' && (
        <div className="cut-field">
          <div className="cut-field__label">Shape</div>
          <Segmented<TokenShape>
            size="sm"
            aria-label="Token shape"
            value={group.shape ?? 'round'}
            onChange={(v) =>
              change('Token shape', (d) => {
                (d as CutterDoc).groups.find((g) => g.id === group.id)!.shape = v;
                applyGroupShape(d as CutterDoc, group.id, dims);
              })
            }
            options={[
              { value: 'round', label: 'Round', icon: Circle },
              { value: 'square', label: 'Square', icon: Square },
              { value: 'hex', label: 'Hex', icon: Hexagon },
            ]}
          />
        </div>
      )}

      {/* the finish of each medium: bleed on print pages, trim + corners on photos */}
      <div className="cut-2col">
        {(info.onFlat || !info.onPhotos) && (
          <div className="cut-field">
            <div className="cut-field__label">{info.onPhotos ? 'Bleed · PDF pages' : 'Bleed to trim'}</div>
            <NumberField size="sm" value={group.trimMm} min={0} max={6} step={0.1} precision={1} unit="mm" aria-label="Bleed to trim" onChange={(v) => burst('Bleed', (d) => void ((d as CutterDoc).groups.find((g) => g.id === group.id)!.trimMm = v))} />
          </div>
        )}
        {info.onPhotos && (
          <div className="cut-field">
            <div className="cut-field__label">{info.onFlat ? 'Trim · photos' : 'Trim the edges'}</div>
            <NumberField size="sm" value={group.photo?.trimMm ?? PHOTO_TRIM_MM} min={0} max={6} step={0.1} precision={1} unit="mm" aria-label="Trim the edges" onChange={(v) => burst('Trim', (d) => {
              const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
              g.photo = { trimMm: v, cornerMm: g.photo?.cornerMm ?? PHOTO_CORNER_MM };
            })} />
          </div>
        )}
        {info.onPhotos && group.kind !== 'tokens' && (
          <div className="cut-field">
            <div className="cut-field__label">{info.onFlat ? 'Corners · photos' : 'Round the corners'}</div>
            <NumberField size="sm" value={group.photo?.cornerMm ?? PHOTO_CORNER_MM} min={0} max={8} step={0.5} precision={1} unit="mm" aria-label="Round the corners" onChange={(v) => burst('Corners', (d) => {
              const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
              g.photo = { trimMm: g.photo?.trimMm ?? PHOTO_TRIM_MM, cornerMm: v };
            })} />
          </div>
        )}
      </div>

      {(group.kind === 'cards' || group.kind === 'tokens') && <BacksSection game={game} doc={doc} group={group} />}
      {group.kind === 'board' && <JoinPanel game={game} doc={doc} group={group} />}

      <PiecesStrip game={game} doc={doc} group={group} plan={plan} />
      <Checklist group={group} plan={plan} info={info} />
    </section>
  );
}

function NameField({ group }: { group: CutGroup }) {
  const [name, setName] = useState(group.name);
  useEffect(() => setName(group.name), [group.name]);
  const save = () => {
    const n = name.trim();
    if (n && n !== group.name) commit('Rename the group', (d) => void ((d as CutterDoc).groups.find((g) => g.id === group.id)!.name = n));
    else setName(group.name);
  };
  return <TextInput className="cut-group__input" value={name} aria-label="Group name" onChange={(e) => setName(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid="group-name" />;
}

/** Every group of the cut: jump to one (its first page, its grid selected). */
function GroupSwitcher({ doc, current }: { doc: CutterDoc; current: string }) {
  if (doc.groups.length < 2) return null;
  const go = (id: string) => {
    const f = Object.values(doc.frames).find((x) => x.groupId === id);
    if (!f) return;
    goTo(f.at);
    select(f.gridId ? { gridId: f.gridId } : { frameId: f.id });
  };
  return (
    <label className="cut-group__switch">
      <span className="cut-sr">Show a group</span>
      <Select<string> value={current} onChange={go} options={doc.groups.map((g) => ({ value: g.id, label: groupLabel(g) }))} />
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* size                                                                */
/* ------------------------------------------------------------------ */

function SizeSection({ game, doc, group, info, at }: { game: Game; doc: CutterDoc; group: CutGroup; info: ReturnType<typeof sizeInfo>; at: PageRef }) {
  const presets = presetsFor(group.kind);
  const [w, setW] = useState(info.size?.w ?? 63.5);
  const [h, setH] = useState(info.size?.h ?? 88.9);
  const [editing, setEditing] = useState(false);
  // a board or cover with no size yet: its own proportions (not a card's), about 30 cm on the long side
  const proportion = (() => {
    const f = Object.values(doc.frames).find((x) => x.groupId === group.id);
    if (!f) return 1;
    const q = f.quad;
    const w = (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1])) / 2;
    const h = (Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1])) / 2;
    return w / Math.max(1, h);
  })();
  const guess = group.kind === 'tokens' ? { w: 25, h: 25 } : group.kind === 'cards' || group.kind === 'back' ? { w: 63.5, h: 88.9 } : proportion >= 1 ? { w: 300, h: Math.round(300 / proportion) } : { w: Math.round(300 * proportion), h: 300 };
  useEffect(() => {
    setW(info.size?.w ?? guess.w);
    setH(info.size?.h ?? guess.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.size?.w, info.size?.h, group.kind]);
  const dims = (r: PageRef) => pageDims(game, r);
  const apply = (size: { w: number; h: number; from: 'preset' | 'typed' | 'measured'; preset?: string; note?: string } | null, label: string) =>
    commitGroupChange(game, at, group.id, label, (d) => {
      const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
      g.size = size;
      // flat pages: the grid takes the new piece size
      if (size && info.onFlat) fitGridsToSize(d as CutterDoc, group.id, size.w, size.h, dims);
    });
  const measure = () => {
    const r = measureGroup(doc, group.id, game);
    if ('error' in r) return toast.warning('Can’t measure yet', { description: r.error, duration: 7000 });
    apply({ w: r.w, h: r.h, from: 'measured', note: `Measured against the ${r.ref.toLowerCase()} in the same photo — check it.` }, 'Measure the size');
    toast.success(`Measured: ${fmtMm(r.w)} × ${fmtMm(r.h)} mm`, { description: `Against the ${r.ref.toLowerCase()} in the same photo.` });
  };
  const canMeasure = info.onPhotos && Object.values(doc.frames).some((f) => f.groupId !== group.id && doc.groups.find((g) => g.id === f.groupId)?.size && Object.values(doc.frames).some((m) => m.groupId === group.id && sameRef(m.at, f.at)));
  const tokens = group.kind === 'tokens';
  const presetValue = info.preset?.id ?? 'custom';

  return (
    <div className="cut-size" data-testid="size-section">
      <div className="cut-field__label">
        <span>Size</span>
        {info.size && <span className="cut-field__val">{info.from === 'page' ? 'from the page' : info.from === 'measured' ? 'measured' : info.from === 'preset' ? 'chosen' : 'typed'}</span>}
      </div>
      {info.size ? (
        <div className="cut-size__now" data-testid="size-now">
          <strong>
            {tokens ? `${fmtMm(info.size.w)} mm across` : `${fmtMm(info.size.w)} × ${fmtMm(info.size.h)} mm`}
          </strong>
          {info.preset && <span className="cut-size__preset">{info.preset.label.split(' · ')[0]}</span>}
          <ScaleCard w={info.size.w} h={info.size.h} round={tokens && group.shape === 'round'} />
          <span className="cut-scale__cap">Grey: a bank card, to the same scale</span>
        </div>
      ) : (
        <div className="cut-needs" role="note" data-testid="size-needed">
          <AlertTriangle size={16} aria-hidden />
          <div>
            <strong>Needs a size before it can be made.</strong>
            <span>A photo has no scale. Pick a size, type it, or measure it against a piece of known size lying in the same photo.</span>
          </div>
        </div>
      )}
      {info.note && <p className="cut-muted">{info.note}</p>}
      {info.from === 'page' && info.onPhotos && <p className="cut-muted" data-testid="size-shared">Read from the PDF pages — the photos in this group are cut to it too.</p>}

      {(!info.size || editing || info.onPhotos) && (
        <div className="cut-size__set">
          {presets.length > 0 && (
            <label className="cut-field">
              <span className="cut-field__label">{tokens ? 'Common token sizes' : 'Card sizes'}</span>
              <Select<string>
                value={info.size ? presetValue : ''}
                onChange={(id) => {
                  const p = presets.find((x) => x.id === id);
                  if (p) apply({ w: p.w, h: p.h, from: 'preset', preset: p.id }, `Size: ${p.label}`);
                }}
                options={[...(info.size ? [] : [{ value: '', label: 'Choose a size…' }]), ...presets.map((p) => ({ value: p.id, label: p.label })), ...(info.size && !info.preset ? [{ value: 'custom', label: 'Custom size' }] : [])]}
              />
            </label>
          )}
          <div className="cut-field">
            <span className="cut-field__label">{tokens ? 'Across' : 'Width × height'}</span>
            <div className="cut-size__typed">
              <NumberField size="sm" value={w} min={3} max={1200} step={0.5} precision={1} unit="mm" aria-label={tokens ? 'Across' : 'Width'} onChange={setW} />
              {!tokens && <NumberField size="sm" value={h} min={3} max={1200} step={0.5} precision={1} unit="mm" aria-label="Height" onChange={setH} />}
              <Button size="sm" onClick={() => apply({ w, h: tokens ? w : h, from: 'typed' }, 'Type the size')} data-testid="size-set">
                Use
              </Button>
            </div>
          </div>
          {info.onPhotos && group.kind !== 'cards' && (
            <div className="cut-measure">
              <Button size="sm" icon={Ruler} disabled={!canMeasure} onClick={measure} data-testid="measure">
                Measure it
              </Button>
              <span className="cut-muted">{canMeasure ? 'Against the cards (or any piece with a size) in the same photo.' : 'Frame a piece of known size in the same photo first — a card, say.'}</span>
            </div>
          )}
        </div>
      )}
      {info.size && info.onFlat && !info.onPhotos && (
        <div className="cut-row">
          {info.from === 'page' ? (
            <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)} data-testid="size-change">
              {editing ? 'Keep the size from the page' : 'Change the size'}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => apply(null, 'Size from the page')} data-testid="size-from-page">
              Use the size on the page
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The piece beside a bank card (85.6 × 54 mm), to scale — a quick sense of "is that right?". */
function ScaleCard({ w, h, round }: { w: number; h: number; round: boolean }) {
  const bw = 85.6;
  const bh = 54;
  const H = Math.max(bh, h);
  const k = 64 / H;
  return (
    <svg className="cut-scale" viewBox={`0 0 ${bw + 6 + w} ${H}`} width={Math.min(260, (bw + 6 + w) * k)} height={64} role="img" aria-label={`The piece next to a bank card, to scale`}>
      <rect x={0} y={H - bh} width={bw} height={bh} rx={3} className="cut-scale__card" />
      {round ? <ellipse cx={bw + 6 + w / 2} cy={H - h / 2} rx={w / 2} ry={h / 2} className="cut-scale__piece" /> : <rect x={bw + 6} y={H - h} width={w} height={h} rx={Math.min(3, w / 8)} className="cut-scale__piece" />}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* pieces + checklist                                                  */
/* ------------------------------------------------------------------ */

function PiecesStrip({ game, doc, group, plan }: { game: Game; doc: CutterDoc; group: CutGroup; plan: ReturnType<typeof planGroup> }) {
  const shown = plan.pieces.slice(0, 8);
  if (!shown.length) return null;
  return (
    <div className="cut-field">
      <div className="cut-field__label">
        <span>Pieces</span>
        <button type="button" className="cut-textbtn" onClick={() => setMode('pieces', group.id)} data-testid="open-pieces">
          {plan.pieces.length > shown.length ? `All ${plan.pieces.length} in Pieces` : 'Open Pieces'}
        </button>
      </div>
      <div className="cut-pieces" data-testid="pieces-strip">
        {shown.map((p) => (
          <PieceThumb key={p.frames[0].id} game={game} doc={doc} group={group} frameId={p.frames[0].id} count={p.count} aspect={p.mm.w > 0 && p.mm.h > 0 ? p.mm.w / p.mm.h : 0.7} />
        ))}
      </div>
    </div>
  );
}

function PieceThumb({ game, doc, group, frameId, count, aspect }: { game: Game; doc: CutterDoc; group: CutGroup; frameId: string; count: number; aspect: number }) {
  const f = doc.frames[frameId];
  const url = usePreview(game, doc, f, group, 200);
  const { numbers } = pageContent(doc, f.at);
  return (
    <button type="button" className={`cut-piece ${f.shape === 'round' ? 'is-round' : ''}`} style={{ aspectRatio: `${Math.max(0.4, Math.min(2.5, aspect))}` }} onClick={() => {
        const cur = useCutter.getState().doc.view?.at;
        if (!sameRef(cur, f.at)) toast(`Showing ${pageLabel(game, f.at)}`, { duration: 1600 });
        goTo(f.at);
        select({ frameId: f.id, gridId: f.gridId ?? null, zoom: true });
      }} title="Show this frame" data-testid="piece-thumb">
      {url ? <img src={url} alt="" draggable={false} data-testid="piece-img" /> : <span className="cut-piece__wait" />}
      <span className="cut-piece__n">{numbers.get(f.id)}</span>
      {count > 1 && <span className="cut-piece__count">×{count}</span>}
    </button>
  );
}

function Checklist({ group, plan, info }: { group: CutGroup; plan: ReturnType<typeof planGroup>; info: ReturnType<typeof sizeInfo> }) {
  const items: { ok: boolean; text: string }[] = [
    { ok: plan.pieces.length > 0, text: plan.pieces.length ? 'Frames' : 'No pieces framed yet' },
    { ok: !!info.size, text: info.size ? 'Size' : 'Needs a size' },
  ];
  // the pairs are looked at once before the first make (and again whenever they change)
  const hasBacks = (group.kind === 'cards' || group.kind === 'tokens') && group.backs.mode !== 'none';
  if (hasBacks) {
    const ok = group.backs.checked === pairsSignature(group);
    items.push({ ok, text: ok ? 'Fronts & backs checked' : group.backs.checked ? 'The pairs changed — check them again in Pieces' : 'Check the fronts & backs in Pieces' });
  }
  const other = plan.blockers.filter((b) => !/size/i.test(b) && !/no pieces|left out/i.test(b));
  const ready = items.every((i) => i.ok) && !other.length;
  return (
    <div className={`cut-check ${ready ? 'is-ready' : ''}`} data-testid="checklist">
      <ul>
        {items.map((i) => (
          <li key={i.text} className={i.ok ? 'is-ok' : 'is-todo'}>
            {i.ok ? <Check size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />} {i.text}
          </li>
        ))}
        {other.map((b) => (
          <li key={b} className="is-todo">
            <AlertTriangle size={14} aria-hidden /> {b}
          </li>
        ))}
      </ul>
      <p className="cut-muted">{ready ? 'Ready. Making the pieces comes with the next update of the Cutter.' : 'Once these are done, the group is ready to make.'}</p>
    </div>
  );
}

