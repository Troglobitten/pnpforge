# Play table engine & `<TableView>`

Everything that renders and manipulates a virtual table lives here. The **Play** page
(`PlayPage.tsx`) and the **Setup editor** (`src/features/setup`) both drive the same
`<TableView>`; the only differences are `mode` and which callbacks are supplied.

```
engine/        pure, immutable state ops (no React, no DOM)
  geometry.ts    mm maths: sizes, stack layouts, bounds, hit-testing, z-order
  ops.ts         every mutation on a TableState (move/flip/shuffle/draw/…)
  drop.ts        drag sources, drop targets, applyDrop()
  session.ts     freshStateFromSetup(), normalizeState()
  history.ts     undo/redo store (250 snapshots, coalescing)
  ids.ts         newId(), randomInt()
table/
  TableView.tsx  the React component (thin)
  controller.ts  TableController — camera, gestures, drag loop, all actions
  entities.tsx   renderers for stack/board/token/die/counter/zone/note
  overlays.tsx   context menu, long-press ring, inspect, browse, shortcuts
  HandTray.tsx   the fanned hand at the bottom (play mode only)
  menus.ts       context-menu item builders
  store.ts       per-view ephemeral UI store (zustand vanilla)
  theme.ts       table materials (photo textures) + getTableThemeStyle()
chrome/          RulesPanel, SessionsDialog (play page only)
```

## `<TableView>` props

| prop | type | notes |
|---|---|---|
| `game` | `Game` | components + assets; identity change re-reads it |
| `state` | `TableState` | the committed state to render |
| `mode` | `'play' \| 'setup'` | `setup` hides the hand tray and allows moving locked boards via the menu |
| `onCommit` | `(next, meta?) => void` | **required.** `meta.label` names the undo step; `meta.coalesceKey` merges rapid repeats (counters, note typing) |
| `onUndo` / `onRedo` | `() => void` | wire to your history store; enables Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y |
| `onCameraChange` | `(c: Camera) => void` | debounced ~400 ms; persist it with the session |
| `onSelectionChange` | `(ids: ID[]) => void` | for an inspector panel |
| `onThemeChange` | `(t: TableTheme) => void` | omit to hide the "Table material" menu entry |
| `onResetGame` | `() => void` | omit to hide "Restart game…" |
| `extraEntityMenuItems` | `(e, ctl) => MenuItem[]` | appended to any piece's context menu |
| `extraTableMenuItems` | `(at, ctl) => MenuItem[]` | appended to the empty-table menu |
| `controllerRef` | `(ctl \| null) => void` | receives the `TableController` on mount |
| `hideZoomControls` | `boolean` | hide the built-in bottom-right zoom cluster |
| `children` | `ReactNode` | overlay content above the table (coach marks, empty states) |

`<TableView>` never owns the state: it renders what you pass and calls `onCommit`.
Undo/redo, autosave and routing belong to the page.

## `TableController`

Obtained via `controllerRef`. The setup editor uses it to drive the table from its own UI.

- **Camera** — `fitAll(animate)`, `fitRect(rect, animate, maxZoom)`, `zoomBy(f)`,
  `zoomAt(clientX, clientY, f)`, `setCamera(c, animate)`, `screenToWorld`, `worldToScreen`,
  `viewCenterWorld()`, `subscribeCamera(fn)`, `insets()`.
- **Selection** — `select(ids)`, `selectAll()`, `clearSelection()`, `targets(kinds?)`
  (the hovered piece, else the selection).
- **Actions** — `flip`, `flipWholeStack`, `setStackFace`, `rotate`, `shuffle`, `drawToHand`,
  `dealRow`, `split`, `splitTokens`, `setLayout`, `toggleSpread`, `roll`, `setDieFace`,
  `counter`, `setCounterValue`, `resetCounter`, `renameCounter`, `toggleLock`,
  `deleteEntities`, `addNote`, `setNoteText`, `setNoteColor`, `editNote`, `addCounter`,
  `takeTokenBeside`, `returnTokenToSupply`, `playHandCard`, `handCardToStack`,
  `takeFromStack`, `moveCardInStack`, `browse`, `inspectEntity`, `inspectHandCard`.
  Each one commits through `onCommit` with a label and plays its sound.
- **`ui`** — the ephemeral zustand store (`selection`, `ghost`, `menu`, `inspect`,
  `browse`, `shortcutsOpen`, `handCollapsed`…). `ctl.ui.setState({ shortcutsOpen: true })`
  opens the shortcuts sheet from outside.

