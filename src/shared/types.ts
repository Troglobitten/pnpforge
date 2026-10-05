/**
 * pnpforge shared data model — used by both the web client and the server.
 *
 * UNITS: every physical size and every table position is in MILLIMETRES.
 * Rotations are in DEGREES (clockwise). Entity x/y is the entity's CENTRE.
 * The camera maps mm -> screen px via `zoom` (px per mm).
 */

export type ID = string;

/* ------------------------------------------------------------------ */
/* Assets (server-managed; every binary file belonging to a game)      */
/* ------------------------------------------------------------------ */

/** 'photo' = an original photo kept for an unfinished (or re-editable) photo import. */
export type AssetRole = 'source' | 'page' | 'card' | 'image' | 'cover' | 'other' | 'photo';

export interface Asset {
  id: ID;
  /** Filename on disk inside data/games/<gameId>/assets/ (id + extension). */
  file: string;
  mime: string;
  /** Pixel dimensions (0 for non-images such as PDFs). */
  width: number;
  height: number;
  bytes: number;
  /** Original upload filename, if any. */
  name?: string;
  role?: AssetRole;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Sources: the user's original print-and-play files                   */
/* ------------------------------------------------------------------ */

export interface SourcePage {
  index: number; // 0-based
  /**
   * Page size in mm. For a page of an image set that is a photo (`photo: true`) there is no known
   * scale: both are 0 — use `pageMm()` from `src/shared/cutter/doc.ts`, never these directly.
   */
  widthMm: number;
  heightMm: number;
  /** Optional pre-rendered thumbnail asset. */
  thumb?: ID | null;

