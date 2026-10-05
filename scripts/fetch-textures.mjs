/**
 * Fetch the table materials' source textures and bake them into glazes.
 *
 * Every source is **CC0, from Poly Haven only** (polyhaven.com/license: "CC0 …
 * Public Domain"). Nothing is hotlinked at runtime: this writes the finished
 * files into `public/textures/`, which is what ships, and `CREDITS.md` beside
 * them records where each came from.
 *
 * What it bakes, and why it is not just the photo:
 *
 *  - **Glaze, not colour.** Each photo becomes an *opaque greyscale* glaze about
 *    mid-grey, which the table blends over the material's swatch with
 *    `mix-blend-mode: soft-light`. The colour then comes from our token, exactly
 *    as it did when the layers were procedural — so the three felts share one
 *    file, and a material's colour stays ours to pick rather than whatever the
 *    photographer's cloth happened to be dyed. (Chrome encodes a WebP alpha
 *    channel losslessly, so the same glaze carried in alpha costs 5× the bytes:
 *    23 MB across the four files against 3.6 MB.)
 *  - **High-passed, with a wrap-around blur.** Any residual lighting gradient in
 *    a photo is the thing that makes a tiled texture countable, and it is the
 *    first thing your eye finds. Subtracting a circularly-blurred copy removes it
 *    and keeps the tile seamless, because the blur wraps the same way the tile
 *    does.
 *
 * Run: node scripts/fetch-textures.mjs          (needs network; Edge for encoding)
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = decodeURIComponent(new URL('../', import.meta.url).pathname).replace(/^\/(\w:)/, '$1');
const OUT = ROOT + 'public/textures/';
mkdirSync(OUT, { recursive: true });

/**
 * Poly Haven asset → our file. `px` is the baked width: felt is photographed at
 * ~280 mm across, so 1536 px already gives it 5.5 px/mm, while the table top
 * (1 m) needs every pixel of 2048 to stay sharp when the table is magnified
 * fourteen times.
 */
const SOURCES = [
  // `gain` is how far the 99.5th-percentile deviation is pushed towards full
  // black/white; `pos` tames the light side on its own. `hp` divides the width to
  // get the high-pass radius, so a *smaller* hp keeps more of the photograph's
  // slow variation — the thing that stops a material reading as one flat tone.
  // These used to be 6 and 11, which scrubbed the cloth and the boards so clean
  // that what was left was monotone.
  { file: 'felt', id: 'velour_velvet', gain: 0.6, hp: 2.5, px: 2048, q: 0.78, soften: 1, note: 'green / blue / red / black / white felt (one file, tinted by the material swatch)' },
  { file: 'wood', id: 'plywood', gain: 0.88, hp: 3, px: 4096, q: 0.72, note: 'plywood / dark plywood (one file; the two differ only in the swatch they are glazed over)' },
];

/**
 * 4K sources. The table is drawn up to 14 px/mm, and the materials are tiled at
 * half life size (`GRAIN` in theme.ts), so the worn table's 550 mm photograph has
 * to carry ~15 px/mm of its own: 2K was not enough and showed as a soft, slightly
 * pixelated upscale.
 */
const RES = '4k';


/**
 * Luminance → ink + alpha, after a wrap-around high pass. Runs in the browser
 * because that is also what encodes the WebP, and it keeps this script free of
 * image dependencies.
 */
