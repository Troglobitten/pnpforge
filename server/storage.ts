import { promises as fs, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { customAlphabet } from 'nanoid';
import { imageSize } from 'image-size';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type {
  Asset,
  AssetRole,
  CutterDoc,
  Game,
  GameSummary,
  Session,
  SessionSummary,
} from '../src/shared/types.js';
import { normalizeSettings, sanitizeSettingsPatch, type AppSettings } from '../src/shared/settings.js';
import { validateCutterDoc } from '../src/shared/cutter/doc.js';

export const DATA_DIR = path.resolve(process.env.PNPFORGE_DATA ?? path.join(process.cwd(), 'data'));
const GAMES_DIR = path.join(DATA_DIR, 'games');
const TRASH_DIR = path.join(DATA_DIR, 'trash');

export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

export class NotFound extends Error {
  statusCode = 404;
}

const ID_RE = /^[a-z0-9_-]{1,64}$/i;
function safeId(id: string): string {
  if (!ID_RE.test(id)) throw new NotFound('Invalid id');
  return id;
}

const gameDir = (id: string) => path.join(GAMES_DIR, safeId(id));
const gameFile = (id: string) => path.join(gameDir(id), 'game.json');
const assetsIndexFile = (id: string) => path.join(gameDir(id), 'assets.json');
export const assetsDir = (id: string) => path.join(gameDir(id), 'assets');
const sessionsDir = (id: string) => path.join(gameDir(id), 'sessions');
/** Photo import in progress: kept beside game.json so the hot game save stays small. */
const photoDraftFile = (id: string) => path.join(gameDir(id), 'photo-draft.json');
/** v3 unified cutter state: grids, frames, groups (see CutterDoc). Kept beside game.json like the draft. */
const cutterFile = (id: string) => path.join(gameDir(id), 'cutter.json');

/* ---------------- per-game serialisation of writes ---------------- */

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new NotFound('Not found');
    throw e;
  }
}

async function writeJsonAtomic(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, file);
}

export async function ensureDataDirs() {
  await fs.mkdir(GAMES_DIR, { recursive: true });
  await fs.mkdir(TRASH_DIR, { recursive: true });
}

/* ---------------- games ---------------- */

export function blankGame(id: string, name: string): Omit<Game, 'assets'> {
  const now = Date.now();
  return {
    id,
    schema: 1,
    name: name.trim() || 'Untitled game',
    description: '',
    designer: '',
    cover: null,
    playTime: '',
    tags: [],
    createdAt: now,
    updatedAt: now,
    sources: [],
    slices: [],
    components: [],
    setup: { entities: {}, order: [], hand: [] },
    rules: { sourceId: null, notes: '' },
    table: { theme: 'felt-green' },
  };
}

async function readAssets(id: string): Promise<Record<string, Asset>> {
  try {
    return await readJson<Record<string, Asset>>(assetsIndexFile(id));
  } catch (e) {
    if (e instanceof NotFound) return {};
    throw e;
  }
}

export async function readGame(id: string): Promise<Game> {
  const game = await readJson<Game>(gameFile(id));
  game.assets = await readAssets(id);
  return game;
}

export async function createGame(name: string, partial?: Partial<Game>): Promise<Game> {
  const id = newId();
  const game = { ...blankGame(id, name), ...(partial ?? {}), id } as Game;
  delete (game as Partial<Game>).assets;
  await fs.mkdir(assetsDir(id), { recursive: true });
  await fs.mkdir(sessionsDir(id), { recursive: true });
  await writeJsonAtomic(gameFile(id), game);
  await writeJsonAtomic(assetsIndexFile(id), {});
  return { ...game, assets: {} };
}

