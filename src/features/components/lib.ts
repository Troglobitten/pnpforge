import { customAlphabet } from 'nanoid';
import type { Draft } from 'immer';
import { ChessPawn, Coins, Dices, Gauge, Layers, Map as MapIcon, type LucideIcon } from 'lucide-react';
import { PIECE_MATERIALS, PIECE_SHAPES, PLAYER_COLORS, colorName } from '@/features/play/pieces/model';
import { api, assetUrlById } from '@/api/client';
import {
  CARD_PRESETS,
  type Asset,
  type AssetRole,
  type BoardComponent,
  type CardDef,
  type Component,
  type ComponentKind,
  type CounterComponent,
  type DeckComponent,
  type DieComponent,
  type DieFace,
  type Game,
  type ID,
  type PieceComponent,
  type PieceShape,
  type TableState,
  type TokenComponent,
} from '@/shared/types';

/* ------------------------------------------------------------------ */
/* Ids, names, formatting                                               */
/* ------------------------------------------------------------------ */

export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export const KIND_ORDER: ComponentKind[] = ['deck', 'board', 'tokens', 'piece', 'dice', 'counter'];

export const KIND_META: Record<ComponentKind, { label: string; plural: string; icon: LucideIcon; blurb: string }> = {
  deck: { label: 'Deck', plural: 'Decks', icon: Layers, blurb: 'Cards that share a size and a back' },
  board: { label: 'Board', plural: 'Boards', icon: MapIcon, blurb: 'A large printed sheet the game is played on' },
  tokens: { label: 'Tokens', plural: 'Tokens', icon: Coins, blurb: 'Chits, coins and markers, one or two sided' },
  dice: { label: 'Die', plural: 'Dice', icon: Dices, blurb: 'Standard or custom-faced dice' },
  counter: { label: 'Counter', plural: 'Counters', icon: Gauge, blurb: 'A tracked number such as health or score' },
  piece: { label: 'Game piece', plural: 'Game pieces', icon: ChessPawn, blurb: 'Cubes, discs, meeples, houses and pawns in wood, plastic or acrylic' },
};

export function pieceMaterialLabel(m: PieceComponent['material']) {
  return PIECE_MATERIALS.find((x) => x.id === m)?.label ?? 'Wood';
}
export function pieceShapeLabel(s: PieceShape) {
  return PIECE_SHAPES.find((x) => x.id === s)?.label ?? 'Piece';
}

