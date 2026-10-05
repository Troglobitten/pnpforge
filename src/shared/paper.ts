/** Paper sizes in words: "A4 portrait", "Letter landscape", "210 × 297 mm". */
import { PAGE_PRESETS, type SourcePage } from './types.js';

export function paperName(w: number, h: number): string | null {
  for (const p of PAGE_PRESETS) {
    if (Math.abs(p.width - w) < 2.5 && Math.abs(p.height - h) < 2.5) return p.label;
    if (Math.abs(p.width - h) < 2.5 && Math.abs(p.height - w) < 2.5) return p.label;
  }
  if (Math.abs(w - 297) < 2.5 && Math.abs(h - 420) < 2.5) return 'A3';
  if (Math.abs(h - 297) < 2.5 && Math.abs(w - 420) < 2.5) return 'A3';
  return null;
}

export function pageSizeLabel(p: Pick<SourcePage, 'widthMm' | 'heightMm'>, withOrientation = true): string {
  const name = paperName(p.widthMm, p.heightMm);
  const o = p.widthMm > p.heightMm + 1 ? 'landscape' : 'portrait';
  if (name) return withOrientation ? `${name} ${o}` : name;
  return `${Math.round(p.widthMm)} × ${Math.round(p.heightMm)} mm`;
}
