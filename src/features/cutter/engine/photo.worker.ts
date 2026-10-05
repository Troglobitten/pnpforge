/**
 * Photo engine worker: decoding, warping the user's frames flat and clean-up
 * all happen here so the page stays responsive on a tablet. Nothing here looks
 * for pieces — the user draws the frames.
 *
 * Memory: a 12 MP photo is ~48 MB as pixels. Each worker keeps at most one
 * full-resolution photo and two medium copies (≤ ~2000 px); anything else is
 * decoded again from the original file when needed.
 */
import { readMeta } from './exif';
import { buildPyramid, cleanUp, colourPrint, detailPrint, gainsFromIlluminant, measureIlluminant, warpItem, type Pyramid, type RGBA } from './warp';
import { dist } from './geom';
import type { AnalyzeResult, WarpParams, WarpResult, WorkerRequest, WorkerResponse } from './engineTypes';

type Job = Exclude<WorkerRequest, { type: 'cancel' } | { type: 'forget' }>;

class JobError extends Error {
  constructor(
    public code: 'cancelled' | 'superseded' | 'decode' | 'heic' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(m, transfer);

/** Browsers (iOS Safari especially) refuse canvases much above 16 MP. */
const MAX_PIXELS = 16_000_000;
const MID_SIDE = 2100;

interface Entry {
  mid?: Pyramid;
  /** Pixels of the decoded photo per pixel of mid.levels[0]. */
  midScale: number;
  w: number;
  h: number;
}
const entries = new Map<string, Entry>();
const midOrder: string[] = [];
let fullCache: { id: string; img: RGBA; pyr: Pyramid } | null = null;

const queue: Job[] = [];
const cancelled = new Set<string>();
let busy = false;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.type === 'cancel') {
    const i = queue.findIndex((j) => j.jobId === m.jobId);
    if (i >= 0) {
      queue.splice(i, 1);
      post({ type: 'error', jobId: m.jobId, code: 'cancelled', message: 'Cancelled' });
    } else cancelled.add(m.jobId);
    return;
  }
  if (m.type === 'forget') {
    entries.delete(m.photoId);
    const k = midOrder.indexOf(m.photoId);
    if (k >= 0) midOrder.splice(k, 1);
    if (fullCache?.id === m.photoId) fullCache = null;
    return;
  }
  if (m.type === 'warp' && m.coalesce) {
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      if (q.type === 'warp' && q.coalesce === m.coalesce) {
        queue.splice(i, 1);
        post({ type: 'error', jobId: q.jobId, code: 'superseded', message: 'Superseded' });
      }
    }
  }
  // quick jobs (previews, light) go before long ones
  const quick = (j: Job) => (j.type === 'warp' && j.output === 'jpeg') || j.type === 'light';
  if (quick(m)) {
    const at = queue.findIndex((j) => !quick(j));
    if (at < 0) queue.push(m);
    else queue.splice(at, 0, m);
  } else queue.push(m);
  void pump();
};

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        if (cancelled.has(job.jobId)) throw new JobError('cancelled', 'Cancelled');
        if (job.type === 'analyze') await analyze(job);
        else if (job.type === 'warp') await warp(job);
        else await light(job);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof JobError ? err.code : msg === 'cancelled' ? 'cancelled' : 'failed';
        post({ type: 'error', jobId: job.jobId, code, message: msg });
      } finally {
        cancelled.delete(job.jobId);
      }
      // let cancel / newer preview messages in between jobs
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    busy = false;
  }
}

const check = (jobId: string) => {
  if (cancelled.has(jobId)) throw new JobError('cancelled', 'Cancelled');
};
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

async function decode(file: Blob): Promise<RGBA> {
  let bmp: ImageBitmap;
  try {
    // honours EXIF orientation, so "width" is what the user sees
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const meta = await readMeta(file);
    if (meta.format === 'heic') throw new JobError('heic', 'This photo is in HEIC format, which this browser can’t open.');
    throw new JobError('decode', 'This file isn’t a photo this browser can open.');
  }
  const s = Math.min(1, Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height)));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const img: RGBA = { data: ctx.getImageData(0, 0, w, h).data, w, h };
  bmp.close();
  c.width = c.height = 1;
  return img;
}

function remember(id: string, e: Entry) {
  entries.set(id, e);
  const k = midOrder.indexOf(id);
  if (k >= 0) midOrder.splice(k, 1);
  midOrder.push(id);
  while (midOrder.length > 2) {
    const old = midOrder.shift()!;
    const o = entries.get(old);
    if (o) o.mid = undefined;
  }
}

function midOf(pyr: Pyramid, w: number, h: number): { mid: Pyramid; scale: number } {
  let k = 0;
  while (k + 1 < pyr.levels.length && Math.max(pyr.levels[k].w, pyr.levels[k].h) > MID_SIDE) k++;
  return { mid: { levels: pyr.levels.slice(k) }, scale: w / pyr.levels[k].w };
}

async function toJpeg(img: RGBA, quality: number): Promise<Blob> {
  const c = new OffscreenCanvas(img.w, img.h);
  c.getContext('2d')!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.w, img.h), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

function levelAtMost(pyr: Pyramid, side: number): RGBA {
  let lv = pyr.levels[0];
  for (const l of pyr.levels) {
    lv = l;
    if (Math.max(l.w, l.h) <= side) break;
  }
  return lv;
}

