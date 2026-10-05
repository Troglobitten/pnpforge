/**
 * Context-menu builders for the table (right-click / long-press).
 * Each returns plain `MenuItem[]` for the UI-kit <Menu>.
 */
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CirclePlus,
  Dices,
  Eye,
  FlipHorizontal2,
  GalleryHorizontal,
  Hand,
  Layers,
  LayoutGrid,
  Lock,
  LockOpen,
  Maximize,
  Minus,
  Palette,
  Pencil,
  Plus,
  RefreshCcw,
  RotateCcw,
  RotateCw,
  Search,
  Shuffle,
  Split,
  SquareStack,
  StickyNote,
  Trash2,
  Undo2,
  Rows3,
  MousePointer2,
} from 'lucide-react';
import type { DieFace, Entity, ID, StackEntity, StackLayout } from '@/shared/types';
import { promptText, toast, type MenuItem } from '@/ui';
import { cardName, describeZone, getComponent, ops, zoneTakes, type Vec } from '../engine';
import { TABLE_THEMES } from './theme';
import type { TableController } from './controller';

const SEP: MenuItem = { type: 'separator' };

/**
 * Every face of a die. Up to 12 faces fit one list; bigger dice (d20, d30, d100) get a short
 * list of ranges ("1 – 10", "11 – 20" …), each opening its faces, so no menu runs off screen.
 */
function faceMenu(faces: DieFace[], current: number, set: (i: number) => void): MenuItem[] {
  const item = (i: number): MenuItem => {
    const f = faces[i];
    const text = f.label?.trim() || String(f.value ?? i + 1);
    return { label: f.image && !f.label?.trim() ? `Face ${i + 1}` : text, checked: current === i, onSelect: () => set(i) };
  };
  if (faces.length <= 12) return faces.map((_, i) => item(i));
  const per = faces.length > 120 ? 20 : 10;
  const groups: MenuItem[] = [];
  for (let from = 0; from < faces.length; from += per) {
    const to = Math.min(faces.length, from + per);
    const name = (i: number) => (item(i) as { label: string }).label;
    groups.push({
      label: `${name(from)} – ${name(to - 1)}`,
      checked: current >= from && current < to,
      submenu: Array.from({ length: to - from }, (_, k) => item(from + k)),
    });
  }
  return groups;
}

/** Top rows of a menu opened by holding a finger on the table: dragging on from here box-selects. */
export function boxSelectHint(): MenuItem[] {
  return [{ label: 'Keep holding and drag', icon: MousePointer2, hint: 'Draws a box to select several pieces', disabled: true }, SEP];
}

/** "Select all N dice" — the quick way (on touch, the only quick way) to gather dice for one throw. */
function selectDiceItem(ctl: TableController): MenuItem[] {
  const s = ctl.state;
  const sel = ctl.ui.getState().selection;
  const all = s.order.filter((id) => s.entities[id]?.kind === 'die' && !ctl.isFixed(s.entities[id]));
  if (all.length < 2 || all.every((id) => sel[id])) return [];
  return [{ label: `Select all ${all.length} dice`, icon: MousePointer2, hint: 'Then fling one to throw them all', onSelect: () => ctl.select(all) }];
}

/** The selection if `id` is part of it, else just `id`. */
function scope(ctl: TableController, id: ID): ID[] {
  const sel = ctl.ui.getState().selection;
  return sel[id] ? Object.keys(sel).filter((k) => ctl.state.entities[k]) : [id];
}

async function askNumber(title: string, max: number, initial = 2): Promise<number | null> {
  const v = await promptText({ title, label: `How many? (1–${max})`, initial: String(Math.min(initial, max)), confirmLabel: 'OK' });
  if (v == null) return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, max);
}

function countSubmenu(max: number, run: (n: number) => void, title: string): MenuItem[] {
  const opts = [2, 3, 4, 5, 6].filter((n) => n <= max);
  return [
    ...opts.map<MenuItem>((n) => ({ label: `${n} cards`, onSelect: () => run(n) })),
    ...(max > 6 || opts.length === 0 ? [SEP, { label: 'Other amount…', onSelect: () => void askNumber(title, max).then((n) => n && run(n)) } as MenuItem] : []),
  ];
}

