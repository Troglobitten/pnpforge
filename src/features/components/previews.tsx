import { useState, type CSSProperties, type ReactNode } from 'react';
import { ImageOff, Minus, Plus } from 'lucide-react';
import type { BoardComponent, CounterComponent, DeckComponent, DieComponent, Game, TokenComponent, Component, ID } from '@/shared/types';
import { inkFor, urlOf } from './lib';
import { DieView } from '@/features/play/dice/DieView';
import { PieceView } from '@/features/play/pieces/PieceView';
import { lookOf, pieceFrame } from '@/features/play/pieces/model';

type G = Pick<Game, 'id' | 'assets'>;

/* ------------------------------------------------------------------ */
/* Cards                                                                */
/* ------------------------------------------------------------------ */

export interface Box {
  width: number;
  height: number;
  radius: number;
}

/** Pixel box for a card whose longer side is `longPx`. */
export function cardBox(size: { width: number; height: number; cornerRadius: number }, longPx: number): Box & { scale: number } {
  const scale = longPx / Math.max(size.width, size.height, 1);
  return { width: size.width * scale, height: size.height * scale, radius: size.cornerRadius * scale, scale };
}

interface FaceProps extends Partial<Box> {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  lazy?: boolean;
}

/**
 * Card art with a loading skeleton. Without it a grid of not-yet-decoded
 * images paints as blank cream rectangles that read as "cards with no art"
 * rather than "loading" (AGENTS #9).
 */