async function analyze(job: Extract<Job, { type: 'analyze' }>) {
  const { jobId, photoId, file } = job;
  const progress = (value: number, label: string) => post({ type: 'progress', jobId, value, label });
  progress(0.05, 'Opening the photo');
  const meta = await readMeta(file);
  fullCache = null;
  const img = await decode(file);
  check(jobId);
  progress(0.6, 'Making previews');
  await yieldNow();
  const pyr = buildPyramid(img);
  const { mid, scale } = midOf(pyr, img.w, img.h);
  const display = await toJpeg(levelAtMost(pyr, MID_SIDE), 0.86);
  const thumb = await toJpeg(levelAtMost(pyr, 560), 0.8);
  check(jobId);
  remember(photoId, { mid, midScale: scale, w: img.w, h: img.h });
  fullCache = { id: photoId, img, pyr };
  const result: AnalyzeResult = { width: img.w, height: img.h, takenAt: meta.takenAt, display, thumb };
  post({ type: 'done', jobId, result });
}

async function ensureMid(photoId: string, file: Blob): Promise<Entry> {
  const e = entries.get(photoId);
  if (e?.mid) {
    remember(photoId, e);
    return e;
  }
  const full = await ensureFull(photoId, file);
  const { mid, scale } = midOf(full.pyr, full.img.w, full.img.h);
  const next: Entry = { ...(e ?? {}), mid, midScale: scale, w: full.img.w, h: full.img.h };
  remember(photoId, next);
  return next;
}

async function ensureFull(photoId: string, file: Blob) {
  if (fullCache?.id === photoId) return fullCache;
  fullCache = null;
  const img = await decode(file);
  fullCache = { id: photoId, img, pyr: buildPyramid(img) };
  return fullCache;
}


async function warp(job: Extract<Job, { type: 'warp' }>) {
  const { jobId, photoId, file, params, output } = job;
  const p: WarpParams = params;
  const stop = () => cancelled.has(jobId);
  const aspect = p.wMm / p.hMm;
  let outW: number;
  let outH: number;
  let pyr: Pyramid;
  let quadScale = 1;
  if (p.maxSide) {
    const e = await ensureMid(photoId, file);
    pyr = e.mid!;
    quadScale = e.midScale;
    outW = aspect >= 1 ? p.maxSide : Math.round(p.maxSide * aspect);
    outH = aspect >= 1 ? Math.round(p.maxSide / aspect) : p.maxSide;
  } else {
    const full = await ensureFull(photoId, file);
    pyr = full.pyr;
    // never invent more detail than the photo holds (plus a little headroom)
    const pxW = (dist(p.quad[0], p.quad[1]) + dist(p.quad[3], p.quad[2])) / 2;
    const pxH = (dist(p.quad[0], p.quad[3]) + dist(p.quad[1], p.quad[2])) / 2;
    const native = Math.max((pxW / p.wMm) * 25.4, (pxH / p.hMm) * 25.4);
    // a little above what the photo holds, but never so few pixels that text goes soft
    const dpi = Math.min(p.dpi ?? 300, Math.max(250, native * 1.15));
    outW = Math.max(8, Math.round((p.wMm / 25.4) * dpi));
    outH = Math.max(8, Math.round((p.hMm / 25.4) * dpi));
  }
  check(jobId);
  const raw = warpItem(pyr, p.quad, {
    outW: Math.max(8, outW),
    outH: Math.max(8, outH),
    trimX: p.clean.trimMm / p.wMm,
    trimY: p.clean.trimMm / p.hMm,
    quadScale,
    shouldStop: stop,
  });
  check(jobId);
  const cl = cleanUp(raw, { color: p.clean.color, flatten: p.clean.flatten, corner: p.clean.cornerMm / Math.min(p.wMm, p.hMm), gains: p.gains, borrowed: p.borrowed });
  const fp = colourPrint(cl);
  const detail = detailPrint(cl);
  if (output === 'jpeg') {
    const blob = await toJpeg(cl, 0.88);
    const result: WarpResult = { blob, width: cl.w, height: cl.h, fp, detail };
    post({ type: 'done', jobId, result });
  } else {
    const c = new OffscreenCanvas(cl.w, cl.h);
    c.getContext('2d')!.putImageData(new ImageData(cl.data as Uint8ClampedArray<ArrayBuffer>, cl.w, cl.h), 0, 0);
    const bitmap = c.transferToImageBitmap();
    const result: WarpResult = { bitmap, width: cl.w, height: cl.h, fp, detail };
    post({ type: 'done', jobId, result }, [bitmap]);
  }
}

/**
 * The colour of the light in a photo, read from the paper of the pieces the
 * user framed in it (see measureIlluminant). null = no paper to judge by.
 */
async function light(job: Extract<Job, { type: 'light' }>) {
  const { jobId, photoId, file, quads } = job;
  const e = await ensureMid(photoId, file);
  const flats: RGBA[] = [];
  for (const q of quads) {
    check(jobId);
    const sw = dist(q[0], q[1]);
    const sh = dist(q[0], q[3]);
    const s = 160 / Math.max(sw, sh, 1);
    flats.push(warpItem(e.mid!, q, { outW: Math.max(8, Math.round(sw * s)), outH: Math.max(8, Math.round(sh * s)), quadScale: e.midScale, trimX: 0.05, trimY: 0.05 }));
  }
  post({ type: 'done', jobId, result: flats.length ? gainsFromIlluminant(measureIlluminant(flats, 0)) : null });
}
