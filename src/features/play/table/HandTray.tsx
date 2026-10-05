/**
 * The player's hand: a gently fanned arc of cards along the bottom edge.
 * Hover raises a card (desktop), tap raises it (touch) and reveals actions.
 * Dragging in / out / within is driven by the TableController.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, Eye, FlipHorizontal2, ArrowUpToLine } from 'lucide-react';
import type { CardInstance, Game, ID } from '@/shared/types';
import { cardDims } from '../engine';
import { CardFront, reduceMotion } from './entities';
import { useCtl, useUi } from './store';

type Vars = CSSProperties & Record<`--${string}`, string | number>;

const KEY = 'pnpforge.play.handCollapsed';
const coarse = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

interface Slot {
  x: number;
  y: number;
  rot: number;
}

/** Steepest tilt any card in the fan can reach (deg) — see `fanLayout`. */
const MAX_TILT = 16;
const FAN_DROP = 1 - Math.cos((MAX_TILT * Math.PI) / 180);
const FAN_SWING = Math.sin((MAX_TILT * Math.PI) / 180);

function fanLayout(m: number, cw: number, avail: number, cardH: number): Slot[] {
  const spacing = m > 1 ? Math.max(18, Math.min(cw * 0.8, (avail - cw) / (m - 1))) : 0;
  const step = m > 1 ? Math.min(4, 32 / (m - 1)) : 0;
  const R = cardH * 2.6;
  const out: Slot[] = [];
  for (let i = 0; i < m; i++) {
    const t = i - (m - 1) / 2;
    const rot = t * step;
    out.push({ x: t * spacing, y: R * (1 - Math.cos((rot * Math.PI) / 180)), rot });
  }
  return out;
}

