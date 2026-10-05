/**
 * Table overlays: context menu host, long-press ring, inspect preview,
 * browse/search dialog and the shortcuts sheet.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, ArrowUpToLine, EyeOff, FlipHorizontal2, Hand, LayoutGrid, Search, Shuffle, X } from 'lucide-react';
import type { CardInstance, Game } from '@/shared/types';
import { assetUrlById } from '@/api/client';
import { Button, Dialog, Kbd, Menu, TextInput, EmptyState } from '@/ui';
import { cardDims, cardName, getComponent } from '../engine';
import { CardBack, CardFront } from './entities';
import { useCtl, useUi } from './store';

type Vars = CSSProperties & Record<`--${string}`, string | number>;

export function ContextMenuHost() {
  const ctl = useCtl();
  const menu = useUi((s) => s.menu);
  if (!menu) return null;
  return <Menu x={menu.x} y={menu.y} items={menu.items} minWidth={228} className="play-menu" onClose={() => ctl.ui.setState({ menu: null })} />;
}

export function LongPressRing() {
  const lp = useUi((s) => s.longPress);
  if (!lp) return null;
  return (
    <div key={lp.seq} className="play-lpring" style={{ left: lp.x, top: lp.y }} aria-hidden>
      <svg viewBox="0 0 64 64" width="64" height="64">
        <circle cx="32" cy="32" r="26" className="play-lpring__track" />
        <circle cx="32" cy="32" r="26" className="play-lpring__bar" />
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inspect                                                              */
/* ------------------------------------------------------------------ */

function BigCard({ game, card, faceUp }: { game: Game; card: CardInstance; faceUp: boolean }) {
  const d = cardDims(game, card);
  return (
    <div className="play-inspect__card" style={{ aspectRatio: `${d.w} / ${d.h}`, '--r': `${(d.r / d.h) * 100}%` } as Vars}>
      <div className={`play-inspect__flip ${faceUp ? '' : 'is-down'}`}>
        <div className="play-inspect__face">
          <CardFront game={game} card={card} />
        </div>
        <div className="play-inspect__face is-back">
          <CardBack game={game} card={card} />
        </div>
      </div>
    </div>
  );
}