/** 63.5 → "63.5", 70 → "70", 88.94 → "88.9" */
export function fmtMm(v: number) {
  return String(Math.round(v * 10) / 10);
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function uniqueName(game: Game, base: string) {
  const names = new Set(game.components.map((c) => c.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function deckTotals(deck: DeckComponent) {
  return { total: deck.cards.reduce((n, c) => n + c.count, 0), unique: deck.cards.length };
}

export function deckCountLabel(deck: DeckComponent) {
  const { total, unique } = deckTotals(deck);
  if (total === 0) return 'No cards yet';
  if (total === unique) return plural(total, 'card');
  return `${plural(total, 'card')}, ${unique} unique`;
}

export function dieLabel(die: DieComponent) {
  const n = die.faces.length;
  const standard = [4, 6, 8, 10, 12, 20].includes(n);
  const custom = die.faces.some((f) => f.label || f.image);
  return custom || !standard ? `Custom · ${plural(n, 'face')}` : `d${n}`;
}

/**
 * Tile meta split over two lines, so the second half (usually the physical
 * size — the thing you check at a glance) never gets truncated away.
 */
export function componentMetaLines(c: Component): [string, string?] {
  switch (c.kind) {
    case 'deck':
      return [deckCountLabel(c), `${fmtMm(c.width)} × ${fmtMm(c.height)} mm`];
    case 'board':
      return [`${fmtMm(c.width)} × ${fmtMm(c.height)} mm`];
    case 'tokens': {
      const shape = { square: 'Square', rect: 'Rectangle', round: 'Round', hex: 'Hex' }[c.shape];
      const size = c.shape === 'rect' ? `${fmtMm(c.width)}×${fmtMm(c.height)}` : fmtMm(c.width);
      return [`${shape} · ${size} mm`, c.back ? 'Two-sided' : undefined];
    }
    case 'dice': {
      // Dice are usually named after their type; don't say "d6" twice.
      const label = dieLabel(c);
      return c.name.trim().toLowerCase() === label.toLowerCase() ? [`${fmtMm(c.size)} mm`] : [label, `${fmtMm(c.size)} mm`];
    }
    case 'counter':
      return [`${c.min}–${c.max}`, `Starts at ${c.initial}`];
    case 'piece':
      return [`${pieceMaterialLabel(c.material)} ${pieceShapeLabel(c.shape).toLowerCase()}`, `${colorName(c.color) ?? 'Custom colour'} · ${fmtMm(c.size)} mm`];
  }
}

export function describeComponent(c: Component): string {
  const [a, b] = componentMetaLines(c);
  return b ? `${a} · ${b.toLowerCase()}` : a;
}

/** Readable ink colour for text printed on a fill colour. */
export function inkFor(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#fff8ee';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#231d16' : '#fff8ee';
}

export function urlOf(game: Pick<Game, 'id' | 'assets'>, id: ID | null | undefined) {
  return assetUrlById(game, id);
}

/* ------------------------------------------------------------------ */
/* Card sizes                                                           */
/* ------------------------------------------------------------------ */

const near = (a: number, b: number) => Math.abs(a - b) < 0.15;

/** Finds the preset matching a size in either orientation. */
export function matchPreset(w: number, h: number) {
  for (const p of CARD_PRESETS) {
    if (near(p.width, w) && near(p.height, h)) return { preset: p, landscape: false };
    if (near(p.width, h) && near(p.height, w)) return { preset: p, landscape: true };
  }
  return null;
}

/** A sensible card size for images of the given pixel aspect (w/h). */
export function sizeForImageAspect(aspect: number): { width: number; height: number } {
  if (!Number.isFinite(aspect) || aspect <= 0) return { width: 63.5, height: 88.9 };
  let best: { width: number; height: number; err: number } | null = null;
  for (const p of CARD_PRESETS) {
    for (const [w, h] of [
      [p.width, p.height],
      [p.height, p.width],
    ]) {
      const err = Math.abs(Math.log(w / h / aspect));
      if (!best || err < best.err) best = { width: w, height: h, err };
    }
  }
  if (best && best.err < 0.04) return { width: best.width, height: best.height };
  // No preset fits: keep a poker-sized long side.
  return aspect >= 1
    ? { width: 88.9, height: Math.round((88.9 / aspect) * 10) / 10 }
    : { width: Math.round(88.9 * aspect * 10) / 10, height: 88.9 };
}

/* ------------------------------------------------------------------ */
/* Factories                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_BACK_COLOR = '#2c3e52';

export function makeDeck(game: Game, partial: Partial<DeckComponent> = {}): DeckComponent {
  return {
    id: newId(),
    kind: 'deck',
    name: uniqueName(game, partial.name ?? 'New deck'),
    createdAt: Date.now(),
    width: 63.5,
    height: 88.9,
    cornerRadius: 3,
    back: null,
    backColor: DEFAULT_BACK_COLOR,
    cards: [],
    ...partial,
  } as DeckComponent;
}

export function makeBoard(game: Game, image: Asset | null, name = 'Board'): BoardComponent {
  // Default to A3-ish long side (420 mm) at the image's aspect.
  let width = 420;
  let height = 297;
  if (image && image.width > 0 && image.height > 0) {
    const aspect = image.width / image.height;
    if (aspect >= 1) height = Math.round(width / aspect);
    else {
      height = 420;
      width = Math.round(height * aspect);
    }
  }
  return { id: newId(), kind: 'board', name: uniqueName(game, name), createdAt: Date.now(), image: image?.id ?? null, width, height, cornerRadius: 3 };
}

export function makeTokens(game: Game): TokenComponent {
  return {
    id: newId(),
    kind: 'tokens',
    name: uniqueName(game, 'Tokens'),
    createdAt: Date.now(),
    shape: 'round',
    width: 22,
    height: 22,
    front: null,
    back: null,
    color: '#3f6fb0',
    label: '1',
  };
}

export function standardFaces(n: number): DieFace[] {
  return Array.from({ length: n }, (_, i) => ({ value: i + 1 }));
}

export function makeDie(game: Game, faces: number | 'custom'): DieComponent {
  const custom = faces === 'custom';
  return {
    id: newId(),
    kind: 'dice',
    name: uniqueName(game, custom ? 'Custom die' : `d${faces}`),
    createdAt: Date.now(),
    size: 16,
    color: '#f1ebdd',
    inkColor: '#2a241c',
    faces: custom ? ['A', 'B', 'C', 'D', 'E', 'F'].map((label, i) => ({ value: i + 1, label })) : standardFaces(faces),
  };
}

export function makeCounter(game: Game): CounterComponent {
  return {
    id: newId(),
    kind: 'counter',
    name: uniqueName(game, 'Counter'),
    createdAt: Date.now(),
    label: 'Score',
    min: 0,
    max: 20,
    initial: 0,
    step: 1,
    color: '#e6b94a',
  };
}

export function makePiece(game: Game, shape: PieceShape): PieceComponent {
  const meta = PIECE_SHAPES.find((s) => s.id === shape) ?? PIECE_SHAPES[0];
  const used = new Set(game.components.filter((c) => c.kind === 'piece' && c.shape === shape).map((c) => (c as PieceComponent).color.toLowerCase()));
  const color = PLAYER_COLORS.find((c) => !used.has(c.hex.toLowerCase()))?.hex ?? PLAYER_COLORS[0].hex;
  const name = used.size ? `${meta.label} (${colorName(color)})` : meta.label;
  return { id: newId(), kind: 'piece', name: uniqueName(game, name), createdAt: Date.now(), shape, material: 'wood', color, size: meta.defaultSize };
}

/** A piece's name without its colour suffix ("Meeple (Red)" -> "Meeple"). */
export function pieceBaseName(piece: PieceComponent) {
  const own = colorName(piece.color);
  return own ? piece.name.replace(new RegExp(`\\s*[(—-]?\\s*${own}\\s*\\)?\\s*$`, 'i'), '').trim() || pieceShapeLabel(piece.shape) : piece.name;
}

/** Copies of a piece in every player colour it isn't made in yet (same shape, material and size). */
export function pieceColourVariants(game: Game, piece: PieceComponent): PieceComponent[] {
  const same = game.components.filter(
    (c): c is PieceComponent => c.kind === 'piece' && c.shape === piece.shape && c.material === piece.material && Math.abs(c.size - piece.size) < 0.05,
  );
  const have = new Set(same.map((c) => c.color.toLowerCase()));
  const base = pieceBaseName(piece);
  const out: PieceComponent[] = [];
  const names = { ...game, components: [...game.components] };
  for (const c of PLAYER_COLORS) {
    if (have.has(c.hex.toLowerCase())) continue;
    const copy: PieceComponent = { ...piece, id: newId(), createdAt: Date.now(), color: c.hex, name: uniqueName(names, `${base} (${c.name})`) };
    names.components.push(copy);
    out.push(copy);
  }
  return out;
}

export function cloneComponent(game: Game, c: Component): Component {
  const copy = structuredClone(c) as Component;
  copy.id = newId();
  copy.createdAt = Date.now();
  copy.name = uniqueName(game, `${c.name} copy`);
  if (copy.kind === 'deck') copy.cards = copy.cards.map((card) => ({ ...card, id: newId() }));
  return copy;
}

/* ------------------------------------------------------------------ */
/* Setup placements                                                     */
/* ------------------------------------------------------------------ */

/** How many things on the setup table use this component. */
export function countPlacements(setup: TableState, comp: Pick<Component, 'id' | 'kind'>) {
  let n = 0;
  for (const e of Object.values(setup.entities)) {
    if (e.kind === 'stack') {
      if (comp.kind === 'deck') n += e.cards.filter((c) => c.deckId === comp.id).length;
    } else if ('componentId' in e && e.componentId === comp.id) n++;
  }
  if (comp.kind === 'deck') n += setup.hand.filter((c) => c.deckId === comp.id).length;
  return n;
}

export function countCardPlacements(setup: TableState, deckId: ID, cardIds: Set<ID>) {
  let n = 0;
  const hit = (c: { deckId: ID; cardId: ID }) => c.deckId === deckId && cardIds.has(c.cardId);
  for (const e of Object.values(setup.entities)) if (e.kind === 'stack') n += e.cards.filter(hit).length;
  return n + setup.hand.filter(hit).length;
}

function dropEntity(setup: Draft<TableState>, id: ID) {
  delete setup.entities[id];
  setup.order = setup.order.filter((o) => o !== id);
}

/** Remove card instances matching `pred`; stacks left empty are removed. */
function stripCards(setup: Draft<TableState>, pred: (c: { deckId: ID; cardId: ID }) => boolean) {
  for (const e of Object.values(setup.entities)) {
    if (e.kind !== 'stack') continue;
    const before = e.cards.length;
    e.cards = e.cards.filter((c) => !pred(c));
    if (before && !e.cards.length) dropEntity(setup, e.id);
  }
  setup.hand = setup.hand.filter((c) => !pred(c));
}

export function removePlacements(setup: Draft<TableState>, comp: Pick<Component, 'id' | 'kind'>) {
  if (comp.kind === 'deck') stripCards(setup, (c) => c.deckId === comp.id);
  for (const e of Object.values(setup.entities)) {
    if (e.kind !== 'stack' && 'componentId' in e && e.componentId === comp.id) dropEntity(setup, e.id);
  }
}

export function removeCardPlacements(setup: Draft<TableState>, deckId: ID, cardIds: Set<ID>) {
  stripCards(setup, (c) => c.deckId === deckId && cardIds.has(c.cardId));
}

export function retargetCardPlacements(setup: Draft<TableState>, fromDeck: ID, toDeck: ID, cardIds: Set<ID>) {
  const fix = (c: { deckId: ID; cardId: ID }) => {
    if (c.deckId === fromDeck && cardIds.has(c.cardId)) c.deckId = toDeck;
  };
  for (const e of Object.values(setup.entities)) if (e.kind === 'stack') e.cards.forEach(fix);
  setup.hand.forEach(fix);
}

/* ------------------------------------------------------------------ */
/* Files & uploads                                                      */
/* ------------------------------------------------------------------ */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;

export function isImageFile(f: File) {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name);
}

export function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function nameFromFile(name: string) {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The name a set of card images have in common, so a deck imported from
 * `ember-01.png … ember-18.png` is called "Ember" rather than "New deck 2".
 * Returns null when the files share nothing usable.
 */
export function commonBaseName(fileNames: string[]): string | null {
  const clean = fileNames.map((n) => nameFromFile(n).replace(/[-.]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) return null;
  let prefix = clean[0];
  for (const n of clean.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i].toLowerCase() === n[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) return null;
  }
  // Drop the counter the files were numbered with, and any trailing separator.
  const base = prefix.replace(/[\s\-_.]*\d*$/, '').trim();
  if (base.length < 3 || base.length > 40) return null;
  return base[0].toUpperCase() + base.slice(1);
}

/** Opens the system file picker. Resolves [] when cancelled. */
export function pickFiles({ accept = 'image/*', multiple = true } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    const done = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    input.click();
  });
}

/** Uploads images in batches of 20 with overall progress (0..1). */
export async function uploadImages(
  gameId: ID,
  files: (File | { blob: Blob; name: string })[],
  role: AssetRole,
  onProgress?: (p: number) => void,
): Promise<Asset[]> {
  const out: Asset[] = [];
  const BATCH = 20;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const assets = await api.uploadAssets(gameId, batch, {
      role,
      onProgress: (p) => onProgress?.((i + p * batch.length) / files.length),
    });
    out.push(...assets);
  }
  onProgress?.(1);
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = url;
  });
}

