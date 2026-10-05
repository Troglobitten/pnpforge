/**
 * One renderer for every kind of page (v3 unified cutter): a PDF page, a flat image (the legacy
 * one-image source, or a scan in an image set) and a camera photo. Replaces the slicer's
 * SourceRenderer and the photo import's CutRenderer as the thing make.ts cuts through.
 *
 * `renderFrame` picks one of three paths:
 *  - 'crop'  — flat page, frame is an axis-aligned rectangle (any quarter turn): the page region is
 *              rendered straight at the output dpi (pdf.js vector crop, or a scaled image draw) —
 *              exactly the old slicer's cut, pixel for pixel;
 *  - 'warp'  — flat page, frame rotated or skewed: the frame's bounding box is rendered at 2× the
 *              output dpi and pulled flat through the frame's homography (photos' warpItem), so the
 *              piece comes out upright with nothing from outside the frame in it;
 *  - 'photo' — a photo page: the photo engine's worker warp + "look like a scan" clean-up with the
 *              photo's light, exactly as photo import renders today. Clean-up never runs elsewhere.
 */
import { assetUrlById } from '@/api/client';
import { loadImage, mmToPx } from '@/lib/pdf';
import { canvasToGray, isBlankRegion, type GrayImage } from '@/lib/pdfDetect';
import type { CutQuad, Game, SourceDoc, SourcePage } from '@/shared/types';
import { axisFrame, quadBounds, type Quad } from '@/shared/cutter/geom';
import { hash53, pageUnits } from '@/shared/cutter/doc';
import { SourceRenderer } from './renderer';
import { warpItem, type RGBA } from './engine/warp';
import { getEngine } from './engine/engine';

export type RenderPath = 'crop' | 'warp' | 'photo';

export interface RenderFrameOpts {
  page: number;
  /** The frame in page units, corners [TL, TR, BR, BL] of the piece as it stands upright. */
  quad: CutQuad;
  /**
   * Finished size in mm (after the trim). Photo pages and warped flat frames come out this size;
   * a straight frame on a flat page renders exactly what is printed and ignores it.
   */
  mm: { w: number; h: number };
  /** Cut off every edge of the frame, mm. */
  trimMm: number;
  dpi: number;
  /** Photo pages only ("look like a scan"); ignored on flat pages. */
  clean?: { color: number; flatten: number; cornerMm: number };
}

export interface RenderedFrame {
  canvas: HTMLCanvasElement;
  path: RenderPath;
}

export interface PageSource {
  source: SourceDoc;
  /** Units of frame coordinates on this source's pages. */
  readonly units: 'mm' | 'px';
  isPhoto(page: number): boolean;
  /** The latest source data (e.g. a newly measured light) without reopening the file. */
  setSource(source: SourceDoc): void;
  /** The whole page for the stage and thumbnails, longest side ≤ maxSide px. */
  display(page: number, maxSide: number): Promise<HTMLCanvasElement>;
  /** Resolutions (px per page unit) the stage can ask for, ascending. */
  levels(page: number): number[];
  /** The whole page at one of `levels` (cached). */
  bitmapAt(page: number, pxPerUnit: number): Promise<HTMLCanvasElement>;
  renderFrame(o: RenderFrameOpts): Promise<RenderedFrame>;
  /** A small straightened preview of a frame (JPEG), longest side ≈ maxSide px. Photos: with clean-up. */
  previewFrame(o: RenderFrameOpts & { maxSide: number }): Promise<Blob>;
  /** Photos: the colour of the light, measured from the paper inside these frames (null = no paper). */
  measureLight(page: number, quads: CutQuad[]): Promise<[number, number, number] | null>;
  /** Flat pages: the trimmed frame carries no ink (the slicer's "skip empty spaces"). Photos: never. */
  isBlank(page: number, quad: CutQuad, trimMm: number): Promise<boolean>;
  /**
   * The analysis bitmap (grey, ~100 dpi, in mm) the flat-page helpers read. `null` on a photo page:
   * the helpers never see a photograph (owner ruling Q1).
   */
  flatGray(page: number): Promise<GrayImage | null>;
  /** Page units → mm (1 on PDF pages; a scan's mm per px; null on a photo). */
  mmPerUnit(page: number): number | null;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* shared bits                                                          */
/* ------------------------------------------------------------------ */

/** Mild tolerance for "is this an axis-aligned rectangle" (page units). */
const AXIS_EPS = 1e-4;
/** Pixel budget of the bounding-box render behind a warp. */
const WARP_BUDGET = 40_000_000;

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function canvasToRGBA(c: HTMLCanvasElement): RGBA {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  return { data: d.data, w: c.width, h: c.height };
}

function rgbaToCanvas(img: RGBA): HTMLCanvasElement {
  const c = newCanvas(img.w, img.h);
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0);
  return c;
}