export async function saveGame(id: string, incoming: Game): Promise<Game> {
  return withLock(id, async () => {
    const existing = await readJson<Game>(gameFile(id));
    const game: Game = {
      ...incoming,
      id,
      schema: 1,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    delete (game as Partial<Game>).assets;
    await writeJsonAtomic(gameFile(id), game);
    return { ...game, assets: await readAssets(id) };
  });
}

export async function deleteGame(id: string) {
  const dir = gameDir(id);
  if (!existsSync(dir)) throw new NotFound('Not found');
  await fs.mkdir(TRASH_DIR, { recursive: true });
  const dest = path.join(TRASH_DIR, `${id}-${Date.now()}`);
  try {
    await fs.rename(dir, dest);
  } catch (e: any) {
    // Windows: a directory watched by another process (e.g. the Vite dev
    // server's file watcher) can't be renamed. Copy to the trash, then remove.
    if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EXDEV'].includes(e?.code)) throw e;
    await fs.cp(dir, dest, { recursive: true });
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  }
}

export async function listGames(): Promise<GameSummary[]> {
  await ensureDataDirs();
  const ids = await fs.readdir(GAMES_DIR);
  const out: GameSummary[] = [];
  for (const id of ids) {
    try {
      const game = await readJson<Game>(gameFile(id));
      const assets = await readAssets(id);
      const sessions = await listSessions(id);
      let cardCount = 0;
      for (const c of game.components) {
        if (c.kind === 'deck') cardCount += c.cards.reduce((n, card) => n + (card.count ?? 1), 0);
      }
      out.push({
        id: game.id,
        name: game.name,
        description: game.description,
        designer: game.designer ?? '',
        cover: game.cover,
        coverFile: game.cover && assets[game.cover] ? assets[game.cover].file : null,
        tags: game.tags ?? [],
        playTime: game.playTime ?? '',
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
        componentCount: game.components.length,
        cardCount,
        sessionCount: sessions.length,
        lastPlayedAt: sessions.length ? Math.max(...sessions.map((s) => s.updatedAt)) : null,
      });
    } catch {
      // skip unreadable / partial directories
    }
  }
  out.sort((a, b) => Math.max(b.updatedAt, b.lastPlayedAt ?? 0) - Math.max(a.updatedAt, a.lastPlayedAt ?? 0));
  return out;
}

/* ---------------- assets ---------------- */

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
};

export const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]),
);

function sniffMime(buf: Buffer, fallback: string, filename?: string): string {
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
    return 'image/webp';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  return fallback || 'application/octet-stream';
}

export async function addAsset(
  gameId: string,
  data: Buffer,
  opts: { name?: string; mime?: string; role?: AssetRole },
): Promise<Asset> {
  if (!existsSync(gameFile(gameId))) throw new NotFound('Game not found');
  const mime = sniffMime(data, opts.mime ?? '', opts.name);
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const id = newId();
  let width = 0;
  let height = 0;
  if (mime.startsWith('image/')) {
    try {
      const dim = imageSize(data);
      width = dim.width ?? 0;
      height = dim.height ?? 0;
    } catch {
      /* unknown dims */
    }
  }
  const asset: Asset = {
    id,
    file: `${id}.${ext}`,
    mime,
    width,
    height,
    bytes: data.length,
    name: opts.name,
    role: opts.role,
    createdAt: Date.now(),
  };
  await fs.mkdir(assetsDir(gameId), { recursive: true });
  await fs.writeFile(path.join(assetsDir(gameId), asset.file), data);
  await withLock(gameId + ':assets', async () => {
    const idx = await readAssets(gameId);
    idx[id] = asset;
    await writeJsonAtomic(assetsIndexFile(gameId), idx);
  });
  return asset;
}

export async function deleteAssets(gameId: string, ids: string[]) {
  await withLock(gameId + ':assets', async () => {
    const idx = await readAssets(gameId);
    for (const id of ids) {
      const a = idx[id];
      if (!a) continue;
      delete idx[id];
      await fs.rm(path.join(assetsDir(gameId), a.file), { force: true });
    }
    await writeJsonAtomic(assetsIndexFile(gameId), idx);
  });
}

export function assetFilePath(gameId: string, file: string): string {
  if (!/^[a-z0-9_-]+\.[a-z0-9]+$/i.test(file)) throw new NotFound('Invalid asset');
  const p = path.join(assetsDir(gameId), file);
  if (!existsSync(p)) throw new NotFound('Asset not found');
  return p;
}

export function assetStream(gameId: string, file: string) {
  return createReadStream(assetFilePath(gameId, file));
}

/* ---------------- sessions ---------------- */

