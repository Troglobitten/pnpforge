/**
 * Pieces: one group's pieces, straightened, in the order they will be made — rename, leave out,
 * turn, reorder — and, when the group has backs, each front beside its back ("Fronts & backs").
 * A back is changed by hand (tap it, pick another); the rule that filled the pairs keeps those.
 * "The pairs look right" is remembered until the pairs change (checked before the first make).
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronLeft, Eye, EyeOff, RotateCw } from 'lucide-react';
import { Button, Dialog, Segmented, Select, TextInput, toast } from '@/ui';
import type { BackFlip, CutFrame, CutGroup, CutterDoc, Game, ID } from '@/shared/types';
import { groupFrames, pieceKey } from '@/shared/cutter/doc';
import { commit, goTo, select, setMode, undo, useCutter } from './store';
import { backsReport, groupLabel, groupTint, pageContent, pageLabel, pairByHand, pairsSignature, toggleExcluded, turnFrame } from './ops';
import { usePreview } from './previews';
import { applyRule, currentMap, FLIPS, PAGE_FLIPS, pairToast, pieceNumber } from './BacksSection';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Piece {
  frames: CutFrame[];
  count: number;
  out: boolean;
}

/** The group's fronts as pieces ("the same" frames are one piece with a count), in make order. */
export function piecesOf(doc: CutterDoc, group: CutGroup): Piece[] {
  const fronts = groupFrames(doc, group).filter((f) => f.side === 'front');
  const out: Piece[] = [];
  const byKey = new Map<string, Piece>();
  for (const f of fronts) {
    if (f.excluded) {
      out.push({ frames: [f], count: 0, out: true });
      continue;
    }
    const k = pieceKey(f);
    const p = byKey.get(k);
    if (p) {
      p.frames.push(f);
      p.count += Math.max(1, Math.round(f.copies ?? 1));
    } else {
      const n: Piece = { frames: [f], count: Math.max(1, Math.round(f.copies ?? 1)), out: false };
      byKey.set(k, n);
      out.push(n);
    }
  }
  return out;
}

export function PiecesView({ game, groupId }: { game: Game; groupId: ID | null }) {
  const doc = useCutter((s) => s.doc);
  const group = doc.groups.find((g) => g.id === groupId) ?? doc.groups[0];
  const [picking, setPicking] = useState<ID | null>(null);
  if (!group) {
    return (
      <div className="cut-pv cut-pv--empty" data-testid="pieces-view">
        <p className="cut-muted">Nothing framed yet — frame some pieces on the pages first.</p>
        <Button icon={ChevronLeft} onClick={() => setMode('pages')}>
          Back to the pages
        </Button>
      </div>
    );
  }
  const pieces = piecesOf(doc, group);
  const b = group.backs;
  const hasBacks = (group.kind === 'cards' || group.kind === 'tokens') && b.mode !== 'none';
  const sig = pairsSignature(group);
  const checked = b.checked === sig;
  const live = pieces.filter((p) => !p.out);
  const rep = backsReport(doc, group);
  const backWords = b.mode === 'same' ? (b.sharedFrameId || b.assetId ? ' · one back for all' : ' · no back chosen yet') : ` · ${rep.distinct} of ${live.length} with their own back${rep.shared ? ` · ${rep.shared} share one` : ''}`;
  const flip: BackFlip | null = b.mode === 'each' && b.rule && b.rule.kind !== 'hand' ? b.rule.flip : null;

  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= pieces.length) return;
    commit(by < 0 ? 'Move a piece earlier' : 'Move a piece later', (d) => {
      const list = [...pieces];
      [list[i], list[j]] = [list[j], list[i]];
      const g = (d as CutterDoc).groups.find((x) => x.id === group.id)!;
      g.order = list.flatMap((p) => p.frames.map((f) => f.id));
    });
  };

  return (
    <div className={`cut-pv cut-t${groupTint(doc, group.id)}`} data-testid="pieces-view">
      <div className="cut-pv__bar">
        <label className="cut-pv__group">
          <span className="cut-swatch cut-swatch--lg" aria-hidden />
          <span className="cut-sr">Group</span>
          <Select<string> value={group.id} onChange={(id) => setMode('pieces', id)} options={doc.groups.map((g) => ({ value: g.id, label: groupLabel(g) }))} data-testid="pv-group" />
        </label>
        <span className="cut-muted" data-testid="pv-summary">
          {plural(live.reduce((n, p) => n + p.count, 0), 'piece')}
          {live.length !== live.reduce((n, p) => n + p.count, 0) ? ` (${live.length} different)` : ''}
          {pieces.length > live.length ? ` · ${pieces.length - live.length} left out` : ''}
          {hasBacks ? backWords : ''}
        </span>
        <span className="cut-pv__spacer" />
        {flip && (
          <div className="cut-pv__flip">
            <span className="cut-muted">{b.rule!.kind === 'turned-over' ? 'Turned over on the' : 'The backs are'}</span>
            <Segmented<BackFlip> size="sm" aria-label={b.rule!.kind === 'turned-over' ? 'How the sheet turns over' : 'How the backs are laid out'} value={flip} onChange={(f) => applyRule(game, group, b.rule!.kind as 'turned-over' | 'backs-page', f, b.rule!.kind === 'backs-page' ? currentMap(doc, group) : undefined)} options={b.rule!.kind === 'turned-over' ? FLIPS : PAGE_FLIPS} />
          </div>
        )}
        {hasBacks &&
          (checked ? (
            <span className="cut-pv__ok" data-testid="pairs-checked">
              <Check size={15} aria-hidden /> Pairs checked
            </span>
          ) : (
            <Button variant="primary" size="sm" icon={Check} onClick={() => commit('The pairs look right', (d) => void ((d as CutterDoc).groups.find((g) => g.id === group.id)!.backs.checked = sig))} data-testid="pairs-ok">
              The pairs look right
            </Button>
          ))}
      </div>
      {hasBacks && !checked && (
        <p className="cut-pv__note" data-testid="pv-note">
          {b.checked ? 'The pairs changed since you checked them. ' : ''}Look at each front beside its back before making. Tap a back to change it — nothing is paired by look.
        </p>
      )}

      <ol className={`cut-pv__grid ${hasBacks ? 'has-backs' : ''}`} data-testid="pv-grid">
        {pieces.map((p, i) => (
          <PieceTile key={p.frames[0].id} game={game} doc={doc} group={group} piece={p} index={i} total={pieces.length} hasBacks={hasBacks} onMove={(by) => move(i, by)} onPickBack={() => setPicking(p.frames[0].id)} />
        ))}
      </ol>

      <BackPicker game={game} doc={doc} group={group} frontId={picking} onClose={() => setPicking(null)} />
    </div>
  );
}