/** Turn a canvas by quarter turns clockwise (exact pixel moves). */
export function turnCanvas(src: HTMLCanvasElement, turn: number): HTMLCanvasElement {
  const k = ((turn % 4) + 4) % 4;
  if (!k) return src;
  const c = k % 2 ? newCanvas(src.height, src.width) : newCanvas(src.width, src.height);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  if (k === 1) ctx.setTransform(0, 1, -1, 0, c.width, 0);
  else if (k === 2) ctx.setTransform(-1, 0, 0, -1, c.width, c.height);
  else ctx.setTransform(0, -1, 1, 0, 0, c.height);
  ctx.drawImage(src, 0, 0);
  src.width = src.height = 0;
  return c;
}

/**
 * The frame's piece from a raster of its bounding box: `toRaster` maps page units to raster
 * pixels. Output: the frame's size less the trim at `dpi`.
 */
function warpFromRaster(raster: RGBA, quad: Quad, toRaster: (p: [number, number]) => [number, number], mm: { w: number; h: number }, trimMm: number, dpi: number): HTMLCanvasElement {
  const q = quad.map(toRaster) as Quad;
  // `mm` is the finished piece; the frame is that plus the trim on every side
  const wMm = Math.max(0.1, mm.w);
  const hMm = Math.max(0.1, mm.h);
  const out = warpItem({ levels: [raster] }, q, {
    outW: Math.max(1, Math.round(mmToPx(wMm, dpi))),
    outH: Math.max(1, Math.round(mmToPx(hMm, dpi))),
    trimX: trimMm / (wMm + 2 * trimMm),
    trimY: trimMm / (hMm + 2 * trimMm),
  });
  return rgbaToCanvas(out);
}

/** A flat page's preview: the real render at a low resolution. */
async function flatPreview(ps: PageSource, o: RenderFrameOpts & { maxSide: number }): Promise<Blob> {
  const longest = Math.max(o.mm.w, o.mm.h, 1);
  const dpi = Math.max(24, Math.min(200, (o.maxSide / longest) * 25.4));
  const { canvas } = await ps.renderFrame({ ...o, dpi });
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
  canvas.width = canvas.height = 0;
  return blob;
}

/* ------------------------------------------------------------------ */
/* PDF pages and the legacy one-image source (page mm)                  */
/* ------------------------------------------------------------------ */

class DocPageSource implements PageSource {
  readonly units = 'mm' as const;
  constructor(
    public source: SourceDoc,
    private r: SourceRenderer,
  ) {}

  setSource(source: SourceDoc) {
    this.source = source;
    this.r.setSource(source);
  }

  isPhoto() {
    return false;
  }

  async display(page: number, maxSide: number) {
    const { w, h } = this.r.pageSize(page);
    const dpi = Math.max(24, Math.floor((maxSide / Math.max(w, h)) * 25.4));
    return this.r.bitmap(page, dpi);
  }

  levels() {
    return [100, 150, 200, 300].map((d) => d / 25.4);
  }

  bitmapAt(page: number, pxPerUnit: number) {
    return this.r.bitmap(page, Math.round(pxPerUnit * 25.4));
  }

