/**
 * Flattening an item out of a photo and making it look like a scan.
 *
 * warpItem: inverse homography per output pixel, bilinear from the pyramid
 * level closest to the output scale (no aliasing when a big photo becomes a
 * small preview). Optional trim insets the item a little in its own plane.
 *
 * cleanUp: white balance from near-neutral bright pixels, levels stretch,
 * even-out lighting (robust quadratic fit to local brightness), and filling
 * the rounded corners so no table shows through.
 */
import { applyH, rectToQuad, dist, type Quad } from './geom';
export interface RGBA {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface Pyramid {
  levels: RGBA[];
}

export function buildPyramid(base: RGBA, minSide = 256): Pyramid {
  const levels: RGBA[] = [base];
  let cur = base;
  while (Math.min(cur.w, cur.h) / 2 >= minSide) {
    const w = cur.w >> 1;
    const h = cur.h >> 1;
    const d = new Uint8ClampedArray(w * h * 4);
    const s = cur.data;
    const sw = cur.w;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const i = (2 * y * sw + 2 * x) * 4;
        const j = i + 4;
        const k = i + sw * 4;
        const l = k + 4;
        d[o] = (s[i] + s[j] + s[k] + s[l] + 2) >> 2;
        d[o + 1] = (s[i + 1] + s[j + 1] + s[k + 1] + s[l + 1] + 2) >> 2;
        d[o + 2] = (s[i + 2] + s[j + 2] + s[k + 2] + s[l + 2] + 2) >> 2;
        d[o + 3] = 255;
      }
    cur = { data: d, w, h };
    levels.push(cur);
  }
  return { levels };
}

/** Source pixels per output pixel for this quad at this output size. */
export function sourceScale(quad: Quad, outW: number, outH: number): number {
  const sw = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const sh = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  return Math.sqrt((sw / outW) * (sh / outH));
}

export interface WarpOpts {
  outW: number;
  outH: number;
  /** Inset from each edge, as a fraction of the item's width / height. */
  trimX?: number;
  trimY?: number;
  /** Coordinates of `quad` are in pixels of an image `quadScale`× the size of pyramid level 0. */
  quadScale?: number;
  shouldStop?: () => boolean;
}