export function InspectOverlay() {
  const ctl = useCtl();
  const insp = useUi((s) => s.inspect);
  const game = useUi((s) => s.game);
  const [flipped, setFlipped] = useState(false);
  useEffect(() => setFlipped(false), [insp]);
  if (!insp) return null;
  const close = () => ctl.ui.setState({ inspect: null });
  let body = null;
  let title = '';
  let canFlip = false;
  if (insp.card) {
    const showing = flipped ? !insp.faceUp : insp.faceUp;
    // Never caption a face-down card with its name — in a solo game that is a straight
    // information leak. You get the deck it belongs to, and nothing more.
    title = showing ? cardName(game, insp.card) : `${ctl.deckName(insp.card.deckId)} · face down`;
    canFlip = true;
    body = <BigCard game={game} card={insp.card} faceUp={showing} />;
  } else if (insp.entity) {
    const e = insp.entity;
    if (e.kind === 'board' || e.kind === 'token') {
      const comp = getComponent(game, e.componentId);
      title = comp?.name ?? '';
      let url: string | undefined;
      if (comp?.kind === 'board') url = assetUrlById(game, comp.image);
      if (comp?.kind === 'tokens') {
        const up = flipped ? !insp.faceUp : insp.faceUp;
        url = assetUrlById(game, up ? comp.front : (comp.back ?? comp.front));
        canFlip = !!comp.back;
      }
      body = url ? <img className={`play-inspect__img ${e.kind === 'token' ? 'is-token' : ''}`} src={url} alt={title} draggable={false} /> : <div className="play-inspect__note">{title}</div>;
    } else if (e.kind === 'note') {
      title = 'Note';
      body = (
        <div className="play-inspect__note" style={{ '--nc': e.color } as Vars}>
          {e.text || 'Empty note'}
        </div>
      );
    }
  }
  return (
    <div className={`play-inspect ${insp.sticky ? 'is-sticky' : ''}`} data-ui onPointerDown={insp.sticky ? close : undefined}>
      <div className="play-inspect__stage">{body}</div>
      <div className="play-inspect__bar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="play-inspect__title">{title}</span>
        {insp.sticky ? (
          <>
            {canFlip && (
              <Button size="sm" variant="secondary" icon={FlipHorizontal2} onClick={() => setFlipped((f) => !f)}>
                {!insp.faceUp && !flipped ? 'Peek at the face' : 'Other side'}
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={X} onClick={close}>
              Close
            </Button>
          </>
        ) : (
          <span className="play-inspect__hint">Release to close</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Browse & search                                                      */
/* ------------------------------------------------------------------ */

function ordinal(i: number) {
  if (i === 0) return 'Top';
  const n = i + 1;
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

export function BrowseDialog() {
  const ctl = useCtl();
  const id = useUi((s) => s.browse);
  const st = useUi((s) => (s.browse ? s.state.entities[s.browse] : undefined));
  const game = useUi((s) => s.game);
  const mode = useUi((s) => s.mode);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const stack = st?.kind === 'stack' ? st : null;

  useEffect(() => {
    setQ('');
    setSel(null);
  }, [id]);
  useEffect(() => {
    if (id && !stack) ctl.ui.setState({ browse: null });
  }, [id, stack, ctl]);

  const list = useMemo(() => {
    if (!stack) return [];
    const all = stack.cards
      .slice()
      .reverse()
      .map((c, i) => ({ c, i, name: cardName(game, c) }));
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((x) => x.name.toLowerCase().includes(needle)) : all;
  }, [stack, q, game]);

  if (!id || !stack) return null;
  const close = () => ctl.ui.setState({ browse: null });
  const selCard = sel ? stack.cards.find((c) => c.uid === sel) : undefined;
  const title = stack.name || ctl.deckName(stack.cards[stack.cards.length - 1].deckId);
  const pos = selCard ? stack.cards.length - 1 - stack.cards.indexOf(selCard) : -1;
  const act = (fn: () => void) => {
    fn();
    setSel(null);
  };

  return (
    <Dialog
      open
      onClose={close}
      size="xl"
      className="play-browse"
      title={`${title} · ${stack.cards.length} card${stack.cards.length === 1 ? '' : 's'}`}
      description="Top of the stack first. Pick a card, then choose what to do with it."
      footer={
        <>
          <Button variant="ghost" icon={Shuffle} onClick={() => ctl.shuffle(stack.id)} disabled={stack.cards.length < 2}>
            Shuffle
          </Button>
          <span className="play-browse__spacer" />
          {selCard ? (
            <>
              <Button icon={ArrowUpToLine} disabled={pos === 0} onClick={() => act(() => ctl.moveCardInStack(stack.id, selCard.uid, 'top'))}>
                To top
              </Button>
              <Button icon={ArrowDownToLine} disabled={pos === stack.cards.length - 1} onClick={() => act(() => ctl.moveCardInStack(stack.id, selCard.uid, 'bottom'))}>
                To bottom
              </Button>
              <Button icon={LayoutGrid} onClick={() => act(() => ctl.takeFromStack(stack.id, selCard.uid, 'table'))}>
                On the table
              </Button>
              {mode === 'play' && (
                <Button variant="primary" icon={Hand} onClick={() => act(() => ctl.takeFromStack(stack.id, selCard.uid, 'hand'))}>
                  Take into hand
                </Button>
              )}
            </>
          ) : (
            <span className="play-browse__pick">Pick a card to move it</span>
          )}
        </>
      }
    >
      <div className="play-browse__search">
        <Search size={16} />
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by card name…" aria-label="Search cards" />
      </div>
      {list.length ? (
        <div className="play-browse__grid">
          {list.map(({ c, i, name }) => (
            <button
              key={c.uid}
              type="button"
              className={`play-browse__tile ${sel === c.uid ? 'is-selected' : ''}`}
              onClick={() => setSel(sel === c.uid ? null : c.uid)}
              onDoubleClick={() => act(() => ctl.takeFromStack(stack.id, c.uid, mode === 'play' ? 'hand' : 'table'))}
              aria-pressed={sel === c.uid}
            >
              <div className="play-browse__img" style={{ aspectRatio: `${cardDims(game, c).w} / ${cardDims(game, c).h}` }}>
                <CardFront game={game} card={c} />
                {!c.faceUp && (
                  <span className="play-browse__down" title="Face down on the table">
                    <EyeOff size={12} />
                  </span>
                )}
              </div>
              <span className="play-browse__meta">
                <span className="play-browse__pos">{ordinal(i)}</span>
                <span className="play-browse__name">{name}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState compact icon={Search} title="No cards match" description={`Nothing in this stack is called “${q}”.`} />
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Shortcuts                                                            */
/* ------------------------------------------------------------------ */

const KEYS: [string, string][] = [
  ['Drag a stack', 'Take the top card'],
  ['Shift+drag', 'Move the whole stack (or drag its count badge)'],
  ['Double-click', 'Flip a card · roll a die · edit a note'],
  ['F', 'Flip'],
  ['Q / E', 'Rotate left / right'],
  ['S', 'Shuffle'],
  ['D', 'Draw a card into your hand'],
  ['G', 'Spread out / gather'],
  ['R', 'Roll dice'],
  ['+', 'Add to a counter'],
  ['-', 'Take off a counter'],
  ['L', 'Lock / unlock'],
  ['N', 'Show / hide names on the table'],
  ['Hold Z', 'Inspect up close (or hold Alt)'],
  ['Delete', 'Remove a note'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z', 'Redo (or Ctrl+Y)'],
  ['Ctrl+A', 'Select all pieces'],
  ['Shift+drag table', 'Box-select'],
  ['Space+drag', 'Pan (or drag empty table / middle mouse)'],
  ['Wheel', 'Zoom at the pointer'],
  ['0', 'Show everything (or Home)'],
  ['Esc', 'Clear selection'],
];

const TOUCH: [string, string][] = [
  ['Drag', 'Pick up the top card · pan on empty table'],
  ['Tap', 'Select · raise a card in your hand'],
  ['Double-tap', 'Flip a card · roll a die · play a hand card'],
  ['Long-press', 'Everything else (menu)'],
  ['Pinch', 'Zoom'],
  ['Two fingers', 'Pan'],
];

export function ShortcutsDialog() {
  const ctl = useCtl();
  const open = useUi((s) => s.shortcutsOpen);
  if (!open) return null;
  return (
    <Dialog open size="lg" title="Keyboard & gestures" description="Keys act on the piece under the pointer, otherwise on the selection." onClose={() => ctl.ui.setState({ shortcutsOpen: false })}>
      <div className="play-keys">
        <div className="play-keys__col">
          {KEYS.map(([k, v]) => (
            <div key={k} className="play-keys__row">
              <span className="play-keys__k">{/^[A-Z0-9+/ -]+$|^(Ctrl|Shift|Hold|Space|Esc|Delete)/.test(k) ? <Kbd keys={k.replace('Hold ', '')} /> : k}</span>
              <span className="play-keys__v">{k.startsWith('Hold') ? `Hold · ${v}` : v}</span>
            </div>
          ))}
        </div>
        <div className="play-keys__col">
          <div className="play-keys__head">On a tablet</div>
          {TOUCH.map(([k, v]) => (
            <div key={k} className="play-keys__row">
              <span className="play-keys__k is-text">{k}</span>
              <span className="play-keys__v">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
