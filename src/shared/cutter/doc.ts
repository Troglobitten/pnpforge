/**
 * The cutter document: defaults, units, validation, and the signature that tells whether a group
 * changed since it was made. Pure; shared by server, scripts and client.
 */
import type { CutClean, CutFrame, CutGroup, CutterDoc, ID, SourceDoc, SourcePage } from '../types.js';

export const CUTTER_VERSION = 2 as const;

export function emptyCutter(): CutterDoc {
  return { version: CUTTER_VERSION, grids: {}, frames: {}, groups: [], clean: {} };
}

/** "Look like a scan" defaults (the photo import's). Trim 0.4 mm and corners 3 mm live on the group. */
export const DEFAULT_CLEAN: CutClean = { color: 1, flatten: 0.7 };
export const DEFAULT_PHOTO_TRIM_MM = 0.4;
export const DEFAULT_PHOTO_CORNER_MM = 3;

/** The unit of frame coordinates on this source's pages (see CutPt). */
export function pageUnits(source: Pick<SourceDoc, 'kind'>): 'mm' | 'px' {
  return source.kind === 'images' ? 'px' : 'mm';
}

/** Is this page a camera photo (perspective, clean-up, no known scale, never auto helpers)? */
export const isPhotoPage = (source: Pick<SourceDoc, 'kind'>, page: Pick<SourcePage, 'photo'> | undefined) => source.kind === 'images' && !!page?.photo;

/** The page's real size in mm, or null when it has no known scale (a photo). */
export function pageMm(source: Pick<SourceDoc, 'kind'>, page: SourcePage): { w: number; h: number } | null {
  if (source.kind !== 'images') return { w: page.widthMm, h: page.heightMm };
  if (page.photo) return null;
  if (page.px && page.dpi) return { w: (page.px.w / page.dpi) * 25.4, h: (page.px.h / page.dpi) * 25.4 };
  return page.widthMm > 0 && page.heightMm > 0 ? { w: page.widthMm, h: page.heightMm } : null;
}

/** Frames with the same key are one piece (made once, with a count). */
export const pieceKey = (f: Pick<CutFrame, 'id' | 'same'>) => f.same ?? f.id;

/** A group's frames: first in `order`, then the rest in reading order (page, then cell / id). */
export function groupFrames(doc: Pick<CutterDoc, 'frames'>, group: Pick<CutGroup, 'id' | 'order'>): CutFrame[] {
  const all = Object.values(doc.frames).filter((f) => f.groupId === group.id);
  const inOrder = group.order.map((id) => doc.frames[id]).filter((f): f is CutFrame => !!f && f.groupId === group.id);
  const seen = new Set(inOrder.map((f) => f.id));
  const rest = all
    .filter((f) => !seen.has(f.id))
    .sort((a, b) => a.at.sourceId.localeCompare(b.at.sourceId) || a.at.page - b.at.page || (a.cell ?? 1e9) - (b.cell ?? 1e9) || a.id.localeCompare(b.id));
  return [...inOrder, ...rest];
}

/* ------------------------------------------------------------------ */
/* Signature                                                            */
/* ------------------------------------------------------------------ */

