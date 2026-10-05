/**
 * What making a group produces, decided without touching a pixel: the pieces in order, how many
 * of each (the user's "same" links and "×N" — never by looks, owner Q5), each piece's back, its
 * finished size, and what still blocks making. Pure; shared by make.ts, scripts and the UI.
 */
import type { CutFrame, CutGroup, CutterDoc, ID, PageRef, SourceDoc } from '../types.js';
import { groupFrames, pieceKey } from './doc.js';
import { axisFrame, isProperQuad, quadSize } from './geom.js';

/** What a page is, for making. */
export interface PageInfo {
  /** A camera photo: no known scale, clean-up applies. */
  photo: boolean;
  /** mm per page unit (1 on PDF/image pages; 25.4 / dpi on a scan in an image set); null on photos. */
  mmPerUnit: number | null;
}

export function pageInfo(sources: SourceDoc[], at: PageRef): PageInfo | null {
  const s = sources.find((x) => x.id === at.sourceId);
  const p = s?.pages[at.page];
  if (!s || !p) return null;
  if (s.kind !== 'images') return { photo: false, mmPerUnit: 1 };
  if (p.photo) return { photo: true, mmPerUnit: null };
  if (p.dpi) return { photo: false, mmPerUnit: 25.4 / p.dpi };
  if (p.px?.w && p.widthMm > 0) return { photo: false, mmPerUnit: p.widthMm / p.px.w };
  return null;
}

export type PieceBack = { frame: CutFrame } | { assetId: ID } | null;

export const PHOTO_TRIM_MM = 0.4;
export const PHOTO_CORNER_MM = 3;

/** The finish of a frame by its medium: flat pages use the group's bleed; photos their own trim + corners. */
export function finishFor(group: CutGroup, photo: boolean): { trimMm: number; cornerMm: number } {
  if (!photo) return { trimMm: group.trimMm, cornerMm: 0 };
  return { trimMm: group.photo?.trimMm ?? PHOTO_TRIM_MM, cornerMm: group.kind === 'tokens' ? 0 : (group.photo?.cornerMm ?? PHOTO_CORNER_MM) };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * The group's size: the one the user set, else the size read from its frames on flat pages (the
 * median, less the bleed). Null only when no member gives a scale (photos only, nothing chosen).
 * Photo frames of the group adopt it.
 */
export function groupSize(doc: CutterDoc, group: CutGroup, sources: SourceDoc[]): { w: number; h: number; from: 'page' | 'preset' | 'typed' | 'measured' } | null {
  if (group.size) return { w: group.size.w, h: group.size.h, from: group.size.from };
  const ms: { w: number; h: number }[] = [];
  for (const f of Object.values(doc.frames)) {
    if (f.groupId !== group.id || f.side !== 'front' || f.excluded) continue;
    const info = pageInfo(sources, f.at);
    if (!info || info.photo || info.mmPerUnit == null) continue;
    const q = quadSize(f.quad);
    ms.push({ w: q.w * info.mmPerUnit - 2 * group.trimMm, h: q.h * info.mmPerUnit - 2 * group.trimMm });
  }
  if (!ms.length) return null;
  return { w: Math.round(median(ms.map((m) => m.w)) * 10) / 10, h: Math.round(median(ms.map((m) => m.h)) * 10) / 10, from: 'page' };
}

export interface PlannedPiece {
  /** The frames that are this piece; the first is the one rendered (joined boards: all, in order). */
  frames: CutFrame[];
  /** How many copies the game has (sum of the frames' ×N). */
  count: number;
  back: PieceBack;
  name?: string;
  /** Finished size in mm, as the piece stands upright (after the trim). */
  mm: { w: number; h: number };
}

export interface MakePlan {
  group: CutGroup;
  pieces: PlannedPiece[];
  /** Frames left out because they look empty (flat pages, grid "skip empty spaces"). */
  skipped: CutFrame[];
  /** Why the group can't be made yet (empty = ready). */
  blockers: string[];
  warnings: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The finished size of a frame's piece in mm. Flat pages: what is printed (the frame's own size
 * less the trim). Photos: the group's size — boards turned to match how the frame lies.
 */