export async function listSessions(gameId: string): Promise<SessionSummary[]> {
  const dir = sessionsDir(gameId);
  if (!existsSync(dir)) return [];
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  const out: SessionSummary[] = [];
  for (const f of files) {
    try {
      const s = await readJson<Session>(path.join(dir, f));
      out.push({ id: s.id, gameId, name: s.name, createdAt: s.createdAt, updatedAt: s.updatedAt });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readSession(gameId: string, sid: string): Promise<Session> {
  return readJson<Session>(path.join(sessionsDir(gameId), `${safeId(sid)}.json`));
}

export async function saveSession(gameId: string, sid: string | null, body: Partial<Session>): Promise<Session> {
  if (!existsSync(gameFile(gameId))) throw new NotFound('Game not found');
  const id = sid ? safeId(sid) : newId();
  return withLock(`${gameId}:s:${id}`, async () => {
    let existing: Session | null = null;
    try {
      existing = await readSession(gameId, id);
    } catch {
      existing = null;
    }
    const now = Date.now();
    const session: Session = {
      id,
      gameId,
      name: body.name ?? existing?.name ?? 'Session',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      state: body.state ?? existing?.state ?? { entities: {}, order: [], hand: [] },
      notes: body.notes ?? existing?.notes,
    };
    await writeJsonAtomic(path.join(sessionsDir(gameId), `${id}.json`), session);
    return session;
  });
}

export async function deleteSession(gameId: string, sid: string) {
  await fs.rm(path.join(sessionsDir(gameId), `${safeId(sid)}.json`), { force: true });
}

/* ---------------- photo import draft ---------------- */

export async function readPhotoDraft(gameId: string): Promise<unknown | null> {
  if (!existsSync(gameFile(gameId))) throw new NotFound('Game not found');
  try {
    return await readJson<unknown>(photoDraftFile(gameId));
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}



/* ---------------- unified cutter state (v3) ---------------- */

const badRequest = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });

/** The game's cutter.json, or null when the game has none yet (every game before v3). */
export async function readCutter(gameId: string): Promise<CutterDoc | null> {
  if (!existsSync(gameFile(gameId))) throw new NotFound('Game not found');
  try {
    return await readJson<CutterDoc>(cutterFile(gameId));
  } catch (e) {
    if (e instanceof NotFound) return null;
    throw e;
  }
}

/**
 * Replace the cutter state (atomic write, serialised per game). With `baseUpdatedAt` the save
 * only goes through when the file on disk is still that version — so a tablet and a desktop
 * editing the same game can't silently overwrite each other (409 with the current version).
 */
export async function saveCutter(gameId: string, doc: unknown, baseUpdatedAt?: number): Promise<{ ok: true; updatedAt: number }> {
  if (!existsSync(gameFile(gameId))) throw new NotFound('Game not found');
  const errs = validateCutterDoc(doc);
  if (errs.length) throw badRequest(`Invalid cutter state: ${errs.slice(0, 5).join('; ')}`);
  return withLock(gameId + ':cutter', async () => {
    if (baseUpdatedAt != null) {
      const cur = await readCutter(gameId);
      const at = cur?.updatedAt ?? 0;
      if (at !== baseUpdatedAt) throw Object.assign(new Error('The cutter was changed somewhere else. Reload to see the latest.'), { statusCode: 409, updatedAt: at });
    }
    const updatedAt = Math.max(Date.now(), (baseUpdatedAt ?? 0) + 1);
    await writeJsonAtomic(cutterFile(gameId), { ...(doc as CutterDoc), updatedAt });
    return { ok: true as const, updatedAt };
  });
}

export async function deleteCutter(gameId: string) {
  if (!existsSync(gameFile(gameId))) throw new NotFound('Game not found');
  await withLock(gameId + ':cutter', () => fs.rm(cutterFile(gameId), { force: true }));
}

/* ---------------- import / export ---------------- */

export interface ExportOptions {
  sessions?: boolean;
  /** Include the original photos (role 'photo'): big, so opt-in (v3 Q4). */
  photos?: boolean;
}

export async function exportGame(gameId: string, opts: ExportOptions | boolean = {}): Promise<Uint8Array> {
  const { sessions: withSessions = false, photos = false } = typeof opts === 'boolean' ? { sessions: opts } : opts;
  const game = await readJson<Game>(gameFile(gameId));
  // original photos are working files, not part of the game — unless asked for
  const assets = Object.fromEntries(Object.entries(await readAssets(gameId)).filter(([, a]) => photos || a.role !== 'photo'));
  const files: Record<string, Uint8Array> = {
    'pnpforge.json': strToU8(JSON.stringify({ format: 'pnpforge', version: 1, exportedAt: Date.now() })),
    'game.json': strToU8(JSON.stringify(game)),
    'assets.json': strToU8(JSON.stringify(assets)),
  };
  // the cutter state always travels with the game (small); without the photos, photo pages come back empty
  if (existsSync(cutterFile(gameId))) files['cutter.json'] = new Uint8Array(await fs.readFile(cutterFile(gameId)));
  for (const a of Object.values(assets)) {
    try {
      files[`assets/${a.file}`] = [new Uint8Array(await fs.readFile(path.join(assetsDir(gameId), a.file))), { level: 0 }] as any;
    } catch {
      /* missing file */
    }
  }
  if (withSessions) {
    const dir = sessionsDir(gameId);
    if (existsSync(dir)) {
      for (const f of await fs.readdir(dir)) {
        if (f.endsWith('.json')) files[`sessions/${f}`] = new Uint8Array(await fs.readFile(path.join(dir, f)));
      }
    }
  }
  return zipSync(files as any, { level: 6 });
}

export async function importGame(zip: Uint8Array): Promise<Game> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip);
  } catch {
    throw Object.assign(new Error('That file is not a valid pnpforge archive.'), { statusCode: 400 });
  }
  if (!entries['game.json']) {
    throw Object.assign(new Error('Archive is missing game.json — is this a pnpforge export?'), { statusCode: 400 });
  }
  const game = JSON.parse(strFromU8(entries['game.json'])) as Game;
  const assets = entries['assets.json']
    ? (JSON.parse(strFromU8(entries['assets.json'])) as Record<string, Asset>)
    : {};
  const id = newId();
  const dir = gameDir(id);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith('assets/') && name.length > 7) {
      const file = path.basename(name);
      if (/^[a-z0-9_-]+\.[a-z0-9]+$/i.test(file)) await fs.writeFile(path.join(dir, 'assets', file), data);
    } else if (name.startsWith('sessions/') && name.endsWith('.json')) {
      const s = JSON.parse(strFromU8(data)) as Session;
      s.gameId = id;
      await writeJsonAtomic(path.join(dir, 'sessions', `${safeId(s.id)}.json`), s);
    }
  }
  const now = Date.now();
  const saved = { ...game, id, updatedAt: now } as Game;
  delete (saved as Partial<Game>).assets;
  if (entries['cutter.json']) {
    // an unreadable or invalid cutter state is left behind rather than failing the whole import
    try {
      const cutter = JSON.parse(strFromU8(entries['cutter.json']));
      if (!validateCutterDoc(cutter).length) await writeJsonAtomic(path.join(dir, 'cutter.json'), cutter);
    } catch {
      /* skip */
    }
  }
  await writeJsonAtomic(path.join(dir, 'game.json'), saved);
  await writeJsonAtomic(path.join(dir, 'assets.json'), assets);
  return { ...saved, assets };
}

