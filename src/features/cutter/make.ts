/**
 * Make a group (v3 unified cutter), headless: plan its pieces (src/shared/cutter/pieces.ts),
 * render every frame through its PageSource, upload the images and write the component — deck,
 * tokens, board(s), a deck's back or the game cover — the way the slicer and the photo import do
 * today. The group remembers what it made (`group.made`), so making it again UPDATES that
 * component in place: same deck (same slot, same card ids), same token / board component ids, so
 * anything on the table that points at them keeps working.
 *
 * Owner rulings: nothing is ever placed on the table (Q3 — `game.setup` is never touched); pieces
 * are never merged by looks (Q5 — counts come from the user's "same" links and ×N). Back images
 * that look identical are still stored once, as the slicer does: that is storage, not identity.
 * No SliceJob is written (game.slices is legacy).
 */
import { produce } from 'immer';
import { api } from '@/api/client';
import { canvasToBlob } from '@/lib/pdf';
import { useGame } from '@/state/gameStore';
import type { Asset, AssetRole, BoardComponent, CardDef, CutFrame, CutGroup, CutterDoc, DeckComponent, Game, ID, TokenComponent } from '@/shared/types';
import { DEFAULT_CLEAN, groupSignature } from '@/shared/cutter/doc';
import { finishFor, frameMm, groupSize, joinLayout, pageInfo, planGroup, seamsFor, type MakePlan, type PlannedPiece, type Seam } from '@/shared/cutter/pieces';
import { quadSize } from '@/shared/cutter/geom';
import { newId } from '@/shared/ids';
import { openPageSource, type PageSource, type RenderFrameOpts, type RenderPath } from './pageSource';
import { presetOf } from './sizes';

/* ------------------------------------------------------------------ */
/* environment                                                          */
/* ------------------------------------------------------------------ */

/** Where make reads and writes the game. The app uses the editor store; tests can use their own. */
export interface MakeEnv {
  getGame(): Game;
  /** Apply a change to the game (and save it). */
  update(recipe: (g: Game) => void, label: string): void;
  /** Merge uploaded assets into the local game. */
  addAssets(assets: Asset[]): void;
  /** Forget assets deleted on the server. */
  removeAssets?(ids: ID[]): void;
}

/** The editor's game store (undo + autosave). */
export function storeEnv(): MakeEnv {
  return {
    getGame: () => {
      const g = useGame.getState().game;
      if (!g) throw new Error('No game is open.');
      return g;
    },
    update: (recipe, label) => useGame.getState().update((d) => void recipe(d as Game), label),
    addAssets: (a) => useGame.getState().addAssets(a),
    removeAssets: (ids) => useGame.getState().removeAssetsLocal(ids),
  };
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}
export interface CancelToken {
  cancelled: boolean;
}
export interface Progress {
  value: number;
  label: string;
}
const check = (c?: CancelToken) => {
  if (c?.cancelled) throw new CancelledError();
};

export interface MakeOptions {
  env: MakeEnv;
  doc: CutterDoc;
  groupId: ID;
  onProgress?: (p: Progress) => void;
  cancel?: CancelToken;
  /** "Make a separate copy instead": ignore what the group made before (and don't replace it). */
  separate?: boolean;
}

