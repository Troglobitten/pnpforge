/**
 * "Add PDFs or images" from the Cutter (owner Q2: one button). A PDF becomes a PDF source. Images
 * become one image set per batch: every image is a page with its own original and its own "This is
 * a photo" switch (on by default — a photo gets perspective handles; off, it is a flat scan at
 * 300 dpi with square frames). Nothing is detected or guessed from the pixels.
 *
 * Adding is one step on the Cutter's undo stack (see store.commitWithGame): undo takes the source
 * back out of the game, redo puts it back. The uploaded files stay on the server either way —
 * nothing is ever deleted from under the cut.
 */
import { create } from 'zustand';
import { api } from '@/api/client';
import { canvasToBlob } from '@/lib/pdf';
import { useGame } from '@/state/gameStore';
import { toast } from '@/ui';
import type { Asset, CutterDoc, ID, PageRef, SourceDoc, SourcePage } from '@/shared/types';
import { readMeta } from './engine/exif';
import { baseName, buildPdfSource, fileKind } from '@/features/sources/importFiles';
import { newId } from '@/shared/ids';
import { commitWithGame, useCutter } from './store';
import { pageContent, propagate } from './ops';
import { squareAnchors } from '@/shared/cutter/grid';

export const ACCEPT = 'application/pdf,.pdf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
export const SCAN_DPI = 300;
/** Below this many pixels on the short side a photo is too coarse to cut useful pieces from. */
const SMALL_PHOTO = 800;

export interface AddTask {
  id: string;
  /** Which game it is being added to (the Sources page shows only its own). */
  gameId: ID;
  label: string;
  detail: string;
  /** Bytes of the file(s), for the row on the Sources page. */
  bytes: number;
  kind: 'pdf' | 'image';
  error?: string;
}

export const useAddTasks = create<{ tasks: AddTask[] }>(() => ({ tasks: [] }));
const setTask = (id: string, patch: Partial<AddTask>) => useAddTasks.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
const dropTask = (id: string) => useAddTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
const startTask = (gameId: ID, label: string, kind: AddTask['kind'], bytes: number) => {
  const id = newId();
  useAddTasks.setState((s) => ({ tasks: [...s.tasks, { id, gameId, label, kind, bytes, detail: 'Waiting…' }] }));
  return id;
};

/** Dismiss a finished or failed row. */
export const dismissAddTask = (id: string) => dropTask(id);

/** Put a new source into the game: an undo step in the Cutter when it is open, else a plain edit. */
function addSource(gameId: ID, source: SourceDoc, assets: Asset[]) {
  const gs = useGame.getState();
  if (gs.game?.id !== gameId) {
    // the user left meanwhile: straight to the server
    void api.getGame(gameId).then((g) => api.saveGame({ ...g, sources: [...g.sources, source] }));
    return;
  }
  gs.addAssets(assets);
  const label = `Add ${source.name}`;
  if (useCutter.getState().gameId === gameId && useCutter.getState().status === 'ready') commitWithGame(label, null, (g) => void g.sources.push(source));
  else gs.update((g) => void g.sources.push(source), label);
}

/** Add files: PDFs as PDF sources, images as one new image set. Returns the first new page (to open). */
export async function addFiles(gameId: ID, list: File[]): Promise<PageRef | null> {
  const pdfs = list.filter((f) => fileKind(f) === 'pdf');
  const images = list.filter((f) => fileKind(f) === 'image');
  const other = list.length - pdfs.length - images.length;
  if (other) toast.error(`${other === 1 ? 'One file was' : `${other} files were`} skipped`, { description: 'Only PDF and image files (PNG, JPG, WebP) can be added.' });
  let first: PageRef | null = null;
  if (images.length) {
    const id = await importImages(gameId, images);
    if (id) first = { sourceId: id, page: 0 };
  }
  for (const f of pdfs) {
    const id = await importPdf(gameId, f);
    if (id && !first) first = { sourceId: id, page: 0 };
  }
  return first;
}

async function importPdf(gameId: ID, file: File): Promise<ID | null> {
  const id = startTask(gameId, file.name, 'pdf', file.size);
  try {
    const { source, assets } = await buildPdfSource(gameId, file, (p) => setTask(id, { detail: p.detail ?? '' }));
    addSource(gameId, source, assets);
    toast.success(`Added “${source.name}”`, { description: `${source.pageCount === 1 ? '1 page' : `${source.pageCount} pages`} ready to cut` });
    dropTask(id);
    return source.id;
  } catch (e: any) {
    const msg = e?.name === 'InvalidPDFException' ? 'This PDF looks damaged or is not a PDF.' : e?.name === 'PasswordException' ? 'This PDF is password protected.' : (e?.message ?? 'The PDF could not be added.');
    setTask(id, { error: msg, detail: msg });
    window.setTimeout(() => dropTask(id), 8000);
    return null;
  }
}

/** Longest side of the page previews. */
const THUMB_SIDE = 360;

export const scanMm = (px: number, dpi = SCAN_DPI) => Math.round((px / dpi) * 25.4 * 100) / 100;

