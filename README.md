# pnpforge

A self-hosted workshop and virtual tabletop for **solo print-and-play games**.

1. **Add your PnP files** — drop in the PDF, scans or photos you'd otherwise print.
2. **Cut out the pieces** — lay a grid over the card sheets, say where the backs are, and pnpforge
   cuts every card, board and token at print quality.
3. **Play** — on a table that behaves like cardboard: slide the top card off a deck, flip it, fan
   your hand, shuffle, roll dice. Undo anything. Your game saves itself.

Built for desktop (mouse and keyboard) and tablets (touch). Everything runs on your own machine;
nothing is uploaded anywhere.

![licence](https://img.shields.io/badge/licence-MIT-blue)

## Run it with Docker

```bash
docker run -d --name pnpforge -p 3717:3717 -v pnpforge-data:/data ghcr.io/troglobitten/pnpforge:latest
```

Then open <http://localhost:3717>. The server binds all interfaces, so a tablet on the same network
can open `http://<your-computer's-ip>:3717`.

Or with compose, which keeps your games in `./data` next to the compose file:

```bash
docker compose up -d
```

Image tags: `latest` (newest release), `0.1.0` (an exact version), `0.1` (newest patch of that
minor). Built for `linux/amd64` and `linux/arm64`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PNPFORGE_PORT` | `3717` | Port the app and API listen on |
| `PNPFORGE_HOST` | `0.0.0.0` | Bind address |
| `PNPFORGE_DATA` | `./data` (`/data` in Docker) | Where games, images and saves are stored |
| `PNPFORGE_LOG` | `warn` | Log level (`fatal`…`trace`) |

## Your data

Everything lives in the data folder: one directory per game holding `game.json`, its images and its
play sessions. Back it up by copying that folder. You can also export a single game as a
`.pnpforge` file from the library (optionally with your saves) and import it on another install.
Deleted games move to `data/trash` rather than being erased.

A fresh install starts with an empty library. Drop any `.pnpforge` file into a `samples/` folder
beside the server and it will be imported on first run.

## Running from source

Requires Node 20 or newer.

```bash
npm install
npm run dev
```

The app is on <http://localhost:5173> and the API on 3717. For a production build:

```bash
npm run build
npm start
```

That serves the built app and the API together on <http://localhost:3717>.

### Checks

```bash
npm run typecheck          # TypeScript, web and server
node scripts/smoke.mjs     # API smoke test against a running server
npx tsx scripts/check-zones.mts    # drop/stacking rules
npx tsx scripts/check-throws.mts   # dice throwing
```

There is deliberately no browser-driving UI test suite — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Table materials are CC0 photographs from [Poly Haven](https://polyhaven.com); see
[`public/textures/CREDITS.md`](public/textures/CREDITS.md) for each file's source and author.

Licensed under the [MIT Licence](LICENSE).