function FaceImage({ url, lazy }: { url: string; lazy?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const done = () => setLoaded(true);
  return (
    <>
      {!loaded && <span className="cmp-face__skel" aria-hidden />}
      <img
        src={url}
        alt=""
        draggable={false}
        loading={lazy ? 'lazy' : undefined}
        decoding="async"
        className={loaded ? 'is-loaded' : 'is-loading'}
        ref={(el) => {
          if (el?.complete) setLoaded(true);
        }}
        onLoad={done}
        onError={done}
      />
    </>
  );
}

export function CardFront({ url, width, height, radius, className, style, children, lazy }: FaceProps & { url?: string }) {
  return (
    <div className={`cmp-face ${className ?? ''}`} style={{ width, height, borderRadius: radius, ...style }}>
      {url ? (
        <FaceImage key={url} url={url} lazy={lazy} />
      ) : (
        <div className="cmp-face__blank">
          <ImageOff size={Math.max(14, Math.min(26, (width ?? 80) / 5))} strokeWidth={1.6} />
        </div>
      )}
      {children}
    </div>
  );
}

export function CardBack({ url, color, width, height, radius = 0, className, style, children, lazy }: FaceProps & { url?: string; color: string }) {
  return (
    <div className={`cmp-face ${className ?? ''}`} style={{ width, height, borderRadius: radius, ...style }}>
      {url ? (
        <FaceImage key={url} url={url} lazy={lazy} />
      ) : (
        <div className="cmp-face__backfill" style={{ background: color, ['--ink' as string]: inkFor(color) }}>
          <span className="cmp-face__backframe" style={{ borderRadius: Math.max(2, radius * 0.7) }} />
        </div>
      )}
      {children}
    </div>
  );
}

/** A small fanned hand: the deck back underneath, the first cards on top. */
export function DeckFan({ game, deck, longPx = 110 }: { game: G; deck: DeckComponent; longPx?: number }) {
  const box = cardBox(deck, longPx);
  const backUrl = urlOf(game, deck.back);
  if (!deck.cards.length) {
    return (
      <div className="cmp-fan" style={{ width: box.width * 1.6, height: box.height * 1.12 }}>
        <CardBack
          url={backUrl}
          color={deck.backColor}
          {...box}
          className="cmp-fan__card"
          style={{ ['--x' as string]: '-14%', ['--rot' as string]: '-6deg' }}
        />
        <div className="cmp-fan__card cmp-fan__ghost" style={{ ...box, borderRadius: box.radius, ['--x' as string]: '16%', ['--rot' as string]: '6deg' }}>
          <Plus size={20} />
        </div>
      </div>
    );
  }
  const fronts = deck.cards.slice(0, 2).map((c) => urlOf(game, c.front));
  const layers: { kind: 'back' | 'front'; url?: string; x: string; rot: string }[] =
    fronts.length > 1
      ? [
          { kind: 'back', url: backUrl, x: '-34%', rot: '-13deg' },
          { kind: 'front', url: fronts[1], x: '-2%', rot: '-2deg' },
          { kind: 'front', url: fronts[0], x: '30%', rot: '10deg' },
        ]
      : [
          { kind: 'back', url: backUrl, x: '-20%', rot: '-8deg' },
          { kind: 'front', url: fronts[0], x: '20%', rot: '8deg' },
        ];
  const thick = Math.min(4, Math.floor(deck.cards.reduce((n, c) => n + c.count, 0) / 12));
  return (
    <div className="cmp-fan" style={{ width: box.width * 1.9, height: box.height * 1.14 }}>
      {layers.map((l, i) =>
        l.kind === 'back' ? (
          <CardBack
            key={i}
            url={l.url}
            color={deck.backColor}
            {...box}
            className={`cmp-fan__card cmp-fan__card--${i}`}
            style={{ ['--x' as string]: l.x, ['--rot' as string]: l.rot, ['--thick' as string]: thick }}
          />
        ) : (
          <CardFront key={i} url={l.url} {...box} className={`cmp-fan__card cmp-fan__card--${i}`} style={{ ['--x' as string]: l.x, ['--rot' as string]: l.rot }} />
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Boards                                                               */
/* ------------------------------------------------------------------ */

export function BoardFace({ game, board, width, height, className }: { game: G; board: BoardComponent; width: number; height: number; className?: string }) {
  const url = urlOf(game, board.image);
  const radius = board.cornerRadius * (width / Math.max(1, board.width));
  return (
    <div className={`cmp-face cmp-board ${className ?? ''}`} style={{ width, height, borderRadius: radius }}>
      {url ? (
        <FaceImage key={url} url={url} />
      ) : (
        <div className="cmp-face__blank">
          <ImageOff size={24} strokeWidth={1.6} />
        </div>
      )}
    </div>
  );
}

export function fitBox(w: number, h: number, maxW: number, maxH: number) {
  const s = Math.min(maxW / Math.max(1, w), maxH / Math.max(1, h));
  return { width: w * s, height: h * s, scale: s };
}

/* ------------------------------------------------------------------ */
/* Tokens                                                               */
/* ------------------------------------------------------------------ */

export function tokenPx(token: TokenComponent, scale: number) {
  const width = token.width * scale;
  const height = (token.shape === 'rect' ? token.height : token.width) * scale;
  return { width, height };
}

export function TokenFace({
  game,
  token,
  side,
  scale,
  className,
  style,
}: {
  game: G;
  token: TokenComponent;
  side: 'front' | 'back';
  scale: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { width, height } = tokenPx(token, scale);
  const img = side === 'front' ? token.front : token.back;
  const url = urlOf(game, img);
  const fill = side === 'back' && !img ? `color-mix(in srgb, ${token.color} 78%, #000)` : token.color;
  const m = Math.min(width, height);
  const radius = token.shape === 'round' ? '50%' : token.shape === 'hex' ? 0 : token.shape === 'square' ? m * 0.14 : m * 0.1;
  const label = token.label?.trim();
  return (
    <div className={`cmp-token cmp-token--${token.shape} ${className ?? ''}`} style={{ width, height, ...style }}>
      <div className="cmp-token__face" style={{ background: fill, color: inkFor(token.color), borderRadius: radius }}>
        {url ? (
          <img src={url} alt="" draggable={false} decoding="async" />
        ) : label ? (
          <span style={{ fontSize: Math.max(8, (m * (label.length > 3 ? 0.26 : label.length > 1 ? 0.36 : 0.48))) }}>{label}</span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dice                                                                 */
/* ------------------------------------------------------------------ */

const PIPS: Record<number, number[]> = {
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function Pips({ n }: { n: number }) {
  const on = new Set(PIPS[n] ?? []);
  return (
    <div className="cmp-pips">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={on.has(i) ? 'is-on' : ''} />
      ))}
    </div>
  );
}

export function faceText(die: DieComponent, index: number) {
  const f = die.faces[index];
  if (!f) return '';
  return f.label?.trim() || String(f.value ?? index + 1);
}

/** A flat face as it appears on the table. */
export function DieFaceView({ game, die, index, size, className }: { game: G; die: DieComponent; index: number; size: number; className?: string }) {
  const f = die.faces[index] ?? {};
  const url = urlOf(game, f.image);
  const pips = die.faces.length === 6 && !f.label?.trim() && !url && f.value != null && f.value >= 1 && f.value <= 6;
  const text = faceText(die, index);
  return (
    <div
      className={`cmp-dieface ${className ?? ''}`}
      style={{ width: size, height: size, background: die.color, color: die.inkColor, borderRadius: size * 0.2, fontSize: size * (text.length > 2 ? 0.3 : 0.46) }}
    >
      {url ? <img src={url} alt="" draggable={false} /> : pips ? <Pips n={f.value!} /> : <span>{text}</span>}
    </div>
  );
}

/**
 * The die as it looks on the table — the same polyhedral renderer the play table uses, so the
 * editor and the table always match. Changing `spins` rolls it; changing `face` tips it over.
 */
export function Die3D({ game, die, size, face = 0, spins = 0 }: { game: G; die: DieComponent; size: number; face?: number; spins?: number }) {
  return (
    <div className="cmp-die3d" style={{ width: size, height: size }}>
      <DieView look={die} face={face} size={size * 0.62} rollSeq={spins} resolve={(id) => urlOf(game, id)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Counters                                                             */
/* ------------------------------------------------------------------ */

export function CounterWidget({
  counter,
  value,
  onChange,
  size = 'md',
}: {
  counter: Pick<CounterComponent, 'label' | 'min' | 'max' | 'step' | 'color'>;
  value: number;
  onChange?: (v: number) => void;
  size?: 'sm' | 'md' | 'lg';
}) {
  const vars = { ['--c' as string]: counter.color, ['--cink' as string]: inkFor(counter.color) };
  const step = (d: number) => onChange?.(Math.min(counter.max, Math.max(counter.min, value + d * counter.step)));
  const Btn = onChange ? 'button' : 'span';
  return (
    <div className={`cmp-counter cmp-counter--${size}`} style={vars}>
      <div className="cmp-counter__label">{counter.label || 'Counter'}</div>
      <div className="cmp-counter__row">
        <Btn className="cmp-counter__btn" {...(onChange ? { type: 'button' as const, 'aria-label': 'Decrease', disabled: value <= counter.min, onClick: () => step(-1) } : {})}>
          <Minus size={size === 'lg' ? 20 : 14} strokeWidth={2.5} />
        </Btn>
        <div className="cmp-counter__value">{value}</div>
        <Btn className="cmp-counter__btn" {...(onChange ? { type: 'button' as const, 'aria-label': 'Increase', disabled: value >= counter.max, onClick: () => step(1) } : {})}>
          <Plus size={size === 'lg' ? 20 : 14} strokeWidth={2.5} />
        </Btn>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview tile preview                                                */
/* ------------------------------------------------------------------ */

export function ComponentPreview({ game, comp }: { game: G; comp: Component }) {
  switch (comp.kind) {
    case 'deck':
      return <DeckFan game={game} deck={comp} longPx={104} />;
    case 'board': {
      const b = fitBox(comp.width, comp.height, 200, 118);
      return <BoardFace game={game} board={comp} width={b.width} height={b.height} className="cmp-lifted" />;
    }
    case 'tokens': {
      const long = Math.max(comp.width, comp.shape === 'rect' ? comp.height : comp.width);
      const scale = 64 / long;
      return (
        <div className="cmp-tokpair">
          <TokenFace game={game} token={comp} side="back" scale={scale} className="cmp-tokpair__back" />
          <TokenFace game={game} token={comp} side="front" scale={scale} className="cmp-tokpair__front" />
        </div>
      );
    }
    case 'dice':
      return <Die3D game={game} die={comp} size={100} />;
    case 'counter':
      return <CounterWidget counter={comp} value={comp.initial} size="sm" />;
    case 'piece': {
      const look = lookOf(comp);
      return <PieceView look={look} scale={Math.min(8, 96 / pieceFrame(look, false).D)} />;
    }
  }
}

export type { ID };
