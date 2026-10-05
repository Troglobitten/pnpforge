/**
 * Pure migration of the two old cutters' saved work into one CutterDoc (v3 stage 1).
 *
 * Inputs (all read-only):
 *  - `game.slices`: SliceJobs of the PDF slicer (grid / single / stitch) and of photo import
 *    (sourceId 'photos');
 *  - `photo-draft.json` (version 1, both the old auto-detect format and the grid format);
 *  - the PDF slicer's per-browser localStorage drafts `pnpforge.slicer.<gameId>:<sourceId>`
 *    (owner Q7: imported once, at switch-over, as unmade groups — only when they hold work the
 *    last cut does not).
 *
 * Output: the CutterDoc, the new image-set source for the photos, the SliceJob sourceId rewrites
 * and a report that lists every record and every field as mapped / retired / dropped (with the
 * reason) / unmapped. Deterministic: ids of new things are hashes of where they came from, so the
 * same input gives the same document, and passing the result back as `existing` adds nothing.
 * Nothing here touches the disk; applying the result is stage 8.
 */
import type {
  Asset,
  BackFlip,
  CutBacks,
  CutFrame,
  CutGrid,
  CutGroup,
  CutKind,
  CutOrigin,
  CutQuad,
  CutSize,
  CutterDoc,
  Game,
  ID,
  SliceJob,
  SourceDoc,
  SourcePage,
  TokenShape,
} from '../types.js';
import { CARD_PRESETS } from '../types.js';
import { CUTTER_VERSION, DEFAULT_CLEAN, DEFAULT_PHOTO_CORNER_MM, DEFAULT_PHOTO_TRIM_MM, canonical, emptyCutter, groupSignature, hash53, pairsSignature } from './doc.js';
import { rectQuad } from './geom.js';
import { mirrorAxis, mirrorCell, rectGrid } from './grid.js';

/* ------------------------------------------------------------------ */
/* Legacy shapes (read-only descriptions of what is on disk)            */
/* ------------------------------------------------------------------ */

/** The slicer's GridLayout (page mm): the outer box of a cell includes the bleed. */
export interface LegacyLayout {
  x: number;
  y: number;
  cols: number;
  rows: number;
  cardW: number;
  cardH: number;
  bleed: number;
  gapX: number;
  gapY: number;
}
interface LegacyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type LegacySharedBack = { kind: 'region'; page: number; rect: LegacyRect } | { kind: 'asset'; assetId: ID };
export interface LegacyGridConfig {
  templates: Record<string, LegacyLayout>;
  overrides: Record<string, LegacyLayout>;
  excluded: Record<string, number[]>;
  included: Record<string, number[]>;
  autoSkipBlank: boolean;
  pages: number[];
  scope: string;
  backs: { mode: 'none' | 'shared' | 'duplex' | 'page'; flip: BackFlip; shared: LegacySharedBack | null; backPage: number | null };
  backAdjust: { dx: number; dy: number };
  preset: string;
  shape: TokenShape;
}
interface LegacyOut {
  target: 'new' | 'existing';
  name: string;
  deckId: ID | null;
  dpi: number;
  merge: boolean;
  dedupe?: boolean;
  replaceJobId: ID | null;
}
interface LegacySingle {
  rects: Record<string, LegacyRect>;
  target: 'board' | 'back' | 'cover';
  name: string;
  deckId: ID | null;
  dpi: number;
}
interface LegacyStitch {
  parts: { page: number; rect: LegacyRect }[];
  dir: 'h' | 'v';
  joins: { overlap: number; shift: number }[];
  seamAuto?: boolean[];
  seamScore?: number[];
  bleed?: number;
  name: string;
  dpi: number;
}
/** What the PDF slicer persisted to localStorage per `${gameId}:${sourceId}` (PERSIST_KEYS). */
export interface LegacySlicerDraft {
  mode?: 'cards' | 'tokens' | 'single' | 'stitch';
  page?: number;
  cards?: Partial<LegacyGridConfig>;
  tokens?: Partial<LegacyGridConfig>;
  single?: Partial<LegacySingle>;
  stitch?: Partial<LegacyStitch>;
  cardsOut?: Partial<LegacyOut>;
  tokensOut?: Partial<LegacyOut>;
}

/** photo-draft.json, version 1 (fields from every build that wrote it). */
interface LegacyPhotoDraft {
  version: 1;
  updatedAt?: number;
  photos: Record<string, unknown>[];
  items: Record<string, Record<string, unknown>>;
  order: string[];
  groups: Record<string, unknown>[];
  clean?: { color?: number; flatten?: number; trimMm?: number; cornerMm?: number };
  created?: Record<string, { componentId: string | null; title?: string; jobId?: string | null; kind?: string; at?: number }>;
  step?: string;
  userOrdered?: boolean;
  photoId?: string | null;
}

/** Photo import recorded its SliceJobs under this pseudo source id. */
export const LEGACY_PHOTO_SOURCE_ID = 'photos';
/** localStorage key prefix of the PDF slicer's drafts. */
export const LEGACY_SLICER_PREFIX = 'pnpforge.slicer.';

/* ------------------------------------------------------------------ */
/* Input / output                                                       */
/* ------------------------------------------------------------------ */

export interface MigrateInput {
  game: Pick<Game, 'id' | 'name' | 'sources' | 'slices' | 'components'>;
  /** assets.json (optional): lets the report say when a photo's original is missing. */
  assets?: Record<ID, Asset>;
  /** photo-draft.json contents, or null. */
  photoDraft?: unknown;
  /** The PDF slicer's localStorage entries (key with or without the prefix, value parsed or a JSON string). */
  slicerDrafts?: { key: string; value: unknown }[];
  /** An existing cutter.json: records it already absorbed are skipped, its groups are kept. */
  existing?: CutterDoc | null;
  /**
   * Which kinds of record this run may read. The switch-over reads them all; the browser's one-off
   * import of leftover localStorage (owner Q7) passes `['slicer-drafts']`, because SliceJobs on the
   * server are the migration's business and must never be absorbed by a browser opening a game.
   */
  only?: ('slice-jobs' | 'photo-draft' | 'slicer-drafts')[];
  now?: number;
}

export type EntryStatus = 'mapped' | 'retired' | 'dropped' | 'skipped' | 'unmapped';

export interface ReportEntry {
  record: 'slice-job' | 'photo-draft' | 'slicer-draft';
  id: string;
  label: string;
  status: EntryStatus;
  /** Why (for anything but a plain mapping), or what it became. */
  detail: string;
  groups: ID[];
  grids: number;
  frames: number;
  /** Groups that got a `made` link. */
  made: number;
}

export interface FieldAudit {
  /** e.g. "photo-draft.items[].score" */
  field: string;
  status: 'mapped' | 'dropped' | 'unmapped';
  /** Where it went, or why it was dropped. */
  note: string;
  count: number;
}

export interface MigrateReport {
  gameId: ID;
  gameName: string;
  entries: ReportEntry[];
  fields: FieldAudit[];
  /** Things worth knowing that are not failures. */
  notes: string[];
  /** Anything that could not be mapped (the acceptance bar is: empty). */
  unmapped: string[];
}

