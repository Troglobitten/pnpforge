/**
 * Measuring a piece against a reference in the same photograph (the photo import's `measureWith`),
 * and the token sizes the Size section offers. Moved here when the photo import was retired.
 */
import { CARD_PRESETS } from '@/shared/types';
import { applyH, dist, estimateAspect, invertH, rectToQuad, type Pt, type Quad } from './engine/geom';

export const TOKEN_SIZES = [
  { id: 'tok-16', label: '16 mm', w: 16, h: 16 },
  { id: 'tok-20', label: '20 mm', w: 20, h: 20 },
  { id: 'tok-25', label: '25 mm', w: 25, h: 25 },
  { id: 'tok-30', label: '30 mm', w: 30, h: 30 },
  { id: 'tok-38', label: '38 mm', w: 38, h: 38 },
];

/** Short side over long side. */
export const ratio = (a: number) => (a > 1 ? 1 / a : a);

/** Card presets whose shape matches this aspect, best first. */
export function presetsForAspect(aspect: number) {
  const r = ratio(aspect);
  return CARD_PRESETS.map((p) => ({ p, err: Math.abs(Math.min(p.width, p.height) / Math.max(p.width, p.height) - r) / r })).sort((a, b) => a.err - b.err);
}

/**
 * Measure `target` using `ref`, an item of known size lying on the same table
 * in the same photo. Two independent estimates:
 *  - the reference's outline fixes the table plane and the target is measured in
 *    it (perspective from a small card, extrapolated across a big board), and
 *  - the target's own outline fixes the plane (its shape from the photo's focal
 *    length) and the reference only gives the scale.
 * Lens distortion pushes them in opposite directions, so their mean is used.
 * On the test photos this lands within ~3% (each alone: up to 8%).
 */
export function measureWith(ref: { quad: Quad; wMm: number; hMm: number }, target: Quad, imgW: number, imgH: number, focal: number): { w: number; h: number } {
  const sides = (q: Pt[]) => [(dist(q[0], q[1]) + dist(q[3], q[2])) / 2, (dist(q[0], q[3]) + dist(q[1], q[2])) / 2];
  const toRef = invertH(rectToQuad(ref.wMm, ref.hMm, ref.quad));
  const [w1, h1] = sides(target.map((p) => applyH(toRef, p[0], p[1])));
  const aspect = estimateAspect(target, imgW, imgH, focal);
  const toT = invertH(rectToQuad(aspect, 1, target));
  const [rw, rh] = sides(ref.quad.map((p) => applyH(toT, p[0], p[1])));
  const scale = (ref.wMm / rw + ref.hMm / rh) / 2;
  const w2 = aspect * scale;
  const h2 = scale;
  return { w: (w1 + w2) / 2, h: (h1 + h2) / 2 };
}
