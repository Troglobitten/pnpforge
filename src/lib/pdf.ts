/**
 * Thin wrapper around pdf.js shared by the slicer, rules viewer and play-mode
 * rulebook panel.
 *
 *   const doc = await loadPdf(assetUrl(gameId, asset)!);
 *   const sizes = await getPageSizesMm(doc);
 *   const canvas = await renderPage(doc, 0, { dpi: 150 });
 *   const crop = await renderRegion(doc, 0, { x: 10, y: 10, w: 63, h: 88 }, 300);
 *   const blob = await canvasToBlob(crop);
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { RectMm } from '@/shared/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export const PT_PER_MM = 72 / 25.4;
export const mmToPx = (mm: number, dpi: number) => (mm / 25.4) * dpi;
export const pxToMm = (px: number, dpi: number) => (px / dpi) * 25.4;

const urlCache = new Map<string, Promise<PdfDoc>>();

/** Load a PDF from a URL (cached per URL) or from raw bytes (not cached). */
export function loadPdf(src: string | ArrayBuffer | Uint8Array): Promise<PdfDoc> {
  if (typeof src === 'string') {
    let p = urlCache.get(src);
    if (!p) {
      p = pdfjs.getDocument({ url: src }).promise;
      p.catch(() => urlCache.delete(src));
      urlCache.set(src, p);
    }
    return p;
  }
  const data = src instanceof Uint8Array ? src : new Uint8Array(src);
  return pdfjs.getDocument({ data }).promise;
}

/** Page sizes in millimetres (respecting page rotation). */
export async function getPageSizesMm(doc: PdfDoc): Promise<{ widthMm: number; heightMm: number }[]> {
  const out: { widthMm: number; heightMm: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    out.push({ widthMm: vp.width / PT_PER_MM, heightMm: vp.height / PT_PER_MM });
  }
  return out;
}

/** Render a whole page (0-based index) to a new canvas at the given DPI. */
export async function renderPage(
  doc: PdfDoc,
  pageIndex: number,
  opts: { dpi?: number; maxSide?: number; background?: string } = {},
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  let scale = (opts.dpi ?? 150) / 72;
  if (opts.maxSide) scale = Math.min(scale, opts.maxSide / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  await page.render({ canvas, viewport: vp, background: opts.background ?? '#ffffff' }).promise;
  return canvas;
}

/**
 * Render only a rectangle of a page (in page mm) at the given DPI. Much cheaper
 * than rendering the full page at high DPI and cropping.
 */
export async function renderRegion(
  doc: PdfDoc,
  pageIndex: number,
  rect: RectMm,
  dpi: number,
  background = '#ffffff',
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageIndex + 1);
  const scale = dpi / 72;
  const vp = page.getViewport({ scale });
  const x = mmToPx(rect.x, dpi);
  const y = mmToPx(rect.y, dpi);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(mmToPx(rect.w, dpi)));
  canvas.height = Math.max(1, Math.round(mmToPx(rect.h, dpi)));
  await page.render({
    canvas,
    viewport: vp,
    transform: [1, 0, 0, 1, -x, -y],
    background,
  }).promise;
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/webp', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encode failed'))), type, quality),
  );
}

/** Load an image URL into an HTMLImageElement (for image-based sources). */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = url;
  });
}
