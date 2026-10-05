/**
 * Straightened previews of frames, as they will be made: flat pages rendered small, photos through
 * the photo engine with the page's clean-up and light. Cached by everything that changes the look;
 * the last picture stays up while a newer one renders.
 */
import { useEffect, useState } from 'react';
import type { CutFrame, CutGroup, CutterDoc, Game } from '@/shared/types';
import { DEFAULT_CLEAN } from '@/shared/cutter/doc';
import { finishFor, frameMm, groupSize, pageInfo } from '@/shared/cutter/pieces';
import { quadSize } from '@/shared/cutter/geom';
import { openPageSource } from './pageSource';

const cache = new Map<string, Promise<string>>();

/** The size a preview is drawn at: the real one, or (a photo with no size yet) the frame's proportions. */
export function previewMm(frame: CutFrame, group: CutGroup, game: Pick<Game, 'sources'>, doc: CutterDoc) {
  const m = frameMm(frame, group, pageInfo(game.sources, frame.at), groupSize(doc, group, game.sources));
  if (m && m.w > 0 && m.h > 0) return m;
  const q = quadSize(frame.quad);
  return { w: (88.9 * q.w) / Math.max(1, q.h), h: 88.9 };
}

export function cleanFor(doc: CutterDoc, frame: CutFrame, group: CutGroup, mm: { w: number; h: number }, photo: boolean) {
  const c = doc.clean[frame.at.sourceId] ?? DEFAULT_CLEAN;
  return { color: c.color, flatten: c.flatten, cornerMm: Math.min(finishFor(group, photo).cornerMm, Math.min(mm.w, mm.h) / 4) };
}

export function usePreview(game: Game, doc: CutterDoc, frame: CutFrame | undefined, group: CutGroup | undefined, maxSide = 240): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const source = frame ? game.sources.find((s) => s.id === frame.at.sourceId) : undefined;
  const page = frame && source ? source.pages[frame.at.page] : undefined;
  const mm = frame && group ? previewMm(frame, group, game, doc) : null;
  const clean = frame && group && mm ? cleanFor(doc, frame, group, mm, !!page?.photo && source?.kind === 'images') : null;
  const trimMm = group ? finishFor(group, !!page?.photo && source?.kind === 'images').trimMm : 0;
  const key =
    frame && group && mm && clean && source
      ? [source.id, frame.at.page, frame.quad.flat().map((v) => v.toFixed(1)).join(','), mm.w.toFixed(1), mm.h.toFixed(1), trimMm, clean.color, clean.flatten, clean.cornerMm, JSON.stringify(page?.gains ?? null), page?.photo ? 1 : 0, maxSide].join('|')
      : '';
  useEffect(() => {
    if (!key || !frame || !source || !mm || !clean || !group) return;
    let alive = true;
    let p = cache.get(key);
    if (!p) {
      p = openPageSource(game, source)
        .then((ps) => ps.previewFrame({ page: frame.at.page, quad: frame.quad, mm, trimMm, dpi: 100, clean, maxSide }))
        .then((b) => URL.createObjectURL(b));
      p.catch(() => cache.delete(key));
      cache.set(key, p);
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
    }
    // a newer request for the same frame supersedes an older one: nothing to report
    p.then((u) => alive && setUrl(u)).catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return frame ? url : null;
}
