# Contributing

## Getting set up

```bash
npm install
npm run dev
```

The web app runs on <http://localhost:5173>, the API on 3717. Node 20 or newer.

## Layout

| Path | What's in it |
|---|---|
| `src/features/` | One folder per area: `library`, `editor`, `sources`, `cutter`, `components`, `play`, `setup`, `settings` |
| `src/shared/` | Types and logic shared by the web app and the server |
| `src/ui/` | The UI kit (buttons, fields, dialogs) and design tokens |
| `server/` | Fastify API and file storage |
| `public/textures/` | Table material photographs (CC0, see its CREDITS.md) |
| `scripts/` | Checks and asset tooling |

Some conventions worth knowing:

- **Millimetres everywhere.** Every real-world size is in mm, and an entity's `x`/`y` is its centre.
  Pixels only appear at the edges, where something is drawn.
- **Components versus entities.** A component is a definition (a deck and its card images); an
  entity is a placement of one on a table.
- **The table is physical.** The surface, the grain and the pieces belong to the table, not the
  screen, so they scale with the camera rather than staying a fixed number of pixels.

## Testing

**There is no browser-driving UI test suite, and please don't add one.** It was removed on purpose:
it cost far more to maintain than it ever caught, and the app is quick to check by hand.

What exists, and what to extend:

- `node scripts/smoke.mjs` — API smoke test. Add to it when you add a route.
- `npx tsx scripts/check-zones.mts` and `check-throws.mts` — headless simulations of the drop and
  dice rules, where the maths is the thing worth checking.

Prefer one check that would actually have caught the bug over a suite. For anything visual, look at
it in the app and say what you saw.

## Pull requests

- `npm run typecheck` must pass, and the console should be free of errors.
- Keep the commit history readable; one logical change per commit.
- Describe what you changed and how you checked it. If something is unverified, say so — an honest
  gap is worth more than a confident guess.

## Releases

Versions follow [semver](https://semver.org). To cut one:

1. Update `version` in `package.json`.
2. Move the unreleased notes in `CHANGELOG.md` under the new version and date.
3. Commit, then tag: `git tag v0.2.0 && git push origin main --tags`.

Pushing a `v*` tag builds and publishes the container image to GHCR, tagged with the exact version,
the major.minor, and `latest`. Pre-release tags (`v0.2.0-rc.1`) publish without moving `latest`.
