import { useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FlipHorizontal2,
  FolderInput,
  ImagePlus,
  Images,
  Layers,
  RotateCcw,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { Badge, Button, IconButton, Kbd, MenuButton, NumberField, Segmented, TextInput, type MenuItem } from '@/ui';
import type { CardDef, DeckComponent, Game, ID } from '@/shared/types';
import { deckTotals, fmtMm, matchPreset, plural, urlOf } from '../lib';
import { CardBack, CardFront, cardBox, type Box } from '../previews';
import { PanelSection, commitOnEnter } from '../common';

export interface DeckOps {
  setCount: (ids: ID[], n: number) => void;
  remove: (ids: ID[]) => void;
  duplicate: (ids: ID[]) => void;
  swap: (ids: ID[]) => void;
  rotate: (ids: ID[], deg: 90 | 180 | 270) => void;
  rename: (id: ID, name: string) => void;
  replaceFront: (id: ID, how: 'upload' | 'choose') => void;
  backItems: (ids: ID[]) => MenuItem[];
  rotateItems: (ids: ID[]) => MenuItem[];
  moveItems: (ids: ID[]) => MenuItem[];
}

export function FlipCard({ front, back, backColor, flipped, onFlip, box }: { front?: string; back?: string; backColor: string; flipped: boolean; onFlip: () => void; box: Box }) {
  return (
    <button
      type="button"
      className={`cmp-flip ${flipped ? 'is-flipped' : ''}`}
      style={{ width: box.width, height: box.height }}
      onClick={onFlip}
      aria-label={flipped ? 'Showing the back. Flip to the front' : 'Showing the front. Flip to the back'}
    >
      <span className="cmp-flip__inner">
        <CardFront url={front} {...box} className="cmp-flip__face" />
        <CardBack url={back} color={backColor} {...box} className="cmp-flip__face cmp-flip__face--back" />
      </span>
    </button>
  );
}

/** Long side of the inspector preview, fitting ~250 px of width. */
function previewBox(deck: DeckComponent, maxW = 232, maxH = 300) {
  const long = Math.min(maxH, (maxW * Math.max(deck.width, deck.height)) / deck.width);
  return cardBox(deck, long);
}

export function DeckInspector({
  game,
  deck,
  selIds,
  busy,
  ops,
  onSelectOnly,
  coarse,
}: {
  game: Game;
  deck: DeckComponent;
  selIds: ID[];
  busy: Set<ID>;
  ops: DeckOps;
  onSelectOnly: (id: ID) => void;
  coarse: boolean;
}) {
  const [side, setSide] = useState<'front' | 'back'>('front');
  const cards = selIds.map((id) => deck.cards.find((c) => c.id === id)).filter(Boolean) as CardDef[];
  if (cards.length === 1)
    return <CardPanel game={game} deck={deck} card={cards[0]} side={side} setSide={setSide} busy={busy.has(cards[0].id)} ops={ops} onSelectOnly={onSelectOnly} />;
  if (cards.length > 1) return <MultiPanel game={game} deck={deck} cards={cards} ops={ops} busy={cards.some((c) => busy.has(c.id))} />;
  return <DeckGlance game={game} deck={deck} side={side} setSide={setSide} coarse={coarse} />;
}

function Sides({ side, setSide }: { side: 'front' | 'back'; setSide: (s: 'front' | 'back') => void }) {
  return (
    <Segmented<'front' | 'back'>
      size="sm"
      value={side}
      onChange={setSide}
      className="cmp-insp__sides"
      aria-label="Show side"
      options={[
        { value: 'front', label: 'Front' },
        { value: 'back', label: 'Back' },
      ]}
    />
  );
}

function CardPanel({
  game,
  deck,
  card,
  side,
  setSide,
  busy,
  ops,
  onSelectOnly,
}: {
  game: Game;
  deck: DeckComponent;
  card: CardDef;
  side: 'front' | 'back';
  setSide: (s: 'front' | 'back') => void;
  busy: boolean;
  ops: DeckOps;
  onSelectOnly: (id: ID) => void;
}) {
  const index = deck.cards.indexOf(card);
  const box = previewBox(deck);
  const ids = [card.id];
  return (
    <div className="cmp-insp" onKeyDown={commitOnEnter}>
      <div className="cmp-insp__nav">
        <IconButton icon={ChevronLeft} size="sm" label="Previous card" shortcut="←" disabled={index <= 0} onClick={() => onSelectOnly(deck.cards[index - 1].id)} />
        <span>
          Card <strong>{index + 1}</strong> of {deck.cards.length}
        </span>
        <IconButton
          icon={ChevronRight}
          size="sm"
          label="Next card"
          shortcut="→"
          disabled={index >= deck.cards.length - 1}
          onClick={() => onSelectOnly(deck.cards[index + 1].id)}
        />
      </div>
      <div className="cmp-insp__stage">
        <FlipCard
          box={box}
          front={urlOf(game, card.front)}
          back={urlOf(game, card.back ?? deck.back)}
          backColor={deck.backColor}
          flipped={side === 'back'}
          onFlip={() => setSide(side === 'front' ? 'back' : 'front')}
        />
      </div>
      <Sides side={side} setSide={setSide} />

      <PanelSection title="Name">
        <TextInput value={card.name ?? ''} placeholder={`Card ${index + 1}`} aria-label="Card name" onChange={(e) => ops.rename(card.id, e.target.value)} />
      </PanelSection>
      <PanelSection title="Copies in the deck">
        <NumberField value={card.count} onChange={(n) => ops.setCount(ids, n)} min={1} max={99} className="cmp-num" aria-label="Copies" />
      </PanelSection>
      <PanelSection title="Front image">
        <div className="cmp-btnrow">
          <Button size="sm" icon={ImagePlus} onClick={() => ops.replaceFront(card.id, 'upload')} disabled={busy}>
            {card.front ? 'Replace' : 'Upload'}
          </Button>
          <Button size="sm" variant="ghost" icon={Images} onClick={() => ops.replaceFront(card.id, 'choose')} disabled={busy}>
            Choose
          </Button>
          <span className="cmp-btnrow__spacer" />
          <IconButton icon={RotateCcw} size="sm" label="Rotate 90° left" disabled={busy || !card.front} onClick={() => ops.rotate(ids, 270)} />
          <IconButton icon={RotateCw} size="sm" label="Rotate 90° right" disabled={busy || !card.front} onClick={() => ops.rotate(ids, 90)} />
        </div>
      </PanelSection>
      <PanelSection title="Back" aside={card.back ? <Badge tone="accent">Own back</Badge> : <span className="cmp-psec__value">Uses the deck back</span>}>
        <MenuButton items={ops.backItems(ids)} placement="bottom-start">
          <Button size="sm" icon={Layers}>
            Change back…
          </Button>
        </MenuButton>
      </PanelSection>
      <div className="cmp-insp__actions">
        <Button size="sm" icon={Copy} onClick={() => ops.duplicate(ids)}>
          Duplicate
        </Button>
        <Button size="sm" icon={FlipHorizontal2} onClick={() => ops.swap(ids)}>
          Swap faces
        </Button>
        <MenuButton items={ops.moveItems(ids)} placement="top-start">
          <Button size="sm" icon={FolderInput}>
            Move…
          </Button>
        </MenuButton>
        <Button size="sm" variant="danger" icon={Trash2} onClick={() => ops.remove(ids)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function MultiPanel({ game, deck, cards, ops, busy }: { game: Game; deck: DeckComponent; cards: CardDef[]; ops: DeckOps; busy: boolean }) {
  const ids = cards.map((c) => c.id);
  const copies = cards.reduce((n, c) => n + c.count, 0);
  const counts = new Set(cards.map((c) => c.count));
  const box = cardBox(deck, 150);
  const shown = cards.slice(0, 4);
  return (
    <div className="cmp-insp" onKeyDown={commitOnEnter}>
      <div className="cmp-insp__stack" style={{ height: box.height + 30 }}>
        {shown.map((c, i) => (
          <CardFront
            key={c.id}
            url={urlOf(game, c.front)}
            {...box}
            className="cmp-insp__stackcard"
            style={{ transform: `translateX(${(i - (shown.length - 1) / 2) * 26}px) rotate(${(i - (shown.length - 1) / 2) * 7}deg)`, zIndex: i }}
          />
        ))}
      </div>
      <div className="cmp-insp__title">{plural(cards.length, 'card')} selected</div>
      <div className="cmp-insp__sub">{plural(copies, 'copy', 'copies')} in total</div>
      <PanelSection title="Copies of each" aside={counts.size > 1 ? <span className="cmp-psec__value">currently mixed</span> : undefined}>
        <NumberField value={cards[0].count} onChange={(n) => ops.setCount(ids, n)} min={1} max={99} className="cmp-num" aria-label="Copies of each" />
      </PanelSection>
      <div className="cmp-insp__list">
        <MenuButton items={ops.rotateItems(ids)} placement="bottom-start">
          <Button icon={RotateCw} block disabled={busy}>
            Rotate…
          </Button>
        </MenuButton>
        <MenuButton items={ops.backItems(ids)} placement="bottom-start">
          <Button icon={Layers} block>
            Change back…
          </Button>
        </MenuButton>
        <Button icon={FlipHorizontal2} block onClick={() => ops.swap(ids)}>
          Swap front and back
        </Button>
        <MenuButton items={ops.moveItems(ids)} placement="top-start">
          <Button icon={FolderInput} block>
            Move or copy to deck…
          </Button>
        </MenuButton>
        <Button icon={Copy} block onClick={() => ops.duplicate(ids)}>
          Duplicate
        </Button>
        <Button icon={Trash2} block variant="danger" onClick={() => ops.remove(ids)}>
          Delete {plural(cards.length, 'card')}
        </Button>
      </div>
    </div>
  );
}

function DeckGlance({ game, deck, side, setSide, coarse }: { game: Game; deck: DeckComponent; side: 'front' | 'back'; setSide: (s: 'front' | 'back') => void; coarse: boolean }) {
  const box = previewBox(deck, 200, 250);
  const first = deck.cards[0];
  const { total, unique } = deckTotals(deck);
  const own = deck.cards.filter((c) => c.back).length;
  const preset = matchPreset(deck.width, deck.height);
  return (
    <div className="cmp-insp">
      <div className="cmp-insp__eyebrow">Deck at a glance</div>
      <div className="cmp-insp__stage">
        <FlipCard
          box={box}
          front={urlOf(game, first?.front)}
          back={urlOf(game, first?.back ?? deck.back)}
          backColor={deck.backColor}
          flipped={side === 'back'}
          onFlip={() => setSide(side === 'front' ? 'back' : 'front')}
        />
      </div>
      <Sides side={side} setSide={setSide} />
      <dl className="cmp-facts">
        <div>
          <dt>Cards</dt>
          <dd>{total}</dd>
        </div>
        <div>
          <dt>Unique</dt>
          <dd>{unique}</dd>
        </div>
        <div>
          <dt>Own backs</dt>
          <dd>{own || 'None'}</dd>
        </div>
        <div>
          <dt>Card size</dt>
          <dd>
            {fmtMm(deck.width)} × {fmtMm(deck.height)} mm{preset ? ` · ${preset.preset.label}` : ''}
          </dd>
        </div>
      </dl>
      <div className="cmp-keys">
        <div className="cmp-keys__title">{coarse ? 'Touch tips' : 'Tips'}</div>
        {coarse ? (
          <ul>
            <li>Tap a card to edit it.</li>
            <li>Press and hold a card, then drag, to reorder.</li>
            <li>
              Use <strong>Select</strong> to pick several cards at once.
            </li>
          </ul>
        ) : (
          <ul>
            <li>
              <span>Select a range</span>
              <Kbd keys="Shift" /> + click
            </li>
            <li>
              <span>Add to selection</span>
              <Kbd keys="Ctrl" /> + click
            </li>
            <li>
              <span>Select all</span>
              <Kbd keys="Ctrl+A" />
            </li>
            <li>
              <span>Duplicate</span>
              <Kbd keys="Ctrl+D" />
            </li>
            <li>
              <span>Move selected</span>
              <Kbd keys="Alt+←" />
              <Kbd keys="Alt+→" />
            </li>
            <li>
              <span>Delete</span>
              <Kbd keys="Del" />
            </li>
          </ul>
        )}
        {!coarse && <p className="cmp-keys__note">Drag cards to reorder. Drag on empty space to box-select.</p>}
      </div>
    </div>
  );
}
