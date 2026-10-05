/**
 * Pure, immutable operations on a TableState. Every function returns a NEW
 * state (or the same object when nothing changed) and never mutates input.
 * Functions that create an entity return `{ state, id }`.
 *
 * These are shared by the Play table and the Setup editor.
 */
import type {
  CardInstance,
  CounterEntity,
  Entity,
  Game,
  ID,
  NoteEntity,
  PieceEntity,
  StackEntity,
  StackLayout,
  TableState,
  TokenEntity,
} from '@/shared/types';
import { cardDims, getComponent, localBounds, rotateVec, type Vec } from './geometry';
import { newId, randomInt, type Rng } from './ids';

type S = TableState;
type GameLike = Pick<Game, 'components'>;
export interface Created {
  state: S;
  id: ID;
}

/* ------------------------------------------------------------------ */
/* Generic entity plumbing                                              */
/* ------------------------------------------------------------------ */

export function updateEntity<E extends Entity = Entity>(s: S, id: ID, fn: (e: E) => E): S {
  const e = s.entities[id] as E | undefined;
  if (!e) return s;
  const n = fn(e);
  if (n === e) return s;
  return { ...s, entities: { ...s.entities, [id]: n } };
}

/** Add (or replace) an entity and put it on top of the z-order. */
export function addEntity(s: S, e: Entity): S {
  return { ...s, entities: { ...s.entities, [e.id]: e }, order: [...s.order.filter((i) => i !== e.id), e.id] };
}

export function removeEntities(s: S, ids: ID[]): S {
  const set = new Set(ids.filter((id) => s.entities[id]));
  if (!set.size) return s;
  const entities = { ...s.entities };
  for (const id of set) delete entities[id];
  return { ...s, entities, order: s.order.filter((id) => !set.has(id)) };
}

export function bringToFront(s: S, ids: ID[]): S {
  const set = new Set(ids);
  const tail = s.order.slice(-set.size);
  if (tail.length === set.size && tail.every((id) => set.has(id))) return s;
  return { ...s, order: [...s.order.filter((id) => !set.has(id)), ...s.order.filter((id) => set.has(id))] };
}

export function moveEntity(s: S, id: ID, x: number, y: number): S {
  return updateEntity(s, id, (e) => (e.x === x && e.y === y ? e : { ...e, x, y }));
}

export function translateEntities(s: S, ids: ID[], dx: number, dy: number): S {
  if (!dx && !dy) return s;
  const entities = { ...s.entities };
  for (const id of ids) {
    const e = entities[id];
    if (e) entities[id] = { ...e, x: e.x + dx, y: e.y + dy };
  }
  return { ...s, entities };
}

export function rotateEntities(s: S, ids: ID[], delta: number): S {
  const entities = { ...s.entities };
  let changed = false;
  for (const id of ids) {
    const e = entities[id];
    if (!e) continue;
    let rot = e.rot + delta;
    // keep numbers tidy but continuous (so CSS transitions never spin the long way)
    if (Math.abs(rot) >= 3600) rot = rot % 360;
    entities[id] = { ...e, rot };
    changed = true;
  }
  return changed ? { ...s, entities } : s;
}

export function setRotation(s: S, id: ID, rot: number): S {
  return updateEntity(s, id, (e) => ({ ...e, rot }));
}

export function setLocked(s: S, ids: ID[], locked: boolean): S {
  const entities = { ...s.entities };
  for (const id of ids) {
    const e = entities[id];
    if (e) entities[id] = { ...e, locked };
  }
  return { ...s, entities };
}

/* ------------------------------------------------------------------ */
/* Stacks of cards                                                      */
/* ------------------------------------------------------------------ */

export function newStack(
  s: S,
  cards: CardInstance[],
  at: Vec,
  opts: { rot?: number; layout?: StackLayout; name?: string; id?: ID } = {},
): Created {
  const id = opts.id ?? newId();
  const e: StackEntity = {
    id,
    kind: 'stack',
    x: at.x,
    y: at.y,
    rot: opts.rot ?? 0,
    cards,
    layout: opts.layout ?? 'pile',
    ...(opts.name ? { name: opts.name } : {}),
  };
  return { state: addEntity(s, e), id };
}