  /* ---- image sets only (SourceDoc.kind 'images'): one image file per page ---- */
  /** This page's original image (role 'photo' when it is a photo, 'source' when a flat scan). */
  assetId?: ID;
  /** The image's original file name. */
  name?: string;
  /** Pixel size after EXIF orientation. Frames on image-set pages are in these pixels. */
  px?: { w: number; h: number };
  /**
   * The owner's "This is a photo" switch (v3 Q2). true: a camera photo — perspective frames,
   * clean-up, no known scale, never any automatic helpers. false: a flat scan at `dpi`.
   */
  photo?: boolean;
  /** Flat scan: pixels per inch (widthMm = px.w / dpi × 25.4). */
  dpi?: number;
  /** EXIF time taken (ms), for sorting a photo set by time. */
  takenAt?: number | null;
  /** The file's modified time (ms): the fallback when there is no `takenAt`. */
  lastModified?: number;
  /** Photo: measured colour of the light (RGB gains), null when the photo shows no paper. */
  gains?: [number, number, number] | null;
}

export interface SourceDoc {
  id: ID;
  name: string;
  /**
   * 'pdf' and 'image' (one flat image) are page-mm sources. 'images' (v3) is an image set added
   * with "Add images": every page is its own file, flagged per page as a photo or a flat scan.
   */
  kind: 'pdf' | 'image' | 'images';
  /** The original uploaded file ('' for an image set — each page has its own `assetId`). */
  assetId: ID;
  pageCount: number;
  pages: SourcePage[];
  createdAt: number;
}

/** A rectangle in page millimetres (origin = top-left of the page). */
export interface RectMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A remembered slicing configuration so the user can revisit / re-run a cut.
 * The slicer feature owns the details of `settings`.
 * v3: legacy. Read only to migrate into `CutterDoc`; the unified cutter never writes it.
 */
export interface SliceJob {
  id: ID;
  sourceId: ID;
  name: string;
  /** What the job produced. */
  targetComponentId: ID | null;
  mode: 'grid' | 'single' | 'stitch';
  pages: number[];
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Components: the game's physical pieces (definitions, not placements) */
/* ------------------------------------------------------------------ */

export type ComponentKind = 'deck' | 'board' | 'tokens' | 'dice' | 'counter' | 'piece';

interface ComponentBase {
  id: ID;
  kind: ComponentKind;
  name: string;
  createdAt: number;
}

export interface CardDef {
  id: ID;
  name?: string;
  /** Front face image asset (null = blank placeholder). */
  front: ID | null;
  /** Optional per-card back override; otherwise the deck back is used. */
  back?: ID | null;
  /** Number of copies of this card in the deck. */
  count: number;
}

export interface DeckComponent extends ComponentBase {
  kind: 'deck';
  width: number; // mm
  height: number; // mm
  cornerRadius: number; // mm
  /** Default card back asset. */
  back: ID | null;
  /** Colour used when there is no back image. */
  backColor: string;
  cards: CardDef[];
}

export interface BoardComponent extends ComponentBase {
  kind: 'board';
  image: ID | null;
  width: number; // mm
  height: number; // mm
  cornerRadius: number; // mm
}

export type TokenShape = 'square' | 'rect' | 'round' | 'hex';

export interface TokenComponent extends ComponentBase {
  kind: 'tokens';
  shape: TokenShape;
  width: number; // mm
  height: number; // mm
  front: ID | null;
  back: ID | null;
  /** Fill colour when there is no image. */
  color: string;
  /** Short text printed on image-less tokens. */
  label?: string;
  /**
   * How many of this token the game has (v3: from the cutter's "same ×N"). Making never puts
   * them on the table (owner Q3); table setup can offer this many. Missing = not known.
   */
  count?: number;
}

export interface DieFace {
  label?: string;
  /** Numeric value (used for pip rendering when no label/image). */
  value?: number;
  image?: ID | null;
}

export interface DieComponent extends ComponentBase {
  kind: 'dice';
  size: number; // mm (edge length)
  color: string;
  inkColor: string;
  faces: DieFace[];
}

export interface CounterComponent extends ComponentBase {
  kind: 'counter';
  label: string;
  min: number;
  max: number;
  initial: number;
  step: number;
  color: string;
}

export type PieceShape = 'cube' | 'disc' | 'meeple' | 'house' | 'pawn';
export type PieceMaterial = 'wood' | 'plastic' | 'acrylic';

/** A generic physical game piece (a wooden cube, a plastic pawn, an acrylic meeple…). */
export interface PieceComponent extends ComponentBase {
  kind: 'piece';
  shape: PieceShape;
  material: PieceMaterial;
  /** Paint / plastic / acrylic tint, #rrggbb. */
  color: string;
  /** mm: cube edge, disc and pawn diameter, meeple width, house length. */
  size: number;
  /** Meeples only: lying on its back instead of standing. */
  lying?: boolean;
}

export type Component =
  | DeckComponent
  | BoardComponent
  | TokenComponent
  | DieComponent
  | CounterComponent
  | PieceComponent;

/* ------------------------------------------------------------------ */
/* Table state: placements on the table (setup + live play sessions)    */
/* ------------------------------------------------------------------ */

export interface CardInstance {
  /** Unique per physical card on the table (copies get distinct uids). */
  uid: ID;
  deckId: ID;
  cardId: ID;
  faceUp: boolean;
}

interface EntityBase {
  id: ID;
  /** Centre position in table mm. */
  x: number;
  y: number;
  /** Degrees clockwise. */
  rot: number;
  locked?: boolean;
}

export type StackLayout = 'pile' | 'fan' | 'row' | 'grid';

/** A card on the table is always a stack (a single card is a stack of 1). */
export interface StackEntity extends EntityBase {
  kind: 'stack';
  /** Bottom -> top. */
  cards: CardInstance[];
  layout: StackLayout;
  name?: string;
  /** Setup only: shuffle this stack when a new session starts. */
  shuffleOnStart?: boolean;
}

export interface BoardEntity extends EntityBase {
  kind: 'board';
  componentId: ID;
}

export interface TokenEntity extends EntityBase {
  kind: 'token';
  componentId: ID;
  faceUp: boolean;
  /** Number of identical tokens stacked here (>=1). */
  count: number;
  /** A supply never runs out: dragging from it spawns a new token. */
  infinite?: boolean;
}

export interface DieEntity extends EntityBase {
  kind: 'die';
  componentId: ID;
  /** Index into the component's faces. */
  face: number;
  /** Incremented on every roll so renderers can animate. */
  rollSeq?: number;
}

/** One game piece. Pieces never merge into a count: every piece is its own entity. */
export interface PieceEntity extends EntityBase {
  kind: 'piece';
  componentId: ID;
  /** A supply (a bowl of them) never runs out: dragging from it spawns a new piece. */
  infinite?: boolean;
  /** Optional per-placement overrides of the component's look. */
  color?: string;
  material?: PieceMaterial;
}

export interface CounterEntity extends EntityBase {
  kind: 'counter';
  componentId?: ID;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  color: string;
}

/** What a zone takes. Anything else dropped on it lands as if on the bare table. */
export type ZoneAccept = 'cards' | 'tokens' | 'pieces' | 'dice';

/**
 * How tokens, pieces and dice dropped in a zone (that is not a grid) are arranged:
 * `stack` — tokens of one kind merge into a counted pile (pieces and dice still line up);
 * `pool` — every item stays individual and is laid out neatly, re-flowing as items come and go;
 * `free` — stays where dropped, kept inside the zone and off its neighbours (a dice tray).
 */
export type ZonePieceMode = 'stack' | 'pool' | 'free';

/** A zone laid out as cells. Sizes in mm. */
export interface ZoneGrid {
  cellW: number;
  cellH: number;
  /** Spacing between neighbouring cells. */
  gapX: number;
  gapY: number;
  /** Limited grids only; the zone's w/h always follow cols × rows. */
  cols: number;
  rows: number;
  /** Extends across the whole table; the zone's x/y is the centre of one cell (the origin). */
  endless?: boolean;
  /** UI only: which size preset the cell came from ('deck:<id>', 'card:poker', 'custom'…). */
  preset?: string;
}

export interface ZoneEntity extends EntityBase {
  kind: 'zone';
  w: number; // mm
  h: number; // mm
  label: string;
  color: string;
  /** How cards dropped here are arranged. */
  snap: 'pile' | 'row' | 'free';
  /** If set, cards dropped here are turned to this orientation. */
  forceFace?: 'up' | 'down';
  /** What it takes. Missing (every zone made before v2-6) = cards only. */
  accepts?: ZoneAccept[];
  /** Tokens / pieces / dice arrangement. Missing = derived from `accepts` (see zoneConfig). */
  pieceMode?: ZonePieceMode;
  /** Present = the zone is a grid (limited or endless); cards and pieces snap to cells. */
  grid?: ZoneGrid;
}

export interface NoteEntity extends EntityBase {
  kind: 'note';
  w: number; // mm
  h: number; // mm
  text: string;
  color: string;
}

export type Entity =
  | StackEntity
  | BoardEntity
  | TokenEntity
  | DieEntity
  | PieceEntity
  | CounterEntity
  | ZoneEntity
  | NoteEntity;

export type EntityKind = Entity['kind'];

export interface Camera {
  /** Table mm at the centre of the viewport. */
  x: number;
  y: number;
  /** Screen px per mm. */
  zoom: number;
  /**
   * Optional: size (px) of the unobstructed table area this camera was saved for. Set by the
   * setup editor's "starting view" so play can frame the same table region on any screen.
   */
  viewW?: number;
  viewH?: number;
}

export interface TableState {
  entities: Record<ID, Entity>;
  /** Z-order, back -> front. */
  order: ID[];
  /** Cards held in the player's hand tray (left -> right). */
  hand: CardInstance[];
  camera?: Camera;
}

/* ------------------------------------------------------------------ */
/* Game                                                                 */
/* ------------------------------------------------------------------ */

export type TableTheme = 'felt-green' | 'felt-blue' | 'felt-red' | 'felt-black' | 'felt-white' | 'wood' | 'wood-dark';

export interface RulebookRef {
  /** A PDF/image source used as the rulebook. */
  sourceId: ID | null;
  /**
   * Further image sources shown as extra pages after `sourceId`, so a rulebook
   * scanned as a set of images isn't stuck at one page. Ignored for PDFs.
   */
  sourceIds?: ID[];
  /** Optional free-form notes / quick reference shown in play. */
  notes: string;
}

export interface Game {
  id: ID;
  schema: 1;
  name: string;
  description: string;
  designer: string;
  /** Cover image asset. */
  cover: ID | null;
  playTime: string; // e.g. "20–30 min"
  tags: string[];
  createdAt: number;
  updatedAt: number;