  async renderFrame(o: RenderFrameOpts): Promise<RenderedFrame> {
    const ax = axisFrame(o.quad, AXIS_EPS);
    if (ax) {
      const t = o.trimMm;
      const rect = { x: ax.rect.x + t, y: ax.rect.y + t, w: ax.rect.w - 2 * t, h: ax.rect.h - 2 * t };
      // exactly the old slicer's cut (renderRegion / image draw at the dpi), turned upright
      const c = await this.r.region(o.page, rect, o.dpi);
      return { canvas: turnCanvas(c, ax.turn), path: 'crop' };
    }
    const b = quadBounds(o.quad);
    let k = 2;
    while (k > 1 && mmToPx(b.w + 2, o.dpi * k) * mmToPx(b.h + 2, o.dpi * k) > WARP_BUDGET) k -= 0.25;
    const box = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
    const c = await this.r.region(o.page, box, o.dpi * k);
    const raster = canvasToRGBA(c);
    c.width = c.height = 0;
    const s = (o.dpi * k) / 25.4;
    return { canvas: warpFromRaster(raster, o.quad, (p) => [(p[0] - box.x) * s, (p[1] - box.y) * s], o.mm, o.trimMm, o.dpi), path: 'warp' };
  }

  async isBlank(page: number, quad: CutQuad, trimMm: number) {
    const b = quadBounds(quad);
    return isBlankRegion(await this.r.gray(page), { x: b.x + trimMm, y: b.y + trimMm, w: b.w - 2 * trimMm, h: b.h - 2 * trimMm });
  }

  flatGray(page: number) {
    return this.r.gray(page);
  }

  mmPerUnit() {
    return 1;
  }

  async previewFrame(o: RenderFrameOpts & { maxSide: number }) {
    return flatPreview(this, o);
  }

  async measureLight() {
    return null;
  }

  dispose() {}
}

/* ------------------------------------------------------------------ */
/* Image sets: one file per page, each a photo or a flat scan (px)      */
/* ------------------------------------------------------------------ */

class ImageSetSource implements PageSource {
  readonly units = 'px' as const;
  private imgs = new Map<number, Promise<HTMLImageElement>>();
  private files = new Map<number, Promise<File>>();
  private grays = new Map<number, Promise<GrayImage>>();

  constructor(
    public source: SourceDoc,
    private game: Pick<Game, 'id' | 'assets'>,
  ) {}

  setSource(source: SourceDoc) {
    this.source = source;
  }

  private pg(page: number): SourcePage {
    const p = this.source.pages[page];
    if (!p) throw new Error(`Page ${page + 1} is not in “${this.source.name}”.`);
    return p;
  }

  private url(page: number): string {
    const url = assetUrlById(this.game, this.pg(page).assetId);
    if (!url) throw new Error(`The original of “${this.pg(page).name ?? `page ${page + 1}`}” is missing.`);
    return url;
  }

  private img(page: number): Promise<HTMLImageElement> {
    let p = this.imgs.get(page);
    if (!p) {
      p = loadImage(this.url(page));
      p.catch(() => this.imgs.delete(page));
      this.imgs.set(page, p);
    }
    return p;
  }

  private file(page: number): Promise<File> {
    let p = this.files.get(page);
    if (!p) {
      const pg = this.pg(page);
      p = fetch(this.url(page))
        .then((r) => r.blob())
        .then((b) => new File([b], pg.name ?? `page-${page + 1}`, { type: b.type, lastModified: pg.lastModified ?? 0 }));
      p.catch(() => this.files.delete(page));
      this.files.set(page, p);
    }
    return p;
  }

  isPhoto(page: number) {
    return !!this.source.pages[page]?.photo;
  }

  /** mm per pixel of a flat scan. */
  private mmPerPx(page: number): number {
    const p = this.pg(page);
    if (p.dpi) return 25.4 / p.dpi;
    if (p.px?.w && p.widthMm > 0) return p.widthMm / p.px.w;
    throw new Error(`“${p.name ?? `Page ${page + 1}`}” has no print resolution.`);
  }