export function frameMm(frame: CutFrame, group: CutGroup, info: PageInfo | null, size: { w: number; h: number } | null = group.size): { w: number; h: number } | null {
  const q = quadSize(frame.quad);
  if (info && !info.photo && info.mmPerUnit != null) {
    // a straight frame is what is printed; a turned or skewed one has the group's size when it has one
    if (group.size && (group.kind === 'cards' || group.kind === 'tokens') && !axisFrame(frame.quad, 1e-4 / info.mmPerUnit)) return { w: group.size.w, h: group.size.h };
    return { w: q.w * info.mmPerUnit - 2 * group.trimMm, h: q.h * info.mmPerUnit - 2 * group.trimMm };
  }
  // photos: the group's size (set, or read from its flat pages)
  if (!size) return null;
  const { w, h } = size;
  if (group.kind === 'cards' || group.kind === 'tokens') return { w, h };
  // boards, backs and covers keep the orientation of the frame
  return q.w >= q.h === w >= h ? { w, h } : { w: h, h: w };
}

export function planGroup(doc: CutterDoc, group: CutGroup, sources: SourceDoc[], opts: { isBlank?: (f: CutFrame) => boolean } = {}): MakePlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const skipped: CutFrame[] = [];
  const all = groupFrames(doc, group);
  const info = (f: CutFrame) => pageInfo(sources, f.at);

  const missing = all.filter((f) => !info(f));
  if (missing.length) blockers.push(`${plural(missing.length, 'frame is', 'frames are')} on a page that no longer exists.`);
  const twisted = all.filter((f) => !f.excluded && !isProperQuad(f.quad));
  if (twisted.length) blockers.push(`${plural(twisted.length, 'frame is', 'frames are')} twisted — fix ${twisted.length === 1 ? 'it' : 'them'} first.`);

  let fronts = all.filter((f) => f.side === 'front' && !f.excluded && info(f));
  fronts = fronts.filter((f) => {
    const g = f.gridId ? doc.grids[f.gridId] : undefined;
    const skip = !!g?.skipBlank && !f.keep && !info(f)!.photo && !!opts.isBlank?.(f);
    if (skip) skipped.push(f);
    return !skip;
  });
  if (!fronts.length) blockers.push(all.some((f) => f.side === 'front') ? 'Every piece is left out.' : 'There are no pieces to make yet.');

  const photoFrames = fronts.some((f) => info(f)?.photo);
  const size = groupSize(doc, group, sources);
  if (photoFrames && !size) blockers.push('Set the size first.');

  /* backs */
  const backOf = (f: CutFrame): PieceBack => {
    const b = group.backs;
    if (group.kind !== 'cards' && group.kind !== 'tokens') return null;
    if (b.mode === 'same') {
      if (b.assetId) return { assetId: b.assetId };
      const bf = b.sharedFrameId ? doc.frames[b.sharedFrameId] : undefined;
      return bf ? { frame: bf } : null;
    }
    if (b.mode === 'each') {
      const id = b.pairs[f.id];
      const bf = id ? doc.frames[id] : undefined;
      return bf && !bf.excluded ? { frame: bf } : null;
    }
    return null;
  };
  if ((group.kind === 'cards' || group.kind === 'tokens') && group.backs.mode === 'same' && !group.backs.assetId && !(group.backs.sharedFrameId && doc.frames[group.backs.sharedFrameId]))
    blockers.push('Choose which piece shows the back.');
  if (group.kind === 'back' && !group.out.deckId) blockers.push('Choose the deck this back is for.');

  /* pieces */
  const pieces: PlannedPiece[] = [];
  const mmOf = (f: CutFrame) => frameMm(f, group, info(f), size) ?? { w: 0, h: 0 };
  if (group.kind === 'cards' || group.kind === 'tokens') {
    const byKey = new Map<string, CutFrame[]>();
    for (const f of fronts) byKey.set(pieceKey(f), [...(byKey.get(pieceKey(f)) ?? []), f]);
    for (const frames of byKey.values()) {
      pieces.push({
        frames,
        count: frames.reduce((n, f) => n + Math.max(1, Math.round(f.copies ?? 1)), 0),
        back: backOf(frames[0]),
        name: frames.find((f) => f.name)?.name,
        mm: mmOf(frames[0]),
      });
    }
    if (group.backs.mode === 'each') {
      const without = pieces.filter((p) => !p.back).length;
      if (without) warnings.push(`${plural(without, 'piece has', 'pieces have')} no back and will use the deck’s plain back colour.`);
    }
  } else if (group.kind === 'board' && group.join && fronts.length >= 2) {
    pieces.push({ frames: fronts, count: 1, back: null, name: group.name, mm: { w: 0, h: 0 } });
  } else if (group.kind === 'board') {
    for (const f of fronts) pieces.push({ frames: [f], count: 1, back: null, name: f.name, mm: mmOf(f) });
  } else if (fronts.length) {
    pieces.push({ frames: [fronts[0]], count: 1, back: null, name: fronts[0].name, mm: mmOf(fronts[0]) });
    if (fronts.length > 1) warnings.push(`Only the first frame is used for a ${group.kind === 'cover' ? 'cover' : 'card back'}.`);
  }
  if (pieces.some((p) => p.frames.length === 1 && (p.mm.w <= 0 || p.mm.h <= 0)) && !blockers.length) blockers.push('A piece is smaller than its trim.');
  return { group, pieces, skipped, blockers, warnings };
}

