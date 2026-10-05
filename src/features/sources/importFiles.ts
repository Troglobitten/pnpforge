/**
 * Source files, the reading half: what a PDF becomes, and the small helpers the rest of the app
 * shares. ADDING files is `features/cutter/addSources.ts` (`addFiles`) — one road in, from the
 * Sources page, the Cutter, the Library and a new game alike — so owner ruling Q2 holds everywhere:
 * a PDF becomes a PDF source, images become one image set whose pages are photos by default, each
 * with its own "This is a photo" switch.
 */
import { api } from '@/api/client';
import { canvasToBlob, getPageSizesMm, loadImage, loadPdf, renderPage } from '@/lib/pdf';
import { useGame } from '@/state/gameStore';
import { toast } from '@/ui';
import type { Asset, ID, SourceDoc } from '@/shared/types';
import { newId } from '@/shared/ids';

export type ImportStage = 'queued' | 'reading' | 'uploading' | 'previews' | 'saving' | 'done' | 'error';

export interface ImportTask {
  id: string;
  gameId: ID;
  name: string;
  kind: 'pdf' | 'image' | 'other';
  bytes: number;
  stage: ImportStage;
  progress: number | null;
  detail: string;
  error?: string;
  sourceId?: ID;
}

/** Recently added sources (for a short highlight on the Sources page). */
export const recentSources = new Set<ID>();

let running = false;

export const IMAGE_DPI = 300;
const THUMB_SIDE = 360;

export function fileKind(f: File): ImportTask['kind'] {
  const n = f.name.toLowerCase();
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/^image\/(png|jpeg|webp|gif|avif)$/.test(f.type) || /\.(png|jpe?g|webp|gif|avif)$/.test(n)) return 'image';
  return 'other';
}

export function baseName(name: string) {
  return name.replace(/\.[a-z0-9]+$/i, '').trim() || 'Untitled';
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Read a PDF, upload it and its page previews, and return the source — without adding it to the
 * game (the caller does: the Sources import here, or the Cutter as one of its own undo steps).
 */
export async function buildPdfSource(gameId: ID, file: File, progress: (p: Partial<ImportTask>) => void): Promise<{ source: SourceDoc; assets: Asset[] }> {
  const task = { id: '', gameId };
  const upd = (_id: string, p: Partial<ImportTask>) => progress(p);
  upd(task.id, { stage: 'reading', progress: null, detail: 'Reading pages…' });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = await loadPdf(bytes);
  try {
    const sizes = await getPageSizesMm(doc);
    const n = sizes.length;

    upd(task.id, { stage: 'uploading', progress: 0, detail: `Uploading ${fmtBytes(file.size)}…` });
    const [original] = await api.uploadAssets(task.gameId, [file], {
      role: 'source',
      onProgress: (p) => upd(task.id, { progress: p }),
    });

    upd(task.id, { stage: 'previews', progress: 0, detail: `Page previews 0 of ${n}` });
    const thumbs: Asset[] = [];
    let batch: { blob: Blob; name: string }[] = [];
    const base = baseName(file.name);
    for (let i = 0; i < n; i++) {
      const canvas = await renderPage(doc, i, { dpi: 150, maxSide: THUMB_SIDE });
      batch.push({ blob: await canvasToBlob(canvas, 'image/webp', 0.85), name: `${base}-p${i + 1}.webp` });
      canvas.width = canvas.height = 0;
      if (batch.length === 8 || i === n - 1) {
        thumbs.push(...(await api.uploadAssets(task.gameId, batch, { role: 'page' })));
        batch = [];
      }
      upd(task.id, { progress: (i + 1) / n, detail: `Page previews ${i + 1} of ${n}` });
    }

    upd(task.id, { stage: 'saving', progress: null, detail: 'Saving…' });
    const source: SourceDoc = {
      id: newId(),
      name: base,
      kind: 'pdf',
      assetId: original.id,
      pageCount: n,
      pages: sizes.map((s, i) => ({ index: i, widthMm: round(s.widthMm), heightMm: round(s.heightMm), thumb: thumbs[i]?.id ?? null })),
      createdAt: Date.now(),
    };
    return { source, assets: [original, ...thumbs] };
  } finally {
    void doc.loadingTask.destroy();
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

