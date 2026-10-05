/**
 * Page previews: the stored preview asset when the file has one, otherwise rendered here once
 * (lazily, when it scrolls into view) and kept for the session.
 */
import { useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { assetUrlById } from '@/api/client';
import type { Game, SourceDoc } from '@/shared/types';
import { openPageSource } from './pageSource';

const rendered = new Map<string, Promise<string>>();

export function useRenderedThumb(game: Game, source: SourceDoc, page: number, el: React.RefObject<HTMLElement | null>): string | null {
  const stored = assetUrlById(game, source.pages[page]?.thumb ?? null);
  const key = `${game.id}:${source.id}:${page}`;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (stored || !el.current) return;
    let alive = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      let p = rendered.get(key);
      if (!p) {
        p = openPageSource(game, source)
          .then((ps) => ps.display(page, 240))
          .then((c) => new Promise<string>((res, rej) => c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('encode'))), 'image/webp', 0.8)));
        p.catch(() => rendered.delete(key));
        rendered.set(key, p);
      }
      p.then((u) => alive && setUrl(u)).catch(() => undefined);
    });
    io.observe(el.current);
    return () => {
      alive = false;
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stored]);
  return stored ?? url;
}

/** A small page picture (e.g. in the "Use this grid on…" picker). */
export function PageThumbImg({ game, source, page, className }: { game: Game; source: SourceDoc; page: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const url = useRenderedThumb(game, source, page, ref);
  const p = source.pages[page];
  const w = source.kind === 'images' ? (p.px?.w ?? 3) : p.widthMm;
  const h = source.kind === 'images' ? (p.px?.h ?? 4) : p.heightMm;
  return (
    <span ref={ref} className={className} style={{ aspectRatio: `${w} / ${h}` }}>
      {url ? <img src={url} alt="" draggable={false} loading="lazy" /> : <FileText size={14} aria-hidden />}
    </span>
  );
}