export function warpItem(pyr: Pyramid, quad: Quad, o: WarpOpts): RGBA {
  const k = o.quadScale ?? 1;
  const q = quad.map((p) => [p[0] / k, p[1] / k]) as Quad;
  const scale = sourceScale(q, o.outW, o.outH);
  let lv = 0;
  while (lv + 1 < pyr.levels.length && scale / 2 ** (lv + 1) >= 1) lv++;
  const src = pyr.levels[lv];
  const f = 2 ** lv;
  const tx = o.trimX ?? 0;
  const ty = o.trimY ?? 0;
  const W = o.outW;
  const Hh = o.outH;
  const Hm = rectToQuad(1, 1, q);
  const out = new Uint8ClampedArray(W * Hh * 4);
  const sd = src.data;
  const sw = src.w;
  const sh = src.h;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = Hm;
  for (let y = 0; y < Hh; y++) {
    if (o.shouldStop && (y & 63) === 0 && o.shouldStop()) throw new Error('cancelled');
    const v = ty + ((y + 0.5) / Hh) * (1 - 2 * ty);
    for (let x = 0; x < W; x++) {
      const u = tx + ((x + 0.5) / W) * (1 - 2 * tx);
      const ww = h6 * u + h7 * v + h8;
      let X = (h0 * u + h1 * v + h2) / ww / f - 0.5;
      let Y = (h3 * u + h4 * v + h5) / ww / f - 0.5;
      X = X < 0 ? 0 : X > sw - 1.001 ? sw - 1.001 : X;
      Y = Y < 0 ? 0 : Y > sh - 1.001 ? sh - 1.001 : Y;
      const x0 = X | 0;
      const y0 = Y | 0;
      const ax = X - x0;
      const ay = Y - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const oi = (y * W + x) * 4;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      out[oi] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      out[oi + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      out[oi + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      out[oi + 3] = 255;
    }
  }
  return { data: out, w: W, h: Hh };
}


/* ------------------------------------------------------------------ */
/* clean-up                                                            */
/* ------------------------------------------------------------------ */

export interface CleanOpts {
  /** 0 = leave colours alone, 1 = full automatic white balance + levels. */
  color: number;
  /** 0..1 strength of evening out uneven lighting. */
  flatten: number;
  /** Corner radius to fill, as a fraction of the shorter side (0 = square). */
  corner: number;
  /** Per-channel white-balance gains measured elsewhere (e.g. across the whole photo). */
  gains?: [number, number, number] | null;
  /** The gains come from another photo in the same light: correct colour, but don't judge brightness by paper. */
  borrowed?: boolean;
}

export interface Illuminant {
  /** Red over green, and blue over green, of the brightest large surfaces. */
  rg: number;
  bg: number;
  /** How much those bright pixels vary in colour (0 = one uniform paper colour). */
  spread: number;
}

/**
 * The colour of the light, read from the brightest quarter of the pieces'
 * pixels. On printed cards that's mostly paper, which is one colour
 * everywhere, so its colour is the paper tinted by the light. When the bright
 * pixels are all sorts of colours (card backs, art) there's no paper to read
 * and `spread` says so.
 */
export function measureIlluminant(imgs: RGBA[], margin = 0.06): Illuminant | null {
  const px: number[][] = [];
  for (const img of imgs) {
    const { data, w, h } = img;
    const mx = Math.round(w * margin);
    const my = Math.round(h * margin);
    for (let y = my; y < h - my; y += 2)
      for (let x = mx; x < w - mx; x += 2) {
        const i = (y * w + x) * 4;
        const R = data[i];
        const G = data[i + 1];
        const B = data[i + 2];
        if (Math.max(R, G, B) > 250 || G < 12) continue;
        px.push([0.3 * R + 0.59 * G + 0.11 * B, R / G, B / G]);
      }
  }
  if (px.length < 200) return null;
  px.sort((a, b) => b[0] - a[0]);
  const top = px.slice(0, Math.round(px.length * 0.25));
  const med = (k: number) => {
    const v = top.map((x) => x[k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const rg = med(1);
  const bg = Math.max(0.05, med(2));
  const dev = top.map((x) => Math.abs(Math.log(Math.max(0.01, x[2]) / bg)) + Math.abs(Math.log(Math.max(0.01, x[1]) / rg))).sort((a, b) => a - b);
  return { rg, bg, spread: dev[dev.length >> 1] };
}

/** Print paper as it looks in daylight: a little warm, not grey. */
export const PAPER = { rg: 1.05, bg: 0.87 };

/**
 * Gains that bring the paper back to paper colour — however strong the cast
 * (candle light, a yellow lamp, a cold window). null when there is no clear
 * paper to judge by; [1,1,1] when the light is already right.
 */
export function gainsFromIlluminant(il: Illuminant | null): [number, number, number] | null {
  if (!il || il.spread > 0.08) return null;
  const clamp = (v: number) => Math.max(0.4, Math.min(3, v));
  const g: [number, number, number] = [clamp(PAPER.rg / il.rg), 1, clamp(PAPER.bg / il.bg)];
  if (Math.abs(g[0] - 1) < 0.02 && Math.abs(g[2] - 1) < 0.02) return [1, 1, 1];
  return g;
}

/** Channel gains for one image on its own (used when nothing was measured across the photo). */
export function measureGains(img: RGBA, margin = 0.05): [number, number, number] | null {
  return gainsFromIlluminant(measureIlluminant([img], margin));
}

export function cleanUp(img: RGBA, o: CleanOpts): RGBA {
  const { w, h } = img;
  const d = new Uint8ClampedArray(img.data);
  const N = w * h;

  /* white balance */
  // gains: numbers = paper was found (maybe [1,1,1]); null = no paper to judge by; undefined = measure here
  const gains = o.gains !== undefined ? o.gains : measureGains(img);
  if (o.color > 0) {
    if (gains) {
      // the paper target already keeps paper warm; the slider scales the correction
      const gg = gains.map((x) => Math.pow(x, o.color));
      // divide only part of the strongest gain back out: keeps the precision a dim photo needs
      const norm = Math.max(1, Math.max(...gg) / 1.6);
      for (let i = 0; i < N * 4; i += 4) {
        d[i] = (d[i] * gg[0]) / norm;
        d[i + 1] = (d[i + 1] * gg[1]) / norm;
        d[i + 2] = (d[i + 2] * gg[2]) / norm;
      }
    }
  }

  /* even out lighting */
  if (o.flatten > 0) flattenLight(d, w, h, o.flatten);

  /* levels */
  if (o.color > 0) {
    const hist = new Uint32Array(256);
    const mx = Math.round(w * 0.04);
    const my = Math.round(h * 0.04);
    let n = 0;
    for (let y = my; y < h - my; y += 2)
      for (let x = mx; x < w - mx; x += 2) {
        const i = (y * w + x) * 4;
        hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
        n++;
      }
    const pct = (p: number) => {
      let a = 0;
      for (let v = 0; v < 256; v++) {
        a += hist[v];
        if (a >= n * p) return v;
      }
      return 255;
    };
    let lo = pct(0.004);
    let hi = pct(0.996);
    lo = Math.min(lo, 45);
    if (gains && !o.borrowed) {
      // with paper to judge by, the paper itself sets the white point: a dim or
      // vignetted photo is lifted until its paper looks like paper again
      const paper = pct(0.85);
      // only when this piece is itself mostly light (a card front, not a dark back)
      if (paper >= hi * 0.72) hi = Math.min(hi, Math.round(paper * 1.05));
      // a dim photo (evening light) may need a big lift; a very dark one stays within reason
      hi = Math.max(hi, 40);
    } else {
      // no paper (card backs, dark art): stretch gently, never pump colours up
      hi = Math.max(hi, 200);
      lo = Math.min(lo, 15);
    }
    const s = o.color;
    const LO = lo * s;
    const HI = 255 + (hi - 255) * s;
    // bright paper lands a touch below pure white, as it prints
    const k = 244 / Math.max(40, HI - LO);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - LO) * k;
    for (let i = 0; i < N * 4; i += 4) {
      d[i] = lut[d[i]];
      d[i + 1] = lut[d[i + 1]];
      d[i + 2] = lut[d[i + 2]];
    }
  }

  if (o.corner > 0) fillCorners(d, w, h, o.corner * Math.min(w, h));
  return { data: d, w, h };
}

function flattenLight(d: Uint8ClampedArray, w: number, h: number, strength: number) {
  const GX = 10;
  const GY = Math.max(6, Math.round((GX * h) / w));
  const cells: { x: number; y: number; v: number }[] = [];
  const hist = new Uint32Array(256);
  for (let cy = 0; cy < GY; cy++)
    for (let cx = 0; cx < GX; cx++) {
      hist.fill(0);
      let n = 0;
      const x0 = Math.floor((cx * w) / GX);
      const x1 = Math.floor(((cx + 1) * w) / GX);
      const y0 = Math.floor((cy * h) / GY);
      const y1 = Math.floor(((cy + 1) * h) / GY);
      for (let y = y0; y < y1; y += 2)
        for (let x = x0; x < x1; x += 2) {
          const i = (y * w + x) * 4;
          hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
          n++;
        }
      let a = 0;
      let v = 255;
      for (let k = 255; k >= 0; k--) {
        a += hist[k];
        if (a >= n * 0.1) {
          v = k;
          break;
        }
      }
      if (v > 40) cells.push({ x: (cx + 0.5) / GX - 0.5, y: (cy + 0.5) / GY - 0.5, v: Math.log(v) });
    }
  if (cells.length < 12) return;
  // robust quadratic surface in log-brightness
  const basis = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
  let coef = [0, 0, 0, 0, 0, 0];
  let wts = cells.map(() => 1);
  for (let it = 0; it < 5; it++) {
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const b = new Array(6).fill(0);
    cells.forEach((c, i) => {
      const f = basis(c.x, c.y);
      for (let r = 0; r < 6; r++) {
        b[r] += wts[i] * f[r] * c.v;
        for (let q = 0; q < 6; q++) A[r][q] += wts[i] * f[r] * f[q];
      }
    });
    for (let r = 0; r < 6; r++) A[r][r] += 1e-6;
    const sol = solve6(A, b);
    if (!sol) return;
    coef = sol;
    const res = cells.map((c) => c.v - basis(c.x, c.y).reduce((s, f, k) => s + f * coef[k], 0));
    const mad = res.map(Math.abs).sort((a, b) => a - b)[Math.floor(res.length / 2)] || 0.02;
    const cc = Math.max(0.04, mad * 4.5);
    wts = res.map((r) => (Math.abs(r) >= cc ? 0 : (1 - (r / cc) ** 2) ** 2));
  }
  // correction relative to the brightest part of the fitted field
  let peak = -Infinity;
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) peak = Math.max(peak, basis(x / 8 - 0.5, y / 8 - 0.5).reduce((s, f, k) => s + f * coef[k], 0));
  const RW = 32;
  const RH = 32;
  const lut = new Float32Array(RW * RH);
  for (let y = 0; y < RH; y++)
    for (let x = 0; x < RW; x++) {
      const v = basis(x / (RW - 1) - 0.5, y / (RH - 1) - 0.5).reduce((s, f, k) => s + f * coef[k], 0);
      lut[y * RW + x] = Math.max(1, Math.min(1.7, Math.exp((peak - v) * strength)));
    }
  for (let y = 0; y < h; y++) {
    const fy = (y / (h - 1)) * (RH - 1);
    const y0 = Math.min(RH - 2, fy | 0);
    const ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x / (w - 1)) * (RW - 1);
      const x0 = Math.min(RW - 2, fx | 0);
      const ax = fx - x0;
      const g = (lut[y0 * RW + x0] * (1 - ax) + lut[y0 * RW + x0 + 1] * ax) * (1 - ay) + (lut[(y0 + 1) * RW + x0] * (1 - ax) + lut[(y0 + 1) * RW + x0 + 1] * ax) * ay;
      const i = (y * w + x) * 4;
      d[i] *= g;
      d[i + 1] *= g;
      d[i + 2] *= g;
    }
  }
}

function solve6(A: number[][], b: number[]): number[] | null {
  const n = 6;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Replace what lies outside rounded corners with the colour just inside the arc. */
function fillCorners(d: Uint8ClampedArray, w: number, h: number, r: number) {
  const R = Math.max(1, Math.min(r, Math.min(w, h) / 2 - 1));
  const Ri = Math.ceil(R);
  const corners = [
    [R, R, 0, 0],
    [w - R, R, w - Ri, 0],
    [w - R, h - R, w - Ri, h - Ri],
    [R, h - R, 0, h - Ri],
  ];
  for (const [cx, cy, x0, y0] of corners)
    for (let y = y0; y < y0 + Ri; y++)
      for (let x = x0; x < x0 + Ri; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const len = Math.hypot(dx, dy);
        if ((x < cx === dx < 0 || Math.abs(dx) < 1e-6) && (y < cy === dy < 0 || Math.abs(dy) < 1e-6) && len > R - 0.5) {
          const k = (R - 1.5) / len;
          const sx = Math.max(0, Math.min(w - 1, Math.round(cx + dx * k - 0.5)));
          const sy = Math.max(0, Math.min(h - 1, Math.round(cy + dy * k - 0.5)));
          const s = (sy * w + sx) * 4;
          const i = (y * w + x) * 4;
          // soften the one-pixel rim so the arc isn't jagged
          const a = Math.max(0, Math.min(1, len - (R - 0.5)));
          d[i] = d[i] * (1 - a) + d[s] * a;
          d[i + 1] = d[i + 1] * (1 - a) + d[s + 1] * a;
          d[i + 2] = d[i + 2] * (1 - a) + d[s + 2] * a;
        }
      }
}

/**
 * A fine structure print of a straightened piece: the middle of the piece (the
 * frame is left out — a whole deck shares it) at 40×56, with the local average
 * removed, normalised. Colour and lighting hardly change it; different card art
 * does. The same card back scores high against itself; different fronts sharing
 * a layout stay well below.
 */
export function detailPrint(img: RGBA): number[] {
  const W = 40;
  const H = 56;
  const g = new Float32Array(W * H);
  const cnt = new Float32Array(W * H);
  const mx = Math.round(img.w * 0.14);
  const my = Math.round(img.h * 0.14);
  for (let y = my; y < img.h - my; y++)
    for (let x = mx; x < img.w - mx; x++) {
      const i = (y * img.w + x) * 4;
      const c = Math.min(H - 1, (((y - my) * H) / (img.h - 2 * my)) | 0) * W + Math.min(W - 1, (((x - mx) * W) / (img.w - 2 * mx)) | 0);
      g[c] += img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11;
      cnt[c]++;
    }
  for (let c = 0; c < g.length; c++) g[c] /= cnt[c] || 1;
  const out: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let t = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          t += g[Y * W + X];
          n++;
        }
      out.push(g[y * W + x] - t / n);
    }
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  const sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length) || 1;
  return out.map((v) => Math.round(((v - mean) / sd) * 100) / 100);
}

/** 12×12 colour thumbnail, normalised as a whole: colour differences still count. */
export function colourPrint(img: RGBA): number[] {
  const N = 12;
  const out = new Array(N * N * 3).fill(0);
  const cnt = new Array(N * N).fill(0);
  for (let y = 0; y < img.h; y += 2)
    for (let x = 0; x < img.w; x += 2) {
      const i = (y * img.w + x) * 4;
      const c = Math.min(N - 1, ((y * N) / img.h) | 0) * N + Math.min(N - 1, ((x * N) / img.w) | 0);
      out[c * 3] += img.data[i];
      out[c * 3 + 1] += img.data[i + 1];
      out[c * 3 + 2] += img.data[i + 2];
      cnt[c]++;
    }
  for (let c = 0; c < N * N; c++) for (let k = 0; k < 3; k++) out[c * 3 + k] /= cnt[c] || 1;
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  const sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / out.length) || 1;
  return out.map((v) => Math.round(((v - mean) / sd) * 100) / 100);
}