function lockItem(ctl: TableController, e: Entity): MenuItem {
  const fixed = ctl.isFixed(e);
  return {
    label: fixed ? 'Unlock' : 'Lock in place',
    icon: fixed ? LockOpen : Lock,
    shortcut: 'L',
    hint: fixed ? 'Let it be moved again' : 'Dragging it will pan the table instead',
    onSelect: () => ctl.toggleLock(scope(ctl, e.id), true),
  };
}

/** One row instead of two — the piece menu is long enough to clip a short window. */
function rotateItems(ctl: TableController, id: ID): MenuItem[] {
  return [
    {
      label: 'Rotate',
      icon: RotateCw,
      submenu: [
        { label: 'Left a quarter turn', icon: RotateCcw, shortcut: 'Q', onSelect: () => ctl.rotate(scope(ctl, id), -90) },
        { label: 'Right a quarter turn', icon: RotateCw, shortcut: 'E', onSelect: () => ctl.rotate(scope(ctl, id), 90) },
        { label: 'Upright', icon: RefreshCcw, onSelect: () => ctl.setRotation(scope(ctl, id), 0) },
      ],
    },
  ];
}

const LAYOUTS: { id: StackLayout; label: string; icon: typeof Layers }[] = [
  { id: 'pile', label: 'Pile (gather)', icon: SquareStack },
  { id: 'row', label: 'Row (spread out)', icon: Rows3 },
  { id: 'fan', label: 'Fan', icon: GalleryHorizontal },
  { id: 'grid', label: 'Grid', icon: LayoutGrid },
];

function stackMenu(ctl: TableController, st: StackEntity, cardUid?: ID): MenuItem[] {
  const n = st.cards.length;
  const play = ctl.mode === 'play';
  const top = st.cards[n - 1];
  const title = st.name || (n === 1 ? cardName(ctl.game, top) : ctl.deckName(top.deckId));
  const items: MenuItem[] = [{ type: 'label', label: n > 1 ? `${title} · ${n} cards` : title }];

  // a specific (non-top) card of a spread was pressed
  const picked = cardUid && cardUid !== top.uid ? st.cards.find((c) => c.uid === cardUid) : undefined;
  if (picked) {
    items.push(
      { label: `Take “${cardName(ctl.game, picked)}” to hand`, icon: Hand, disabled: !play, onSelect: () => ctl.takeFromStack(st.id, picked.uid, 'hand') },
      { label: 'Inspect this card', icon: Eye, onSelect: () => ctl.inspectEntity(st.id, true, picked.uid) },
      SEP,
    );
  }

  items.push({ label: n > 1 ? 'Flip top card' : 'Flip', icon: FlipHorizontal2, shortcut: 'F', onSelect: () => ctl.flip(scope(ctl, st.id)) });
  if (play) {
    items.push({ label: n > 1 ? 'Draw to hand' : 'Take into hand', icon: Hand, shortcut: 'D', onSelect: () => ctl.drawToHand(st.id, 1) });
    if (n > 1) items.push({ label: 'Draw several', icon: Hand, submenu: countSubmenu(n, (k) => ctl.drawToHand(st.id, k), 'Draw cards') });
  }
  if (n > 1) {
    items.push({ label: 'Deal in a row', icon: GalleryHorizontal, hint: 'Face up, next to the stack', submenu: countSubmenu(n, (k) => ctl.dealRow(st.id, k, true), 'Deal cards') });
    items.push(
      SEP,
      { label: 'Shuffle', icon: Shuffle, shortcut: 'S', onSelect: () => ctl.shuffle(st.id) },
      { label: 'Browse & search…', icon: Search, hint: 'Look through the stack, take any card', onSelect: () => ctl.browse(st.id) },
      {
        label: st.layout === 'pile' ? 'Spread out' : 'Gather into a pile',
        icon: st.layout === 'pile' ? Rows3 : SquareStack,
        shortcut: 'G',
        onSelect: () => ctl.toggleSpread(st.id),
      },
      {
        label: 'Arrange as',
        icon: LayoutGrid,
        submenu: [
          ...LAYOUTS.map<MenuItem>((l) => ({ label: l.label, icon: l.icon, checked: st.layout === l.id, onSelect: () => ctl.setLayout(st.id, l.id) })),
          SEP,
          { label: 'Split in half', icon: Split, onSelect: () => ctl.split(st.id) },
        ],
      },
      { label: 'Turn whole stack over', icon: RefreshCcw, onSelect: () => ctl.flipWholeStack(st.id) },
    );
  } else {
    items.push({ label: 'Browse & search…', icon: Search, onSelect: () => ctl.browse(st.id) });
  }
  items.push(SEP, ...rotateItems(ctl, st.id), { label: 'Inspect', icon: Eye, shortcut: 'Z', hint: 'Or hold Z / Alt while hovering', onSelect: () => ctl.inspectEntity(st.id, true) }, lockItem(ctl, st));
  return items;
}