export interface MigrateResult {
  doc: CutterDoc;
  /** Sources to add to `game.sources` (the photo set). */
  addSources: SourceDoc[];
  /** SliceJobs whose `sourceId` ('photos') should point at the new photo set. */
  sliceSourceRewrites: { jobId: ID; sourceId: ID }[];
  report: MigrateReport;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Groups a botched import left behind: no `made` link, and every frame sits exactly where a frame of
 * a freshly migrated (and linked) group sits. Those are duplicates of the real cut, so they go —
 * anything the user drew themselves, or that differs by so much as a corner, is left alone.
 */
function dropStaleCopies(ctx: Ctx) {
  const real = ctx.doc.groups.filter((g) => g.made?.componentId);
  // the same piece of paper to a tenth of a millimetre counts as the same frame
  const at = (f: CutFrame) => `${f.at.sourceId}:${f.at.page}:${f.quad.map((p) => p.map((v) => Math.round(v * 10)).join(',')).join(';')}`;
  const realFrames = new Set(
    Object.values(ctx.doc.frames)
      .filter((f) => real.some((g) => g.id === f.groupId))
      .map(at),
  );
  const drop = ctx.doc.groups.filter((g) => {
    if (g.made || real.some((r) => r.id === g.id)) return false;
    const frames = Object.values(ctx.doc.frames).filter((f) => f.groupId === g.id);
    return frames.length > 0 && frames.every((f) => realFrames.has(at(f)));
  });
  for (const g of drop) {
    for (const [id, f] of Object.entries(ctx.doc.frames)) if (f.groupId === g.id) delete ctx.doc.frames[id];
    for (const [id, gr] of Object.entries(ctx.doc.grids)) if (gr.groupId === g.id) delete ctx.doc.grids[id];
    ctx.doc.groups = ctx.doc.groups.filter((x) => x.id !== g.id);
    ctx.report.notes.push(`Removed “${g.name}”: an unmade copy of a cut that is linked to what it made.`);
  }
}

/** A deterministic 12-character id from where a thing came from. */
export const derivedId = (...parts: (string | number)[]) => 'm' + hash53(parts.join('|')).slice(-11);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

const outerW = (L: LegacyLayout) => L.cardW + 2 * L.bleed;
const outerH = (L: LegacyLayout) => L.cardH + 2 * L.bleed;
const layoutW = (L: LegacyLayout) => L.cols * outerW(L) + (L.cols - 1) * L.gapX;
const layoutH = (L: LegacyLayout) => L.rows * outerH(L) + (L.rows - 1) * L.gapY;
function cellOuter(L: LegacyLayout, i: number): LegacyRect {
  const r = Math.floor(i / L.cols);
  const c = i % L.cols;
  return { x: L.x + c * (outerW(L) + L.gapX), y: L.y + r * (outerH(L) + L.gapY), w: outerW(L), h: outerH(L) };
}
const sizeKey = (p: { widthMm: number; heightMm: number }) => `${Math.round(p.widthMm)}x${Math.round(p.heightMm)}`;

export function legacyDefaultGrid(kind: 'cards' | 'tokens'): LegacyGridConfig {
  return {
    templates: {},
    overrides: {},
    excluded: {},
    included: {},
    autoSkipBlank: true,
    pages: [0],
    scope: 'size',
    backs: { mode: 'none', flip: 'long', shared: null, backPage: null },
    backAdjust: { dx: 0, dy: 0 },
    preset: kind === 'cards' ? 'poker' : 'custom',
    shape: kind === 'cards' ? 'rect' : 'round',
  };
}

/** A stored config (possibly partial or stale) over the defaults, as the slicer reads it. */
export function legacyConfig(kind: 'cards' | 'tokens', raw: unknown): LegacyGridConfig {
  const d = legacyDefaultGrid(kind);
  if (!isObj(raw)) return d;
  return { ...d, ...raw, backs: { ...d.backs, ...(isObj(raw.backs) ? raw.backs : {}) }, backAdjust: { ...d.backAdjust, ...(isObj(raw.backAdjust) ? raw.backAdjust : {}) } } as LegacyGridConfig;
}

function duplexFrontOf(cfg: LegacyGridConfig, page: number): number | null {
  if (cfg.backs.mode !== 'duplex') return null;
  return cfg.pages.includes(page - 1) && !cfg.pages.includes(page) ? page - 1 : null;
}
function baseLayout(cfg: LegacyGridConfig, source: SourceDoc, page: number): LegacyLayout | null {
  const pg = source.pages[page];
  if (!pg) return null;
  return cfg.overrides[page] ?? cfg.templates[sizeKey(pg)] ?? null;
}
/** The slicer's layoutFor(): a duplex back page gets its front's layout mirrored and shifted. */
export function legacyLayoutFor(cfg: LegacyGridConfig, source: SourceDoc, page: number): LegacyLayout | null {
  const front = duplexFrontOf(cfg, page);
  if (front != null) {
    const fl = baseLayout(cfg, source, front);
    const pg = source.pages[page];
    if (!fl || !pg) return null;
    const axis = mirrorAxis(pg.widthMm, pg.heightMm, cfg.backs.flip);
    const m = axis === 'x' ? { ...fl, x: r2(pg.widthMm - fl.x - layoutW(fl)) } : axis === 'y' ? { ...fl, y: r2(pg.heightMm - fl.y - layoutH(fl)) } : fl;
    return { ...m, x: r2(m.x + cfg.backAdjust.dx), y: r2(m.y + cfg.backAdjust.dy) };
  }
  return baseLayout(cfg, source, page);
}

/** The slicer's stitchLayout(): the joined board's size. */
function stitchSize(st: LegacyStitch): { W: number; H: number } {
  const pos: { x: number; y: number; w: number; h: number }[] = [];
  st.parts.forEach((p, i) => {
    if (i === 0) return void pos.push({ x: 0, y: 0, w: p.rect.w, h: p.rect.h });
    const prev = pos[i - 1];
    const j = st.joins[i - 1] ?? { overlap: 0, shift: 0 };
    if (st.dir === 'h') pos.push({ x: prev.x + prev.w - j.overlap, y: prev.y + j.shift, w: p.rect.w, h: p.rect.h });
    else pos.push({ x: prev.x + j.shift, y: prev.y + prev.h - j.overlap, w: p.rect.w, h: p.rect.h });
  });
  const minX = Math.min(0, ...pos.map((p) => p.x));
  const minY = Math.min(0, ...pos.map((p) => p.y));
  const W = Math.max(0, ...pos.map((p) => p.x - minX + p.w));
  const H = Math.max(0, ...pos.map((p) => p.y - minY + p.h));
  const b = Math.max(0, Math.min(st.bleed ?? 0, (Math.min(W, H) - 1) / 2));
  return { W: W - 2 * b, H: H - 2 * b };
}

const rq = (r: LegacyRect) => rectQuad(r.x, r.y, r.w, r.h) as CutQuad;

function presetSize(id: string | undefined): boolean {
  return !!id && (CARD_PRESETS.some((p) => p.id === id) || /^tok-\d+$/.test(id));
}

/* ------------------------------------------------------------------ */
/* The migration                                                        */
/* ------------------------------------------------------------------ */

interface Built {
  group: CutGroup;
  grids: CutGrid[];
  frames: CutFrame[];
  notes: string[];
}

class Ctx {
  doc: CutterDoc;
  absorbed: Set<string>;
  report: MigrateReport;
  fields = new Map<string, FieldAudit>();
  constructor(
    public input: MigrateInput,
    public now: number,
  ) {
    this.doc = input.existing ? clone(input.existing) : emptyCutter();
    this.doc.version = CUTTER_VERSION;
    this.absorbed = new Set(this.doc.migrated?.absorbed ?? []);
    this.report = { gameId: input.game.id, gameName: input.game.name, entries: [], fields: [], notes: [], unmapped: [] };
  }
  field(field: string, status: FieldAudit['status'], note: string, n = 1) {
    const k = `${field}|${status}`;
    const f = this.fields.get(k);
    if (f) f.count += n;
    else this.fields.set(k, { field, status, note, count: n });
    if (status === 'unmapped') this.report.unmapped.push(`${field}: ${note}`);
  }
  add(b: Built) {
    for (const g of b.grids) this.doc.grids[g.id] = g;
    for (const f of b.frames) this.doc.frames[f.id] = f;
    this.doc.groups.push(b.group);
  }
  entry(e: ReportEntry) {
    this.report.entries.push(e);
    if (e.status === 'unmapped') this.report.unmapped.push(`${e.record} ${e.id} (${e.label}): ${e.detail}`);
  }
}

export function migrate(input: MigrateInput): MigrateResult {
  const ctx = new Ctx(input, input.now ?? Date.now());
  const { game } = input;
  const reads = (what: 'slice-jobs' | 'photo-draft' | 'slicer-drafts') => !input.only || input.only.includes(what);
  const sources = new Map(game.sources.map((s) => [s.id, s]));
  const addSources: SourceDoc[] = [];
  const sliceSourceRewrites: { jobId: ID; sourceId: ID }[] = [];
  /** Groups whose `made` is exact (the job holds the settings it was made with). */
  const signNow: ID[] = [];

  /*
   * Repair pass. A document can claim a SliceJob is "already in cutter.json" while holding no link
   * to the component that job made — that is what the Q7 import bug produced. Trusting the claim
   * would leave a finished cut looking unmade for ever, so the claim is dropped and the job is
   * migrated again from game.json, which is intact. Nothing else in the document is disturbed.
   */
  const repaired: ID[] = [];
  if (reads('slice-jobs'))
    for (const job of game.slices ?? []) {
      const key = `slice-job:${job.id}`;
      if (!ctx.absorbed.has(key) || !job.targetComponentId) continue;
      const linked = ctx.doc.groups.some((g) => g.made?.componentId === job.targetComponentId);
      const gone = !game.components.some((c) => c.id === job.targetComponentId);
      if (linked || gone) continue;
      ctx.absorbed.delete(key);
      repaired.push(job.id);
    }
  if (repaired.length)
    ctx.report.notes.push(
      `${repaired.length === 1 ? 'One cut said it' : `${repaired.length} cuts said they`} had already been migrated, but the document held no link to what ${repaired.length === 1 ? 'it' : 'they'} made — migrated again from the job records.`,
    );

  /* ---------------- SliceJobs of the PDF slicer ---------------- */
  for (const job of reads('slice-jobs') ? (game.slices ?? []) : []) {
    if (job.sourceId === LEGACY_PHOTO_SOURCE_ID) continue; // with the photo draft, below
    const key = `slice-job:${job.id}`;
    const label = `${job.mode} “${job.name}”`;
    if (ctx.absorbed.has(key)) {
      ctx.entry({ record: 'slice-job', id: job.id, label, status: 'skipped', detail: 'already in cutter.json', groups: [], grids: 0, frames: 0, made: 0 });
      continue;
    }
    const source = sources.get(job.sourceId);
    if (!source) {
      ctx.entry({ record: 'slice-job', id: job.id, label, status: 'retired', detail: 'its source file was deleted; the components it made stay in the game', groups: [], grids: 0, frames: 0, made: 0 });
      ctx.absorbed.add(key);
      continue;
    }
    try {
      const built = fromSliceJob(ctx, job, source);
      ctx.add(built);
      if (built.group.made) signNow.push(built.group.id);
      ctx.absorbed.add(key);
      ctx.entry({
        record: 'slice-job',
        id: job.id,
        label,
        status: 'mapped',
        detail: `→ ${built.group.kind} group “${built.group.name}”${built.notes.length ? ` (${built.notes.join('; ')})` : ''}`,
        groups: [built.group.id],
        grids: built.grids.length,
        frames: built.frames.length,
        made: built.group.made ? 1 : 0,
      });
    } catch (e) {
      ctx.entry({ record: 'slice-job', id: job.id, label, status: 'unmapped', detail: (e as Error).message, groups: [], grids: 0, frames: 0, made: 0 });
    }
  }

  /* ---------------- photo import draft (+ its SliceJobs) ---------------- */
  const photoJobs = (game.slices ?? []).filter((j) => j.sourceId === LEGACY_PHOTO_SOURCE_ID);
  if (input.photoDraft != null && reads('photo-draft')) {
    if (ctx.absorbed.has('photo-draft')) {
      ctx.entry({ record: 'photo-draft', id: 'photo-draft.json', label: 'photo import draft', status: 'skipped', detail: 'already in cutter.json', groups: [], grids: 0, frames: 0, made: 0 });
    } else {
      try {
        const res = fromPhotoDraft(ctx, input.photoDraft, photoJobs);
        addSources.push(res.source);
        for (const j of photoJobs) sliceSourceRewrites.push({ jobId: j.id, sourceId: res.source.id });
        ctx.absorbed.add('photo-draft');
        for (const j of photoJobs) ctx.absorbed.add(`slice-job:${j.id}`);
      } catch (e) {
        ctx.entry({ record: 'photo-draft', id: 'photo-draft.json', label: 'photo import draft', status: 'unmapped', detail: (e as Error).message, groups: [], grids: 0, frames: 0, made: 0 });
      }
    }
  } else {
    for (const j of photoJobs) {
      const key = `slice-job:${j.id}`;
      if (ctx.absorbed.has(key)) continue;
      ctx.absorbed.add(key);
      ctx.entry({
        record: 'slice-job',
        id: j.id,
        label: `photos ${j.mode} “${j.name}”`,
        status: 'retired',
        detail: 'made from photos whose draft was discarded, so its frames no longer exist; the components it made stay in the game',
        groups: [],
        grids: 0,
        frames: 0,
        made: 0,
      });
    }
  }

  /* ---------------- the PDF slicer's localStorage drafts (Q7) ---------------- */
  for (const d of reads('slicer-drafts') ? (input.slicerDrafts ?? []) : []) fromSlicerDraft(ctx, d, sources);

  /* ---------------- finish ---------------- */
  if (repaired.length) dropStaleCopies(ctx);
  for (const id of signNow) {
    const g = ctx.doc.groups.find((x) => x.id === id);
    if (!g?.made) continue;
    g.made.signature = groupSignature(ctx.doc, id);
    // it was already made with these backs, so its pairs count as looked at (no gate on an update)
    if (g.backs.mode !== 'none') g.backs.checked = pairsSignature(g);
  }
  ctx.doc.migrated = { at: ctx.doc.migrated?.at ?? ctx.now, absorbed: [...ctx.absorbed].sort() };
  ctx.report.fields = [...ctx.fields.values()].sort((a, b) => a.field.localeCompare(b.field) || a.status.localeCompare(b.status));
  return { doc: ctx.doc, addSources, sliceSourceRewrites, report: ctx.report };
}

/* ------------------------------------------------------------------ */
/* PDF slicer: grid / single / stitch                                   */
/* ------------------------------------------------------------------ */

function fromSliceJob(ctx: Ctx, job: SliceJob, source: SourceDoc): Built {
  const s = job.settings as Record<string, any>;
  const origin: CutOrigin = { from: 'slice-job', id: job.id };
  if (job.mode === 'grid') {
    const kind: 'cards' | 'tokens' = s.kind === 'tokens' ? 'tokens' : 'cards';
    if (!isObj(s.cfg)) throw new Error('grid job without a grid configuration');
    const cfg = legacyConfig(kind, s.cfg);
    const out = (isObj(s.out) ? s.out : {}) as Partial<LegacyOut>;
    auditJobFields(ctx, 'slice-job(grid).settings', s, ['kind', 'cfg', 'out', 'ids']);
    const b = fromGridConfig(ctx, { cfg, kind, source, seed: `job:${job.id}`, name: job.name || out.name || 'Deck', out, origin });
    const ids: ID[] = Array.isArray(s.ids) ? s.ids.slice() : [];
    b.group.made = { componentId: job.targetComponentId, pieceIds: ids, at: job.updatedAt, signature: '' };
    ctx.field('slice-job(grid).settings.ids', 'mapped', 'group.made.pieceIds');
    ctx.field('slice-job.targetComponentId', 'mapped', 'group.made.componentId');
    const alive = liveIds(ctx, kind, job.targetComponentId, ids);
    if (alive < ids.length) b.notes.push(`${ids.length - alive} of ${ids.length} made ${kind === 'tokens' ? 'tokens' : 'cards'} were deleted since`);
    const merged = out.dedupe ?? (kind === 'tokens' || !!out.merge);
    if (merged) {
      b.group.origin!.note = `was merged by look when made (${ids.length} ${kind} from ${b.group.order.length} frames); owner Q5 removed look-merging — say "same" by hand`;
      b.notes.push('look-merge dropped (Q5)');
    }
    return b;
  }
  if (job.mode === 'single') {
    auditJobFields(ctx, 'slice-job(single).settings', s, ['target', 'rect', 'dpi']);
    ctx.field('slice-job(single).settings.target/rect/dpi', 'mapped', 'group.kind / the frame / group.out.dpi');
    const target: 'board' | 'back' | 'cover' = s.target === 'back' || s.target === 'cover' ? s.target : 'board';
    const page = job.pages[0] ?? 0;
    if (!isObj(s.rect)) throw new Error('single job without a rectangle');
    const b = singleGroup({ seed: `job:${job.id}`, source, page, rect: s.rect as LegacyRect, target, name: job.name, dpi: s.dpi ?? 200, deckId: target === 'back' ? job.targetComponentId : null, origin });
    b.group.made = {
      componentId: target === 'cover' ? null : job.targetComponentId,
      pieceIds: target === 'board' && job.targetComponentId ? [job.targetComponentId] : [],
      at: job.updatedAt,
      signature: '',
    };
    ctx.field('slice-job.targetComponentId', 'mapped', 'group.made.componentId');
    return b;
  }
  if (job.mode === 'stitch') {
    auditJobFields(ctx, 'slice-job(stitch).settings', s, ['stitch']);
    for (const k of Object.keys(isObj(s.stitch) ? s.stitch : {}))
      if (!['parts', 'dir', 'joins', 'seamAuto', 'seamScore', 'bleed', 'name', 'dpi'].includes(k)) ctx.field(`slicer.stitch.${k}`, 'unmapped', 'unknown field');
    if (!isObj(s.stitch) || !Array.isArray(s.stitch.parts)) throw new Error('stitch job without parts');
    const b = stitchGroup(ctx, { seed: `job:${job.id}`, source, st: s.stitch as LegacyStitch, name: job.name, origin });
    b.group.made = { componentId: job.targetComponentId, pieceIds: job.targetComponentId ? [job.targetComponentId] : [], at: job.updatedAt, signature: '' };
    ctx.field('slice-job.targetComponentId', 'mapped', 'group.made.componentId');
    return b;
  }
  throw new Error(`unknown job mode “${(job as SliceJob).mode}”`);
}

function auditJobFields(ctx: Ctx, prefix: string, s: Record<string, unknown>, known: string[]) {
  for (const k of Object.keys(s)) if (!known.includes(k)) ctx.field(`${prefix}.${k}`, 'unmapped', 'unknown field');
}

/** How many of the made pieces still exist (deleted cards/tokens are only reported). */
function liveIds(ctx: Ctx, kind: 'cards' | 'tokens', componentId: ID | null, ids: ID[]): number {
  const comps = ctx.input.game.components ?? [];
  if (kind === 'tokens') return ids.filter((id) => comps.some((c) => c.id === id)).length;
  const deck = comps.find((c) => c.id === componentId);
  if (!deck || deck.kind !== 'deck') return 0;
  return ids.filter((id) => deck.cards.some((c) => c.id === id)).length;
}

function fromGridConfig(
  ctx: Ctx,
  a: { cfg: LegacyGridConfig; kind: 'cards' | 'tokens'; source: SourceDoc; seed: string; name: string; out: Partial<LegacyOut>; origin: CutOrigin },
): Built {
  const { cfg, kind, source, seed } = a;
  const groupId = derivedId(seed, 'group');
  const notes: string[] = [];
  const grids: CutGrid[] = [];
  const frames: CutFrame[] = [];
  const order: ID[] = [];
  const frontPages = [...new Set(cfg.pages)].sort((x, y) => x - y);
  const round = kind === 'tokens' && cfg.shape === 'round';
  const frontGrid = new Map<number, { grid: CutGrid; L: LegacyLayout; frames: CutFrame[] }>();
  let first: LegacyLayout | null = null;
  const bleeds = new Set<number>();

  const makeGrid = (page: number, L: LegacyLayout, role: 'front' | 'back', extra: Partial<CutGrid>): { grid: CutGrid; frames: CutFrame[] } => {
    const id = derivedId(seed, role, page);
    const grid: CutGrid = {
      id,
      at: { sourceId: source.id, page },
      groupId,
      ...rectGrid({ x: L.x, y: L.y, cols: L.cols, rows: L.rows, cellW: outerW(L), cellH: outerH(L), gapX: L.gapX, gapY: L.gapY }),
      removed: [],
      same: false,
      fitted: true,
      ...extra,
    };
    const fs: CutFrame[] = [];
    for (let i = 0; i < L.rows * L.cols; i++) {
      const f: CutFrame = {
        id: derivedId(seed, role, page, i),
        at: { sourceId: source.id, page },
        groupId,
        quad: rq(cellOuter(L, i)),
        shape: round ? 'round' : 'rect',
        gridId: id,
        cell: i,
        onGrid: true,
        turn: 0,
        side: role,
      };
      if (role === 'front') {
        if (cfg.excluded[page]?.includes(i)) f.excluded = true;
        if (cfg.included[page]?.includes(i)) f.keep = true;
      }
      fs.push(f);
    }
    grids.push(grid);
    frames.push(...fs);
    return { grid, frames: fs };
  };

  for (const page of frontPages) {
    if (!source.pages[page]) {
      notes.push(`page ${page + 1} is not in the file any more`);
      continue;
    }
    const L = baseLayout(cfg, source, page);
    if (!L) {
      notes.push(`page ${page + 1} had no grid`);
      continue;
    }
    first ??= L;
    bleeds.add(L.bleed);
    const linked = cfg.overrides[page] == null;
    const { grid, frames: fs } = makeGrid(page, L, 'front', { skipBlank: cfg.autoSkipBlank, ...(linked ? { linkId: derivedId(seed, 'link', sizeKey(source.pages[page])) } : {}) });
    frontGrid.set(page, { grid, L, frames: fs });
    order.push(...fs.map((f) => f.id));
  }
  // a template used by one page only is not a link
  const linkUse = new Map<string, number>();
  for (const g of grids) if (g.linkId) linkUse.set(g.linkId, (linkUse.get(g.linkId) ?? 0) + 1);
  for (const g of grids) if (g.linkId && (linkUse.get(g.linkId) ?? 0) < 2) delete g.linkId;

  if (!first) throw new Error('no page of this cut has a grid');
  if (bleeds.size > 1) notes.push('bleed differed between pages; the first page’s is the group trim');

  /* backs */
  const backs: CutBacks = { mode: 'none', pairs: {} };
  const b = cfg.backs;
  if (b.mode === 'duplex') {
    backs.mode = 'each';
    backs.rule = { kind: 'turned-over', flip: b.flip };
    for (const [page, fg] of frontGrid) {
      const bp = page + 1;
      if (bp >= source.pageCount || cfg.pages.includes(bp) || !source.pages[bp]) continue;
      const BL = legacyLayoutFor(cfg, source, bp);
      if (!BL) continue;
      const pg = source.pages[bp];
      const back = makeGrid(bp, BL, 'back', { backOf: { gridId: fg.grid.id, flip: b.flip, linked: true, dx: cfg.backAdjust.dx, dy: cfg.backAdjust.dy, page: { w: pg.widthMm, h: pg.heightMm } } });
      const axis = mirrorAxis(pg.widthMm, pg.heightMm, b.flip);
      fg.frames.forEach((f, i) => (backs.pairs[f.id] = back.frames[mirrorCell(BL, i, axis)].id));
    }
  } else if (b.mode === 'page') {
    backs.mode = 'each';
    const bp = b.backPage;
    const BL = bp != null && source.pages[bp] ? legacyLayoutFor(cfg, source, bp) : null;
    if (bp != null && BL) {
      backs.rule = { kind: 'backs-page', page: { sourceId: source.id, page: bp }, flip: b.flip, size: { w: source.pages[bp].widthMm, h: source.pages[bp].heightMm }, map: Object.fromEntries([...frontGrid.keys()].map((p) => [`${source.id}:${p}`, { sourceId: source.id, page: bp }])) };
      const back = makeGrid(bp, BL, 'back', { backs: true });
      const pg = source.pages[bp];
      const axis = mirrorAxis(pg.widthMm, pg.heightMm, b.flip);
      const n = BL.rows * BL.cols;
      for (const fg of frontGrid.values()) {
        fg.frames.forEach((f, i) => {
          const idx = BL.rows === fg.L.rows && BL.cols === fg.L.cols ? mirrorCell(BL, i, axis) : i % n;
          backs.pairs[f.id] = back.frames[idx].id;
        });
      }
    } else {
      backs.rule = { kind: 'hand' };
      notes.push('the backs page had no grid, so no backs');
      for (const fg of frontGrid.values()) for (const f of fg.frames) backs.pairs[f.id] = null;
    }
  } else if (b.mode === 'shared') {
    if (b.shared?.kind === 'asset') {
      backs.mode = 'same';
      backs.assetId = b.shared.assetId;
    } else if (b.shared?.kind === 'region') {
      backs.mode = 'same';
      const f: CutFrame = {
        id: derivedId(seed, 'shared-back'),
        at: { sourceId: source.id, page: b.shared.page },
        groupId,
        // the group trim applies to every frame, so the drawn back is outset by it (the old cut used the rect as drawn)
        quad: rq({ x: b.shared.rect.x - first.bleed, y: b.shared.rect.y - first.bleed, w: b.shared.rect.w + 2 * first.bleed, h: b.shared.rect.h + 2 * first.bleed }),
        shape: 'rect',
        onGrid: false,
        turn: 0,
        side: 'back',
      };
      frames.push(f);
      backs.sharedFrameId = f.id;
    } else notes.push('“same back for all” had no back chosen, so no backs');
  }
  ctx.field('slicer.cfg.backs', 'mapped', 'group.backs (+ back grids, pairs)');

  const size: CutSize = { w: first.cardW, h: first.cardH, from: 'page', ...(presetSize(cfg.preset) ? { preset: cfg.preset } : {}) };
  const group: CutGroup = {
    id: groupId,
    name: a.name,
    kind,
    size,
    trimMm: first.bleed,
    cornerMm: 0,
    ...(kind === 'tokens' ? { shape: cfg.shape } : {}),
    order,
    backs,
    out: { target: a.out.target === 'existing' ? 'existing' : 'new', deckId: a.out.deckId ?? null, dpi: a.out.dpi ?? 300 },
    origin: { ...a.origin },
  };
  for (const [k, where] of [
    ['templates', 'grids (one per page; pages sharing a paper-size template share a linkId)'],
    ['overrides', 'grids (unlinked)'],
    ['excluded', 'frame.excluded'],
    ['included', 'frame.keep'],
    ['autoSkipBlank', 'grid.skipBlank'],
    ['pages', 'the pages that get front grids'],
    ['backAdjust', 'back grid backOf.dx/dy'],
    ['preset', 'group.size.preset'],
    ['shape', kind === 'tokens' ? 'group.shape + frame.shape' : 'cards are rectangles'],
  ] as const)
    ctx.field(`slicer.cfg.${k}`, 'mapped', where);
  ctx.field('slicer.cfg.scope', 'dropped', 'the "Changes apply to" scope is gone: linked grids (linkId) replace it');
  const knownCfg = ['templates', 'overrides', 'excluded', 'included', 'autoSkipBlank', 'pages', 'scope', 'backs', 'backAdjust', 'preset', 'shape'];
  for (const k of Object.keys(cfg)) if (!knownCfg.includes(k)) ctx.field(`slicer.cfg.${k}`, 'unmapped', 'unknown field');
  ctx.field('slicer.out.target/deckId/dpi', 'mapped', 'group.out');
  ctx.field('slicer.out.name', 'mapped', 'group.name');
  if ('merge' in a.out || 'dedupe' in a.out) ctx.field('slicer.out.merge/dedupe', 'dropped', 'owner Q5: never merge by look — the user says which pieces are the same (noted on the group origin when it applied)');
  if ('replaceJobId' in a.out) ctx.field('slicer.out.replaceJobId', 'dropped', 'a group always updates what it made (group.made)');
  for (const k of Object.keys(a.out)) if (!['target', 'name', 'deckId', 'dpi', 'merge', 'dedupe', 'replaceJobId'].includes(k)) ctx.field(`slicer.out.${k}`, 'unmapped', 'unknown field');
  return { group, grids, frames, notes };
}

function singleGroup(a: { seed: string; source: SourceDoc; page: number; rect: LegacyRect; target: 'board' | 'back' | 'cover'; name: string; dpi: number; deckId: ID | null; origin: CutOrigin }): Built {
  const groupId = derivedId(a.seed, 'group');
  const f: CutFrame = { id: derivedId(a.seed, 'frame'), at: { sourceId: a.source.id, page: a.page }, groupId, quad: rq(a.rect), shape: 'rect', onGrid: false, turn: 0, side: 'front' };
  const kind: CutKind = a.target;
  const group: CutGroup = {
    id: groupId,
    name: a.name || (kind === 'board' ? 'Board' : kind === 'cover' ? 'Cover image' : 'Card back'),
    kind,
    size: { w: a.rect.w, h: a.rect.h, from: 'page' },
    trimMm: 0,
    cornerMm: 0,
    order: [f.id],
    backs: { mode: 'none', pairs: {} },
    out: { target: kind === 'back' ? 'existing' : 'new', deckId: a.deckId, dpi: a.dpi },
    origin: { ...a.origin },
  };
  return { group, grids: [], frames: [f], notes: [] };
}

function stitchGroup(ctx: Ctx, a: { seed: string; source: SourceDoc; st: LegacyStitch; name: string; origin: CutOrigin }): Built {
  const groupId = derivedId(a.seed, 'group');
  const st = a.st;
  const frames: CutFrame[] = st.parts.map((p, i) => ({
    id: derivedId(a.seed, 'part', i),
    at: { sourceId: a.source.id, page: p.page },
    groupId,
    quad: rq(p.rect),
    shape: 'rect',
    onGrid: false,
    turn: 0,
    side: 'front',
  }));
  const { W, H } = stitchSize(st);
  const group: CutGroup = {
    id: groupId,
    name: a.name || st.name || 'Board',
    kind: 'board',
    size: { w: Math.round(W * 10) / 10, h: Math.round(H * 10) / 10, from: 'page' },
    trimMm: 0,
    cornerMm: 0,
    order: frames.map((f) => f.id),
    backs: { mode: 'none', pairs: {} },
    join: {
      dir: st.dir === 'v' ? 'v' : 'h',
      joins: st.parts.slice(1).map((_, i) => ({ overlap: st.joins[i]?.overlap ?? 0, shift: st.joins[i]?.shift ?? 0, ...(st.seamAuto?.[i] != null ? { auto: !!st.seamAuto[i] } : {}) })),
      bleed: st.bleed ?? 0,
    },
    out: { target: 'new', deckId: null, dpi: st.dpi ?? 200 },
    origin: { ...a.origin },
  };
  ctx.field('slicer.stitch.parts/dir/joins/bleed/seamAuto', 'mapped', 'board group frames (in order) + group.join');
  if (st.seamScore) ctx.field('slicer.stitch.seamScore', 'dropped', 'measurement confidence is recomputed when seams are measured again');
  ctx.field('slicer.stitch.name/dpi', 'mapped', 'group.name / group.out.dpi');
  return { group, grids: [], frames, notes: [] };
}

/* ------------------------------------------------------------------ */
/* Photo import draft                                                   */
/* ------------------------------------------------------------------ */

const PHOTO_FIELDS: Record<string, [FieldAudit['status'], string]> = {
  id: ['mapped', 'the page (PageRef) of the new image set'],
  name: ['mapped', 'page.name'],
  width: ['mapped', 'page.px.w'],
  height: ['mapped', 'page.px.h'],
  takenAt: ['mapped', 'page.takenAt'],
  lastModified: ['mapped', 'page.lastModified'],
  gains: ['mapped', 'page.gains'],
  assetId: ['mapped', 'page.assetId'],
  grid: ['mapped', 'a CutGrid (square: false)'],
  deckId: ['mapped', 'grid.groupId (the deck its new frames go into)'],
  bytes: ['dropped', 'the asset records its size'],
  kind: ['dropped', 'derived: a page’s kind is its grid’s group kind'],
  countSet: ['dropped', 'UI hint: a page with a grid or frames counts as set'],
  nothingFound: ['dropped', 'auto-detection result from an earlier build (owner ruling: no detection on photos)'],
  flags: ['dropped', 'auto-detection flags from an earlier build'],
  analyzed: ['dropped', 'auto-detection state from an earlier build'],
};
const ITEM_FIELDS: Record<string, [FieldAudit['status'], string]> = {
  id: ['mapped', 'frame.id (kept)'],
  photoId: ['mapped', 'frame.at'],
  quad: ['mapped', 'frame.quad (exact copy)'],
  shape: ['mapped', 'frame.shape'],
  groupId: ['mapped', 'frame.groupId'],
  name: ['mapped', 'frame.name'],
  excluded: ['mapped', 'frame.excluded'],
  side: ['mapped', 'frame.side'],
  cell: ['mapped', 'frame.cell (+ gridId)'],
  onGrid: ['mapped', 'frame.onGrid'],
  turn: ['mapped', 'frame.turn'],
  same: ['mapped', 'frame.same (a representative frame id; same partition)'],
  aspect: ['dropped', 'derived from the quad whenever needed'],
  edited: ['dropped', 'superseded by onGrid (a frame off its grid keeps its own corners)'],
  checked: ['dropped', 'UI-only “looked at” mark'],
  score: ['dropped', 'auto-detection score from an earlier build'],
  clipped: ['dropped', 'auto-detection flag from an earlier build'],
  steep: ['dropped', 'auto-detection flag from an earlier build'],
  tableEdge: ['dropped', 'auto-detection flag from an earlier build'],
  found: ['dropped', 'the auto-detected outline from an earlier build (the kept quad is the user’s)'],
};
const GROUP_FIELDS: Record<string, [FieldAudit['status'], string]> = {
  id: ['mapped', 'group.id (kept)'],
  name: ['mapped', 'group.name'],
  kind: ['mapped', 'group.kind'],
  preset: ['mapped', 'group.size.from / size.preset'],
  w: ['mapped', 'group.size.w'],
  h: ['mapped', 'group.size.h'],
  sizeKnown: ['mapped', 'group.size (null when not known)'],
  sizeNote: ['mapped', 'group.size.note'],
  shape: ['mapped', 'group.shape (tokens)'],
  backs: ['mapped', 'group.backs.mode'],
  sharedBackId: ['mapped', 'group.backs.sharedFrameId'],
  pairs: ['mapped', 'group.backs.pairs (+ rule "by hand")'],
  target: ['mapped', 'group.out.target'],
  deckId: ['mapped', 'group.out.deckId'],
  tokenSupply: ['dropped', 'owner Q3: making never places anything on the table'],
};
const GRID_FIELDS: Record<string, [FieldAudit['status'], string]> = {
  rows: ['mapped', 'grid.rows'],
  cols: ['mapped', 'grid.cols'],
  gapX: ['mapped', 'grid.gapX'],
  gapY: ['mapped', 'grid.gapY'],
  anchors: ['mapped', 'grid.anchors (exact copy)'],
  round: ['mapped', 'grid.round'],
  cellAspect: ['mapped', 'grid.cellAspect'],
  turn: ['mapped', 'grid.turn'],
  fitted: ['mapped', 'grid.fitted'],
  removed: ['mapped', 'grid.removed'],
  sameToken: ['mapped', 'grid.same (Q5 switch)'],
};
const DRAFT_FIELDS: Record<string, [FieldAudit['status'], string]> = {
  version: ['mapped', 'checked (1)'],
  photos: ['mapped', 'the new image-set source’s pages'],
  items: ['mapped', 'frames'],
  order: ['mapped', 'group.order (each group’s frames in this order)'],
  groups: ['mapped', 'groups'],
  clean: ['mapped', 'clean[source] (colour, shadows) + group.trimMm / cornerMm'],
  created: ['mapped', 'group.made (+ its SliceJob’s piece ids)'],
  photoId: ['mapped', 'view.at'],
  updatedAt: ['dropped', 'the cutter stamps its own updatedAt on save'],
  step: ['dropped', 'the five-step wizard is gone (one workspace)'],
  userOrdered: ['dropped', 'the order is always kept (group.order)'],
};

function audit(ctx: Ctx, prefix: string, rec: Record<string, unknown>, table: Record<string, [FieldAudit['status'], string]>) {
  for (const k of Object.keys(rec)) {
    const t = table[k];
    if (t) ctx.field(`${prefix}.${k}`, t[0], t[1]);
    else ctx.field(`${prefix}.${k}`, 'unmapped', 'unknown field');
  }
}

function fromPhotoDraft(ctx: Ctx, raw: unknown, photoJobs: SliceJob[]): { source: SourceDoc } {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.photos) || !isObj(raw.items) || !Array.isArray(raw.groups)) throw new Error('not a version 1 photo draft');
  const draft = raw as unknown as LegacyPhotoDraft;
  const { game, assets } = ctx.input;
  audit(ctx, 'photo-draft', draft as unknown as Record<string, unknown>, DRAFT_FIELDS);

  /* the photo set */
  const sourceId = derivedId(game.id, 'photo-set');
  const pageOf = new Map<string, number>();
  const pages: SourcePage[] = draft.photos.map((p, i) => {
    audit(ctx, 'photo-draft.photos[]', p, PHOTO_FIELDS);
    pageOf.set(String(p.id), i);
    const page: SourcePage = {
      index: i,
      widthMm: 0,
      heightMm: 0,
      thumb: null,
      assetId: String(p.assetId ?? ''),
      name: String(p.name ?? `Photo ${i + 1}`),
      px: { w: Number(p.width) || 0, h: Number(p.height) || 0 },
      photo: true,
      takenAt: (p.takenAt as number | null) ?? null,
      ...(typeof p.lastModified === 'number' ? { lastModified: p.lastModified } : {}),
      gains: (p.gains as [number, number, number] | null) ?? null,
    };
    if (!page.assetId) ctx.report.unmapped.push(`photo ${page.name}: no original kept (assetId missing)`);
    else if (assets && !assets[page.assetId]) ctx.report.notes.push(`photo ${page.name}: its original (${page.assetId}) is missing from assets.json`);
    if (!page.px!.w || !page.px!.h) ctx.report.notes.push(`photo ${page.name}: pixel size unknown`);
    return page;
  });
  const n = pages.length;
  const source: SourceDoc = {
    id: sourceId,
    name: n === 1 ? 'Photo' : `Photos (${n})`,
    kind: 'images',
    assetId: '',
    pageCount: n,
    pages,
    createdAt: Math.min(...pages.map((p) => p.lastModified ?? ctx.now), ctx.now),
  };

  /* clean-up */
  const clean = draft.clean ?? {};
  ctx.doc.clean[sourceId] = { color: clean.color ?? DEFAULT_CLEAN.color, flatten: clean.flatten ?? DEFAULT_CLEAN.flatten };
  const trimMm = clean.trimMm ?? DEFAULT_PHOTO_TRIM_MM;
  const cornerMm = clean.cornerMm ?? DEFAULT_PHOTO_CORNER_MM;

  /* groups */
  const groupIds = new Set(draft.groups.map((g) => String(g.id)));
  const itemOrder = [...draft.order.filter((id) => draft.items[id]), ...Object.keys(draft.items).filter((id) => !draft.order.includes(id))];

  /* frames (ids kept); `same` keys become one representative frame id per piece */
  const keyOf = (it: Record<string, unknown>) => (it.same as string | null | undefined) ?? String(it.id);
  const members = new Map<string, string[]>();
  for (const id of itemOrder) members.set(keyOf(draft.items[id]), [...(members.get(keyOf(draft.items[id])) ?? []), id]);
  const repOf = (key: string) => {
    const m = members.get(key)!;
    return m.includes(key) ? key : m[0];
  };

  const gridIdOf = (photoId: string) => derivedId(sourceId, 'grid', photoId);
  const frames: CutFrame[] = [];
  for (const id of itemOrder) {
    const it = draft.items[id];
    audit(ctx, 'photo-draft.items[]', it, ITEM_FIELDS);
    const page = pageOf.get(String(it.photoId));
    if (page == null) {
      ctx.report.unmapped.push(`frame ${id}: its photo ${String(it.photoId)} is not in the draft`);
      continue;
    }
    if (!groupIds.has(String(it.groupId))) ctx.report.unmapped.push(`frame ${id}: its group ${String(it.groupId)} is not in the draft`);
    const photo = draft.photos[page];
    const hasGrid = isObj(photo.grid) && typeof it.cell === 'number';
    const rep = repOf(keyOf(it));
    const f: CutFrame = {
      id,
      at: { sourceId, page },
      groupId: String(it.groupId),
      quad: clone(it.quad) as CutQuad,
      shape: it.shape === 'round' ? 'round' : 'rect',
      ...(hasGrid ? { gridId: gridIdOf(String(it.photoId)), cell: it.cell as number } : typeof it.cell === 'number' ? { cell: it.cell as number } : {}),
      onGrid: hasGrid && !!it.onGrid,
      turn: typeof it.turn === 'number' ? it.turn : 0,
      side: it.side === 'back' ? 'back' : 'front',
      ...(rep !== id ? { same: rep } : {}),
      ...(it.name ? { name: String(it.name) } : {}),
      ...(it.excluded ? { excluded: true } : {}),
    };
    frames.push(f);
  }
  for (const f of frames) ctx.doc.frames[f.id] = f;

  /* grids */
  let grids = 0;
  draft.photos.forEach((p, page) => {
    if (!isObj(p.grid)) return;
    const gr = p.grid as Record<string, any>;
    audit(ctx, 'photo-draft.photos[].grid', gr, GRID_FIELDS);
    const photoId = String(p.id);
    const onIt = frames.filter((f) => f.gridId === gridIdOf(photoId));
    // the group its new frames go into: the photo's deck, else the group its frames are in
    const counts = new Map<string, number>();
    for (const f of onIt) counts.set(f.groupId, (counts.get(f.groupId) ?? 0) + 1);
    const byFrames = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const kindGroup = draft.groups.find((g) => g.kind === (p.kind ?? 'cards'))?.id as string | undefined;
    const groupId = (typeof p.deckId === 'string' && groupIds.has(p.deckId) ? p.deckId : undefined) ?? byFrames ?? kindGroup ?? String(draft.groups[0]?.id ?? '');
    if (!groupIds.has(groupId)) ctx.report.unmapped.push(`grid on photo ${String(p.name)}: no group to put it in`);
    const kind = draft.groups.find((g) => g.id === groupId)?.kind;
    const grid: CutGrid = {
      id: gridIdOf(photoId),
      at: { sourceId, page },
      groupId,
      rows: gr.rows,
      cols: gr.cols,
      gapX: gr.gapX,
      gapY: gr.gapY,
      anchors: clone(gr.anchors) as CutQuad,
      square: false,
      round: !!gr.round,
      cellAspect: gr.cellAspect,
      turn: gr.turn ?? 0,
      removed: Array.isArray(gr.removed) ? gr.removed.slice() : [],
      same: kind === 'tokens' && gr.sameToken !== false,
      fitted: !!gr.fitted,
    };
    ctx.doc.grids[grid.id] = grid;
    grids++;
  });

  /* groups */
  const created = draft.created ?? {};
  const usedJobs = new Set<string>();
  let madeCount = 0;
  const newGroupIds: ID[] = [];
  for (const g of draft.groups) {
    audit(ctx, 'photo-draft.groups[]', g, GROUP_FIELDS);
    const id = String(g.id);
    const kind = (g.kind === 'tokens' || g.kind === 'board' ? g.kind : 'cards') as 'cards' | 'tokens' | 'board';
    const preset = typeof g.preset === 'string' ? g.preset : 'custom';
    const size: CutSize | null = g.sizeKnown
      ? {
          w: Number(g.w),
          h: Number(g.h),
          from: preset === 'measured' ? 'measured' : presetSize(preset) ? 'preset' : 'typed',
          ...(presetSize(preset) ? { preset } : {}),
          ...(g.sizeNote ? { note: String(g.sizeNote) } : {}),
        }
      : null;
    const backsMode = g.backs === 'same' || g.backs === 'each' ? g.backs : 'none';
    const backs: CutBacks = { mode: backsMode, pairs: clone((g.pairs as Record<string, string | null>) ?? {}) };
    if (backsMode === 'same') backs.sharedFrameId = (g.sharedBackId as string | null) ?? null;
    if (backsMode === 'each') backs.rule = { kind: 'hand' };
    const group: CutGroup = {
      id,
      name: String(g.name ?? 'Cards'),
      kind,
      size,
      // photo pieces keep their own finish (the group's flat-page bleed is 0)
      trimMm: 0,
      cornerMm: 0,
      photo: { trimMm, cornerMm: kind === 'tokens' ? 0 : cornerMm },
      ...(kind === 'tokens' ? { shape: (g.shape as TokenShape) ?? 'round' } : {}),
      order: itemOrder.filter((iid) => draft.items[iid].groupId === id && pageOf.has(String(draft.items[iid].photoId))),
      backs,
      out: { target: g.target === 'existing' ? 'existing' : 'new', deckId: (g.deckId as ID | null) ?? null, dpi: 300 },
      origin: { from: 'photo-draft', id },
    };
    const c = created[id];
    if (c) {
      const job = c.jobId ? photoJobs.find((j) => j.id === c.jobId) : undefined;
      if (job) usedJobs.add(job.id);
      const ids: ID[] = job && Array.isArray((job.settings as any).ids) ? ((job.settings as any).ids as ID[]).slice() : c.componentId && kind === 'board' ? [c.componentId] : [];
      group.made = { componentId: c.componentId, pieceIds: ids, at: c.at ?? job?.updatedAt ?? draft.updatedAt ?? 0, signature: '' };
      group.origin!.note = 'made before the switch-over: whether it changed since is unknown, so it shows “Update” once';
      madeCount++;
    }
    ctx.doc.groups.push(group);
    newGroupIds.push(id);
  }
  for (const gid of Object.keys(created)) {
    if (!groupIds.has(gid)) ctx.report.notes.push(`photo draft: a “created” record for group ${gid}, which no longer exists — its component stays`);
  }

  /* view */
  if (!ctx.doc.view) {
    const at = draft.photoId != null && pageOf.has(draft.photoId) ? { sourceId, page: pageOf.get(draft.photoId)! } : n ? { sourceId, page: 0 } : null;
    ctx.doc.view = { at, mode: 'pages' };
  }

  ctx.entry({
    record: 'photo-draft',
    id: 'photo-draft.json',
    label: `photo import draft (${n} photos, ${frames.length} frames, ${draft.groups.length} groups)`,
    status: 'mapped',
    detail: `→ image set “${source.name}” + ${draft.groups.length} groups`,
    groups: newGroupIds,
    grids,
    frames: frames.length,
    made: madeCount,
  });

  /* the photo import's SliceJobs */
  for (const j of photoJobs) {
    const label = `photos ${j.mode} “${j.name}”`;
    if (usedJobs.has(j.id)) {
      const gid = Object.entries(created).find(([, c]) => c.jobId === j.id)?.[0];
      ctx.entry({ record: 'slice-job', id: j.id, label, status: 'mapped', detail: `→ made link of group ${gid}`, groups: gid ? [gid] : [], grids: 0, frames: 0, made: 1 });
    } else {
      ctx.entry({
        record: 'slice-job',
        id: j.id,
        label,
        status: 'retired',
        detail: 'an earlier run from photos that no group links to (making the group again created new pieces then too); its components stay in the game',
        groups: [],
        grids: 0,
        frames: 0,
        made: 0,
      });
    }
  }
  return { source };
}

