import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { MadeFrom } from '@/features/cutter/MadeFrom';
import { warmPieceRenderer } from '@/features/play/pieces/render';
import { useNavigate } from 'react-router';
import { Copy, ExternalLink, Images, Layers, MoreHorizontal, Pencil, Plus, Scissors, Trash2, Upload } from 'lucide-react';
import { Button, IconButton, MenuButton, ProgressBar, Spinner, promptText, toast, type MenuItem } from '@/ui';
import { useGame } from '@/state/gameStore';
import type { Component, ComponentKind, Game, PieceShape } from '@/shared/types';
import { PIECE_SHAPES } from '@/features/play/pieces/model';
import {
  KIND_META,
  makePiece,
  KIND_ORDER,
  commonBaseName,
  componentMetaLines,
  countPlacements,
  describeComponent,
  makeBoard,
  makeCounter,
  makeDeck,
  makeDie,
  makeTokens,
  nameFromFile,
  naturalCompare,
  newCard,
  pickFiles,
  plural,
  sizeForImageAspect,
} from './lib';
import { ComponentPreview } from './previews';
import { AssetPickerHost } from './AssetPicker';
import { undoToast, useComponentActions, useGameId, useUploader } from './common';
import './components.css';

/* ------------------------------------------------------------------ */
/* Creating components                                                  */
/* ------------------------------------------------------------------ */

