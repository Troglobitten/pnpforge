/**
 * Table materials — real seamless photographs, served from this repo.
 *
 * The table is a *physical* surface: its grain is fixed to the table, not to the
 * screen. So every material is described in **millimetres of table**, never in
 * pixels, and the camera turns those millimetres into pixels (`zoom` is exactly
 * screen px per mm — see engine/geometry K). `controller.applyCamera()` is the
 * only place that does that conversion, and that is the part the owner has
 * confirmed works; nothing here changes it.
 *
 * What did change: the materials used to be generated on the fly from stacked
 * `feTurbulence` filters, and at far zoom that boiled and banded. A procedural
 * tile is re-rasterised whenever its raster step changes, has nothing to
 * mip-filter it on the way down, and needed opacity ramps to keep it from
 * aliasing — three things changing at once while you zoom. Four CC0 photographs
 * from Poly Haven replace all of it (`public/textures/CREDITS.md`): the browser
 * downscales a bitmap properly, there is no filter to re-run, and the ramps are
 * gone.
 *
 * A material is still a stack of **bands** — the same world-locked tiles — but
 * now the same photograph at three scales: see `photoBands`. One tiled photo is
 * the most countable wallpaper there is, and the three scales plus a stretched,
 * faint drift layer are what stop it reading as one.
 *
 * Other features use `getTableThemeStyle` for static previews and swatches, and
 * `TABLE_THEMES` for pickers.
 */
import type { CSSProperties } from 'react';
import type { TableTheme } from '@/shared/types';

export interface TableThemeInfo {
  id: TableTheme;
  label: string;
  /** Base colour of the material; every band is a translucent glaze over this. */
  swatch: string;
  /** True for dark materials (light UI hints on top). */
  dark: boolean;
}

export const TABLE_THEMES: TableThemeInfo[] = [
  { id: 'felt-green', label: 'Green felt', swatch: '#1d5537', dark: true },
  { id: 'felt-blue', label: 'Blue felt', swatch: '#1b4664', dark: true },
  { id: 'felt-red', label: 'Red felt', swatch: '#64222a', dark: true },
  { id: 'felt-black', label: 'Black felt', swatch: '#1c1d20', dark: true },
  { id: 'felt-white', label: 'White felt', swatch: '#d7d4cd', dark: false },
  // Both woods are the one plywood photograph; only the swatch under it differs.
  // The dark one is colour-matched to the worn table this replaced.
  { id: 'wood', label: 'Plywood', swatch: '#9c7a52', dark: true },
  { id: 'wood-dark', label: 'Dark plywood', swatch: '#6b4e33', dark: true },
];

export function themeInfo(theme: TableTheme | undefined): TableThemeInfo {
  return TABLE_THEMES.find((t) => t.id === theme) ?? TABLE_THEMES[0];
}
/** One tiling of a photograph: how much table a tile covers, and how strongly it paints. */
export interface Layer {
  /** World period, x and y (mm) — how much table one tile covers. */
  pw: number;
  ph: number;
  /** The tiling `url(...)` background-image. */
  image: string;
  /** Constant — never animated, never faded. See `SURFACES`. */
  alpha: number;
}

/** A material's surface: the sharp tiling, plus one broad one to break its grid. */
export interface Surface {
  sharp: Layer;
  broad: Layer;
}

/* ================================================================== */
/* The textures                                                        */
/* ================================================================== */

/**
 * Two CC0 photographs from Poly Haven, baked into greyscale glazes by
 * `scripts/fetch-textures.mjs` and served from this repo — see
 * `public/textures/CREDITS.md` for source, author and licence.
 *
 * The *colour* is ours: each glaze is mid-grey plus deviation, blended over the
 * material's swatch with `soft-light`, which is why one felt file serves green,
 * blue, red, black and white.
 */
const TEX = {
  felt: 'url("/textures/felt.webp")',
  wood: 'url("/textures/wood.webp")',
} as const;

/**
 * How big the grain is drawn, against the size the photograph was really taken
 * at — so 1 is life size. Chosen by eye on the table (it was 0.5 while the
 * materials were being judged, and 2.1× of that is what looked right).
 */
const GRAIN = 1.05;

/* ================================================================== */
/* The materials                                                       */
/* ================================================================== */