export type Seam = NonNullable<CutGroup['join']>['joins'][number] & { key: string };

/** The parts of a joined board: the group's front frames, in the group's order. */
export function joinParts(doc: CutterDoc, group: CutGroup): CutFrame[] {
  return groupFrames(doc, group).filter((f) => f.side === 'front' && !f.excluded);
}

/**
 * The seams of a joined board, derived from the parts as they are now: one per neighbouring pair,
 * keyed by that pair. What the user set for a pair that still exists is kept; a pair that is new
 * starts from the overlap of the seam before it (or 0) and is marked `pending`; a pair that is gone
 * takes its seam with it. Nothing here depends on the stored order or length, so no seam can go
 * stale or linger.
 */
export function seamsFor(doc: CutterDoc, group: CutGroup, parts = joinParts(doc, group)): Seam[] {
  const stored = group.join?.joins ?? [];
  const byKey = new Map(stored.filter((j) => j.key).map((j) => [j.key!, j]));
  const out: Seam[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const key = `${parts[i].id}>${parts[i + 1].id}`;
    // documents written before seams were keyed: fall back to the seam in that position
    const old = byKey.get(key) ?? (stored.length === parts.length - 1 && !stored.some((j) => j.key) ? stored[i] : undefined);
    if (old) out.push({ ...old, key, pending: old.pending });
    else out.push({ key, overlap: out[out.length - 1]?.overlap ?? 0, shift: 0, auto: false, pending: true });
  }
  return out;
}

/**
 * Where each part of a joined board lands (mm) and the board's size — the slicer's stitchLayout:
 * each part overlaps the previous by `overlap` and is shifted across by `shift`; the printed
 * `bleed` comes off the outside of the assembled board.
 */
export function joinLayout(parts: { w: number; h: number }[], join: { dir: 'h' | 'v'; joins: { overlap: number; shift: number }[]; bleed: number }) {
  const pos: { x: number; y: number; w: number; h: number }[] = [];
  parts.forEach((p, i) => {
    if (i === 0) return void pos.push({ x: 0, y: 0, w: p.w, h: p.h });
    const prev = pos[i - 1];
    const j = join.joins[i - 1] ?? { overlap: 0, shift: 0 };
    if (join.dir === 'h') pos.push({ x: prev.x + prev.w - j.overlap, y: prev.y + j.shift, w: p.w, h: p.h });
    else pos.push({ x: prev.x + j.shift, y: prev.y + prev.h - j.overlap, w: p.w, h: p.h });
  });
  const minX = Math.min(0, ...pos.map((p) => p.x));
  const minY = Math.min(0, ...pos.map((p) => p.y));
  for (const p of pos) {
    p.x -= minX;
    p.y -= minY;
  }
  const W = Math.max(0, ...pos.map((p) => p.x + p.w));
  const H = Math.max(0, ...pos.map((p) => p.y + p.h));
  const b = Math.max(0, Math.min(join.bleed ?? 0, (Math.min(W, H) - 1) / 2));
  for (const p of pos) {
    p.x -= b;
    p.y -= b;
  }
  return { pos, W: W - 2 * b, H: H - 2 * b, bleed: b };
}