export function entityMenu(ctl: TableController, id: ID, cardUid?: ID): MenuItem[] {
  const e = ctl.state.entities[id];
  if (!e) return [];
  const game = ctl.game;
  let items: MenuItem[] = [];
  switch (e.kind) {
    case 'stack':
      items = stackMenu(ctl, e, cardUid);
      break;

    case 'token': {
      const comp = getComponent(game, e.componentId);
      const name = comp?.name ?? 'Token';
      const hasSupply = !e.infinite && Object.values(ctl.state.entities).some((o) => o.kind === 'token' && o.infinite && o.componentId === e.componentId);
      items = [{ type: 'label', label: e.infinite ? `${name} · supply` : e.count > 1 ? `${name} × ${e.count}` : name }];
      if (e.infinite || e.count > 1) items.push({ label: 'Take one', icon: CirclePlus, hint: e.infinite ? 'A supply never runs out' : undefined, onSelect: () => ctl.takeTokenBeside(e.id) });
      if (!e.infinite) items.push({ label: 'Flip', icon: FlipHorizontal2, shortcut: 'F', onSelect: () => ctl.flip(scope(ctl, e.id)) });
      if (!e.infinite && e.count > 1) items.push({ label: 'Split pile in half', icon: Split, onSelect: () => ctl.splitTokens(e.id) });
      if (!e.infinite) items.push({ label: hasSupply ? 'Return one to supply' : 'Remove one', icon: Undo2, onSelect: () => ctl.returnTokenToSupply(e.id) });
      items.push(SEP, ...rotateItems(ctl, e.id), { label: 'Inspect', icon: Eye, shortcut: 'Z', onSelect: () => ctl.inspectEntity(e.id, true) }, lockItem(ctl, e));
      break;
    }

    case 'piece': {
      const comp = getComponent(game, e.componentId);
      const name = comp?.name ?? 'Piece';
      const supply = !e.infinite && Object.values(ctl.state.entities).some((o) => o.kind === 'piece' && o.infinite && o.componentId === e.componentId);
      items = [{ type: 'label', label: e.infinite ? `${name} · supply` : name }];
      if (e.infinite) items.push({ label: 'Take one', icon: CirclePlus, hint: 'Or drag one out of the bowl', onSelect: () => ctl.takePieceBeside(e.id) });
      if (supply) items.push({ label: 'Return to supply', icon: Undo2, hint: 'Or drop it in the bowl', onSelect: () => ctl.returnPieceToSupply(e.id) });
      items.push(SEP, ...rotateItems(ctl, e.id), lockItem(ctl, e));
      if (ctl.mode === 'play' && !e.infinite && !supply) items.push(SEP, { label: 'Remove piece', icon: Trash2, danger: true, onSelect: () => ctl.deleteEntities(scope(ctl, e.id)) });
      break;
    }

    case 'die': {
      const comp = getComponent(game, e.componentId);
      const faces: DieFace[] = comp?.kind === 'dice' && comp.faces.length ? comp.faces : [1, 2, 3, 4, 5, 6].map((value) => ({ value }));
      const dice = scope(ctl, e.id).filter((id) => ctl.state.entities[id]?.kind === 'die');
      items = [
        { type: 'label', label: dice.length > 1 ? `${dice.length} dice selected` : (comp?.name ?? 'Die') },
        {
          label: dice.length > 1 ? `Roll ${dice.length} dice` : 'Roll',
          icon: Dices,
          shortcut: 'R',
          hint: dice.length > 1 ? 'Or fling any of them' : 'Or double-tap it, or fling it',
          onSelect: () => ctl.roll(dice),
        },
        ...(ctl.coarsePointer
          ? [
              {
                label: 'Pick more dice',
                icon: MousePointer2,
                hint: 'Tap other dice to add them, then fling one',
                onSelect: () => {
                  ctl.select([...new Set([...dice, e.id])]);
                  toast('Tap dice to add or remove them', { description: 'Then fling any of them, or press Roll.', duration: 3200 });
                },
              } as MenuItem,
            ]
          : []),
        ...selectDiceItem(ctl),
        {
          label: 'Set face',
          icon: Dices,
          submenu: faceMenu(faces, e.face, (i) => ctl.setDieFace(e.id, i)),
        },
        SEP,
        lockItem(ctl, e),
      ];
      break;
    }

    case 'counter': {
      const comp = getComponent(game, e.componentId);
      const initial = comp?.kind === 'counter' ? comp.initial : Math.max(e.min, Math.min(e.max, 0));
      items = [
        { type: 'label', label: e.label || 'Counter' },
        { label: `Add ${e.step || 1}`, icon: Plus, shortcut: '+', disabled: e.value >= e.max, onSelect: () => ctl.counter(e.id, 1) },
        { label: `Subtract ${e.step || 1}`, icon: Minus, shortcut: '-', disabled: e.value <= e.min, onSelect: () => ctl.counter(e.id, -1) },
        {
          label: 'Set value…',
          icon: Pencil,
          onSelect: async () => {
            const v = await promptText({ title: `Set ${e.label || 'counter'}`, label: `Value (${e.min} to ${e.max})`, initial: String(e.value), confirmLabel: 'Set' });
            if (v == null) return;
            const n = Number(v);
            if (Number.isFinite(n)) ctl.setCounterValue(e.id, Math.round(n));
          },
        },
        { label: `Reset to ${initial}`, icon: RotateCcw, disabled: e.value === initial, onSelect: () => ctl.resetCounter(e.id) },
        {
          label: 'Rename…',
          icon: Pencil,
          onSelect: async () => {
            const v = await promptText({ title: 'Rename counter', initial: e.label, confirmLabel: 'Rename' });
            if (v) ctl.renameCounter(e.id, v);
          },
        },
        SEP,
        lockItem(ctl, e),
      ];
      if (ctl.mode === 'play') items.push({ label: 'Remove counter', icon: Trash2, danger: true, onSelect: () => ctl.deleteEntities([e.id]) });
      break;
    }

    case 'note':
      items = [
        { type: 'label', label: 'Note' },
        { label: 'Edit text', icon: Pencil, hint: 'Or double-tap the note', onSelect: () => ctl.editNote(e.id) },
        {
          label: 'Colour',
          icon: Palette,
          submenu: ops.NOTE_COLORS.map((c, i) => ({
            label: ['Yellow', 'Pink', 'Blue', 'Green', 'Lilac'][i] ?? c,
            checked: e.color === c,
            onSelect: () => ctl.setNoteColor(e.id, c),
          })),
        },
        SEP,
        ...rotateItems(ctl, e.id),
        lockItem(ctl, e),
        SEP,
        { label: 'Delete note', icon: Trash2, shortcut: 'Delete', danger: true, onSelect: () => ctl.deleteEntities(scope(ctl, e.id)) },
      ];
      break;

    case 'board':
      items = [
        { type: 'label', label: getComponent(game, e.componentId)?.name ?? 'Board' },
        { label: 'Inspect', icon: Eye, shortcut: 'Z', onSelect: () => ctl.inspectEntity(e.id, true) },
        ...rotateItems(ctl, e.id),
        SEP,
        lockItem(ctl, e),
      ];
      break;

    case 'zone':
      items = [
        { type: 'label', label: e.label || (e.grid ? (e.grid.endless ? 'Endless grid' : 'Grid') : 'Zone') },
        { label: describeZone(e), disabled: true },
        ...(zoneTakes(e, 'cards')
          ? [{ label: 'Cards dropped here ' + (e.forceFace === 'up' ? 'turn face up' : e.forceFace === 'down' ? 'turn face down' : 'keep their side'), disabled: true }]
          : []),
        SEP,
        lockItem(ctl, e),
      ];
      break;
  }
  const extra = ctl.props.extraEntityMenuItems?.(e, ctl);
  if (extra?.length) items.push(SEP, ...extra);
  return items;
}