function asStack(s: S, id: ID): StackEntity | undefined {
  const e = s.entities[id];
  return e?.kind === 'stack' ? e : undefined;
}

/** Replace a stack's cards; removes the stack when it becomes empty. */
export function setStackCards(s: S, id: ID, cards: CardInstance[]): S {
  const st = asStack(s, id);
  if (!st) return s;
  if (!cards.length) return removeEntities(s, [id]);
  return updateEntity<StackEntity>(s, id, (e) => ({ ...e, cards, layout: cards.length === 1 ? 'pile' : e.layout }));
}

/** Remove the top `n` cards (returned bottom->top). */
export function removeTop(s: S, id: ID, n = 1): { state: S; cards: CardInstance[] } {
  const st = asStack(s, id);
  if (!st || n <= 0) return { state: s, cards: [] };
  const k = Math.min(n, st.cards.length);
  const cards = st.cards.slice(st.cards.length - k);
  return { state: setStackCards(s, id, st.cards.slice(0, st.cards.length - k)), cards };
}

/** Remove specific cards by uid (returned in stack order). */
export function removeCards(s: S, id: ID, uids: ID[]): { state: S; cards: CardInstance[] } {
  const st = asStack(s, id);
  if (!st) return { state: s, cards: [] };
  const set = new Set(uids);
  const cards = st.cards.filter((c) => set.has(c.uid));
  return { state: setStackCards(s, id, st.cards.filter((c) => !set.has(c.uid))), cards };
}

/** Put cards on the top (default) or bottom of a stack. */
export function putCards(s: S, id: ID, cards: CardInstance[], where: 'top' | 'bottom' = 'top'): S {
  if (!cards.length) return s;
  return updateEntity<StackEntity>(s, id, (e) => ({
    ...e,
    cards: where === 'top' ? [...e.cards, ...cards] : [...cards, ...e.cards],
  }));
}

/** Take the top `n` cards off a stack into a new stack at `at`. */
export function takeTop(s: S, id: ID, n: number, at: Vec, opts: { faceUp?: boolean } = {}): Created | null {
  const st = asStack(s, id);
  if (!st) return null;
  const r = removeTop(s, id, n);
  if (!r.cards.length) return null;
  const cards = opts.faceUp === undefined ? r.cards : r.cards.map((c) => ({ ...c, faceUp: opts.faceUp! }));
  return newStack(r.state, cards, at, { rot: st.rot });
}

/** Take one specific card out of a stack into a new stack at `at`. */
export function takeCard(s: S, id: ID, uid: ID, at: Vec, opts: { faceUp?: boolean; rot?: number } = {}): Created | null {
  const st = asStack(s, id);
  if (!st) return null;
  const r = removeCards(s, id, [uid]);
  if (!r.cards.length) return null;
  const cards = opts.faceUp === undefined ? r.cards : r.cards.map((c) => ({ ...c, faceUp: opts.faceUp! }));
  return newStack(r.state, cards, at, { rot: opts.rot ?? st.rot });
}

/** Put the whole source stack on top of the target stack (source disappears). */
export function mergeStacks(s: S, sourceId: ID, targetId: ID): S {
  const src = asStack(s, sourceId);
  const dst = asStack(s, targetId);
  if (!src || !dst || sourceId === targetId) return s;
  return bringToFront(putCards(removeEntities(s, [sourceId]), targetId, src.cards), [targetId]);
}

/** Flip the top card (or a single card) of a stack. */
export function flipTop(s: S, id: ID): S {
  return updateEntity<StackEntity>(s, id, (e) => {
    if (e.kind !== 'stack' || !e.cards.length) return e;
    const cards = e.cards.slice();
    const top = cards[cards.length - 1];
    cards[cards.length - 1] = { ...top, faceUp: !top.faceUp };
    return { ...e, cards };
  });
}