export function HandTray() {
  const ctl = useCtl();
  const hand = useUi((s) => s.state.hand);
  const game = useUi((s) => s.game);
  const collapsed = useUi((s) => s.handCollapsed);
  const raised = useUi((s) => s.raisedHandCard);
  const dragUid = useUi((s) => s.handDrag);
  const dropIdx = useUi((s) => (s.dropTarget?.type === 'hand' ? s.dropTarget.index : -1));
  const carryingCards = useUi((s) => s.ghost?.payload === 'cards');
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1200,
    h: typeof window !== 'undefined' ? window.innerHeight : 800,
  }));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const tv = el.closest<HTMLElement>('.play-table')?.getBoundingClientRect();
      setBox({ w: r.width, h: tv?.height ?? window.innerHeight });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    const tv = el.closest<HTMLElement>('.play-table');
    if (tv) ro.observe(tv);
    return () => ro.disconnect();
  }, []);

  const width = box.w;
  const narrow = width < 900;
  // The tray is sized FROM the card, never the other way round — a hand you can only see
  // the top 70% of is not a hand. Cards also shrink if the window is too short to show one.
  const want = narrow ? 132 : coarse() ? 146 : 156;
  const cardH = Math.max(84, Math.min(want, Math.round(box.h * 0.26)));
  const padTop = 13;

  const dragFrom = dragUid ? hand.findIndex((c) => c.uid === dragUid) : -1;
  const visible = useMemo(() => hand.filter((c) => c.uid !== dragUid), [hand, dragUid]);
  const maxW = visible.reduce((m, c) => Math.max(m, (cardH * cardDims(game, c).w) / cardDims(game, c).h), cardH * 0.715);
  const avail = Math.max(maxW, Math.min(width - (narrow ? 150 : 300), 1100));
  const gap = dropIdx >= 0 ? (dragFrom >= 0 && dropIdx > dragFrom ? dropIdx - 1 : dropIdx) : -1;
  const slots = fanLayout(visible.length + (gap >= 0 ? 1 : 0), maxW, avail, cardH);
  const baseSlots = fanLayout(visible.length, maxW, avail, cardH);

  // Reserve the height the fan can ever occupy — the arc drop plus the corner a tilted
  // card swings below its pivot — so the tray never has to clip a card as the hand grows.
  const reach = FAN_DROP * cardH * 2.6 + FAN_SWING * (maxW / 2);
  const trayH = Math.round(cardH + padTop + reach + 10);

  // tell the controller how to map a pointer x to an insertion index, and our size
  ctl.handCardH = cardH;
  ctl.handTrayH = trayH;
  const metrics = useRef({ baseSlots, dragFrom, n: visible.length });
  metrics.current = { baseSlots, dragFrom, n: visible.length };
  useLayoutEffect(() => {
    ctl.handIndexAt = (clientX: number) => {
      const r = ref.current?.getBoundingClientRect();
      const { baseSlots: bs, dragFrom: from } = metrics.current;
      if (!r) return bs.length;
      const cx = r.left + r.width / 2;
      let k = 0;
      for (const s of bs) if (cx + s.x < clientX) k++;
      return from >= 0 && k >= from ? k + 1 : k;
    };
    return () => {
      ctl.handIndexAt = null;
    };
  }, [ctl]);
  useLayoutEffect(() => {
    // What the floating chrome has to clear: the cards, not the empty shelf. With no cards
    // in hand the tray is just a gradient, so the zoom buttons and the coach bar may sit on
    // it — pushing them a whole tray-height up leaves them stranded over the board.
    ctl.setHandChromeHeight(collapsed || !hand.length ? 48 : trayH);
  }, [ctl, collapsed, trayH, hand.length]);

  const setCollapsed = (v: boolean) => {
    ctl.ui.setState({ handCollapsed: v, raisedHandCard: null });
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const inviting = carryingCards && !dragUid;
  return (
    <div
      ref={ref}
      className={`play-hand ${collapsed ? 'is-collapsed' : ''} ${inviting ? 'is-inviting' : ''} ${dropIdx >= 0 ? 'is-over' : ''}`}
      style={{ '--card-h': `${cardH}px`, '--tray-h': `${trayH}px`, '--fan-top': `${padTop}px` } as Vars}
      data-hand-drop
    >
      <div className="play-hand__shelf" />
      <button
        type="button"
        data-ui
        className="play-hand__tab"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={collapsed ? 'Show your hand' : 'Hide your hand'}
      >
        <span className="play-hand__tab-label">Hand</span>
        <span className="play-hand__count">{hand.length}</span>
        {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>

      {inviting && <div className="play-hand__invite">{dropIdx >= 0 ? 'Release to add to your hand' : 'Drop here to hold in your hand'}</div>}

      {!visible.length && !inviting && !collapsed && (
        <div className="play-hand__empty">
          {coarse() ? 'Your hand is empty — drag a card down here to hold it' : 'Your hand is empty — drag a card here, or point at a deck and press D'}
        </div>
      )}

      <div className="play-hand__fan">
        {visible.map((c, i) => {
          const s = slots[gap >= 0 && i >= gap ? i + 1 : i];
          return <HandCard key={c.uid} game={game} card={c} slot={s} z={i} raised={raised === c.uid} cardH={cardH} />;
        })}
      </div>
    </div>
  );
}

const HandCard = memo(function HandCard({ game, card, slot, z, raised, cardH }: { game: Game; card: CardInstance; slot: Slot; z: number; raised: boolean; cardH: number }) {
  const ctl = useCtl();
  const d = cardDims(game, card);
  const w = (cardH * d.w) / d.h;
  const arriveRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const info = ctl.handArrivals.get(card.uid);
    if (!info) return;
    ctl.handArrivals.delete(card.uid);
    const el = arriveRef.current;
    if (!el || reduceMotion()) return;
    const r = el.getBoundingClientRect();
    const dx = info.x - (r.left + r.width / 2);
    const dy = info.y - (r.top + r.height / 2);
    // counter-rotate the offset into the card's (fanned) frame
    const t = (-slot.rot * Math.PI) / 180;
    const lx = dx * Math.cos(t) - dy * Math.sin(t);
    const ly = dx * Math.sin(t) + dy * Math.cos(t);
    el.animate(
      [
        { transform: `translate(${lx}px, ${ly}px) rotate(${-slot.rot}deg) scale(${info.scale})` },
        { transform: 'translate(0,0) rotate(0deg) scale(1.04)', offset: 0.8 },
        { transform: 'none' },
      ],
      { duration: 420, delay: info.delay, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'backwards' },
    );
  }, [ctl, card.uid]); // eslint-disable-line react-hooks/exhaustive-deps

  const uid: ID = card.uid;
  return (
    <div
      className={`play-hand__card ${raised ? 'is-raised' : ''}`}
      data-hand-uid={uid}
      style={{ transform: `translate(${slot.x - w / 2}px, ${slot.y}px) rotate(${slot.rot}deg)`, width: w, height: cardH, zIndex: raised ? 500 : z, '--rot': `${slot.rot}deg` } as Vars}
    >
      <div className="play-hand__lift">
        {raised && (
          <div className="play-hand__actions" data-ui>
            <button type="button" className="play-hand__action is-primary" onClick={() => ctl.playHandCard(uid, { faceUp: true })}>
              <ArrowUpToLine size={15} /> Play
            </button>
            <button type="button" className="play-hand__action" onClick={() => ctl.playHandCard(uid, { faceUp: false })} aria-label="Play face down" title="Play face down">
              <FlipHorizontal2 size={15} />
            </button>
            <button type="button" className="play-hand__action" onClick={() => ctl.inspectHandCard(uid)} aria-label="Inspect" title="Inspect">
              <Eye size={15} />
            </button>
          </div>
        )}
        <div ref={arriveRef} className="play-hand__arrive">
          <div className="play-hand__face" style={{ '--r': `${(d.r / d.h) * cardH}px` } as Vars}>
            <CardFront game={game} card={card} />
          </div>
        </div>
      </div>
    </div>
  );
});