  /** Server-managed. Present on GET; ignored on PUT. */
  assets: Record<ID, Asset>;

  sources: SourceDoc[];
  slices: SliceJob[];
  components: Component[];
  /** The initial table layout a new session starts from. */
  setup: TableState;
  rules: RulebookRef;
  table: {
    theme: TableTheme;
  };
}

export interface GameSummary {
  id: ID;
  name: string;
  description: string;
  designer: string;
  cover: ID | null;
  /** Filename of the cover asset (for building its URL without loading the game). */
  coverFile: string | null;
  tags: string[];
  playTime: string;
  createdAt: number;
  updatedAt: number;
  componentCount: number;
  cardCount: number;
  sessionCount: number;
  lastPlayedAt: number | null;
}

/* ------------------------------------------------------------------ */
/* Play sessions (saves)                                                */
/* ------------------------------------------------------------------ */

export interface Session {
  id: ID;
  gameId: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  state: TableState;
  /** Optional player notes kept with the save. */
  notes?: string;
}

export interface SessionSummary {
  id: ID;
  gameId: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* v3 unified cutter (data/games/<id>/cutter.json)                      */
/* One model for PDF pages, flat scans and photos. See                  */
/* docs/briefs/v3/unified-cutter-design.md §4a; pure helpers and the    */
/* migration from SliceJobs / drafts live in src/shared/cutter/.        */
/* ------------------------------------------------------------------ */

/**
 * A point on a page, in PAGE UNITS: millimetres on 'pdf' and 'image' sources, image pixels (after
 * EXIF) on every page of an 'images' set — photo or flat scan, so flipping a page's "This is a
 * photo" switch never moves a frame. `pageUnits()` in src/shared/cutter/doc.ts says which.
 */
export type CutPt = [number, number];
/** Four corners [TL, TR, BR, BL] in the piece's upright orientation, in page units. */
export type CutQuad = [CutPt, CutPt, CutPt, CutPt];

export interface PageRef {
  sourceId: ID;
  /** 0-based page index in the source. */
  page: number;
}

/** How a sheet was turned over to show the backs (which edge the flip went over). */
export type BackFlip = 'long' | 'short' | 'none';

/**
 * Rows × columns of equal pieces under one set of four handles. Frames are generated from it
 * (and stored, see CutFrame). A flat PDF grid is simply one with `square: true`.
 */
export interface CutGrid {
  id: ID;
  at: PageRef;
  /** The group new frames of this grid go into. */
  groupId: ID;
  rows: number;
  cols: number;
  /** Space between columns as a share of a piece's width; between rows, of its height. */
  gapX: number;
  gapY: number;
  /**
   * Handles, clockwise from top-left: the outer corners of the grid — or, for `round` grids of
   * at least 2 × 2, the centres of the four corner pieces.
   */
  anchors: CutQuad;
  /** "Keep it square": the grid stays an axis-aligned rectangle (default on flat pages). */
  square: boolean;
  /** Round pieces: cells are square (aspect 1) and the handles sit on the corner pieces' centres. */
  round: boolean;
  /** Width ÷ height of one piece as it lies on the page, before `turn`. */
  cellAspect: number;
  /** Quarter turns from the grid's layout to the pieces' upright. */
  turn: number;
  /** Cells whose frame was deleted (no frame exists for them). Leaving a piece out is CutFrame.excluded. */
  removed: number[];
  /**
   * Owner Q5: "all the same piece" (one piece × the number of frames) or "all different".
   * Never decided by looks. The frames' `same` links carry it; this is the grid's switch.
   */
  same: boolean;
  /** The user has placed the handles (a new size grows from them instead of re-centring). */
  fitted?: boolean;
  /** Flat pages only: cells that look empty are skipped when making (unless a frame says `keep`). */
  skipBlank?: boolean;
  /** Flat pages: grids sharing one layout ("Use this grid on… all A4 pages"); editing one moves all. */
  linkId?: ID;
  /**
   * This grid shows the backs of another grid's pieces, turned over. `linked`: its anchors follow
   * the front grid mirrored plus (dx, dy) in page units (flat duplex sheets); otherwise it has its
   * own handles, pre-laid mirrored (photos).
   */
  backOf?: { gridId: ID; flip: BackFlip; linked: boolean; dx: number; dy: number; page?: { w: number; h: number } };
  /** This grid's frames are backs (a page of backs, or backs photographed on their own). */
  backs?: boolean;
  /** Made by the "a page of backs" rule (not by the user): it goes when that rule no longer uses it. */
  byRule?: 'backs-page';
  /** What a flat-page helper found when it placed this grid ("Found 3 × 3 cards … using the crop marks"). */
  note?: { text: string; tone: 'success' | 'info' | 'warning' };
  /**
   * While an image page is switched to "flat scan", the grid's photo layout is kept here so
   * switching back to "This is a photo" restores exactly the corners the user placed.
   */
  photoLayout?: { square: boolean; anchors: CutQuad };
}

/** One piece's outline on a page. */
export interface CutFrame {
  id: ID;
  at: PageRef;
  groupId: ID;
  quad: CutQuad;
  /** 'round' = the ellipse inscribed in the quad (a circle on a flat page). */
  shape: 'rect' | 'round';
  /** The grid and cell it was made for (its place in the numbering). */
  gridId?: ID;
  cell?: number;
  /** It still follows its grid (false once its own corners were moved, or when drawn by hand). */
  onGrid: boolean;
  /** Extra quarter turns on top of the grid's. */
  turn: number;
  side: 'front' | 'back';
  /** "Same piece as frame X": frames linked to one representative make one piece with a count. */
  same?: ID | null;
  /** "×N": this frame stands for N identical pieces (default 1). */
  copies?: number;
  name?: string;
  /** Left out (tap to toggle; reversible). */
  excluded?: boolean;
  /** Flat pages: made even though it looks empty (overrides the grid's `skipBlank`). */
  keep?: boolean;
}

/** What a group makes. */
export type CutKind = 'cards' | 'tokens' | 'board' | 'back' | 'cover';

export interface CutSize {
  /** The finished piece in mm (cards: as the card stands upright). */
  w: number;
  h: number;
  /** 'page' = measured from the frame on a flat page. */
  from: 'page' | 'preset' | 'typed' | 'measured';
  /** CARD_PRESETS / token size id. */
  preset?: string;
  /** e.g. "Measured against the cards in the same photo — check it." */
  note?: string;
}

/** How "each has its own back" pairs were filled; the result always lives in `CutBacks.pairs`. */
export type CutBacksRule =
  /** Turned over onto the next page/photo: the back grids say which front grid (`CutGrid.backOf`). */
  | { kind: 'turned-over'; flip: BackFlip }
  /** One page of backs; cells map in order, or mirrored when the grids match. */
  | {
      kind: 'backs-page';
      /** The backs page first chosen (older documents: the backs page of every front page). */
      page: PageRef;
      flip: BackFlip;
      size?: { w: number; h: number };
      /** Front page ("sourceId:page") → its backs page, or null = no backs. A page used twice is the user's choice. */
      map?: Record<string, PageRef | null>;
    }
  /** Paired one by one by the user. */
  | { kind: 'hand' };

export interface CutBacks {
  mode: 'none' | 'same' | 'each';
  /** 'same': the frame (a `side: 'back'` frame of this group) every piece gets as its back… */
  sharedFrameId?: ID | null;
  /** …or an uploaded image. */
  assetId?: ID | null;
  rule?: CutBacksRule;
  /** 'each': front frame id → back frame id (null = no back, the deck's colour). */
  pairs: Record<ID, ID | null>;
  /** Fronts the user paired by hand: a rule that fills the pairs again leaves these alone. */
  handPaired?: ID[];
  /** The pairs the user looked at and confirmed (a signature); different now = check again. */
  checked?: string;
}

/** Board groups with 2+ frames joined into one board. */
export interface CutJoin {
  dir: 'h' | 'v';
  /** One per seam (between frame i and i+1 in `order`), in mm. `auto`: the measured value stands. */
  joins: {
    /** The two frames this seam is between ("frontId>nextId"): seams follow the parts, not their position. */
    key?: string;
    /** Not set yet (a part was added): the user is asked for it, or a flat page measures it. */
    pending?: boolean;
    overlap: number;
    shift: number;
    auto?: boolean;
    /** A thin printed line (a cut guide) at the edges that meet, mm: `a` at the end of part i, `b` at the start of part i+1 — painted over when joining, the size unchanged. Flat pages only. */
    line?: { a: number; b: number };
  }[];
  /** Printed bleed trimmed off the outside of the joined board, mm. */
  bleed: number;
}

export interface CutOut {
  /** Cards: a new deck or one that exists. Card back: the deck is `deckId`. */
  target: 'new' | 'existing';
  deckId: ID | null;
  /** 150 / 200 / 300; on photos capped by what the photo holds. */
  dpi: number;
}

/** What the group made last, so making again updates it in place. */
export interface CutMade {
  /** The deck / first token / board; null for a cover. */
  componentId: ID | null;
  /** Cards made (deck card ids), tokens or boards made (component ids), in make order. */
  pieceIds: ID[];
  at: number;
  /** `groupSignature()` when it was made; different now = "Changed · Update". '' = unknown. */
  signature: string;
  /** The piece each front frame made (its first frame → card / token / board id): an update reuses them by frame. */
  byFrame?: Record<ID, ID>;
}

/** Where a migrated group came from (kept for traceability; never used to make). */
export interface CutOrigin {
  from: 'slice-job' | 'photo-draft' | 'slicer-draft';
  id: string;
  note?: string;
}

export interface CutGroup {
  id: ID;
  name: string;
  kind: CutKind;
  /** null = not set yet (photos: the checklist says "needs a size"). */
  size: CutSize | null;
  /** Frames on FLAT pages (PDF, scans): the printed bleed cut off every edge, mm. */
  trimMm: number;
  /** Frames on flat pages: rounded corners filled, mm (0 — print files have their own corners). */
  cornerMm: number;
  /**
   * Frames on PHOTO pages: "trim the edges" and the rounded corners filled by clean-up, mm. Missing =
   * the photo defaults (0.4 mm, 3 mm; tokens 0). Kept apart so a deck mixing a PDF and photos gives
   * each piece the finish of its own medium.
   */
  photo?: { trimMm: number; cornerMm: number };
  /** Tokens. */
  shape?: TokenShape;
  /** The group's frames in piece order (Pieces view). Frames missing here follow in reading order. */
  order: ID[];
  backs: CutBacks;
  join?: CutJoin;
  out: CutOut;
  made?: CutMade;
  origin?: CutOrigin;
  /** The user's colour for the group's frames (0–5, a tint of the palette); missing = by its place. */
  color?: number;
}

/** "Look like a scan" for a photo set (trim and corners are per group). */
export interface CutClean {
  /** 0..1 automatic white balance + levels. */
  color: number;
  /** 0..1 evening out uneven light. */
  flatten: number;
}

export interface CutterDoc {
  version: 2;
  /** Server-stamped on every save. */
  updatedAt?: number;
  grids: Record<ID, CutGrid>;
  frames: Record<ID, CutFrame>;
  groups: CutGroup[];
  /** Per photo set / image source id. */
  clean: Record<ID, CutClean>;
  /** Where the user was. */
  view?: { at: PageRef | null; groupId?: ID | null; mode: 'pages' | 'pieces' };
  /** Legacy records already absorbed ("slice-job:<id>", "photo-draft", "slicer-draft:<key>"). */
  migrated?: { at: number; absorbed: string[] };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

export function emptyTable(): TableState {
  return { entities: {}, order: [], hand: [] };
}

export const CARD_PRESETS: { id: string; label: string; width: number; height: number }[] = [
  { id: 'poker', label: 'Poker', width: 63.5, height: 88.9 },
  { id: 'bridge', label: 'Bridge', width: 57, height: 89 },
  { id: 'mini-euro', label: 'Mini Euro', width: 44, height: 68 },
  { id: 'mini-us', label: 'Mini American', width: 41, height: 63 },
  { id: 'tarot', label: 'Tarot', width: 70, height: 120 },
  { id: 'square', label: 'Square', width: 70, height: 70 },
  { id: 'euro', label: 'Euro', width: 59, height: 92 },
  { id: 'business', label: 'Business card', width: 85, height: 55 },
];

export const PAGE_PRESETS: { id: string; label: string; width: number; height: number }[] = [
  { id: 'a4', label: 'A4', width: 210, height: 297 },
  { id: 'letter', label: 'US Letter', width: 215.9, height: 279.4 },
];