/* ------------------------------------------------------------------ */
/* The PDF slicer's localStorage drafts (Q7)                           */
/* ------------------------------------------------------------------ */

const eqCanon = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The parts of a grid config that decide what gets cut. */
function cutPart(cfg: LegacyGridConfig) {
  const nonEmpty = (r: Record<string, number[]>) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => v?.length).map(([k, v]) => [k, [...v].sort((x, y) => x - y)]));
  return {
    templates: cfg.templates,
    overrides: cfg.overrides,
    excluded: nonEmpty(cfg.excluded),
    included: nonEmpty(cfg.included),
    autoSkipBlank: cfg.autoSkipBlank,
    pages: [...cfg.pages].sort((x, y) => x - y),
    backs: cfg.backs,
    backAdjust: cfg.backAdjust,
    preset: cfg.preset,
    shape: cfg.shape,
  };
}
const outPart = (o: Partial<LegacyOut> | undefined) => ({ target: o?.target ?? 'new', name: o?.name ?? '', deckId: o?.deckId ?? null, dpi: o?.dpi ?? 300 });

function fromSlicerDraft(ctx: Ctx, d: { key: string; value: unknown }, sources: Map<ID, SourceDoc>) {
  const key = d.key.startsWith(LEGACY_SLICER_PREFIX) ? d.key.slice(LEGACY_SLICER_PREFIX.length) : d.key;
  const [gameId, sourceId] = key.split(':');
  if (gameId !== ctx.input.game.id || !sourceId) return; // another game's draft
  const absorbedKey = `slicer-draft:${key}`;
  const entry = (status: EntryStatus, detail: string, built: Built[] = []) =>
    ctx.entry({
      record: 'slicer-draft',
      id: key,
      label: `slicer draft for ${sources.get(sourceId)?.name ?? sourceId}`,
      status,
      detail,
      groups: built.map((b) => b.group.id),
      grids: built.reduce((n, b) => n + b.grids.length, 0),
      frames: built.reduce((n, b) => n + b.frames.length, 0),
      made: 0,
    });
  if (ctx.absorbed.has(absorbedKey)) return entry('skipped', 'already imported');
  let value: unknown = d.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return entry('unmapped', 'not JSON');
    }
  }
  if (!isObj(value)) return entry('unmapped', 'not a slicer draft');
  const draft = value as LegacySlicerDraft;
  for (const k of Object.keys(draft)) if (!['mode', 'page', 'cards', 'tokens', 'single', 'stitch', 'cardsOut', 'tokensOut'].includes(k)) ctx.field(`slicer-draft.${k}`, 'unmapped', 'unknown field');
  ctx.field('slicer-draft.mode/page', 'dropped', 'where the user was in the old slicer; the cutter keeps its own view');
  const source = sources.get(sourceId);
  if (!source) {
    ctx.absorbed.add(absorbedKey);
    return entry('dropped', 'its source file was deleted');
  }
  // Q7: only when the user has not already started on this source in the cutter
  const userGroups = ctx.doc.groups.filter((g) => !g.origin && Object.values(ctx.doc.frames).some((f) => f.groupId === g.id && f.at.sourceId === sourceId));
  if (userGroups.length) {
    ctx.absorbed.add(absorbedKey);
    return entry('dropped', 'the cutter already has work on this source (Q7: import only before that)');
  }
  const jobs = (ctx.input.game.slices ?? []).filter((j) => j.sourceId === sourceId).sort((a, b) => b.updatedAt - a.updatedAt);
  const built: Built[] = [];
  const reasons: string[] = [];
  const origin = (part: string): CutOrigin => ({ from: 'slicer-draft', id: key, note: `unsaved ${part} from the old slicer in one browser, never cut` });

  for (const kind of ['cards', 'tokens'] as const) {
    const raw = draft[kind];
    if (!isObj(raw)) continue;
    const cfg = legacyConfig(kind, raw);
    const out = (kind === 'cards' ? draft.cardsOut : draft.tokensOut) ?? {};
    const framed = Object.keys(cfg.templates ?? {}).length + Object.keys(cfg.overrides ?? {}).length > 0;
    if (!framed) {
      reasons.push(`${kind}: nothing framed`);
      continue;
    }
    const grid = jobs.filter((j) => j.mode === 'grid' && (j.settings as any)?.kind === kind);
    const last = (out.replaceJobId && grid.find((j) => j.id === out.replaceJobId)) || grid[0];
    if (last && eqCanon(cutPart(cfg), cutPart(legacyConfig(kind, (last.settings as any).cfg))) && eqCanon(outPart(out), outPart((last.settings as any).out))) {
      reasons.push(`${kind}: same as the cut already made (“${last.name}”)`);
      continue;
    }
    try {
      const name = (out.name || (kind === 'cards' ? 'Deck' : 'Tokens')).trim();
      built.push(fromGridConfig(ctx, { cfg, kind, source, seed: `draft:${key}:${kind}`, name, out, origin: origin(kind) }));
    } catch (e) {
      reasons.push(`${kind}: ${(e as Error).message}`);
    }
  }

  const single = draft.single;
  if (isObj(single) && isObj(single.rects) && Object.keys(single.rects).length) {
    const pages = Object.keys(single.rects).map(Number).sort((a, b) => a - b);
    const page = draft.page != null && single.rects[draft.page] ? draft.page : pages[0];
    const rect = single.rects[page]!;
    const target = single.target === 'back' || single.target === 'cover' ? single.target : 'board';
    const same = jobs.find((j) => j.mode === 'single' && j.pages[0] === page && (j.settings as any)?.target === target && eqCanon((j.settings as any)?.rect, rect));
    if (same) reasons.push(`one piece: same as the cut already made (“${same.name}”)`);
    else {
      built.push(singleGroup({ seed: `draft:${key}:single`, source, page, rect, target, name: single.name ?? '', dpi: single.dpi ?? 200, deckId: target === 'back' ? (single.deckId ?? null) : null, origin: origin('piece') }));
      if (pages.length > 1) reasons.push(`one piece: only the rectangle on page ${page + 1} was ever cut; ${pages.length - 1} other page rectangles dropped`);
    }
  } else if (single) reasons.push('one piece: nothing drawn');
  if (single) ctx.field('slicer-draft.single', 'mapped', 'the rectangle on the page last shown → a board / back / cover group');
  if (draft.stitch) ctx.field('slicer-draft.stitch', 'mapped', 'a joined board group');
  if (draft.cards || draft.tokens) ctx.field('slicer-draft.cards/tokens(+Out)', 'mapped', 'cards / tokens groups (as a grid job)');

  const st = draft.stitch;
  if (isObj(st) && Array.isArray(st.parts) && st.parts.length >= 2) {
    const full = { joins: [], dir: 'h', name: 'Board', dpi: 200, ...st } as LegacyStitch;
    const same = jobs.find((j) => j.mode === 'stitch' && eqCanon(stitchCut((j.settings as any)?.stitch), stitchCut(full)));
    if (same) reasons.push(`join pages: same as the board already made (“${same.name}”)`);
    else built.push(stitchGroup(ctx, { seed: `draft:${key}:stitch`, source, st: full, name: full.name, origin: origin('joined board') }));
  } else if (st) reasons.push('join pages: fewer than two parts');

  for (const b of built) ctx.add(b);
  ctx.absorbed.add(absorbedKey);
  if (built.length) entry('mapped', `→ ${built.length} unmade group${built.length > 1 ? 's' : ''}${reasons.length ? `; ${reasons.join('; ')}` : ''}`, built);
  else entry('dropped', reasons.join('; ') || 'nothing in it');
}

function stitchCut(st: Partial<LegacyStitch> | undefined) {
  if (!st) return null;
  return { parts: st.parts, dir: st.dir, joins: (st.joins ?? []).map((j) => ({ overlap: j.overlap, shift: j.shift })), bleed: st.bleed ?? 0 };
}