export function handMenu(ctl: TableController, uid: ID): MenuItem[] {
  const card = ctl.state.hand.find((c) => c.uid === uid);
  if (!card) return [];
  const home = ctl.homeStackFor(card.deckId);
  const items: MenuItem[] = [
    { type: 'label', label: cardName(ctl.game, card) },
    { label: 'Play face up', icon: ArrowUpToLine, hint: 'Or double-tap / drag it onto the table', onSelect: () => ctl.playHandCard(uid, { faceUp: true }) },
    { label: 'Play face down', icon: FlipHorizontal2, onSelect: () => ctl.playHandCard(uid, { faceUp: false }) },
  ];
  if (home) {
    const name = home.name || ctl.deckName(card.deckId);
    items.push(
      SEP,
      { label: `Put on top of ${name}`, icon: ArrowUpToLine, onSelect: () => ctl.handCardToStack(uid, home.id, 'top') },
      { label: `Put at the bottom of ${name}`, icon: ArrowDownToLine, onSelect: () => ctl.handCardToStack(uid, home.id, 'bottom') },
    );
  }
  items.push(SEP, { label: 'Inspect', icon: Eye, shortcut: 'Z', onSelect: () => ctl.inspectHandCard(uid) });
  return items;
}

export function tableMenu(ctl: TableController, at: Vec): MenuItem[] {
  const theme = ctl.game.table?.theme ?? 'felt-green';
  const items: MenuItem[] = [
    { label: 'Add a note here', icon: StickyNote, onSelect: () => ctl.addNote(at) },
    { label: 'Add a counter here', icon: CirclePlus, onSelect: () => ctl.addCounter(at) },
    SEP,
    { label: 'Show everything', icon: Maximize, shortcut: '0', onSelect: () => ctl.fitAll(true) },
    {
      label: 'Select all pieces',
      icon: MousePointer2,
      shortcut: 'Ctrl+A',
      hint: ctl.coarsePointer ? 'Or hold the table, then drag a box' : 'Or Shift-drag a box',
      onSelect: () => ctl.selectAll(),
    },
    ...selectDiceItem(ctl),
  ];
  if (ctl.props.onThemeChange) {
    items.push({
      label: 'Table material',
      icon: Palette,
      submenu: TABLE_THEMES.map((t) => ({ label: t.label, checked: t.id === theme, onSelect: () => ctl.props.onThemeChange?.(t.id) })),
    });
  }
  const extra = ctl.props.extraTableMenuItems?.(at, ctl);
  if (extra?.length) items.push(SEP, ...extra);
  if (ctl.props.onResetGame) items.push(SEP, { label: 'Restart game…', icon: RotateCcw, danger: true, onSelect: () => ctl.props.onResetGame?.() });
  return items;
}
