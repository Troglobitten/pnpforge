import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { CardInstance, Entity, Game, ID, TableState, ZoneAccept } from '@/shared/types';
import type { MenuItem } from '@/ui';
import type { DropTarget, Payload } from '../engine';
import type { TableController } from './controller';
import { getSettings } from '@/state/settings';

export type TableMode = 'play' | 'setup';

export interface GhostItem {
  key: string;
  /** Snapshot of what is carried (a synthetic stack for single cards). */
  entity: Entity;
  /** Offset from the anchor, mm. */
  dx: number;
  dy: number;
}

export interface Ghost {
  items: GhostItem[];
  payload: Payload;
  /** Zone categories of what is carried (null: nothing a zone takes). */
  cats: ZoneAccept[] | null;
  seq: number;
}

export interface InspectState {
  card?: CardInstance;
  entity?: Entity;
  faceUp: boolean;
  /** Sticky previews (opened from a menu) close on tap; held ones close on key-up. */
  sticky: boolean;
}

/** Ephemeral, per-TableView UI state. Committed game state lives in `state`. */
export interface TableUi {
  mode: TableMode;
  game: Game;
  state: TableState;
  selection: Record<ID, true>;
  /** Entities whose originals are hidden because they are being carried. */
  hidden: Record<ID, true>;
  /** Top `count` cards of a stack are being carried. */
  lifted: { id: ID; count: number } | null;
  /** One card of a spread is being carried. */
  liftedCard: { id: ID; uid: ID } | null;
  /** One token is being taken from this token pile. */
  tokenLift: ID | null;
  /** Card being dragged out of the hand. */
  handDrag: ID | null;
  dropTarget: DropTarget | null;
  /** Plain-language promise shown on the hovered drop target ("Merges on top · 16 cards"). */
  dropHint: string | null;
  /** A zone under the carried piece that won't take it ("Takes cards only"). */
  dropRefuse: ID | null;
  ghost: Ghost | null;
  settle: Record<ID, number>;
  shuffling: Record<ID, number>;
  editingNote: ID | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
  browse: ID | null;
  inspect: InspectState | null;
  shortcutsOpen: boolean;
  handCollapsed: boolean;
  raisedHandCard: ID | null;
  longPress: { x: number; y: number; seq: number } | null;
  panning: boolean;
  spaceHeld: boolean;
  /** App setting "show names on the table" for this mode. Off → names only on demand. */
  names: boolean;
  /** Piece under the mouse (after a short dwell) whose name is shown while `names` is off. */
  peek: ID | null;
  /** The last multi-dice roll: the readout lists these dice while they still show that roll. */
  rollReadout: { ids: ID[]; seqs: number[]; seq: number } | null;
  /** Device px per mm game pieces are rendered at (a half-octave bucket of zoom × DPR, updated at camera rest). */
  pieceRes: number;
}

export function createTableUi(init: Pick<TableUi, 'mode' | 'game' | 'state'>): StoreApi<TableUi> {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem('pnpforge.play.handCollapsed') === '1';
  } catch {
    /* ignore */
  }
  return createStore<TableUi>(() => ({
    ...init,
    selection: {},
    hidden: {},
    lifted: null,
    liftedCard: null,
    tokenLift: null,
    handDrag: null,
    dropTarget: null,
    dropHint: null,
    dropRefuse: null,
    ghost: null,
    settle: {},
    shuffling: {},
    editingNote: null,
    menu: null,
    browse: null,
    inspect: null,
    shortcutsOpen: false,
    handCollapsed: collapsed,
    raisedHandCard: null,
    longPress: null,
    panning: false,
    spaceHeld: false,
    names: init.mode === 'setup' ? getSettings().showNamesSetup : getSettings().showNamesPlay,
    peek: null,
    rollReadout: null,
    pieceRes: 4,
  }));
}

export const TableCtx = createContext<TableController | null>(null);

export function useCtl(): TableController {
  const c = useContext(TableCtx);
  if (!c) throw new Error('TableCtx missing');
  return c;
}

export function useUi<T>(selector: (s: TableUi) => T): T {
  return useStore(useCtl().ui, selector);
}
