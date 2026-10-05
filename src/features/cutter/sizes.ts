/**
 * Sizes of what a group makes: read from the page on flat pages, set by the user on photos (a
 * preset, typed, or measured against a piece of known size lying in the same photo — the user
 * presses "Measure"; nothing is measured behind their back).
 */
import { CARD_PRESETS, type CutFrame, type CutGroup, type CutterDoc, type Game, type ID } from '@/shared/types';
import { groupSize, pageInfo } from '@/shared/cutter/pieces';
import { measureWith, TOKEN_SIZES } from './measure';
import { focalFromQuads, type Quad } from './engine/geom';

export { TOKEN_SIZES };

export const fmtMm = (v: number) => {
  const s = (Math.round(v * 10) / 10).toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

export interface Preset {
  id: string;
  label: string;
  w: number;
  h: number;
}

export function presetsFor(kind: CutGroup['kind']): Preset[] {
  if (kind === 'tokens') return TOKEN_SIZES.map((t) => ({ id: t.id, label: t.label, w: t.w, h: t.h }));
  if (kind === 'cards' || kind === 'back') return CARD_PRESETS.map((p) => ({ id: p.id, label: `${p.label} · ${fmtMm(p.width)} × ${fmtMm(p.height)}`, w: p.width, h: p.height }));
  return [];
}

/** The preset this size is (either way round, within 0.5 mm). */
export function presetOf(kind: CutGroup['kind'], w: number, h: number): Preset | null {
  for (const p of presetsFor(kind)) if ((Math.abs(p.w - w) <= 0.5 && Math.abs(p.h - h) <= 0.5) || (Math.abs(p.w - h) <= 0.5 && Math.abs(p.h - w) <= 0.5)) return p;
  return null;
}

export interface SizeInfo {
  /** What making will use (null = not set yet). */
  size: { w: number; h: number } | null;
  from: 'page' | 'preset' | 'typed' | 'measured' | null;
  /** e.g. "Poker" when it matches a preset. */
  preset: Preset | null;
  /** Some of its frames are on photos (no scale): the user must set a size. */
  onPhotos: boolean;
  onFlat: boolean;
  note?: string;
}

export function sizeInfo(doc: CutterDoc, group: CutGroup, game: Pick<Game, 'sources'>): SizeInfo {
  const frames = Object.values(doc.frames).filter((f) => f.groupId === group.id && f.side === 'front' && !f.excluded);
  const infos = frames.map((f) => pageInfo(game.sources, f.at));
  const onPhotos = infos.some((i) => i?.photo);
  const onFlat = infos.some((i) => i && !i.photo);
  const size = groupSize(doc, group, game.sources);
  if (!size) return { size: null, from: null, preset: null, onPhotos, onFlat };
  return { size: { w: size.w, h: size.h }, from: size.from, preset: presetOf(group.kind, size.w, size.h), onPhotos, onFlat, note: group.size?.note };
}

/**
 * Measure a group against pieces of known size in the same photos: every frame of another group
 * with a set size (cards, usually) on a photo where this group has a frame. The photo import's
 * method (perspective from the reference, plus the target's own shape), ~3% on the test photos.
 */
export function measureGroup(doc: CutterDoc, groupId: ID, game: Pick<Game, 'sources'>): { w: number; h: number; ref: string } | { error: string } {
  const group = doc.groups.find((g) => g.id === groupId);
  if (!group) return { error: 'That group no longer exists.' };
  const mine = Object.values(doc.frames).filter((f) => f.groupId === groupId && !f.excluded && pageInfo(game.sources, f.at)?.photo);
  if (!mine.length) return { error: 'Measuring works on photos: this group has no frames on a photo.' };
  const sizes: { w: number; h: number }[] = [];
  let refName = '';
  for (const t of mine) {
    const src = game.sources.find((s) => s.id === t.at.sourceId);
    const page = src?.pages[t.at.page];
    if (!page?.px) continue;
    const onPage = Object.values(doc.frames).filter((f) => f.at.sourceId === t.at.sourceId && f.at.page === t.at.page && !f.excluded);
    const refs = onPage.filter((f): f is CutFrame => {
      const g = doc.groups.find((x) => x.id === f.groupId);
      return !!g && g.id !== groupId && !!g.size && f.shape === 'rect';
    });
    if (!refs.length) continue;
    const focal = focalFromQuads(onPage.filter((f) => f.shape === 'rect').map((f) => f.quad as Quad), page.px.w, page.px.h);
    for (const r of refs) {
      const rg = doc.groups.find((x) => x.id === r.groupId)!;
      refName ||= rg.name;
      sizes.push(measureWith({ quad: r.quad as Quad, wMm: rg.size!.w, hMm: rg.size!.h }, t.quad as Quad, page.px.w, page.px.h, focal));
    }
  }
  if (!sizes.length) return { error: 'Put a piece of known size in the same photo — frame it in a group that has a size (cards, say) — then measure.' };
  const w = sizes.reduce((a, s) => a + s.w, 0) / sizes.length;
  const h = sizes.reduce((a, s) => a + s.h, 0) / sizes.length;
  const half = (v: number) => Math.round(v * 2) / 2;
  if (group.kind === 'tokens') {
    const side = half((w + h) / 2);
    return { w: side, h: side, ref: refName };
  }
  return { w: half(w), h: half(h), ref: refName };
}