  /** The photo's light, or the light of the photo taken closest in time (as photo import does). */
  private light(page: number): { gains: [number, number, number] | null; borrowed?: boolean } {
    const p = this.pg(page);
    if (p.gains) return { gains: p.gains };
    const t = p.takenAt ?? p.lastModified ?? 0;
    const donor = this.source.pages
      .filter((x) => x.index !== p.index && x.photo && x.gains)
      .sort((a, b) => Math.abs((a.takenAt ?? a.lastModified ?? 0) - t) - Math.abs((b.takenAt ?? b.lastModified ?? 0) - t))[0];
    return donor ? { gains: donor.gains!, borrowed: true } : { gains: null };
  }

  private bitmaps = new Map<string, Promise<HTMLCanvasElement>>();

  levels(page: number) {
    const p = this.source.pages[page];
    const side = Math.max(p?.px?.w ?? 2000, p?.px?.h ?? 2000);
    // from a ~1000 px overview up to the photo itself
    return [...new Set([Math.min(1, 1000 / side), Math.min(1, 2000 / side), 1])].sort((a, b) => a - b);
  }

  bitmapAt(page: number, pxPerUnit: number) {
    const key = `${page}@${pxPerUnit.toFixed(4)}`;
    let p = this.bitmaps.get(key);
    if (!p) {
      p = this.img(page).then((img) => {
        const c = newCanvas(Math.round(img.naturalWidth * pxPerUnit), Math.round(img.naturalHeight * pxPerUnit));
        const ctx = c.getContext('2d')!;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, c.width, c.height);
        return c;
      });
      p.catch(() => this.bitmaps.delete(key));
      this.bitmaps.set(key, p);
      // keep a handful
      while (this.bitmaps.size > 6) this.bitmaps.delete(this.bitmaps.keys().next().value!);
    }
    return p;
  }

  async display(page: number, maxSide: number) {
    const img = await this.img(page);
    const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = newCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  async renderFrame(o: RenderFrameOpts): Promise<RenderedFrame> {
    if (this.isPhoto(o.page)) {
      const clean = o.clean ?? { color: 1, flatten: 0.7, cornerMm: 0 };
      const r = await getEngine().render(`${this.source.id}:${o.page}`, await this.file(o.page), {
        quad: o.quad,
        wMm: o.mm.w,
        hMm: o.mm.h,
        clean: { color: clean.color, flatten: clean.flatten, trimMm: o.trimMm, cornerMm: clean.cornerMm },
        ...this.light(o.page),
        dpi: o.dpi,
      }).promise;
      const c = newCanvas(r.width, r.height);
      c.getContext('2d')!.drawImage(r.bitmap!, 0, 0);
      r.bitmap!.close();
      return { canvas: c, path: 'photo' };
    }
    const img = await this.img(o.page);
    const mpp = this.mmPerPx(o.page);
    const tpx = o.trimMm / mpp;
    const ax = axisFrame(o.quad, AXIS_EPS / mpp);
    if (ax) {
      const r = { x: ax.rect.x + tpx, y: ax.rect.y + tpx, w: ax.rect.w - 2 * tpx, h: ax.rect.h - 2 * tpx };
      const c = newCanvas(Math.round(mmToPx(r.w * mpp, o.dpi)), Math.round(mmToPx(r.h * mpp, o.dpi)));
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.imageSmoothingQuality = 'high';
      const kx = c.width / r.w;
      const ky = c.height / r.h;
      ctx.drawImage(img, -r.x * kx, -r.y * ky, img.naturalWidth * kx, img.naturalHeight * ky);
      return { canvas: turnCanvas(c, ax.turn), path: 'crop' };
    }
    // warp from the image's own pixels (never more than it holds)
    const b = quadBounds(o.quad);
    const box = { x: Math.max(0, Math.floor(b.x) - 2), y: Math.max(0, Math.floor(b.y) - 2) };
    const w = Math.min(img.naturalWidth, Math.ceil(b.x + b.w) + 2) - box.x;
    const h = Math.min(img.naturalHeight, Math.ceil(b.y + b.h) + 2) - box.y;
    const c = newCanvas(w, h);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, -box.x, -box.y);
    const raster = canvasToRGBA(c);
    c.width = c.height = 0;
    return { canvas: warpFromRaster(raster, o.quad, (p) => [p[0] - box.x, p[1] - box.y], o.mm, o.trimMm, o.dpi), path: 'warp' };
  }

  async previewFrame(o: RenderFrameOpts & { maxSide: number }) {
    if (!this.isPhoto(o.page)) return flatPreview(this, o);
    const clean = o.clean ?? { color: 1, flatten: 0.7, cornerMm: 0 };
    const r = await getEngine().preview(
      `${this.source.id}:${o.page}`,
      await this.file(o.page),
      { quad: o.quad, wMm: o.mm.w, hMm: o.mm.h, clean: { color: clean.color, flatten: clean.flatten, trimMm: o.trimMm, cornerMm: clean.cornerMm }, ...this.light(o.page), maxSide: o.maxSide },
      `cut-preview:${this.source.id}:${o.page}:${o.quad.flat().map((v) => Math.round(v)).join(',')}`,
    ).promise;
    return r.blob!;
  }

  async measureLight(page: number, quads: CutQuad[]) {
    if (!this.isPhoto(page) || !quads.length) return null;
    return getEngine().light(`${this.source.id}:${page}`, await this.file(page), quads).promise;
  }

  mmPerUnit(page: number) {
    return this.isPhoto(page) ? null : this.mmPerPx(page);
  }

  async flatGray(page: number): Promise<GrayImage | null> {
    if (this.isPhoto(page)) return null;
    return this.gray(page);
  }

  async isBlank(page: number, quad: CutQuad, trimMm: number) {
    if (this.isPhoto(page)) return false;
    const mpp = this.mmPerPx(page);
    const b = quadBounds(quad);
    return isBlankRegion(await this.gray(page), { x: b.x * mpp + trimMm, y: b.y * mpp + trimMm, w: b.w * mpp - 2 * trimMm, h: b.h * mpp - 2 * trimMm });
  }

  /** A flat scan's analysis bitmap (never called for a photo). */
  private gray(page: number): Promise<GrayImage> {
    let g = this.grays.get(page);
    const mpp = this.mmPerPx(page);
    if (!g) {
      g = this.img(page).then((img) => {
        // ~100 dpi, like the slicer's analysis bitmap
        const s = Math.min(1, 100 / 25.4 / (1 / mpp));
        const c = newCanvas(Math.round(img.naturalWidth * s), Math.round(img.naturalHeight * s));
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const gray = canvasToGray(c, c.width / (img.naturalWidth * mpp));
        c.width = c.height = 0;
        return gray;
      });
      g.catch(() => this.grays.delete(page));
      this.grays.set(page, g);
    }
    return g;
  }

  dispose() {
    this.bitmaps.clear();
    this.imgs.clear();
    this.files.clear();
    this.grays.clear();
  }
}