export async function duplicateGame(gameId: string, opts: { photos?: boolean } = {}): Promise<Game> {
  const zip = await exportGame(gameId, { sessions: false, photos: !!opts.photos });
  const copy = await importGame(zip);
  copy.name = `${copy.name} (copy)`;
  return saveGame(copy.id, copy);
}

/* ---------------- app settings ---------------- */

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/** Raw file contents (unknown keys included); `{}` when missing or unreadable. */
async function readSettingsRaw(): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    // missing, or a hand-edited file that no longer parses — fall back to defaults
    return {};
  }
}

/** `updatedAt` is 0 until any device has saved settings (used by the client's one-time migration). */
export type StoredSettings = AppSettings & { updatedAt: number };

const withStamp = (raw: Record<string, unknown>): StoredSettings => ({
  ...normalizeSettings(raw),
  updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
});

export async function readSettings(): Promise<StoredSettings> {
  return withStamp(await readSettingsRaw());
}

/**
 * Merge a partial update into data/settings.json. Invalid values and unknown keys in the
 * patch are ignored; unknown keys already on disk (from a newer build) are preserved.
 */
export function patchSettings(patch: unknown): Promise<StoredSettings> {
  return withLock('settings', async () => {
    const cur = await readSettingsRaw();
    const next = { ...cur, ...sanitizeSettingsPatch(patch), updatedAt: Date.now() };
    await writeJsonAtomic(SETTINGS_FILE, next);
    return withStamp(next);
  });
}