/** Turn the whole stack over: order reverses and every card flips. */
export function flipStack(s: S, id: ID): S {
  return updateEntity<StackEntity>(s, id, (e) =>
    e.kind !== 'stack' ? e : { ...e, cards: e.cards.map((c) => ({ ...c, faceUp: !c.faceUp })).reverse() },
  );
}

export function setStackFace(s: S, id: ID, faceUp: boolean): S {
  return updateEntity<StackEntity>(s, id, (e) =>
    e.kind !== 'stack' || e.cards.every((c) => c.faceUp === faceUp) ? e : { ...e, cards: e.cards.map((c) => ({ ...c, faceUp })) },
  );
}

export function shuffleCards<T>(cards: T[], rng: Rng = randomInt): T[] {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function shuffleStack(s: S, id: ID, rng: Rng = randomInt): S {
  return updateEntity<StackEntity>(s, id, (e) => (e.kind !== 'stack' || e.cards.length < 2 ? e : { ...e, cards: shuffleCards(e.cards, rng) }));
}

export function setLayout(s: S, id: ID, layout: StackLayout): S {
  return updateEntity<StackEntity>(s, id, (e) => (e.kind !== 'stack' || e.layout === layout ? e : { ...e, layout }));
}

/** Move one card to the top or bottom of its stack. */
export function moveCardInStack(s: S, id: ID, uid: ID, where: 'top' | 'bottom'): S {
  return updateEntity<StackEntity>(s, id, (e) => {
    if (e.kind !== 'stack') return e;
    const c = e.cards.find((x) => x.uid === uid);
    if (!c) return e;
    const rest = e.cards.filter((x) => x.uid !== uid);
    return { ...e, cards: where === 'top' ? [...rest, c] : [c, ...rest] };
  });
}

/** Split: the top half becomes a new stack placed beside the original. */
export function splitStack(game: GameLike, s: S, id: ID): Created | null {
  const st = asStack(s, id);
  if (!st || st.cards.length < 2) return null;
  const n = Math.floor(st.cards.length / 2);
  const { w } = cardDims(game, st.cards[st.cards.length - 1]);
  const off = rotateVec({ x: w + 6, y: 0 }, st.rot);
  return takeTop(s, id, n, { x: st.x + off.x, y: st.y + off.y });
}

/** Deal `n` cards from the top into a row of single cards to the right of the stack. */
export function dealRow(game: GameLike, s: S, id: ID, n: number, faceUp = true): { state: S; ids: ID[] } {
  const st = asStack(s, id);
  if (!st) return { state: s, ids: [] };
  const { w } = cardDims(game, st.cards[st.cards.length - 1]);
  const lb = localBounds(game, st);
  let state = s;
  const ids: ID[] = [];
  const k = Math.min(n, st.cards.length);
  for (let i = 0; i < k; i++) {
    const off = rotateVec({ x: lb.x + lb.w + 8 + w / 2 + i * (w + 4), y: 0 }, st.rot);
    const r = takeTop(state, id, 1, { x: st.x + off.x, y: st.y + off.y }, { faceUp });
    if (!r) break;
    state = r.state;
    ids.push(r.id);
  }
  return { state, ids };
}

/* ------------------------------------------------------------------ */
/* Hand                                                                 */
/* ------------------------------------------------------------------ */

export function handInsert(s: S, cards: CardInstance[], index = s.hand.length): S {
  if (!cards.length) return s;
  const i = Math.max(0, Math.min(index, s.hand.length));
  const hand = s.hand.slice();
  hand.splice(i, 0, ...cards.map((c) => (c.faceUp ? c : { ...c, faceUp: true })));
  return { ...s, hand };
}

export function handRemove(s: S, uids: ID[]): { state: S; cards: CardInstance[] } {
  const set = new Set(uids);
  const cards = s.hand.filter((c) => set.has(c.uid));
  if (!cards.length) return { state: s, cards };
  return { state: { ...s, hand: s.hand.filter((c) => !set.has(c.uid)) }, cards };
}

/** Reorder: move the card at `from` so it ends up at insertion index `to` (0..hand.length). */
export function handMove(s: S, from: number, to: number): S {
  if (from < 0 || from >= s.hand.length) return s;
  const hand = s.hand.slice();
  const [c] = hand.splice(from, 1);
  const t = Math.max(0, Math.min(to > from ? to - 1 : to, hand.length));
  if (t === from) return s;
  hand.splice(t, 0, c);
  return { ...s, hand };
}

/** Draw `n` cards from the top of a stack into the hand (rightmost). */
export function drawToHand(s: S, stackId: ID, n = 1): S {
  const r = removeTop(s, stackId, n);
  if (!r.cards.length) return s;
  // the top card is drawn first, so it ends up left-most of the drawn group
  return handInsert(r.state, r.cards.slice().reverse());
}

/** Play a card from the hand onto the table as a new single-card stack. */
export function playFromHand(s: S, uid: ID, at: Vec, opts: { faceUp?: boolean; rot?: number } = {}): Created | null {
  const r = handRemove(s, [uid]);
  if (!r.cards.length) return null;
  return newStack(r.state, [{ ...r.cards[0], faceUp: opts.faceUp ?? true }], at, { rot: opts.rot ?? 0 });
}

/* ------------------------------------------------------------------ */
/* Tokens                                                               */
/* ------------------------------------------------------------------ */

export function flipToken(s: S, id: ID): S {
  return updateEntity<TokenEntity>(s, id, (e) => (e.kind !== 'token' ? e : { ...e, faceUp: !e.faceUp }));
}

/** Take one token off a token stack / supply into a new token at `at`. */
export function takeToken(s: S, id: ID, at: Vec): Created | null {
  const t = s.entities[id];
  if (t?.kind !== 'token') return null;
  let state = s;
  if (!t.infinite) {
    if (t.count <= 1) return null;
    state = updateEntity<TokenEntity>(s, id, (e) => ({ ...e, count: e.count - 1 }));
  }
  const nid = newId();
  const e: TokenEntity = { id: nid, kind: 'token', componentId: t.componentId, x: at.x, y: at.y, rot: t.rot, faceUp: t.faceUp, count: 1 };
  return { state: addEntity(state, e), id: nid };
}

/** Put the source tokens onto the target (same component). Supplies absorb them. */
export function mergeTokens(s: S, srcId: ID, targetId: ID, count?: number): S {
  const a = s.entities[srcId];
  const b = s.entities[targetId];
  if (a?.kind !== 'token' || b?.kind !== 'token' || a.componentId !== b.componentId || srcId === targetId) return s;
  const n = count ?? (a.infinite ? 1 : a.count);
  let state = a.infinite ? s : a.count - n <= 0 ? removeEntities(s, [srcId]) : updateEntity<TokenEntity>(s, srcId, (e) => ({ ...e, count: e.count - n }));
  if (!b.infinite) state = updateEntity<TokenEntity>(state, targetId, (e) => ({ ...e, count: e.count + n }));
  return state;
}

/** Remove one token (or the whole entity when it is the last). Supplies are untouched. */
export function removeOneToken(s: S, id: ID): S {
  const t = s.entities[id];
  if (t?.kind !== 'token' || t.infinite) return s;
  return t.count <= 1 ? removeEntities(s, [id]) : updateEntity<TokenEntity>(s, id, (e) => ({ ...e, count: e.count - 1 }));
}

/** Split a token pile in two halves side by side. */
export function splitTokens(game: GameLike, s: S, id: ID): Created | null {
  const t = s.entities[id];
  if (t?.kind !== 'token' || t.infinite || t.count < 2) return null;
  const half = Math.floor(t.count / 2);
  const c = getComponent(game, t.componentId);
  const w = c?.kind === 'tokens' ? c.width : 20;
  const state = updateEntity<TokenEntity>(s, id, (e) => ({ ...e, count: e.count - half }));
  const nid = newId();
  const off = rotateVec({ x: w + 5, y: 0 }, t.rot);
  return { state: addEntity(state, { ...t, id: nid, count: half, x: t.x + off.x, y: t.y + off.y, infinite: undefined }), id: nid };
}

/* ------------------------------------------------------------------ */
/* Game pieces                                                          */
/* ------------------------------------------------------------------ */

/** A new single piece out of an infinite supply, with the supply's look. */
export function takePiece(s: S, supplyId: ID, at: Vec): Created | null {
  const sp = s.entities[supplyId];
  if (sp?.kind !== 'piece') return null;
  const id = newId();
  const e: PieceEntity = {
    id,
    kind: 'piece',
    componentId: sp.componentId,
    x: at.x,
    y: at.y,
    rot: sp.rot,
    ...(sp.color ? { color: sp.color } : {}),
    ...(sp.material ? { material: sp.material } : {}),
  };
  return { state: addEntity(s, e), id };
}

/* ------------------------------------------------------------------ */
/* Dice                                                                 */
/* ------------------------------------------------------------------ */

/** Roll: random face, bump rollSeq, and let the die land a little off where it was. */
export function rollDie(s: S, id: ID, faceCount: number, rng: Rng = randomInt, opts: { scatter?: boolean } = {}): S {
  return updateEntity(s, id, (e) => {
    if (e.kind !== 'die') return e;
    const scatter = opts.scatter ?? true;
    const dx = scatter ? (rng(1000) / 1000 - 0.5) * 10 : 0;
    const dy = scatter ? (rng(1000) / 1000 - 0.5) * 10 : 0;
    const drot = scatter ? (rng(1000) / 1000 - 0.5) * 50 : 0;
    return { ...e, face: rng(Math.max(1, faceCount)), rollSeq: (e.rollSeq ?? 0) + 1, x: e.x + dx, y: e.y + dy, rot: e.rot + drot };
  });
}

export function setDieFace(s: S, id: ID, face: number): S {
  return updateEntity(s, id, (e) => (e.kind !== 'die' || e.face === face ? e : { ...e, face }));
}

/* ------------------------------------------------------------------ */
/* Counters                                                             */
/* ------------------------------------------------------------------ */

export function setCounter(s: S, id: ID, value: number): S {
  return updateEntity<CounterEntity>(s, id, (e) => {
    if (e.kind !== 'counter') return e;
    const v = Math.min(e.max, Math.max(e.min, value));
    return v === e.value ? e : { ...e, value: v };
  });
}

export function changeCounter(s: S, id: ID, steps: number): S {
  const e = s.entities[id];
  if (e?.kind !== 'counter') return s;
  return setCounter(s, id, e.value + steps * (e.step || 1));
}

export function addCounter(s: S, at: Vec, opts: Partial<Omit<CounterEntity, 'id' | 'kind'>> = {}): Created {
  const id = newId();
  const e: CounterEntity = {
    id,
    kind: 'counter',
    x: at.x,
    y: at.y,
    rot: 0,
    label: 'Counter',
    value: 0,
    min: -999,
    max: 999,
    step: 1,
    color: '#e6a756',
    ...opts,
  };
  return { state: addEntity(s, e), id };
}

/* ------------------------------------------------------------------ */
/* Notes                                                                */
/* ------------------------------------------------------------------ */

export const NOTE_COLORS = ['#f7e27c', '#f5b3a8', '#a9d8f0', '#b9e4a6', '#e3c9f2'];

export function addNote(s: S, at: Vec, text = '', color = NOTE_COLORS[0]): Created {
  const id = newId();
  const e: NoteEntity = { id, kind: 'note', x: at.x, y: at.y, rot: 0, w: 60, h: 60, text, color };
  return { state: addEntity(s, e), id };
}

export function setNoteText(s: S, id: ID, text: string): S {
  return updateEntity<NoteEntity>(s, id, (e) => (e.kind !== 'note' || e.text === text ? e : { ...e, text }));
}

export function setNoteColor(s: S, id: ID, color: string): S {
  return updateEntity<NoteEntity>(s, id, (e) => (e.kind !== 'note' || e.color === color ? e : { ...e, color }));
}
