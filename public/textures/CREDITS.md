# Table material textures — sources and licence

Every file here is derived from a **CC0 / public-domain** texture from **Poly Haven**
(<https://polyhaven.com/license>: "CC0 … Public Domain"). Nothing else is used, and nothing
is loaded from the network at runtime — these files are served from this repo.

Regenerate with `node scripts/fetch-textures.mjs`, which is also where the baking is
described: each photo is high-passed with a wrap-around blur (so the tile stays seamless)
and stored as an opaque greyscale glaze about mid-grey, which the table blends over the
material's colour with `mix-blend-mode: soft-light`. The colour comes from the swatch in
`src/features/play/table/theme.ts`, not from the photograph — which is why one felt file
serves green, blue, red, black and white.

| file | used for | source | author | real-world size | licence | size |
| --- | --- | --- | --- | --- | --- | --- |
| `felt.webp` | green / blue / red / black / white felt (one file, tinted by the material swatch) | [Velour Velvet](https://polyhaven.com/a/velour_velvet) | colormass, Rico Cilliers | 284 × 273 mm | CC0 | 857 KB |
| `wood.webp` | plywood / dark plywood (one file; the two differ only in the swatch they are glazed over) | [Plywood](https://polyhaven.com/a/plywood) | Rob Tuytel | 500 × 500 mm | CC0 | 5102 KB |

Total: 5959 KB.

Downloaded from (2K JPG diffuse):

- felt: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/velour_velvet/velour_velvet_diff_4k.jpg
- wood: https://dl.polyhaven.org/file/ph-assets/Textures/jpg/4k/plywood/plywood_diff_4k.jpg