/** cyrb53: a fast, well-mixed 53-bit string hash (hex). */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** JSON with sorted keys and numbers rounded to 1e-4, so equal states give equal strings. */
export function canonical(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : 'null';
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * Everything that decides what making this group produces: the group's settings, its frames,
 * their grids, and the clean-up of the sources they are on. `made`, `origin` and view state are
 * left out. Compare with `made.signature` to show "Changed · Update".
 */
export function groupSignature(doc: CutterDoc, groupId: ID): string {
  const g = doc.groups.find((x) => x.id === groupId);
  if (!g) return '';
  // what the pieces look like — not the bookkeeping (made, origin), the group's colour in the Cutter,
  // or the "pairs look right" mark
  const { made: _m, origin: _o, color: _c, ...rest } = g;
  const { checked: _k, ...backs } = rest.backs;
  const settings = { ...rest, backs };
  const frames = Object.values(doc.frames)
    .filter((f) => f.groupId === groupId || f.id === g.backs.sharedFrameId || Object.values(g.backs.pairs).includes(f.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const gridIds = [...new Set(frames.map((f) => f.gridId).filter((x): x is ID => !!x))].sort();
  const grids = gridIds.map((id) => {
    const gr = doc.grids[id];
    if (!gr) return null;
    const { fitted: _f, groupId: _g, ...geom } = gr;
    return geom;
  });
  const sources = [...new Set(frames.map((f) => f.at.sourceId))].sort();
  const clean = sources.map((s) => doc.clean[s] ?? null);
  return hash53(canonical({ settings, frames, grids, clean }));
}

/* ------------------------------------------------------------------ */
/* Validation (server side, on PUT)                                     */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown) => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isQuad = (v: unknown) => Array.isArray(v) && v.length === 4 && v.every(isPt);
const isRef = (v: unknown) => isObj(v) && typeof v.sourceId === 'string' && isNum(v.page);
const KINDS = ['cards', 'tokens', 'board', 'back', 'cover'];

/** Problems with a document as received (empty = fine). Checks structure, not meaning. */
export function validateCutterDoc(doc: unknown): string[] {
  const errs: string[] = [];
  const err = (s: string) => errs.length < 20 && errs.push(s);
  if (!isObj(doc)) return ['The cutter state must be an object.'];
  if (doc.version !== CUTTER_VERSION) err(`version must be ${CUTTER_VERSION}`);
  if (!isObj(doc.grids)) err('grids must be an object');
  else
    for (const [id, g] of Object.entries(doc.grids)) {
      if (!isObj(g) || g.id !== id) {
        err(`grid ${id}: missing or wrong id`);
        continue;
      }
      if (!isRef(g.at)) err(`grid ${id}: at`);
      if (!isQuad(g.anchors)) err(`grid ${id}: anchors`);
      if (!isNum(g.rows) || !isNum(g.cols) || g.rows < 1 || g.cols < 1) err(`grid ${id}: rows/cols`);
      if (!isNum(g.gapX) || !isNum(g.gapY) || !isNum(g.cellAspect) || !isNum(g.turn)) err(`grid ${id}: numbers`);
      if (!Array.isArray(g.removed)) err(`grid ${id}: removed`);
    }
  if (!isObj(doc.frames)) err('frames must be an object');
  else
    for (const [id, f] of Object.entries(doc.frames)) {
      if (!isObj(f) || f.id !== id) {
        err(`frame ${id}: missing or wrong id`);
        continue;
      }
      if (!isRef(f.at)) err(`frame ${id}: at`);
      if (!isQuad(f.quad)) err(`frame ${id}: quad`);
      if (typeof f.groupId !== 'string') err(`frame ${id}: groupId`);
      if (f.side !== 'front' && f.side !== 'back') err(`frame ${id}: side`);
    }
  if (!Array.isArray(doc.groups)) err('groups must be an array');
  else
    doc.groups.forEach((g, i) => {
      if (!isObj(g) || typeof g.id !== 'string') return err(`group #${i}: id`);
      if (!KINDS.includes(g.kind as string)) err(`group ${g.id}: kind`);
      if (!Array.isArray(g.order)) err(`group ${g.id}: order`);
      if (!isObj(g.backs) || !isObj((g.backs as Record<string, unknown>).pairs)) err(`group ${g.id}: backs`);
      if (!isObj(g.out)) err(`group ${g.id}: out`);
    });
  if (!isObj(doc.clean)) err('clean must be an object');
  return errs;
}

/** What the pairs are now (for "checked before making"). */
export function pairsSignature(g: CutGroup): string {
  return JSON.stringify([g.backs.mode, g.backs.sharedFrameId ?? null, g.backs.assetId ?? null, Object.entries(g.backs.pairs).sort()]);
}