const BAKE = async ([dataUrl, gain, hpDiv, targetPx, quality, pos, soften]) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = targetPx / img.width;
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  const px = d.data;
  // the photograph's own average colour, for picking the material's swatch
  let ar = 0, ag = 0, ab = 0;
  for (let i = 0; i < w * h; i++) { ar += px[i * 4]; ag += px[i * 4 + 1]; ab += px[i * 4 + 2]; }
  const avg = [ar, ag, ab].map((v) => Math.round(v / (w * h)));
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];

  // circular box blur, twice, so the high pass wraps exactly as the tile does
  const blur = (src, r) => {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + ((k % w) + w) % w];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / win;
        s -= src[y * w + ((x - r) % w + w) % w];
        s += src[y * w + ((x + r + 1) % w + w) % w];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[(((k % h) + h) % h) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / win;
        s -= tmp[((((y - r) % h) + h) % h) * w + x];
        s += tmp[((((y + r + 1) % h) + h) % h) * w + x];
      }
    }
    return out;
  };
  const r = Math.max(2, Math.round(w / hpDiv / 2));
  const lo = blur(blur(lum, r), r);

  let peak = 0;
  let dev = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dev[i] = lum[i] - lo[i];
    const a = Math.abs(dev[i]);
    if (a > peak) peak = a;
  }
  // A regular weave is the worst thing you can tile: at far zoom its threads fall
  // below a pixel and beat against the pixel grid. Taking the very finest edges
  // off it here is a band-limit the browser's own resampling does not do, and it
  // is the difference between linen shimmering and not.
  if (soften) dev = blur(dev, soften);

  // normalise on the 99.5th percentile, not the single hottest pixel
  const hist = new Float64Array(256);
  for (let i = 0; i < w * h; i++) hist[Math.min(255, Math.round(Math.abs(dev[i])))]++;
  let acc = 0, p995 = 255;
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > w * h * 0.995) { p995 = Math.max(1, k); break; } }

  for (let i = 0; i < w * h; i++) {
    const raw = (dev[i] / p995) * gain;
    const v = Math.max(-1, Math.min(1, raw > 0 ? raw * pos : raw));
    const grey = Math.round((v * 0.5 + 0.5) * 255);
    px[i * 4] = grey; px[i * 4 + 1] = grey; px[i * 4 + 2] = grey;
    px[i * 4 + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  const detail = c.toDataURL('image/webp', quality);

  return { url: detail, w, h, p995: Math.round(p995), avg };
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.setContent('<!doctype html><meta charset=utf-8><body></body>');

const credits = [];
let total = 0;

for (const s of SOURCES) {
  const info = await (await fetch(`https://api.polyhaven.com/info/${s.id}`)).json();
  const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${RES}/${s.id}/${s.id}_diff_${RES}.jpg`;
  const jpg = Buffer.from(await (await fetch(url)).arrayBuffer());
  const baked = await page.evaluate(BAKE, ['data:image/jpeg;base64,' + jpg.toString('base64'), s.gain, s.hp, s.px, s.q, s.pos ?? 1, s.soften ?? 0]);
  const out = Buffer.from(baked.url.split(',')[1], 'base64');
  writeFileSync(`${OUT}${s.file}.webp`, out);
  total += out.length;
  const mm = info.dimensions ? `${Math.round(info.dimensions[0])} × ${Math.round(info.dimensions[1])} mm` : 'unknown';
  console.log(`${s.file}.webp  ${baked.w}×${baked.h}  ${(out.length / 1024).toFixed(0)} KB  (source ${(jpg.length / 1024).toFixed(0)} KB, real size ${mm}, average colour #${baked.avg.map((v) => v.toString(16).padStart(2, '0')).join('')})`);
  credits.push({ ...s, name: info.name, authors: Object.keys(info.authors || {}).join(', '), mm, bytes: out.length, url: `https://polyhaven.com/a/${s.id}`, dl: url });
}

writeFileSync(
  OUT + 'CREDITS.md',
  `# Table material textures — sources and licence

Every file here is derived from a **CC0 / public-domain** texture from **Poly Haven**
(<https://polyhaven.com/license>: "CC0 … Public Domain"). Nothing else is used, and nothing
is loaded from the network at runtime — these files are served from this repo.

Regenerate with \`node scripts/fetch-textures.mjs\`, which is also where the baking is
described: each photo is high-passed with a wrap-around blur (so the tile stays seamless)
and stored as an opaque greyscale glaze about mid-grey, which the table blends over the
material's colour with \`mix-blend-mode: soft-light\`. The colour comes from the swatch in
\`src/features/play/table/theme.ts\`, not from the photograph — which is why one felt file
serves green, blue, red, black and white.

| file | used for | source | author | real-world size | licence | size |
| --- | --- | --- | --- | --- | --- | --- |
${credits
  .map((c) => `| \`${c.file}.webp\` | ${c.note} | [${c.name}](${c.url}) | ${c.authors} | ${c.mm} | CC0 | ${(c.bytes / 1024).toFixed(0)} KB |`)
  .join('\n')}

Total: ${(total / 1024).toFixed(0)} KB.

Downloaded from (2K JPG diffuse):

${credits.map((c) => `- ${c.file}: ${c.dl}`).join('\n')}
`,
);

await browser.close();
console.log(`\ntotal ${(total / 1024).toFixed(0)} KB in ${OUT}`);
if (!existsSync(OUT + 'CREDITS.md')) throw new Error('CREDITS.md not written');