## Rendering contract

World units are millimetres; the world layer is laid out at `K = 4` CSS px per mm and the
camera scales it (`zoom` = screen px per mm). Only the camera transform changes during a
pan/zoom, and dragging writes to a single ghost element — entity components never
re-render on pointer move. `--hud` and `--px` CSS variables on `.play-world` let badges,
captions and outlines keep a constant on-screen size at any zoom.

## Dice

`dice/` renders every die as a real chamfered solid in SVG (no dependency): `geometry.ts` builds the
model per face count (d2 coin · d4 tetrahedron read at the top corner · d6 cube with pips · d8 · d10
pentagonal trapezohedron · d12 · d20 · even 14–30 trapezohedra · odd counts numbered twice on the
next solid, as real d3/d5/d7 are · 31+ a ball with a plateau per result, the rolled one enlarged);
`<DieView>` projects it with flat shading and lays each number/label/image on its face. Changing
`rollSeq` tumbles it (rAF, ~0.78 s, rolls in from its previous spot); changing `face` tips it over;
reduced motion jumps straight to the result. The entity's `rot` becomes the die's yaw (the frame
rotation is undone) so light comes from one direction across the table.

**Several dice.** Select dice: Shift/Ctrl-click or Shift-drag a box; on touch tap a die, then tap
others to add / remove them (the bar says so), or hold the table / board until the menu opens ("Keep
holding and drag") and drag on to box-select; "Select all N dice" is in the die and table menus. Then:
- **fling any selected die** (or drag the handful and let go at speed) → every selected die is thrown,
  whatever zone or piece the pointer is over; a slow release just moves them. Release speed comes from
  the coalesced pointer samples of the last ~45 ms of movement (`releaseVelocity`), so a busy frame
  can't eat a flick; a quick pick-up-and-toss throws at a lower speed than a long carry. In a mixed
  selection only the dice are thrown; the other pieces are dropped normally (zones still take them).
- dice land as a loose cluster (never a row or grid), off other dice, beside cards / tokens / notes
  when there is room, and never under the bottom chrome (dice bar, hand tab); the bar slides aside
  rather than cover a die. `R` with the mouse over a locked board rolls the selection.
- **"Roll N dice"** — the bar above the hand (play mode) or the die menu; `R` also works.

`controller.throwDice()` rolls them as one commit (one undo step): a common direction and carry
from the gesture, per-die variation, and landing spots solved up front by `table/throw.ts`
(`planThrow`: no die lands on another thrown or resting die, all stay inside `landingArea()` — the
visible table). The camera never moves. Each thrown die tumbles in from where it left the hand
(`ctl.launches` → `<DieView launch>`). After a roll of 2+ dice `<RollReadout>` (`table/DiceHud.tsx`)
lists results per die type in the dice's own colours with a total (sum of numbered faces), beside
the landed group; it leaves after ~7 s, on ×/Esc, and as soon as undo or a re-roll makes it stale. The component editor uses
the same `<DieView>`. "Set face" lists up to 12 faces flat, larger dice in ranges of ten.

## Game pieces

`pieces/` renders generic pieces (cube · disc · meeple · house · pawn) in wood, plastic or acrylic.
`model.ts` holds shape dimensions, the player palette, supply heaps and the screen frame (the body is a
D×D square around the silhouette; ring and hit pad are round). `mesh.ts` builds the meshes once (rounded
box, lathe profiles, rounded extrusions traced from 2D distance functions). `render.ts` rasterises each
(look, yaw, density bucket, lift, supply) ONCE in a shared WebGL2 context — light shadow maps + PCSS ground
shadow, contact occlusion, acrylic thickness from a back-face depth pass, 2× supersampled — and caches a
2D canvas; `<PieceView>` blits it. Same view tilt and light as the dice, so the image is re-lit, not
rotated (entity `rot` → yaw). Density follows `ui.pieceRes` (half-octave buckets, updated at camera rest).
Shaders are deliberately small: ANGLE's D3D compiler took 1.5–10 s per ray-marching variant.
`warmPieceRenderer()` starts compiling in the background (KHR_parallel_shader_compile) when a game has
pieces; no WebGL → a 2D-shaded fallback.

A piece entity with `infinite` is a supply: a wooden bowl with a heap, an ∞ badge and a "X supply"
caption. Dragging from it (`DragSource pieceOne`) makes a new piece; dropping a matching piece over the
bowl (`DropTarget pieceSupply`) returns it. Pieces never merge. In a flung mixed selection pieces are put
down (and nudged clear of dice) like tokens.

## Zones and grids

`engine/zones.ts` holds the rules; `ZoneEntity` gained three optional fields (v2-6), and a zone without
them is exactly a pre-v2-6 zone (`normalizeZone` returns the same object; `normalizeState` and
`freshStateFromSetup` run it).

- **`accepts`** — any of `cards · tokens · pieces · dice` (default cards). A carried thing a zone doesn't
  take is not a target: it lands as on bare table, the zone steps back while carrying (`is-refusing`)
  and the one under the piece shows "Takes … only" (`ui.dropRefuse`).
- **`grid`** — `{ cellW, cellH, gapX, gapY, cols, rows, endless? }`. Limited: w/h always follow
  cols × rows (+3 mm pad). Endless: the entity is its origin cell (visible in setup only) and
  `<EndlessGrids>` (`table/grids.tsx`) draws the lattice under boards and pieces, fading as cells get
  small on screen; bounded zones above it win. The receiving cell is the one nearest the carried
  CENTRE. Occupied cells: cards go on top of the card there; a token joins a pile of the same token;
  pieces / dice / other tokens take the nearest free cell (only the same category occupies — a marker
  may sit on a card); a full limited grid puts the item beside it.
- **`pieceMode`** (tokens / pieces / dice in an area; default stack if it takes tokens, else pool if
  pieces, else free): `stack` — a token joins the zone's pile of that token, pieces and dice line up;
  `pool` — items stay individual in centred rows, inserted where their centre is, re-flowed by
  `reflowZones` on every commit (so taking one closes the gap); supplies and anything else inside are
  obstacles that never move (then rows pack from the top-left around them); full → beside the zone.
  `free` — kept fully inside and nudged off same-category neighbours.

Before release `tableDropTarget` runs the drop (pure) and puts the exact landing footprint on the
target (`DropTarget.land`); `<DropLandMarker>` draws it above the pieces with the hint (pile count,
"Goes on top of …", "Full · goes beside it"). **Dice trays**: a flung die still always throws (v2-4).
Every throw and roll is planned by `planDiceThrow` (`table/throw.ts`, pure, checked by
`npx tsx scripts/check-throws.mts`): the natural plan exactly as on the same table without any tray
(seeded; the landing area's "near the game" bounds ignore zones that take dice). A throw that would leave
that area comes down at its far edge along its own path (the cloud is linear in the distance carried, so the
largest distance that fits is exact): a harder throw never lands shorter. A tray has walls, and a throw is
ONE decision for the whole handful: it is caught when the group's flight — the centre of the flick stretch
(start of the release-speed window → release), then release centre → release centre + direction × travel,
with no random scatter — crosses the tray grown by half a die + 2 mm. Caught: every die is re-planned and
packed inside (overflow in a row just below it). Not caught: every die keeps the natural plan untouched, except
one that would rest in or across a tray, which is moved just outside it. Same release and speed → same outcome. Release speed
(`releaseVelocity` / `flingOf`) is the same code for mouse and touch: a least-squares fit of position over
time for the samples of the last 70 ms (at least two), so event spacing doesn't change the speed. A tray far (> 60 mm) from every
other piece is outside where throws may land at all, as on a table without it. Dice resting in a grid /
pool zone take a cell / slot.

## Sounds

`src/lib/sound.ts` synthesises everything with WebAudio (no files): `pickup`, `place`,
`flip`, `shuffle`, `dice`, `clink`, `tap`, `slide`. On/off is the app-wide `sound` setting
(`src/state/settings.ts`, server-persisted); `useSoundMuted()` still works. The AudioContext
is only created after a real user gesture.

## Names on the table

Zone labels, stack captions and supply captions follow the app setting `showNamesPlay`
(play, default **off**) or `showNamesSetup` (setup editor, default **on**), mirrored into
`ui.names`. With names off, an entity still renders its name as `.is-peek` while it is
hovered (mouse, 260 ms dwell → `ui.peek`), selected, or the current drop target; the long-press /
right-click menu header always names it. Count badges are never affected. Peek labels are
placed by `placeLabels({ only })` around the labels already showing and rank last in a full
pass, so a name appearing or disappearing never moves another label. `N` toggles the setting.
