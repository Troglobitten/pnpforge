/**
 * Renderers for everything that lives on the table. Each <EntityView> only
 * subscribes to its own slice of the table store, so moving one card never
 * re-renders the other 150.
 *
 * DOM shape (world px = mm * K):
 *   .play-ent            translate(x, y)        — data-eid, hit-testing root
 *     .play-ent__rot     rotate(rot)            — rotations animate here
 *       .play-ent__body  rect around the centre — settle animations run here
 */
import { memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { GripVertical, Lock } from 'lucide-react';
import type { CardInstance, CounterEntity, DieEntity, Entity, Game, ID, NoteEntity, PieceEntity, StackEntity, TokenEntity, ZoneEntity } from '@/shared/types';
import { PieceView } from '../pieces/PieceView';
import { lookOf, pieceFrame } from '../pieces/model';
import { assetUrlById } from '@/api/client';
import { GRID_PAD, K, baseSize, cardDims, cardName, clamp, getCardDef, getComponent, getDeck, isEndless, localBounds, rotateVec, stackSlots, worldAABB, zoneLabelFor, zoneTakes, type Rect } from '../engine';
import { TableCtx, useCtl, useUi, type TableMode } from './store';
import { DEFAULT_FACES, DieView } from '../dice/DieView';

export const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Deterministic 0..1 from a string (for the natural jitter of piled cards). */
function rand01(s: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

type Vars = CSSProperties & Record<`--${string}`, string | number>;

/* ------------------------------------------------------------------ */
/* Cards                                                                */
/* ------------------------------------------------------------------ */

export function cardImages(game: Game, card: CardInstance) {
  const deck = getDeck(game, card.deckId);
  const def = getCardDef(game, card);
  return {
    front: assetUrlById(game, def?.front),
    back: assetUrlById(game, def?.back ?? deck?.back),
    backColor: deck?.backColor || '#2b3440',
    name: def?.name || deck?.name || 'Card',
  };
}

export function CardBack({ game, card }: { game: Game; card: CardInstance }) {
  const im = cardImages(game, card);
  return im.back ? (
    <img src={im.back} alt="" draggable={false} />
  ) : (
    <div className="play-card__pattern" style={{ backgroundColor: im.backColor }} />
  );
}

export function CardFront({ game, card }: { game: Game; card: CardInstance }) {
  const im = cardImages(game, card);
  return im.front ? (
    <img src={im.front} alt={im.name} draggable={false} />
  ) : (
    <div className="play-card__blank">
      <span>{im.name}</span>
    </div>
  );
}

interface CardViewProps {
  game: Game;
  card: CardInstance;
  className?: string;
  style?: Vars;
  /** Extra data attributes for spread slots. */
  slot?: { dx: number; dy: number; r: number };
}

export const CardView = memo(function CardView({ game, card, className, style, slot }: CardViewProps) {
  const d = cardDims(game, card);
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef(card.faceUp);
  useLayoutEffect(() => {
    if (prev.current === card.faceUp) return;
    prev.current = card.faceUp;
    if (reduceMotion()) return;
    ref.current?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.09)', offset: 0.45 }, { transform: 'scale(1)' }],
      { duration: 340, easing: 'cubic-bezier(.3,.7,.3,1)' },
    );
  }, [card.faceUp]);
  return (
    <div
      ref={ref}
      className={`play-card ${className ?? ''}`}
      data-card-uid={card.uid}
      data-slot={slot ? '' : undefined}
      data-dx={slot?.dx}
      data-dy={slot?.dy}
      data-r={slot?.r}
      style={{ width: d.w * K, height: d.h * K, '--r': `${d.r * K}px`, ...style } as Vars}
    >
      <div className={`play-card__flip ${card.faceUp ? '' : 'is-down'}`}>
        <div className="play-card__face play-card__front">
          <CardFront game={game} card={card} />
        </div>
        <div className="play-card__face play-card__back">
          <CardBack game={game} card={card} />
        </div>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* HUD bits (constant on-screen size, whatever the zoom)                */
/* ------------------------------------------------------------------ */

function Badge({ children, part, title, className }: { children: ReactNode; part?: string; title?: string; className?: string }) {
  return (
    <div className={`play-hud play-badge ${part ? 'is-grab' : ''} ${className ?? ''}`} data-part={part} title={title}>
      {children}
    </div>
  );
}

function LockPin() {
  return (
    <div className="play-hud play-lockpin" data-part="lock" title="Locked — tap to unlock" role="button" aria-label="Unlock">
      <Lock size={13} strokeWidth={2.4} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stack                                                                */
/* ------------------------------------------------------------------ */

interface StackFlags {
  lifted?: number;
  liftedUid?: ID | null;
  shuffleSeq?: number;
  ghost?: boolean;
}

function StackBody({ game, st, rect, flags, name }: { game: Game; st: StackEntity; rect: Rect; flags: StackFlags; name: NameShow }) {
  const all = st.cards;
  const d = cardDims(game, all[all.length - 1]);
  const spread = st.layout !== 'pile' && all.length > 1;

  if (spread) {
    const slots = stackSlots(game, st);
    const hideFrom = flags.lifted ? all.length - flags.lifted : all.length;
    return (
      <>
        {all.map((c, i) => {
          const s = slots[i];
          const hidden = i >= hideFrom || c.uid === flags.liftedUid;
          return (
            <CardView
              key={c.uid}
              game={game}
              card={c}
              className={`${i === all.length - 1 ? 'is-top' : ''} ${hidden ? 'is-gone' : ''}`}
              slot={{ dx: s.dx * K, dy: s.dy * K, r: s.rot }}
              style={{
                left: (s.dx - rect.x - d.w / 2) * K,
                top: (s.dy - rect.y - d.h / 2) * K,
                rotate: `${s.rot}deg`,
                zIndex: i,
              }}
            />
          );
        })}
        {all.length > 1 && !flags.ghost && (
          <Badge part="handle" title="Drag to move the whole stack" className="play-stack__badge">
            <GripVertical size={12} strokeWidth={2.4} />
            {all.length}
          </Badge>
        )}
      </>
    );
  }

  const cards = flags.lifted ? all.slice(0, all.length - flags.lifted) : flags.liftedUid ? all.filter((c) => c.uid !== flags.liftedUid) : all;
  const n = cards.length;
  if (!n) return null;
  const top = cards[n - 1];
  const second = n > 1 ? cards[n - 2] : null;
  const thick = n > 1 ? Math.min(n - 1, 60) * 0.13 + 0.5 : 0; // mm
  const jit = (c: CardInstance, k: number) => ({
    translate: `${(rand01(c.uid, 1 + k) - 0.5) * 0.7 * K}px ${(rand01(c.uid, 2 + k) - 0.5) * 0.7 * K}px`,
    rotate: `${(rand01(c.uid, 3 + k) - 0.5) * 1.6}deg`,
  });
  return (
    <>
      {thick > 0 && <div className="play-stack__side" style={{ '--r': `${d.r * K}px`, '--t': `${thick * K}px`, width: d.w * K, height: d.h * K } as Vars} />}
      {second && <CardView key={second.uid} game={game} card={second} className="is-under" style={jit(second, 0)} />}
      <CardView key={top.uid} game={game} card={top} className="is-top" style={jit(top, 0)} />
      {flags.shuffleSeq ? <Riffle key={flags.shuffleSeq} game={game} card={top} w={d.w} h={d.h} r={d.r} /> : null}
      {n > 1 && !flags.ghost && (
        <Badge part="handle" title="Drag to move the whole stack" className="play-stack__badge">
          <GripVertical size={12} strokeWidth={2.4} />
          {n}
        </Badge>
      )}
      {st.name && !flags.ghost && name && (
        <div className={`play-hud play-caption ${name === 'peek' ? 'is-peek' : ''}`} style={{ '--t': `${thick * K}px` } as Vars}>
          {st.name}
        </div>
      )}
    </>
  );
}

/** Riffle shuffle: two half-decks slide apart and interleave back together. */
function Riffle({ game, card, w, h, r }: { game: Game; card: CardInstance; w: number; h: number; r: number }) {
  if (reduceMotion()) return null;
  return (
    <div className="play-riffle" aria-hidden>
      {Array.from({ length: 10 }, (_, i) => (
        <div
          key={i}
          className={`play-riffle__card ${i % 2 ? 'is-l' : 'is-r'}`}
          style={{ width: w * K, height: h * K, '--r': `${r * K}px`, '--i': i, animationDelay: `${i * 28}ms` } as Vars}
        >
          <CardBack game={game} card={card} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Board                                                                */
/* ------------------------------------------------------------------ */

function BoardBody({ game, e }: { game: Game; e: Extract<Entity, { kind: 'board' }> }) {
  const comp = getComponent(game, e.componentId);
  const url = comp?.kind === 'board' ? assetUrlById(game, comp.image) : undefined;
  const r = comp?.kind === 'board' ? comp.cornerRadius : 3;
  return (
    <div className="play-board" style={{ '--r': `${r * K}px` } as Vars}>
      {url ? <img src={url} alt={comp?.name ?? 'Board'} draggable={false} /> : <div className="play-board__blank">{comp?.name ?? 'Board'}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tokens                                                               */
/* ------------------------------------------------------------------ */

function TokenBody({ game, t, taking, ghost, name }: { game: Game; t: TokenEntity; taking: boolean; ghost?: boolean; name: NameShow }) {
  const comp = getComponent(game, t.componentId);
  const tc = comp?.kind === 'tokens' ? comp : null;
  const shape = tc?.shape ?? 'round';
  const img = tc ? assetUrlById(game, t.faceUp ? tc.front : (tc.back ?? tc.front)) : undefined;
  const count = t.infinite ? Infinity : taking ? t.count - 1 : t.count;
  const layers = t.infinite ? 3 : Math.min(Math.max(0, count - 1), 5);
  const faceRef = useRef<HTMLDivElement>(null);
  const prev = useRef(t.faceUp);
  useLayoutEffect(() => {
    if (prev.current === t.faceUp) return;
    prev.current = t.faceUp;
    if (!reduceMotion()) faceRef.current?.animate([{ transform: 'rotateY(90deg) scale(1.12)' }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }, [t.faceUp]);
  const face = (
    <>
      {img ? <img src={img} alt="" draggable={false} /> : <span className="play-token__label">{tc?.label ?? ''}</span>}
    </>
  );
  return (
    <div className={`play-token play-token--${shape} ${img ? 'has-img' : ''} ${!t.faceUp && !img ? 'is-down' : ''}`} style={{ '--tc': tc?.color ?? '#c9a24a' } as Vars}>
      {t.infinite && <div className="play-token__dish" />}
      {Array.from({ length: layers }, (_, i) => (
        <div key={i} className="play-token__edge" style={{ '--i': layers - i } as Vars} />
      ))}
      <div ref={faceRef} className="play-token__face">
        {face}
      </div>
      {!ghost && t.infinite && (
        <Badge className="play-token__badge is-supply" title="A supply never runs out — drag to take one">
          ∞
        </Badge>
      )}
      {!ghost && !t.infinite && count > 1 && (
        <Badge part="handle" className="play-token__badge" title="Drag to move the whole pile">
          ×{count}
        </Badge>
      )}
      {!ghost && t.infinite && name && <div className={`play-hud play-caption is-supply ${name === 'peek' ? 'is-peek' : ''}`}>{tc?.name ? `${tc.name} supply` : 'Supply'}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dice                                                                 */
/* ------------------------------------------------------------------ */

function DieBody({ game, d, ghost, selected }: { game: Game; d: DieEntity; ghost?: boolean; selected?: boolean }) {
  const ctl = useContext(TableCtx);
  const launched = ghost ? undefined : ctl?.launches.get(d.id);
  const launch = launched && launched.seq === (d.rollSeq ?? 0) ? launched : undefined;
  const comp = getComponent(game, d.componentId);
  const dc = comp?.kind === 'dice' ? comp : null;
  // Stable props: moving or rolling one die must not rebuild its SVG tree.
  const look = useMemo(
    () => ({ color: dc?.color ?? '#f1ebdd', inkColor: dc?.inkColor ?? '#2a241c', faces: dc?.faces.length ? dc.faces : DEFAULT_FACES }),
    [dc?.color, dc?.inkColor, dc?.faces],
  );
  const resolve = useCallback((id: ID | null | undefined) => assetUrlById(game, id ?? null), [game]);
  // The solid is lit from one fixed direction for the whole table, so undo the frame rotation
  // here and turn the die about its own vertical axis instead (the two transitions cancel).
  return (
    <div className="play-die" style={{ rotate: `${-d.rot}deg` }}>
      <DieView
        look={look}
        face={d.face}
        size={(dc?.size ?? 16) * K}
        yaw={d.rot}
        rollSeq={ghost ? 0 : (d.rollSeq ?? 0)}
        x={ghost ? undefined : d.x * K}
        y={ghost ? undefined : d.y * K}
        lifted={ghost}
        selected={ghost ? undefined : !!selected}
        launch={launch}
        resolve={resolve}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Game pieces                                                          */
/* ------------------------------------------------------------------ */

function PieceBody({ game, p, ghost, name }: { game: Game; p: PieceEntity; ghost?: boolean; name: NameShow }) {
  const res = useUi((s) => s.pieceRes);
  const comp = getComponent(game, p.componentId);
  const pc = comp?.kind === 'piece' ? comp : undefined;
  const look = lookOf(pc, p);
  const bowl = p.infinite ? pieceFrame(look, true).D * K : 0;
  // lit from the table's one light: undo the frame rotation and render the yaw instead (as dice do)
  return (
    <div className="play-piece" style={{ rotate: `${-p.rot}deg` }}>
      <PieceView look={look} scale={K} ppm={res} yaw={p.rot} lifted={ghost} supply={!!p.infinite} />
      {!ghost && <div className="play-piece__grab" />}
      {/* ∞ sits just outside the bowl's rim, sized from the bowl (with a readable floor and a cap), and is
          not a placed label: it never covers the heap and never moves when the zoom settles */}
      {!ghost && p.infinite && (
        <div className="play-piece__inf" style={{ '--bowl': `${bowl}px` } as Vars} title="A supply never runs out — drag to take one" aria-label="Infinite supply">
          ∞
        </div>
      )}
      {!ghost && p.infinite && name && <div className={`play-hud play-caption is-supply ${name === 'peek' ? 'is-peek' : ''}`}>{pc?.name ? `${pc.name} supply` : 'Supply'}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Counter                                                              */
/* ------------------------------------------------------------------ */

function CounterBody({ c }: { c: CounterEntity }) {
  return (
    <div className="play-counter" style={{ '--c': c.color || '#e6a756' } as Vars}>
      <div className="play-counter__label">{c.label || 'Counter'}</div>
      <div className="play-counter__row">
        <div className={`play-counter__btn ${c.value <= c.min ? 'is-disabled' : ''}`} data-part="dec" role="button" aria-label={`Decrease ${c.label}`}>
          −
        </div>
        <div className="play-counter__value" key={c.value}>
          {c.value}
        </div>
        <div className={`play-counter__btn ${c.value >= c.max ? 'is-disabled' : ''}`} data-part="inc" role="button" aria-label={`Increase ${c.label}`}>
          +
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Zone                                                                 */
/* ------------------------------------------------------------------ */

/** A limited grid's cells: one SVG pattern, strokes held at a steady screen width via --px. */
function GridCells({ z }: { z: ZoneEntity }) {
  const pid = `zg-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const g = z.grid!;
  const W = z.w * K;
  const H = z.h * K;
  const P = GRID_PAD * K;
  const inset = 3;
  return (
    <svg className="play-zone__cells" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <defs>
        <pattern id={pid} x={P} y={P} width={(g.cellW + g.gapX) * K} height={(g.cellH + g.gapY) * K} patternUnits="userSpaceOnUse">
          <rect className="play-zone__cell" x={inset} y={inset} width={Math.max(1, g.cellW * K - inset * 2)} height={Math.max(1, g.cellH * K - inset * 2)} rx={Math.min(12, g.cellW * K * 0.06)} />
        </pattern>
      </defs>
      <rect x={P} y={P} width={Math.max(0, W - 2 * P)} height={Math.max(0, H - 2 * P)} fill={`url(#${pid})`} />
    </svg>
  );
}

function ZoneBody({ z, name, mode }: { z: ZoneEntity; name: NameShow; mode: TableMode }) {
  const endless = !!z.grid?.endless;
  return (
    <div className={`play-zone ${z.grid ? (endless ? 'is-endless' : 'is-grid') : ''}`} style={{ '--zc': z.color || '#e6a756' } as Vars}>
      {z.grid && !endless && <GridCells z={z} />}
      {endless && mode === 'setup' && <span className="play-zone__origin" aria-hidden />}
      {name && (z.label || z.forceFace) && !(endless && mode === 'play') && (
        <div className={`play-zone__label ${name === 'peek' ? 'is-peek' : ''}`}>
          {z.label}
          {z.forceFace && <span className="play-zone__hint">{z.forceFace === 'up' ? 'face up' : 'face down'}</span>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Note                                                                 */
/* ------------------------------------------------------------------ */

function NoteBody({ n, editing, ghost }: { n: NoteEntity; editing: boolean; ghost?: boolean }) {
  const ctl = useCtl();
  const [text, setText] = useState(n.text);
  const latest = useRef(n.text);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editing) setText(n.text);
  }, [n.text, editing]);
  // Shrink the handwriting until the whole note fits — a player's note is never clipped.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const el = textRef.current;
    if (!root || !el) return;
    let size = 21;
    root.style.setProperty('--nfs', `${size}px`);
    while (size > 9 && el.scrollHeight > el.clientHeight + 1) {
      size -= 1;
      root.style.setProperty('--nfs', `${size}px`);
    }
  }, [n.text, n.w, n.h, editing]);
  useEffect(() => {
    if (!editing || ghost) return;
    latest.current = n.text;
    return () => {
      // commit when the editor closes (tap elsewhere, Esc, blur)
      const cur = ctl.state.entities[n.id];
      if (cur?.kind === 'note' && cur.text !== latest.current) ctl.setNoteText(n.id, latest.current);
    };
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={rootRef} className="play-note" style={{ '--nc': n.color } as Vars}>
      {editing && !ghost ? (
        <textarea
          className="play-note__edit"
          autoFocus
          value={text}
          placeholder="Write a note…"
          onChange={(ev) => {
            setText(ev.target.value);
            latest.current = ev.target.value;
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.stopPropagation();
              ctl.ui.setState({ editingNote: null });
            }
          }}
          onBlur={() => {
            if (ctl.ui.getState().editingNote === n.id) ctl.ui.setState({ editingNote: null });
          }}
        />
      ) : (
        <div ref={textRef} className={`play-note__text ${n.text ? '' : 'is-empty'}`}>
          {n.text || 'Double-tap to write'}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Frames                                                               */
/* ------------------------------------------------------------------ */

/** Body rectangle (mm, relative to the entity centre, unrotated). */
export function bodyRect(game: Game, e: Entity): Rect {
  if (e.kind === 'stack') return localBounds(game, e);
  const b = baseSize(game, e);
  return { x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h };
}

interface BodyProps {
  game: Game;
  e: Entity;
  rect: Rect;
  mode: TableMode;
  ghost?: boolean;
  lifted?: number;
  liftedUid?: ID | null;
  taking?: boolean;
  shuffleSeq?: number;
  editing?: boolean;
  /** Selected on the table (dice draw their own ring so it follows a roll). */
  selected?: boolean;
  /** Whether name labels (zone label, stack/supply caption) render. Default 'always'. */
  name?: NameShow;
}

/** `'peek'` = shown on demand while the names setting is off. */
export type NameShow = 'always' | 'peek' | false;

export function EntityContent({ game, e, rect, mode, ghost, lifted, liftedUid, taking, shuffleSeq, editing, selected, name = 'always' }: BodyProps) {
  const pin = !ghost && e.locked && e.kind !== 'zone' ? <LockPin /> : null;
  // A 16 mm die is 20 px across at a portrait fit — far under the 44 px touch floor, and a
  // press that misses it lands on bare table and pans the camera instead. Small pieces get
  // an invisible pad behind them so they are always grabbable.
  const pad =
    !ghost && (e.kind === 'die' || e.kind === 'token' || e.kind === 'counter' || e.kind === 'piece') ? (
      <div className="play-hit" style={{ '--bw': `${rect.w * K}px`, '--bh': `${rect.h * K}px` } as Vars} aria-hidden />
    ) : null;
  let inner: ReactNode = null;
  switch (e.kind) {
    case 'stack':
      inner = <StackBody game={game} st={e} rect={rect} flags={{ lifted, liftedUid, shuffleSeq, ghost }} name={name} />;
      break;
    case 'board':
      inner = <BoardBody game={game} e={e} />;
      break;
    case 'token':
      inner = <TokenBody game={game} t={e} taking={!!taking} ghost={ghost} name={name} />;
      break;
    case 'die':
      inner = <DieBody game={game} d={e} ghost={ghost} selected={selected} />;
      break;
    case 'piece':
      inner = <PieceBody game={game} p={e} ghost={ghost} name={name} />;
      break;
    case 'counter':
      inner = <CounterBody c={e} />;
      break;
    case 'zone':
      inner = <ZoneBody z={e} name={name} mode={mode} />;
      break;
    case 'note':
      inner = <NoteBody n={e} editing={!!editing} ghost={ghost} />;
      break;
  }
  void mode;
  return (
    <>
      {pad}
      {inner}
      {pin}
    </>
  );
}

function bodyStyle(rect: Rect): CSSProperties {
  return { left: rect.x * K, top: rect.y * K, width: rect.w * K, height: rect.h * K };
}

/** A ghost copy of a carried piece (no store subscriptions). */
export function GhostEntity({ game, e, dx, dy, mode }: { game: Game; e: Entity; dx: number; dy: number; mode: TableMode }) {
  const rect = bodyRect(game, e);
  return (
    <div className={`play-ent play-ent--${e.kind}`} style={{ transform: `translate3d(${dx * K}px, ${dy * K}px, 0)` }}>
      <div className="play-ent__rot" style={{ transform: `rotate(${e.rot}deg)` }}>
        <div className="play-ent__body" style={bodyStyle(rect)}>
          <EntityContent game={game} e={e} rect={rect} mode={mode} ghost />
        </div>
      </div>
    </div>
  );
}

/**
 * Where the drop pill sits above a target (mm from its centre, negative = up): above its world
 * bounds, and never lower than half its long side — a portrait card held over a deck turned
 * 90° reaches higher than the deck's own bounds and would cover the pill.
 */
function hintTop(game: Game, e: Entity): number {
  const b = baseSize(game, e);
  return Math.min(worldAABB(game, e).y - e.y, -Math.max(b.w, b.h) / 2);
}

export const EntityView = memo(function EntityView({ id }: { id: ID }) {
  const ctl = useCtl();
  const e = useUi((s) => s.state.entities[id]);
  const game = useUi((s) => s.game);
  const mode = useUi((s) => s.mode);
  const selected = useUi((s) => !!s.selection[id]);
  const hidden = useUi((s) => !!s.hidden[id]);
  const target = useUi((s) => !!s.dropTarget && 'id' in s.dropTarget && s.dropTarget.id === id);
  // a zone drop with a known landing spot shows its hint on the landing marker instead
  const dropHint = useUi((s) => (!!s.dropTarget && 'id' in s.dropTarget && s.dropTarget.id === id && !(s.dropTarget.type === 'zone' && s.dropTarget.land) ? s.dropHint : null));
  // while carrying: zones that take it light up, the others step back
  const armed = useUi((s) => e?.kind === 'zone' && !!s.ghost?.cats && s.ghost.cats.every((c) => zoneTakes(e, c)));
  const refusing = useUi((s) => e?.kind === 'zone' && !!s.ghost && !isEndless(e) && !(s.ghost.cats && s.ghost.cats.every((c) => zoneTakes(e, c))));
  const refused = useUi((s) => s.dropRefuse === id);
  const settle = useUi((s) => s.settle[id]);
  const lifted = useUi((s) => (s.lifted?.id === id ? s.lifted.count : 0));
  const liftedUid = useUi((s) => (s.liftedCard?.id === id ? s.liftedCard.uid : null));
  const taking = useUi((s) => s.tokenLift === id);
  const shuffleSeq = useUi((s) => s.shuffling[id]);
  const editing = useUi((s) => s.editingNote === id);
  const names = useUi((s) => s.names);
  const peek = useUi((s) => s.peek === id);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Names are off: still say what a piece is while you point at it, hold it selected, or
  // aim a drop at it. Shown on demand like this, a label is placed around the labels
  // already on screen and never moves them (see placeLabels' `only`).
  const name: NameShow = names ? 'always' : peek || selected || target ? 'peek' : false;
  useLayoutEffect(() => {
    if (name !== 'peek') return;
    const labels = bodyRef.current?.querySelectorAll<HTMLElement>('.is-peek');
    if (labels?.length) ctl.placePeekLabels([...labels]);
  }, [name, ctl, e]);

  useLayoutEffect(() => {
    if (!settle) return;
    const info = ctl.settleFrom.get(id);
    ctl.settleFrom.delete(id);
    const body = bodyRef.current;
    if (!body || reduceMotion()) return;
    const rot = ctl.state.entities[id]?.rot ?? 0;
    const delay = info?.delay ?? 0;
    if (info?.mode === 'spread') {
      body.querySelectorAll<HTMLElement>('[data-slot]').forEach((el, i) => {
        const dx = Number(el.dataset.dx) || 0;
        const dy = Number(el.dataset.dy) || 0;
        const r = Number(el.dataset.r) || 0;
        el.animate([{ transform: `rotate(${-r}deg) translate(${-dx}px, ${-dy}px)` }, { transform: 'none' }], {
          duration: 320,
          delay: Math.min(i * 14, 260),
          easing: 'cubic-bezier(.2,.8,.2,1)',
          fill: 'backwards',
        });
      });
      return;
    }
    const el = info?.mode === 'top' ? (body.querySelector<HTMLElement>('.play-card.is-top') ?? body) : body;
    const off = info ? rotateVec({ x: info.dx, y: info.dy }, -rot) : null;
    const dist = off ? Math.hypot(off.x, off.y) : 0;
    if (off && dist > 2) {
      el.animate(
        [
          { transform: `translate(${off.x}px, ${off.y}px) scale(1.05)` },
          { transform: 'translate(0px, 0px) scale(0.985)', offset: 0.78 },
          { transform: 'none' },
        ],
        { duration: clamp(200 + dist * 0.12, 200, 360), delay, easing: 'cubic-bezier(.25,.8,.3,1)', fill: 'backwards' },
      );
    } else {
      el.animate([{ transform: 'scale(1.055)' }, { transform: 'scale(0.982)', offset: 0.6 }, { transform: 'none' }], {
        duration: 240,
        delay,
        easing: 'ease-out',
        fill: 'backwards',
      });
    }
  }, [settle, ctl, id]);

  if (!e) return null;
  const rect = bodyRect(game, e);
  const fixed = ctl.isFixed(e);
  const cls = [
    'play-ent',
    `play-ent--${e.kind}`,
    selected && 'is-selected',
    hidden && 'is-hidden',
    target && 'is-target',
    armed && 'is-armed',
    refusing && 'is-refusing',
    refused && 'is-refused',
    e.kind === 'zone' && isEndless(e) && 'is-endless',
    fixed && 'is-fixed',
    editing && 'is-editing',
    e.kind === 'stack' && e.layout !== 'pile' && e.cards.length > 1 && 'is-spread',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={cls} data-eid={id} style={{ transform: `translate3d(${e.x * K}px, ${e.y * K}px, 0)` }}>
      <div className="play-ent__rot" style={{ transform: `rotate(${e.rot}deg)` }}>
        <div className="play-ent__body" ref={bodyRef} style={bodyStyle(rect)}>
          <EntityContent game={game} e={e} rect={rect} mode={mode} lifted={lifted} liftedUid={liftedUid} taking={taking} shuffleSeq={shuffleSeq} editing={editing} selected={selected} name={name} />
        </div>
      </div>
      {/* HUD text: outside the rotated frame so it reads upright at any rotation */}
      {dropHint && (
        <div className="play-hud play-drophint" style={{ '--hint-top': `${hintTop(game, e) * K}px` } as Vars}>
          {dropHint}
        </div>
      )}
    </div>
  );
});

/** "Takes … only": screen UI, positioned by the controller beside the carried piece, inside the view. */
export function RefuseHint() {
  const ctl = useCtl();
  const text = useUi((s) => {
    const z = s.dropRefuse ? s.state.entities[s.dropRefuse] : undefined;
    return z?.kind === 'zone' ? zoneLabelFor(z) : null;
  });
  return (
    <div ref={ctl.setRefuseEl} className="play-refusehint" hidden={!text} role="status">
      {text}
    </div>
  );
}

/**
 * Exactly where a drop into a zone will come to rest — the grid cell, the pool slot, the pile it
 * joins, or the spot beside a full zone — drawn above the pieces while carrying, with its hint.
 */
export function DropLandMarker() {
  const t = useUi((s) => (s.dropTarget?.type === 'zone' ? s.dropTarget : null));
  const hint = useUi((s) => s.dropHint);
  const color = useUi((s) => {
    const z = t ? s.state.entities[t.id] : undefined;
    return z?.kind === 'zone' ? z.color : null;
  });
  const l = t?.land;
  if (!l) return null;
  // a little larger than the item, so the spot still shows around the piece held right over it
  const pad = l.merge ? 1 : l.cell ? 0.5 : Math.max(2.5, Math.min(l.w, l.h) * 0.14);
  return (
    <div className="play-landmark-wrap" style={{ transform: `translate3d(${l.x * K}px, ${l.y * K}px, 0)`, '--zc': color || '#e6a756' } as Vars} aria-hidden>
      <div
        className={`play-landmark ${l.round ? 'is-round' : ''} ${l.cell ? 'is-cell' : ''} ${l.merge ? 'is-merge' : ''} ${l.beside ? 'is-beside' : ''}`}
        style={{ width: (l.w + pad * 2) * K, height: (l.h + pad * 2) * K, transform: `translate(-50%, -50%) rotate(${l.rot}deg)` }}
      />
      {hint && (
        <div className="play-hud play-drophint" style={{ '--hint-top': `${(-Math.max(l.w, l.h) / 2) * K}px` } as Vars}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Card name helper for overlays. */
export { cardName };