export interface MakeResult {
  /** The cutter document with the group's `made` updated (save it). */
  doc: CutterDoc;
  group: CutGroup;
  componentId: ID | null;
  /** Deck cards / tokens / boards written, in order. */
  pieceIds: ID[];
  /** true when an earlier make was replaced in place. */
  updated: boolean;
  /** Copies in all (cards incl. counts, tokens incl. ×N). */
  total: number;
  assets: Asset[];
  /** How each frame was rendered. */
  paths: Record<RenderPath, number>;
  plan: MakePlan;
  previews: { url: string; aspect: number }[];
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * Storing identical backs once (storage, not identity): two rendered backs are the same image only
 * when they are TRUE duplicates — the same artwork, differing by nothing more than rendering or
 * JPEG noise. Compared on a 64 × 64 area-averaged print: every cell within `BACK_MAX` and the
 * average within `BACK_MEAN` (0–255). A different colour, or a small emblem a few mm across,
 * breaks it; subpixel offsets and compression don't (see .notes/v3.md, stage 3, for the measurements).
 */
const BACK_FP = 64;
export const BACK_MAX = 20;
export const BACK_MEAN = 1.2;
export function backPrint(canvas: HTMLCanvasElement): Uint8ClampedArray {
  // two halving steps first so the 64 × 64 print is a true area average
  let src: HTMLCanvasElement = canvas;
  while (src.width > BACK_FP * 4 && src.height > BACK_FP * 4) {
    const h = document.createElement('canvas');
    h.width = Math.round(src.width / 2);
    h.height = Math.round(src.height / 2);
    const x = h.getContext('2d')!;
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, h.width, h.height);
    if (src !== canvas) src.width = src.height = 0;
    src = h;
  }
  const c = document.createElement('canvas');
  c.width = c.height = BACK_FP;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, BACK_FP, BACK_FP);
  if (src !== canvas) src.width = src.height = 0;
  return ctx.getImageData(0, 0, BACK_FP, BACK_FP).data;
}
/** Largest and mean channel difference between two prints. */
export function backDistance(a: Uint8ClampedArray, b: Uint8ClampedArray): { max: number; mean: number } {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      sum += d;
      if (d > max) max = d;
    }
  return { max, mean: sum / (BACK_FP * BACK_FP * 3) };
}
export function sameBack(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  const d = backDistance(a, b);
  return d.max <= BACK_MAX && d.mean <= BACK_MEAN;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'piece';
const round1 = (v: number) => Math.round(v * 10) / 10;

async function upload(gameId: ID, items: { blob: Blob; name: string }[], role: AssetRole, onFrac: (f: number) => void, cancel: CancelToken | undefined, sink: Asset[]): Promise<Asset[]> {
  const total = items.reduce((n, i) => n + i.blob.size, 0) || 1;
  let done = 0;
  const out: Asset[] = [];
  for (let i = 0; i < items.length; i += 10) {
    check(cancel);
    const batch = items.slice(i, i + 10);
    const bytes = batch.reduce((n, b) => n + b.blob.size, 0);
    const res = await api.uploadAssets(gameId, batch, { role, onProgress: (p) => onFrac((done + p * bytes) / total) });
    sink.push(...res);
    out.push(...res);
    done += bytes;
    onFrac(done / total);
  }
  return out;
}

/** The images the pieces of an earlier make use (fronts, backs, the deck back, boards, the cover). */
function imagesOf(g: Game, made: CutGroup['made']): ID[] {
  if (!made) return [];
  const out = new Set<ID>();
  const ids = new Set(made.pieceIds);
  for (const c of g.components) {
    if (c.kind === 'deck' && c.id === made.componentId) {
      for (const card of c.cards) if (ids.has(card.id)) [card.front, card.back].forEach((a) => a && out.add(a));
      if (c.back) out.add(c.back);
    } else if (c.kind === 'tokens' && ids.has(c.id)) [c.front, c.back].forEach((a) => a && out.add(a));
    else if (c.kind === 'board' && ids.has(c.id) && c.image) out.add(c.image);
  }
  return [...out];
}

/** The earlier piece a planned piece replaces: by its frames when known, else by position. */
function previousFor(previous: CutGroup['made'], plan: MakePlan): (ID | undefined)[] {
  if (!previous) return plan.pieces.map(() => undefined);
  const used = new Set<ID>();
  const take = (id: ID | undefined) => (id && !used.has(id) ? (used.add(id), id) : undefined);
  if (previous.byFrame) {
    const byFrame = previous.byFrame;
    return plan.pieces.map((p) => take(p.frames.map((f) => byFrame[f.id]).find((id) => id && !used.has(id))));
  }
  return plan.pieces.map((_, i) => take(previous.pieceIds[i]));
}

/** Components still referenced by the table setup (never removed by a remake). */
function onTable(g: Game, id: ID): boolean {
  return Object.values(g.setup.entities).some((e) => 'componentId' in e && e.componentId === id);
}

/* ------------------------------------------------------------------ */
/* make                                                                 */
/* ------------------------------------------------------------------ */

export async function makeGroup(o: MakeOptions): Promise<MakeResult> {
  const { env, cancel } = o;
  const progress = o.onProgress ?? (() => undefined);
  const game = env.getGame();
  const found = o.doc.groups.find((g) => g.id === o.groupId);
  if (!found) throw new Error('That group no longer exists.');
  // a separate copy is a one-off: its own name, and the group stays linked to what it made before
  const group: CutGroup = o.separate ? { ...found, name: `${found.name} (copy)`, out: { ...found.out, target: 'new', deckId: null } } : found;
  const previous = o.separate ? undefined : group.made;

  /* page sources for every page the group touches */
  const frames = Object.values(o.doc.frames).filter((f) => f.groupId === group.id || f.id === group.backs.sharedFrameId || Object.values(group.backs.pairs).includes(f.id));
  const sourceIds = [...new Set(frames.map((f) => f.at.sourceId))];
  const ps = new Map<ID, PageSource>();
  for (const sid of sourceIds) {
    const s = game.sources.find((x) => x.id === sid);
    if (s) ps.set(sid, await openPageSource(game, s));
  }
  const src = (f: CutFrame) => {
    const s = ps.get(f.at.sourceId);
    if (!s) throw new Error('A frame is on a file that was removed.');
    return s;
  };

  /* empty spaces (flat pages whose grid skips them) */
  progress({ value: 0.01, label: 'Checking the pages…' });
  const blank = new Set<ID>();
  for (const f of frames) {
    const g = f.gridId ? o.doc.grids[f.gridId] : undefined;
    if (f.groupId !== group.id || f.side !== 'front' || f.excluded || f.keep || !g?.skipBlank) continue;
    const s = ps.get(f.at.sourceId);
    if (s && !s.isPhoto(f.at.page) && (await s.isBlank(f.at.page, f.quad, group.trimMm))) blank.add(f.id);
  }
  const plan = planGroup(o.doc, group, game.sources, { isBlank: (f) => blank.has(f.id) });
  if (plan.blockers.length) throw new Error(plan.blockers[0]);

  const paths: Record<RenderPath, number> = { crop: 0, warp: 0, photo: 0 };
  // each frame gets the finish of its own medium (a deck can mix a PDF and photos)
  const finish = (f: CutFrame) => finishFor(group, !!pageInfo(game.sources, f.at)?.photo);
  const cleanFor = (f: CutFrame, mm: { w: number; h: number }) => {
    const c = o.doc.clean[f.at.sourceId] ?? DEFAULT_CLEAN;
    // as photo import: corners never more than a quarter of the short side
    return { color: c.color, flatten: c.flatten, cornerMm: Math.min(finish(f).cornerMm, Math.min(mm.w, mm.h) / 4) };
  };
  const render = async (f: CutFrame, mm: { w: number; h: number }, trimMm = finish(f).trimMm) => {
    const r = await src(f).renderFrame({ page: f.at.page, quad: f.quad, mm, trimMm, dpi: group.out.dpi, clean: cleanFor(f, mm) });
    paths[r.path]++;
    return r.canvas;
  };
  const gsize = groupSize(o.doc, group, game.sources);
  const infoMm = (f: CutFrame) => frameMm(f, group, pageInfo(game.sources, f.at), gsize) ?? plan.pieces[0]?.mm ?? { w: 0, h: 0 };

  const uploaded: Asset[] = [];
  try {
    /* ---------------- render ---------------- */
    const RENDER = 0.7;
    const backFrames = [...new Map(plan.pieces.flatMap((p) => (p.back && 'frame' in p.back ? [[p.back.frame.id, p.back.frame] as const] : []))).values()];
    const steps = plan.pieces.length + backFrames.length || 1;
    let done = 0;
    const noun = group.kind === 'cards' ? 'card' : group.kind === 'tokens' ? 'token' : group.kind === 'board' ? 'board' : 'piece';
    const fronts: { blob: Blob; aspect: number }[] = [];
    for (let i = 0; i < plan.pieces.length; i++) {
      check(cancel);
      progress({ value: (done / steps) * RENDER, label: `Cutting ${noun} ${i + 1} of ${plan.pieces.length}…` });
      const p = plan.pieces[i];
      let c: HTMLCanvasElement;
      if (p.frames.length > 1 && group.join) {
        const j = await renderJoined(p, group, src, paths, gsize, seamsFor(o.doc, group, p.frames), undefined, (f) => {
          const c = o.doc.clean[f.at.sourceId] ?? DEFAULT_CLEAN;
          return { color: c.color, flatten: c.flatten, cornerMm: 0 };
        });
        c = j.canvas;
        p.mm = { w: j.W, h: j.H };
      } else c = await render(p.frames[0], p.mm);
      fronts.push({ blob: await canvasToBlob(c, 'image/webp', 0.92), aspect: c.width / c.height });
      c.width = c.height = 0;
      done++;
    }
    const backGroups: { blob: Blob; fp: Uint8ClampedArray; frameIds: ID[] }[] = [];
    for (const bf of backFrames) {
      check(cancel);
      progress({ value: (done / steps) * RENDER, label: 'Cutting the backs…' });
      const c = await render(bf, infoMm(bf));
      const fp = backPrint(c);
      const hit = backGroups.find((g) => sameBack(g.fp, fp));
      if (hit) hit.frameIds.push(bf.id);
      else backGroups.push({ blob: await canvasToBlob(c, 'image/webp', 0.92), fp, frameIds: [bf.id] });
      c.width = c.height = 0;
      done++;
    }

    /* ---------------- upload ---------------- */
    const base = slug(group.name);
    const role: AssetRole = group.kind === 'cards' || group.kind === 'back' ? 'card' : group.kind === 'cover' ? 'cover' : 'image';
    const items = [
      ...fronts.map((f, i) => ({ blob: f.blob, name: `${base}-${i + 1}.webp` })),
      ...backGroups.map((g, i) => ({ blob: g.blob, name: `${base}-back-${i + 1}.webp` })),
    ];
    const assets = await upload(game.id, items, role, (f) => progress({ value: RENDER + f * 0.27, label: `Uploading images… ${Math.round(f * 100)}%` }), cancel, uploaded);
    check(cancel);
    progress({ value: 0.98, label: 'Saving…' });
    env.addAssets(assets);
    const frontAssets = assets.slice(0, fronts.length);
    const backAssets = assets.slice(fronts.length);
    const backAsset = (p: PlannedPiece): ID | null => {
      if (!p.back) return null;
      if ('assetId' in p.back) return p.back.assetId;
      const bf = p.back.frame;
      const gi = backGroups.findIndex((g) => g.frameIds.includes(bf.id));
      return gi >= 0 ? backAssets[gi].id : null;
    };

    /* ---------------- write the component ---------------- */
    const oldImages = previous ? imagesOf(env.getGame(), previous) : [];
    const written = writeComponent(env, group, plan, frontAssets.map((a) => a.id), plan.pieces.map(backAsset), previous, gsize);
    // an update replaces the images: the ones nothing uses any more are deleted
    if (oldImages.length) {
      const g = env.getGame();
      const inUse = JSON.stringify({ ...g, assets: null });
      const gone = oldImages.filter((id) => !inUse.includes(id) && !assets.some((a) => a.id === id));
      if (gone.length) {
        await api.deleteAssets(game.id, gone).catch(() => undefined);
        env.removeAssets?.(gone);
      }
    }
    const now = Date.now();
    const byFrame = Object.fromEntries(plan.pieces.map((p, i) => [p.frames[0].id, written.pieceIds[i]]).filter(([, id]) => !!id));
    const doc = produce(o.doc, (d) => {
      const g = d.groups.find((x) => x.id === group.id)!;
      g.made = { componentId: written.componentId, pieceIds: written.pieceIds, at: now, signature: '', byFrame };
    });
    const signed = produce(doc, (d) => {
      d.groups.find((x) => x.id === group.id)!.made!.signature = groupSignature(doc, group.id);
    });
    return {
      doc: signed,
      group: signed.groups.find((x) => x.id === group.id)!,
      componentId: written.componentId,
      pieceIds: written.pieceIds,
      updated: written.updated,
      total: plan.pieces.reduce((n, p) => n + p.count, 0),
      assets,
      paths,
      plan,
      previews: fronts.slice(0, 8).map((f) => ({ url: URL.createObjectURL(f.blob), aspect: f.aspect })),
    };
  } catch (e) {
    if (uploaded.length) await api.deleteAssets(game.id, uploaded.map((a) => a.id)).catch(() => undefined);
    throw e;
  }
}

/**
 * The size (mm) each part of a joined board is laid out at. Flat parts: their own mm. Photo parts
 * (Q6, manual overlap/shift only) have no mm of their own: they take the board's height across a
 * side-by-side join (its width for top-to-bottom), plus the bleed, at the frame's proportions.
 */
export function joinPartSizes(frames: CutFrame[], group: CutGroup, src: (f: CutFrame) => PageSource, size: { w: number; h: number } | null, seams: Seam[]): { w: number; h: number }[] {
  const join = group.join!;
  const horiz = join.dir === 'h';
  const photo = frames.map((f) => src(f).mmPerUnit(f.at.page) == null);
  const out = frames.map((f, i) => {
    const q = quadSize(f.quad);
    const k = src(f).mmPerUnit(f.at.page);
    if (!photo[i]) return { w: q.w * k!, h: q.h * k! };
    const aspect = q.w / Math.max(1, q.h);
    if (!size) return { w: 100 * aspect, h: 100 };
    return horiz ? { w: (size.h + 2 * join.bleed) * aspect, h: size.h + 2 * join.bleed } : { w: size.w + 2 * join.bleed, h: (size.w + 2 * join.bleed) / aspect };
  });
  // a photo's pixels don't give its parts' true proportions (perspective): when every part is a photo,
  // share the board's length out between them in their photographed proportions
  if (size && photo.every(Boolean)) {
    const along = (p: { w: number; h: number }) => (horiz ? p.w : p.h);
    const overlaps = seams.reduce((n, j) => n + j.overlap, 0);
    const target = (horiz ? size.w : size.h) + 2 * join.bleed + overlaps;
    const k = target / Math.max(1, out.reduce((n, p) => n + along(p), 0));
    for (const p of out) horiz ? (p.w *= k) : (p.h *= k);
  }
  return out;
}

/** A board joined from several frames (the slicer's "Join pages"): flat pages, or photos with a size. */
export async function renderJoined(p: Pick<PlannedPiece, 'frames'>, group: CutGroup, src: (f: CutFrame) => PageSource, paths: Record<RenderPath, number>, size: { w: number; h: number } | null, seams: Seam[], maxDpi?: number, cleanOf?: (f: CutFrame) => RenderFrameOpts['clean']): Promise<{ canvas: HTMLCanvasElement; W: number; H: number; pos: { x: number; y: number; w: number; h: number }[] }> {
  const join = group.join!;
  const sizes = joinPartSizes(p.frames, group, src, size, seams);
  const { pos, W, H } = joinLayout(sizes, { ...join, joins: seams });
  // keep the bitmap within what browsers handle comfortably
  let dpi = maxDpi ?? group.out.dpi;
  while ((W / 25.4) * dpi * ((H / 25.4) * dpi) > 60_000_000 && dpi > 100) dpi -= 25;
  const k = dpi / 25.4;
  const out = document.createElement('canvas');
  out.width = Math.round(W * k);
  out.height = Math.round(H * k);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  for (let i = 0; i < p.frames.length; i++) {
    const f = p.frames[i];
    const r = await src(f).renderFrame({ page: f.at.page, quad: f.quad, mm: sizes[i], trimMm: 0, dpi, clean: src(f).isPhoto(f.at.page) ? cleanOf?.(f) : undefined });
    paths[r.path]++;
    // snap both ends to the same integer grid so neighbouring parts share an edge pixel
    const x0 = Math.round(pos[i].x * k);
    const y0 = Math.round(pos[i].y * k);
    const x1 = Math.round((pos[i].x + pos[i].w) * k);
    const y1 = Math.round((pos[i].y + pos[i].h) * k);
    ctx.drawImage(r.canvas, x0, y0, x1 - x0, y1 - y0);
    r.canvas.width = r.canvas.height = 0;
    // a printed cut line on an edge that meets the next part: paint it over with the artwork beside it
    const horiz = join.dir === 'h';
    const aMm = seams[i]?.line?.a ?? 0;
    const bMm = i > 0 ? (seams[i - 1]?.line?.b ?? 0) : 0;
    if (aMm > 0) {
      const w = Math.max(1, Math.ceil(aMm * k));
      if (horiz) ctx.drawImage(out, x1 - w - 1, y0, 1, y1 - y0, x1 - w, y0, w, y1 - y0);
      else ctx.drawImage(out, x0, y1 - w - 1, x1 - x0, 1, x0, y1 - w, x1 - x0, w);
    }
    if (bMm > 0) {
      const w = Math.max(1, Math.ceil(bMm * k));
      if (horiz) ctx.drawImage(out, x0 + w, y0, 1, y1 - y0, x0, y0, w, y1 - y0);
      else ctx.drawImage(out, x0, y0 + w, x1 - x0, 1, x0, y0, x1 - x0, w);
    }
  }
  return { canvas: out, W, H, pos };
}


/**
 * Write (or replace in place) what the group makes. Returns the component and piece ids.
 * Never touches the table setup (Q3) or game.slices.
 */
function writeComponent(env: MakeEnv, group: CutGroup, plan: MakePlan, fronts: ID[], backs: (ID | null)[], previous: CutGroup['made'], gsize: { w: number; h: number } | null): { componentId: ID | null; pieceIds: ID[]; updated: boolean } {
  const game = env.getGame();
  const now = Date.now();
  const oldIds = previous?.pieceIds ?? [];
  const reuseIds = previousFor(previous, plan);
  const label = (verb: string) => `${previous ? 'Update' : verb} ${group.name}`;

  if (group.kind === 'cards') {
    const isDeck = (id: ID | null | undefined) => !!id && game.components.some((c) => c.id === id && c.kind === 'deck');
    const deckId = isDeck(previous?.componentId) ? previous!.componentId! : group.out.target === 'existing' && isDeck(group.out.deckId) ? group.out.deckId! : newId();
    const updating = !!previous && previous.componentId === deckId;
    const distinctBacks = [...new Set(backs)];
    const shared = distinctBacks.length === 1 ? distinctBacks[0] : null;
    const pieceIds: ID[] = [];
    // a size read off the page is the preset it matches (within 0.5 mm), as the Size section says
    const raw = gsize ?? plan.pieces[0].mm;
    const snap = !group.size || group.size.from === 'page' ? presetOf(group.kind, raw.w, raw.h) : null;
    const size = snap ? (raw.w <= raw.h === snap.w <= snap.h ? { w: snap.w, h: snap.h } : { w: snap.h, h: snap.w }) : raw;
    env.update((g) => {
      let deck = g.components.find((c) => c.id === deckId) as DeckComponent | undefined;
      const isNew = !deck;
      if (!deck) {
        deck = { id: deckId, kind: 'deck', name: group.name.trim() || 'Deck', createdAt: now, width: size.w, height: size.h, cornerRadius: 3, back: null, backColor: '#2b3a55', cards: [] };
        g.components.push(deck);
        deck = g.components[g.components.length - 1] as DeckComponent;
      } else if (updating) {
        deck.width = size.w;
        deck.height = size.h;
      }
      // replace the cards the last make produced, in their slot
      const old = updating ? deck.cards.filter((c) => oldIds.includes(c.id)) : [];
      let at = deck.cards.length;
      if (old.length) {
        at = deck.cards.findIndex((c) => oldIds.includes(c.id));
        deck.cards = deck.cards.filter((c) => !oldIds.includes(c.id));
      }
      const useDeckBack = shared != null && (isNew || !deck.back || deck.back === shared || updating);
      if (useDeckBack) deck.back = shared;
      const oldById = new Map(old.map((c) => [c.id, c]));
      const cards: CardDef[] = plan.pieces.map((p, i) => {
        // the same card ids as before, so stacks on the table keep their cards
        const rid = reuseIds[i];
        const reuse = rid && oldById.has(rid) ? oldById.get(rid)! : undefined;
        const cd: CardDef = { id: reuse?.id ?? newId(), name: p.name ?? reuse?.name ?? `${deck!.name} ${at + i + 1}`, front: fronts[i], count: p.count };
        if (!useDeckBack && backs[i]) cd.back = backs[i];
        return cd;
      });
      deck.cards.splice(at, 0, ...cards);
      pieceIds.push(...cards.map((c) => c.id));
    }, label(`Make ${plan.pieces.length} cards in`));
    return { componentId: deckId, pieceIds, updated: updating };
  }

  if (group.kind === 'tokens' || group.kind === 'board') {
    const kind = group.kind === 'tokens' ? 'tokens' : 'board';
    const pieceIds: ID[] = [];
    let updated = false;
    env.update((g) => {
      plan.pieces.forEach((p, i) => {
        const prevId = reuseIds[i];
        const existing = prevId ? g.components.find((c) => c.id === prevId && c.kind === kind) : undefined;
        const name = p.name ?? (plan.pieces.length > 1 ? `${group.name} ${i + 1}` : group.name);
        const mm = p.mm;
        if (kind === 'tokens') {
          const shape = group.shape === 'rect' || !group.shape ? (Math.abs(mm.w - mm.h) < 0.5 ? 'square' : 'rect') : group.shape === 'square' && Math.abs(mm.w - mm.h) >= 0.5 ? 'rect' : group.shape;
          const t: TokenComponent = {
            id: existing?.id ?? newId(),
            kind: 'tokens',
            name: p.name ?? (existing?.name || name),
            createdAt: existing?.createdAt ?? now,
            shape,
            width: round1(mm.w),
            height: round1(mm.h),
            front: fronts[i],
            back: backs[i] ?? null,
            color: (existing as TokenComponent | undefined)?.color ?? '#e6b94a',
            count: p.count,
          };
          if (existing) Object.assign(existing, t);
          else g.components.push(t);
          pieceIds.push(t.id);
        } else {
          const b: BoardComponent = {
            id: existing?.id ?? newId(),
            kind: 'board',
            name: p.name ?? (existing?.name || name),
            createdAt: existing?.createdAt ?? now,
            image: fronts[i],
            width: round1(mm.w),
            height: round1(mm.h),
            cornerRadius: (existing as BoardComponent | undefined)?.cornerRadius ?? 2,
          };
          if (existing) Object.assign(existing, b);
          else g.components.push(b);
          pieceIds.push(b.id);
        }
        if (existing) updated = true;
      });
      // pieces the group no longer makes go — unless the table still uses them
      const kept = new Set(pieceIds);
      for (const id of oldIds) if (!kept.has(id) && !onTable(g, id)) g.components = g.components.filter((c) => c.id !== id);
    }, label(kind === 'tokens' ? `Make ${plan.pieces.length} tokens:` : 'Make the board'));
    return { componentId: pieceIds[0] ?? null, pieceIds, updated };
  }

  if (group.kind === 'back') {
    const deckId = group.out.deckId!;
    if (!game.components.some((c) => c.id === deckId && c.kind === 'deck')) throw new Error('Choose the deck this back is for.');
    env.update((g) => {
      const d = g.components.find((c) => c.id === deckId) as DeckComponent | undefined;
      if (d) d.back = fronts[0];
    }, `Set the card back of ${game.components.find((c) => c.id === deckId)?.name ?? 'the deck'}`);
    return { componentId: deckId, pieceIds: [], updated: !!previous };
  }

  env.update((g) => void (g.cover = fronts[0]), 'Set the cover image');
  return { componentId: null, pieceIds: [], updated: !!previous };
}