function PieceTile({ game, doc, group, piece, index, total, hasBacks, onMove, onPickBack }: { game: Game; doc: CutterDoc; group: CutGroup; piece: Piece; index: number; total: number; hasBacks: boolean; onMove: (by: number) => void; onPickBack: () => void }) {
  const f = piece.frames[0];
  const url = usePreview(game, doc, f, group, 240);
  const b = group.backs;
  const backId = b.mode === 'same' ? (b.sharedFrameId ?? null) : b.mode === 'each' ? (b.pairs[f.id] ?? null) : null;
  const back = backId ? doc.frames[backId] : undefined;
  const backUrl = usePreview(game, doc, back, group, 240);
  const byHand = (b.handPaired ?? []).includes(f.id);
  const [name, setName] = useState(f.name ?? '');
  useEffect(() => setName(f.name ?? ''), [f.name]);
  const { numbers } = pageContent(doc, f.at);
  const where = `${pageLabel(game, f.at)} · #${numbers.get(f.id) ?? '?'}`;
  const show = (fr: CutFrame) => {
    setMode('pages');
    goTo(fr.at);
    select({ frameId: fr.id, gridId: fr.gridId ?? null, zoom: true });
  };
  const saveName = () => {
    const n = name.trim();
    if (n === (f.name ?? '')) return;
    commit(n ? 'Name a piece' : 'Remove a name', (d) => {
      for (const x of piece.frames) (d as CutterDoc).frames[x.id].name = n || undefined;
    });
  };
  return (
    <li className={`cut-pt ${piece.out ? 'is-out' : ''}`} data-testid="pv-tile" data-front={f.id} data-back={backId ?? ''}>
      <div className="cut-pt__pics">
        <button type="button" className={`cut-pt__img ${f.shape === 'round' ? 'is-round' : ''}`} onClick={() => show(f)} title={`Show on ${where}`} data-testid="pv-front">
          {url ? <img src={url} alt={`Front ${index + 1}`} draggable={false} style={{ transform: f.turn ? `rotate(${f.turn * 90}deg)` : undefined }} /> : <span className="cut-piece__wait" />}
          <span className="cut-pt__n">{index + 1}</span>
          {piece.count > 1 && <span className="cut-piece__count">×{piece.count}</span>}
        </button>
        {hasBacks && (
          <button type="button" className={`cut-pt__img is-back ${back ? '' : 'is-none'}`} onClick={() => (b.mode === 'each' ? onPickBack() : back && show(back))} title={b.mode === 'each' ? 'Change the back' : 'The back of every piece'} data-testid="pv-back" disabled={piece.out}>
            {back ? backUrl ? <img src={backUrl} alt={`Back of ${index + 1}`} draggable={false} /> : <span className="cut-piece__wait" /> : <span className="cut-pt__noback">No back</span>}
            {back && b.mode === 'each' && <span className="cut-pt__where">{pageLabel(game, back.at)} #{pageContent(doc, back.at).numbers.get(back.id)}</span>}
            {byHand && <span className="cut-pt__hand" title="Paired by hand">by hand</span>}
          </button>
        )}
      </div>
      <TextInput className="cut-pt__name" value={name} placeholder={`${group.kind === 'tokens' ? 'Token' : 'Card'} ${index + 1}`} aria-label={`Name of piece ${index + 1}`} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} data-testid="pv-name" />
      <div className="cut-pt__meta">{where}</div>
      <div className="cut-pt__acts">
        <button type="button" className="cut-pt__btn" aria-label="Earlier" title="Earlier" disabled={index === 0} onClick={() => onMove(-1)} data-testid="pv-earlier">
          <ArrowLeft size={16} />
        </button>
        <button type="button" className="cut-pt__btn" aria-label="Later" title="Later" disabled={index === total - 1} onClick={() => onMove(1)} data-testid="pv-later">
          <ArrowRight size={16} />
        </button>
        <button type="button" className="cut-pt__btn" aria-label="Turn" title="Turn a quarter" onClick={() => commit('Turn a piece', (d) => piece.frames.forEach((x) => turnFrame(d as CutterDoc, x.id, 1)))} data-testid="pv-turn">
          <RotateCw size={16} />
        </button>
        <button type="button" className="cut-pt__btn" aria-label={piece.out ? 'Put it back in' : 'Leave it out'} title={piece.out ? 'Put it back in' : 'Leave it out'} onClick={() => commit(piece.out ? 'Put a piece back in' : 'Leave a piece out', (d) => piece.frames.forEach((x) => toggleExcluded(d as CutterDoc, x.id)))} data-testid="pv-exclude">
          {piece.out ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
      </div>
    </li>
  );
}

/** Pick the back of one front: any back of the group (or none). A back belongs to one front. */
function BackPicker({ game, doc, group, frontId, onClose }: { game: Game; doc: CutterDoc; group: CutGroup; frontId: ID | null; onClose: () => void }) {
  const backs = Object.values(doc.frames)
    .filter((f) => f.groupId === group.id && f.side === 'back' && !f.excluded)
    .sort((a, b) => a.at.sourceId.localeCompare(b.at.sourceId) || a.at.page - b.at.page || (a.cell ?? 1e9) - (b.cell ?? 1e9));
  const current = frontId ? (group.backs.pairs[frontId] ?? null) : null;
  const owner = new Map<ID, ID>();
  for (const [f, b] of Object.entries(group.backs.pairs)) if (b) owner.set(b, f);
  const order = piecesOf(doc, group).map((p) => p.frames[0].id);
  const pick = (id: ID | null) => {
    if (!frontId) return;
    const before = group.backs.pairs;
    commit('Pair a back by hand', (d) => pairByHand(d as CutterDoc, group.id, frontId, id));
    const after = useCutter.getState().doc;
    const g = after.groups.find((x) => x.id === group.id)!;
    const lost = Object.keys(before).filter((f) => f !== frontId && before[f] && !g.backs.pairs[f]).map((f) => pieceNumber(after, g, f)).filter((n) => n > 0);
    if (lost.length)
      pairToast(toast(`${lost.length === 1 ? `Piece ${lost[0]} has` : `Pieces ${lost.join(', ')} have`} no back now`, { description: 'That back was paired with it — a back goes on one piece.', action: { label: 'Undo', onClick: () => void undo() }, duration: 5000 }));
    onClose();
  };
  return (
    <Dialog open={!!frontId} onClose={onClose} title={`The back of piece ${frontId ? order.indexOf(frontId) + 1 : ''}`} description={backs.length ? 'Tap the back that belongs to it.' : 'This group has no backs framed yet — frame them with “These are backs”, or choose a rule under Backs.'} size="lg">
      <div className="cut-bp" data-testid="back-picker">
        <button type="button" className={`cut-bp__item is-none ${current === null ? 'is-on' : ''}`} onClick={() => pick(null)} data-testid="bp-none">
          <span className="cut-pt__noback">No back</span>
          <span className="cut-bp__cap">The deck’s colour</span>
        </button>
        {backs.map((bf) => (
          <BackChoice key={bf.id} game={game} doc={doc} group={group} frame={bf} on={bf.id === current} owner={owner.get(bf.id)} ownerN={owner.get(bf.id) ? order.indexOf(owner.get(bf.id)!) + 1 : 0} onPick={() => pick(bf.id)} />
        ))}
      </div>
    </Dialog>
  );
}

function BackChoice({ game, doc, group, frame, on, owner, ownerN, onPick }: { game: Game; doc: CutterDoc; group: CutGroup; frame: CutFrame; on: boolean; owner?: ID; ownerN: number; onPick: () => void }) {
  const url = usePreview(game, doc, frame, group, 180);
  return (
    <button type="button" className={`cut-bp__item ${on ? 'is-on' : ''}`} onClick={onPick} data-testid="bp-item" data-frame={frame.id}>
      <span className="cut-bp__img">{url ? <img src={url} alt="" draggable={false} /> : <span className="cut-piece__wait" />}</span>
      <span className="cut-bp__cap">
        <b>
          {pageLabel(game, frame.at)} #{pageContent(doc, frame.at).numbers.get(frame.id)}
        </b>
        <span>{owner ? (on ? 'Its back now' : `On piece ${ownerN}`) : 'Not used'}</span>
      </span>
    </button>
  );
}