/**
 * Two tilings of the same photograph, scaled with the camera. That is the whole
 * mechanism — and the important part is what it does *not* do.
 *
 * It was three copies, each fading in and out over its own zoom range and
 * re-rendering at its own stepped sizes; that is machinery inherited from the
 * procedural materials, and what the owner saw as the texture crawling while they
 * zoomed was those steps and fades firing at different moments. One copy alone has
 * nothing to crawl, but it tiles visibly and reads as one flat tone.
 *
 * So: a second copy, at a period that is not a multiple of the first, **at a
 * constant opacity that nothing ever changes**. Where the two grids disagree the
 * eye stops finding the repeat, and because neither layer ever fades or re-steps,
 * there is still nothing that can change while you zoom. `broad` is deliberately
 * the quieter of the two: it is there to disturb the grid, not to be seen.
 *
 * The remaining cost is honest and fixed: at maximum zoom the photograph runs out
 * of pixels and goes soft.
 */
const SURFACES: Record<string, Surface> = {
  /** Velour at 284 × 273 mm: a dense even nap, which is what baize is. */
  felt: {
    sharp: { pw: 284 * GRAIN, ph: 273 * GRAIN, image: TEX.felt, alpha: 1 },
    broad: { pw: 284 * GRAIN * 2.73, ph: 273 * GRAIN * 3.11, image: TEX.felt, alpha: 0.38 },
  },
  /** Plywood, photographed at 500 mm across. Serves both wood materials. */
  wood: {
    sharp: { pw: 500 * GRAIN, ph: 500 * GRAIN, image: TEX.wood, alpha: 1 },
    broad: { pw: 500 * GRAIN * 2.73, ph: 500 * GRAIN * 3.11, image: TEX.wood, alpha: 0.34 },
  },
};

/* Public API                                                          */
/* ================================================================== */

/** The material's surface: the photograph it tiles, and how much table one tile covers. */
export function surface(theme: TableTheme | undefined): Surface {
  return theme === 'wood' || theme === 'wood-dark' ? SURFACES.wood : SURFACES.felt;
}

/** Lighting overlay (warm key light + vignette) that sits above the surface, below the pieces. */
export function lightingImage(theme: TableTheme | undefined): string {
  const dark = themeInfo(theme).dark;
  return dark
    ? 'radial-gradient(120% 90% at 50% 38%, rgba(255,236,200,0.10) 0%, rgba(255,236,200,0.03) 35%, rgba(0,0,0,0) 60%), radial-gradient(140% 110% at 50% 45%, rgba(0,0,0,0) 45%, rgba(0,0,0,0.42) 100%)'
    : 'radial-gradient(120% 90% at 50% 38%, rgba(255,250,235,0.35) 0%, rgba(255,250,235,0) 55%), radial-gradient(140% 110% at 50% 45%, rgba(0,0,0,0) 50%, rgba(60,40,20,0.28) 100%)';
}

/**
 * Static style for previews / swatches: the same photograph, at a fixed
 * magnification, on one element.
 *
 * `tilePx` reads as "how big this preview wants the material to look": it maps to
 * a zoom of `tilePx / 110` px per mm (the default 300 → 2.7 px/mm — a close-up,
 * which is what makes a 160 px swatch read as *felt* rather than as a green
 * rectangle).
 */
export function getTableThemeStyle(theme: TableTheme | undefined, tilePx = 300): CSSProperties {
  const zoom = tilePx / 110;
  const { sharp } = surface(theme);
  return {
    backgroundColor: themeInfo(theme).swatch,
    backgroundImage: `${lightingImage(theme)}, ${sharp.image}`,
    backgroundSize: `100% 100%, 100% 100%, ${(sharp.pw * zoom).toFixed(1)}px ${(sharp.ph * zoom).toFixed(1)}px`,
    // nudge off the origin so a preview doesn't always cut the same corner
    backgroundPosition: `0 0, 0 0, ${(-sharp.pw * zoom * 0.17).toFixed(1)}px ${(-sharp.ph * zoom * 0.31).toFixed(1)}px`,
    // the lighting sits on top unblended; the glaze modulates the swatch below
    backgroundBlendMode: 'normal, normal, soft-light',
  };
}