export function useAddComponent() {
  const update = useGame((s) => s.update);
  const navigate = useNavigate();
  const gameId = useGameId();
  const { upload, progress } = useUploader();

  const open = useCallback((c: Component) => navigate(`/games/${gameId}/edit/components/${c.id}`), [navigate, gameId]);

  const add = useCallback(
    (c: Component, label: string) => {
      update((g) => {
        g.components.push(c);
      }, label);
      open(c);
    },
    [update, open],
  );

  const create = useCallback(
    async (kind: ComponentKind | 'deck-images' | 'board-image', faces?: number | 'custom' | PieceShape) => {
      const game = useGame.getState().game;
      if (!game) return;
      switch (kind) {
        case 'deck':
          return add(makeDeck(game), 'Add deck');
        case 'deck-images': {
          const files = (await pickFiles()).sort((a, b) => naturalCompare(a.name, b.name));
          if (!files.length) return;
          const assets = await upload(files, 'card');
          if (!assets.length) return;
          const g = useGame.getState().game!;
          const first = assets.find((a) => a.width > 0);
          const size = first ? sizeForImageAspect(first.width / first.height) : { width: 63.5, height: 88.9 };
          // Name the deck after what the files have in common, not "New deck 2".
          const name = commonBaseName(assets.map((a) => a.name ?? '')) ?? undefined;
          const deck = makeDeck(g, { ...size, name, cards: assets.map((a) => newCard(a.id, nameFromFile(a.name ?? ''))) });
          add(deck, 'Add deck from images');
          toast.success(`Created “${deck.name}” with ${plural(assets.length, 'card')}`, { action: undoToast() });
          return;
        }
        case 'board':
        case 'board-image': {
          const files = await pickFiles({ multiple: false });
          if (!files.length) return;
          const [asset] = await upload(files, 'image');
          if (!asset) return;
          const g = useGame.getState().game!;
          return add(makeBoard(g, asset, nameFromFile(asset.name ?? '') || 'Board'), 'Add board');
        }
        case 'tokens':
          return add(makeTokens(game), 'Add tokens');
        case 'dice':
          return add(makeDie(game, typeof faces === 'number' || faces === 'custom' ? faces : 6), 'Add die');
        case 'piece':
          return add(makePiece(game, typeof faces === 'string' && faces !== 'custom' ? faces : 'cube'), 'Add game piece');
        case 'counter':
          return add(makeCounter(game), 'Add counter');
      }
    },
    [add, upload],
  );

  const deckItems: MenuItem[] = [
    { label: 'From card images…', icon: Upload, hint: 'Each image becomes a card', onSelect: () => void create('deck-images') },
    { label: 'Empty deck', icon: Layers, hint: 'Add cards later', onSelect: () => void create('deck') },
  ];
  const dieItems: MenuItem[] = [
    ...[4, 6, 8, 10, 12, 20].map((n) => ({ label: `d${n}`, hint: `${n} numbered faces`, onSelect: () => void create('dice', n) })),
    { type: 'separator' },
    { label: 'Custom faces', hint: 'Your own labels or images', onSelect: () => void create('dice', 'custom') },
  ];

  const pieceItems: MenuItem[] = PIECE_SHAPES.map((s) => ({ label: s.label, hint: `Wood · ${s.defaultSize} mm`, onSelect: () => void create('piece', s.id) }));

  const items: MenuItem[] = [
    { label: 'Deck of cards', icon: KIND_META.deck.icon, submenu: deckItems },
    { label: 'Board from an image…', icon: KIND_META.board.icon, onSelect: () => void create('board-image') },
    { label: 'Tokens', icon: KIND_META.tokens.icon, hint: 'Chits, coins, markers', onSelect: () => void create('tokens') },
    { label: 'Game piece', icon: KIND_META.piece.icon, hint: 'Cube, disc, meeple, house, pawn', submenu: pieceItems },
    { label: 'Die', icon: KIND_META.dice.icon, submenu: dieItems },
    { label: 'Counter', icon: KIND_META.counter.icon, hint: 'Health, score, rounds…', onSelect: () => void create('counter') },
    { type: 'separator' },
    { label: 'Cut from a PDF…', icon: Scissors, hint: 'Slice sheets on the Sources page', onSelect: () => navigate(`/games/${gameId}/edit/sources`) },
  ];

  return { items, deckItems, dieItems, pieceItems, create, progress };
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function ComponentsPage() {
  const game = useGame((s) => s.game);
  if (!game)
    return (
      <div className="cmp-loading">
        <Spinner size={22} />
      </div>
    );
  return (
    <>
      <Overview game={game} />
      <AssetPickerHost />
    </>
  );
}

function Overview({ game }: { game: Game }) {
  const navigate = useNavigate();
  const gameId = game.id;
  const { items, deckItems, dieItems, pieceItems, create, progress } = useAddComponent();
  const groups = useMemo(
    () => KIND_ORDER.map((kind) => ({ kind, list: game.components.filter((c) => c.kind === kind) })).filter((g) => g.list.length),
    [game.components],
  );
  const hasPieces = game.components.some((c) => c.kind === 'piece');
  useEffect(() => {
    if (hasPieces) warmPieceRenderer();
  }, [hasPieces]);
  const cardTotal = game.components.reduce((n, c) => n + (c.kind === 'deck' ? c.cards.reduce((m, x) => m + x.count, 0) : 0), 0);

  const addButton = (
    <MenuButton items={items} placement="bottom-end" minWidth={260}>
      <Button variant="primary" icon={Plus}>
        Add component
      </Button>
    </MenuButton>
  );

  return (
    <div className="cmp-page">
      <div className="cmp-scroll">
        <div className="cmp-overview">
          <header className="cmp-ohead">
            <div>
              <h1 className="cmp-ohead__title">Components</h1>
              <p className="cmp-ohead__sub">
                {game.components.length
                  ? `${plural(game.components.length, 'component')}${cardTotal ? ` · ${plural(cardTotal, 'card')} in total` : ''}`
                  : 'The physical pieces of your game.'}
              </p>
            </div>
            <div className="cmp-ohead__actions">
              <Button icon={Scissors} onClick={() => navigate(`/games/${gameId}/edit/sources`)}>
                Cut from a PDF
              </Button>
              {addButton}
            </div>
          </header>

          {progress != null && (
            <div className="cmp-uploadbar" role="status">
              <Spinner size={14} />
              <span>Uploading images…</span>
              <ProgressBar value={progress} />
            </div>
          )}

          {groups.length === 0 ? (
            <OverviewEmpty items={items} onSources={() => navigate(`/games/${gameId}/edit/sources`)} />
          ) : (
            <div className="cmp-groups">
              {groups.map(({ kind, list }) => {
                const meta = KIND_META[kind];
                const Icon = meta.icon;
                return (
                  <section key={kind} className="cmp-group" aria-label={meta.plural}>
                    <div className="cmp-group__head">
                      <h2 className="cmp-group__title">
                        <Icon size={16} />
                        {meta.plural}
                        <span className="cmp-group__count">{list.length}</span>
                      </h2>
                      <AddInGroup kind={kind} deckItems={deckItems} dieItems={dieItems} pieceItems={pieceItems} create={create} />
                    </div>
                    <div className="cmp-tiles">
                      {list.map((c) => (
                        <Tile key={c.id} game={game} comp={c} onOpen={() => navigate(`/games/${gameId}/edit/components/${c.id}`)} />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AddInGroup({
  kind,
  deckItems,
  dieItems,
  pieceItems,
  create,
}: {
  kind: ComponentKind;
  deckItems: MenuItem[];
  dieItems: MenuItem[];
  pieceItems: MenuItem[];
  create: (k: any, f?: number | 'custom') => Promise<void>;
}) {
  const label = { deck: 'New deck', board: 'New board', tokens: 'New tokens', dice: 'New die', counter: 'New counter', piece: 'New piece' }[kind];
  const menu = kind === 'deck' ? deckItems : kind === 'dice' ? dieItems : kind === 'piece' ? pieceItems : null;
  const btn = (
    <Button
      size="sm"
      variant="ghost"
      icon={Plus}
      className="cmp-group__add"
      onClick={menu ? undefined : () => void create(kind === 'board' ? 'board-image' : kind)}
    >
      {label}
    </Button>
  );
  if (menu)
    return (
      <MenuButton items={menu} placement="bottom-end" minWidth={220}>
        {btn}
      </MenuButton>
    );
  return btn;
}

function Tile({ game, comp, onOpen }: { game: Game; comp: Component; onOpen: () => void }) {
  const { remove, duplicate, rename } = useComponentActions();
  const placed = countPlacements(game.setup, comp);
  const meta = componentMetaLines(comp);
  const [pressed, setPressed] = useState(false);
  const items: MenuItem[] = [
    { label: 'Open', icon: ExternalLink, onSelect: onOpen },
    {
      label: 'Rename…',
      icon: Pencil,
      onSelect: async () => {
        const name = await promptText({ title: `Rename ${KIND_META[comp.kind].label.toLowerCase()}`, initial: comp.name, confirmLabel: 'Rename' });
        if (name) rename(comp, name);
      },
    },
    { label: 'Duplicate', icon: Copy, onSelect: () => duplicate(comp) },
    { type: 'separator' },
    {
      label: 'Delete',
      icon: Trash2,
      danger: true,
      hint: placed ? `Also removes it from the table setup` : undefined,
      onSelect: () => remove(comp),
    },
  ];
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    } else if (e.key === 'Delete') remove(comp);
  };
  return (
    <div
      className={`cmp-tile ${pressed ? 'is-pressed' : ''}`}
      role="link"
      tabIndex={0}
      aria-label={`${comp.name}, ${describeComponent(comp)}`}
      onClick={onOpen}
      onKeyDown={onKey}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
    >
      <div className="cmp-tile__stage">
        <ComponentPreview game={game} comp={comp} />
        {placed > 0 && (
          <span className="cmp-tile__flag" title="Placed on the table setup">
            On table
          </span>
        )}
      </div>
      <div className="cmp-tile__foot">
        <div className="cmp-tile__text">
          <div className="cmp-tile__name">{comp.name}</div>
          <div className="cmp-tile__meta">{meta[0]}</div>
          {meta[1] && <div className="cmp-tile__meta">{meta[1]}</div>}
          <MadeFrom game={game} componentId={comp.id} compact />
        </div>
        <span className="cmp-tile__menu" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <MenuButton items={items} placement="bottom-end">
            <IconButton icon={MoreHorizontal} label={`Actions for ${comp.name}`} tooltip={false} />
          </MenuButton>
        </span>
      </div>
    </div>
  );
}

function OverviewEmpty({ items, onSources }: { items: MenuItem[]; onSources: () => void }) {
  return (
    <div className="cmp-empty">
      <EmptyArt />
      <h2 className="cmp-empty__title">Your game’s pieces live here</h2>
      <p className="cmp-empty__desc">
        Components are the physical things you’d cut out of a print-and-play PDF: decks of cards, boards, tokens, dice and counters. Once they’re here, you
        can lay them out on the table and play.
      </p>
      <div className="cmp-paths">
        <div className="cmp-path cmp-path--primary">
          <div className="cmp-path__icon">
            <Scissors size={20} />
          </div>
          <div className="cmp-path__title">Cut them from a PDF</div>
          <p className="cmp-path__desc">Recommended. Upload your print-and-play file and slice sheets of cards, boards and tokens with a few drags.</p>
          <Button variant="primary" icon={Scissors} onClick={onSources}>
            Go to Sources
          </Button>
        </div>
        <div className="cmp-path">
          <div className="cmp-path__icon">
            <Images size={20} />
          </div>
          <div className="cmp-path__title">Add them yourself</div>
          <p className="cmp-path__desc">Already have card images? Upload them as a deck. Dice, counters and tokens can be made from scratch.</p>
          <MenuButton items={items} placement="bottom-start" minWidth={260}>
            <Button icon={Plus}>Add component</Button>
          </MenuButton>
        </div>
      </div>
    </div>
  );
}

function EmptyArt() {
  return (
    <svg className="cmp-empty__art" viewBox="0 0 260 150" aria-hidden>
      <defs>
        <filter id="cmp-art-sh" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="5" stdDeviation="5" floodColor="#000" floodOpacity="0.45" />
        </filter>
      </defs>
      <g filter="url(#cmp-art-sh)">
        <g transform="translate(62 20) rotate(-14 30 90)">
          <rect width="62" height="88" rx="6" fill="#2c3e52" />
          <rect x="6" y="6" width="50" height="76" rx="3" fill="none" stroke="#e6a756" strokeOpacity="0.7" strokeWidth="1.5" />
        </g>
        <g transform="translate(86 14) rotate(-2 30 90)">
          <rect width="62" height="88" rx="6" fill="#f3ede1" />
          <rect x="5" y="5" width="52" height="18" rx="3" fill="#b8412f" />
          <text x="31" y="64" textAnchor="middle" fontSize="30" fill="#b8412f" fontFamily="Georgia, serif">
            ▲
          </text>
        </g>
        <g transform="translate(112 20) rotate(12 30 90)">
          <rect width="62" height="88" rx="6" fill="#f3ede1" />
          <rect x="5" y="5" width="52" height="18" rx="3" fill="#3f6fb0" />
          <text x="31" y="64" textAnchor="middle" fontSize="30" fill="#3f6fb0" fontFamily="Georgia, serif">
            ●
          </text>
        </g>
        <g transform="translate(190 92)">
          <rect width="36" height="36" rx="8" fill="#f1ebdd" />
          <circle cx="10" cy="10" r="3.4" fill="#2a241c" />
          <circle cx="18" cy="18" r="3.4" fill="#2a241c" />
          <circle cx="26" cy="26" r="3.4" fill="#2a241c" />
        </g>
        <g transform="translate(34 106)">
          <circle r="17" fill="#e6b94a" />
          <circle r="12" fill="none" stroke="#8a6414" strokeWidth="2" />
        </g>
      </g>
    </svg>
  );
}
