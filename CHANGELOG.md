# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org).

## [Unreleased]

## [0.1.1] — 2026-10-05

### Fixed

- **Permission denied on a mounted data folder.** The container runs as an unprivileged user, so a
  bind-mounted folder owned by someone else failed at startup with an `EACCES` stack trace. The
  bundled `docker-compose.yml` now runs as `PUID`/`PGID` (defaulting to `1000:100`), the README
  explains how to find yours, and the server now says what is wrong and how to fix it rather than
  printing an mkdir trace.

## [0.1.0] — 2026-10-05

First public release.

### Added

- **Library** — your games, with import and export as a single `.pnpforge` file (optionally
  including your saves), duplication, and a trash that holds deleted games rather than erasing them.
- **Sources** — add the PDF, scans or photographs you'd otherwise print. Images can be marked as
  photographs, which gives them perspective corners and a clean-up pass.
- **Cutter** — one place to turn any source into pieces: frames and grids laid over the page,
  groups with a size, card backs (turned over, a page of backs, or paired by hand), a Pieces view
  for reordering and checking fronts against backs, and helpers for flat pages (find the cards,
  skip empty spaces, snap to artwork, join a board from several pages). Making a component can be
  updated in place later without breaking what's already on your table.
- **Play** — a table that behaves like cardboard: decks you can slide the top card off, flipping,
  a fanned hand, shuffling, dice you can throw, zones and grids, undo for everything, and saves
  that keep themselves.
- **Table materials** — green, blue, red, black and white felt, plus plywood and dark plywood,
  from CC0 photographs.
- Docker image for `linux/amd64` and `linux/arm64`.

[Unreleased]: https://github.com/Troglobitten/pnpforge/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Troglobitten/pnpforge/releases/tag/v0.1.1
[0.1.0]: https://github.com/Troglobitten/pnpforge/releases/tag/v0.1.0