async function importImages(gameId: ID, files: File[]): Promise<ID | null> {
  const id = startTask(gameId, files.length === 1 ? files[0].name : `${files.length} images`, 'image', files.reduce((n, f) => n + f.size, 0));
  const uploaded: Asset[] = [];
  try {
    const pages: (SourcePage & { sortAt: number })[] = [];
    const small: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setTask(id, { detail: `${i} of ${files.length}` });
      let bmp: ImageBitmap;
      try {
        // what the user sees: EXIF orientation applied
        bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      } catch {
        throw new Error(`“${f.name}” can’t be opened in this browser.`);
      }
      const meta = await readMeta(f).catch(() => ({ takenAt: null as number | null }));
      const w = bmp.width;
      const h = bmp.height;
      if (Math.min(w, h) < SMALL_PHOTO) small.push(`${f.name} (${w} × ${h} px)`);
      const s = Math.min(1, THUMB_SIDE / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const thumbBlob = await canvasToBlob(c, 'image/webp', 0.85);
      c.width = c.height = 0;
      const [original] = await api.uploadAssets(gameId, [f], { role: 'photo' });
      uploaded.push(original);
      const [thumb] = await api.uploadAssets(gameId, [{ blob: thumbBlob, name: `${baseName(f.name)}-preview.webp` }], { role: 'page' });
      uploaded.push(thumb);
      const takenAt = (meta as { takenAt: number | null }).takenAt ?? null;
      pages.push({ index: 0, widthMm: 0, heightMm: 0, thumb: thumb.id, assetId: original.id, name: f.name, px: { w, h }, photo: true, dpi: SCAN_DPI, takenAt, lastModified: f.lastModified, gains: null, sortAt: takenAt ?? f.lastModified });
    }
    // in the order they were taken
    pages.sort((a, b) => a.sortAt - b.sortAt);
    const source: SourceDoc = {
      id: newId(),
      name: files.length === 1 ? baseName(files[0].name) : `Images (${files.length})`,
      kind: 'images',
      assetId: '',
      pageCount: pages.length,
      pages: pages.map(({ sortAt: _s, ...p }, i) => ({ ...p, index: i })),
      createdAt: Date.now(),
    };
    addSource(gameId, source, uploaded);
    toast.success(`Added ${files.length === 1 ? '1 image' : `${files.length} images`}`, { description: 'Each is treated as a photo — switch it off for a flat scan.' });
    if (small.length) toast.warning(small.length === 1 ? 'This image is very small' : `${small.length} images are very small`, { description: `${small.join(', ')} — pieces cut from it will look blurry. A photo at least ${SMALL_PHOTO} px on the short side works much better.`, duration: 9000 });
    dropTask(id);
    return source.id;
  } catch (e) {
    // nothing references these yet
    if (uploaded.length) await api.deleteAssets(gameId, uploaded.map((a) => a.id)).catch(() => undefined);
    const msg = e instanceof Error ? e.message : 'The images could not be added.';
    setTask(id, { error: msg, detail: msg });
    window.setTimeout(() => dropTask(id), 8000);
    return null;
  }
}

/**
 * The owner's "This is a photo" switch for one page of an image set — one undo step for the page
 * flag and its grids. To a flat scan: grids become square, and their photo layout is kept; back to
 * a photo: exactly the corners the user had come back.
 */
/**
 * An image added before v3 is a `kind: 'image'` source: one page, sized in mm at 300 dpi, with no
 * photo switch. This turns it into an image set (the v3 shape) so it can be a photo like any other
 * image. Frames already on it keep their place: their coordinates change from mm to pixels.
 */
export function asImageSet(gameId: ID, sourceId: ID) {
  const game = useGame.getState().game;
  const src = game?.sources.find((s) => s.id === sourceId);
  const asset = src && game ? game.assets[src.assetId] : undefined;
  if (!game || !src || src.kind !== 'image' || !asset?.width || !asset.height) return false;
  const page = src.pages[0];
  const k = asset.width / (page?.widthMm || 1); // px per mm
  commitWithGame(
    `Make “${src.name}” an image set`,
    (doc) => {
      const d = doc as CutterDoc;
      const scale = (q: number[][]) => q.map((p) => [p[0] * k, p[1] * k]);
      for (const g of Object.values(d.grids)) if (g.at.sourceId === sourceId) g.anchors = scale(g.anchors) as typeof g.anchors;
      for (const f of Object.values(d.frames)) if (f.at.sourceId === sourceId) f.quad = scale(f.quad) as typeof f.quad;
    },
    (g) => {
      const s2 = g.sources.find((x) => x.id === sourceId);
      if (!s2) return;
      s2.kind = 'images';
      s2.pages = s2.pages.map((p, i) => ({ ...p, index: i, assetId: s2.assetId, name: `${s2.name}`, px: { w: asset.width!, h: asset.height! }, photo: true, dpi: p.dpi ?? SCAN_DPI, widthMm: 0, heightMm: 0 }));
      s2.assetId = '';
    },
  );
  return true;
}

export function setPagePhoto(at: PageRef, photo: boolean) {
  commitWithGame(
    photo ? 'Mark as a photo' : 'Mark as a flat scan',
    (doc) => {
      for (const g of pageContent(doc as CutterDoc, at).grids) {
        const grid = (doc as CutterDoc).grids[g.id];
        if (!photo) {
          grid.photoLayout = { square: grid.square, anchors: grid.anchors.map((p) => [...p]) as typeof grid.anchors };
          if (!grid.square) grid.anchors = squareAnchors(grid.anchors);
          grid.square = true;
        } else if (grid.photoLayout) {
          grid.anchors = grid.photoLayout.anchors;
          grid.square = grid.photoLayout.square;
          delete grid.photoLayout;
        } else grid.square = false;
        propagate(doc as CutterDoc, grid.id);
      }
    },
    (g) => {
      const p = g.sources.find((s) => s.id === at.sourceId)?.pages[at.page];
      if (!p) return;
      p.photo = photo;
      const dpi = p.dpi || SCAN_DPI;
      p.dpi = dpi;
      p.widthMm = photo ? 0 : scanMm(p.px?.w ?? 0, dpi);
      p.heightMm = photo ? 0 : scanMm(p.px?.h ?? 0, dpi);
    },
  );
}
