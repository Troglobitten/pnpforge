/**
 * Renders pages / regions of a source (PDF or image) with a small bitmap cache.
 */
import { loadPdf, renderPage, renderRegion, loadImage, mmToPx, type PdfDoc } from '@/lib/pdf';
import { canvasToGray, type GrayImage } from '@/lib/pdfDetect';
import { assetUrlById } from '@/api/client';
import type { Game, RectMm, SourceDoc } from '@/shared/types';

/**
 * What cutting needs from a source: a rectangle at print resolution and a
 * quick low-res crop. SourceRenderer (PDF/image pages) implements it; photo
 * import supplies its own, backed by perspective-corrected photos.
 */
export interface CutRenderer {
  region(page: number, rect: RectMm, dpi: number): Promise<HTMLCanvasElement>;
  crop(page: number, rect: RectMm, maxSide?: number): Promise<HTMLCanvasElement>;
}

const PX_BUDGET = 48_000_000;
export const ANALYSIS_DPI = 100;

export class SourceRenderer {
  private cache = new Map<string, { p: Promise<HTMLCanvasElement>; px: number }>();
  private grays = new Map<number, Promise<GrayImage>>();

  private constructor(
    public source: SourceDoc,
    private pdf: PdfDoc | null,
    private img: HTMLImageElement | null,
  ) {}

  static async open(game: Game, source: SourceDoc): Promise<SourceRenderer> {
    const url = assetUrlById(game, source.assetId);
    if (!url) throw new Error('The original file for this source is missing.');
    if (source.kind === 'pdf') return new SourceRenderer(source, await loadPdf(url), null);
    return new SourceRenderer(source, null, await loadImage(url));
  }

  /** Swap in updated metadata (e.g. an image's print size changed). */
  setSource(source: SourceDoc) {
    if (source.pages.some((p, i) => p.widthMm !== this.source.pages[i]?.widthMm)) {
      this.cache.clear();
      this.grays.clear();
    }
    this.source = source;
  }

  pageSize(i: number) {
    const p = this.source.pages[i];
    return { w: p?.widthMm ?? 210, h: p?.heightMm ?? 297 };
  }

  /** Whole page at a DPI (cached). */
  bitmap(page: number, dpi: number): Promise<HTMLCanvasElement> {
    const key = `${page}@${dpi}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.p;
    }
    const { w, h } = this.pageSize(page);
    const px = mmToPx(w, dpi) * mmToPx(h, dpi);
    const p = this.pdf ? renderPage(this.pdf, page, { dpi }) : Promise.resolve(this.drawImage({ x: 0, y: 0, w, h }, dpi));
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, { p, px });
    this.evict();
    return p;
  }

  private evict() {
    let total = 0;
    for (const v of this.cache.values()) total += v.px;
    for (const [k, v] of this.cache) {
      if (total <= PX_BUDGET || this.cache.size <= 2) break;
      this.cache.delete(k);
      total -= v.px;
    }
  }

  /** A rectangle of a page, freshly rendered at the given DPI. */
  region(page: number, rect: RectMm, dpi: number): Promise<HTMLCanvasElement> {
    if (this.pdf) return renderRegion(this.pdf, page, rect, dpi);
    return Promise.resolve(this.drawImage(rect, dpi));
  }

  /** Fast low-res crop from the cached analysis bitmap (for previews). */
  async crop(page: number, rect: RectMm, maxSide = 200): Promise<HTMLCanvasElement> {
    const src = await this.bitmap(page, ANALYSIS_DPI);
    const k = ANALYSIS_DPI / 25.4;
    const scale = Math.min(1, maxSide / (Math.max(rect.w, rect.h) * k));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(rect.w * k * scale));
    c.height = Math.max(1, Math.round(rect.h * k * scale));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 0, 0, c.width, c.height);
    return c;
  }

  /** Greyscale analysis bitmap (~100 DPI) used for detection and blank checks. */
  gray(page: number): Promise<GrayImage> {
    let g = this.grays.get(page);
    if (!g) {
      g = this.bitmap(page, ANALYSIS_DPI).then((c) => canvasToGray(c, c.width / this.pageSize(page).w));
      g.catch(() => this.grays.delete(page));
      this.grays.set(page, g);
    }
    return g;
  }

  private drawImage(rect: RectMm, dpi: number): HTMLCanvasElement {
    const img = this.img!;
    const { w: pw, h: ph } = this.pageSize(0);
    const sx = img.naturalWidth / pw; // image px per mm
    const sy = img.naturalHeight / ph;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(mmToPx(rect.w, dpi)));
    c.height = Math.max(1, Math.round(mmToPx(rect.h, dpi)));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    const kx = c.width / rect.w;
    const ky = c.height / rect.h;
    // draw the whole image positioned so the rect maps onto the canvas (handles out-of-page rects)
    ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, -rect.x * kx, -rect.y * ky, (img.naturalWidth / sx) * kx, (img.naturalHeight / sy) * ky);
    return c;
  }
}