/* ------------------------------------------------------------------ */
/* opening                                                              */
/* ------------------------------------------------------------------ */

const open = new Map<string, Promise<PageSource>>();

/** The PageSource of a source (cached per game + source; call `closePageSources` when leaving). */
export function openPageSource(game: Pick<Game, 'id' | 'assets'>, source: SourceDoc): Promise<PageSource> {
  // a page switched between photo and scan (or re-pointed) gets a fresh source
  const key = `${game.id}:${source.id}:${hash53(JSON.stringify(source.pages.map((p) => [p.photo ?? null, p.dpi ?? null, p.assetId ?? null, p.widthMm])))}`;
  let p = open.get(key);
  if (!p) {
    p =
      pageUnits(source) === 'px'
        ? Promise.resolve(new ImageSetSource(source, game))
        : SourceRenderer.open(game as Game, source).then((r) => new DocPageSource(source, r));
    p.catch(() => open.delete(key));
    open.set(key, p);
  }
  return p.then((ps) => {
    if (ps.source !== source) ps.setSource(source);
    return ps;
  });
}

export function closePageSources(gameId?: string) {
  for (const [k, p] of open) {
    if (gameId && !k.startsWith(`${gameId}:`)) continue;
    open.delete(k);
    void p.then((s) => s.dispose()).catch(() => undefined);
  }
}