/** Renders an image rotated by 90/180/270° into a new file. */
export async function bakeRotation(url: string, asset: Asset | undefined, deg: 90 | 180 | 270): Promise<{ blob: Blob; name: string }> {
  const img = await loadImage(url);
  let w = img.naturalWidth || asset?.width || 1000;
  let h = img.naturalHeight || asset?.height || 1400;
  // Vector art: rasterise at a comfortable resolution. Huge photos: cap.
  const isSvg = asset?.mime === 'image/svg+xml';
  const longSide = Math.max(w, h);
  const scale = isSvg ? Math.max(1, 1400 / longSide) : Math.min(1, 4096 / longSide);
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const quarter = deg !== 180;
  const canvas = document.createElement('canvas');
  canvas.width = quarter ? h : w;
  canvas.height = quarter ? w : h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  const jpeg = asset?.mime === 'image/jpeg';
  const type = jpeg ? 'image/jpeg' : asset?.mime === 'image/webp' ? 'image/webp' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, 0.92),
  );
  const base = nameFromFile(asset?.name ?? 'card').replace(/\s/g, '-');
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
  return { blob, name: `${base}-r${deg}.${ext}` };
}

export function imageAssets(game: Game): Asset[] {
  return Object.values(game.assets)
    .filter((a) => a.mime.startsWith('image/') && a.role !== 'source' && a.role !== 'photo')
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function newCard(front: ID | null, name?: string): CardDef {
  return { id: newId(), name, front, count: 1 };
}
