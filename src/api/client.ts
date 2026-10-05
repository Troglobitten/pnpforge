import type { Asset, AssetRole, CutterDoc, Game, GameSummary, ID, Session, SessionSummary } from '@/shared/types';
import type { AppSettings, SettingsPatch } from '@/shared/settings';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

/** Multipart upload with progress (0..1). */
function upload<T>(url: string, form: FormData, onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as T);
      else reject(new ApiError(xhr.response?.error ?? `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Network error during upload', 0));
    xhr.send(form);
  });
}

export const api = {
  /** `updatedAt` is 0 until settings have ever been saved on this server. */
  getSettings: () => req<AppSettings & { updatedAt: number }>('GET', '/api/settings'),
  saveSettings: (patch: SettingsPatch) => req<AppSettings & { updatedAt: number }>('PUT', '/api/settings', patch),

  listGames: () => req<GameSummary[]>('GET', '/api/games'),
  createGame: (name: string, partial?: Partial<Game>) => req<Game>('POST', '/api/games', { ...partial, name }),
  getGame: (id: ID) => req<Game>('GET', `/api/games/${id}`),
  saveGame: (game: Game) => req<Game>('PUT', `/api/games/${game.id}`, { ...game, assets: undefined }),
  deleteGame: (id: ID) => req<{ ok: true }>('DELETE', `/api/games/${id}`),
  /** `photos`: also copy the original photos (v3 Q4: opt-in). */
  duplicateGame: (id: ID, opts: { photos?: boolean } = {}) => req<Game>('POST', `/api/games/${id}/duplicate${opts.photos ? '?photos=1' : ''}`),

  /**
   * Upload one or more files/blobs. Blobs without a name get `fallbackName`.
   * Uploading many small files? Batch them (e.g. 20 per call) for progress UX.
   */
  uploadAssets: (
    gameId: ID,
    files: (File | { blob: Blob; name: string })[],
    opts: { role?: AssetRole; onProgress?: (p: number) => void } = {},
  ) => {
    const form = new FormData();
    for (const f of files) {
      if (f instanceof File) form.append('file', f, f.name);
      else form.append('file', f.blob, f.name);
    }
    const q = opts.role ? `?role=${opts.role}` : '';
    return upload<Asset[]>(`/api/games/${gameId}/assets${q}`, form, opts.onProgress);
  },
  deleteAssets: (gameId: ID, ids: ID[]) => req<{ ok: true }>('POST', `/api/games/${gameId}/assets/delete`, { ids }),

  /** Photo import draft (see features/photos/persist). */
  /** Read-only, for the v3 migration: the retired photo importer's draft (no writes any more). */
  getPhotoDraft: <T = unknown>(gameId: ID) => req<{ draft: T | null }>('GET', `/api/games/${gameId}/photo-draft`),

  /** v3 unified cutter state; `cutter` is null for a game that has none yet. */
  getCutter: (gameId: ID) => req<{ cutter: CutterDoc | null }>('GET', `/api/games/${gameId}/cutter`),
  /** With `baseUpdatedAt`, fails with 409 when the state changed elsewhere since that version. */
  saveCutter: (gameId: ID, doc: CutterDoc, baseUpdatedAt?: number) =>
    req<{ ok: true; updatedAt: number }>('PUT', `/api/games/${gameId}/cutter${baseUpdatedAt != null ? `?base=${baseUpdatedAt}` : ''}`, doc),
  deleteCutter: (gameId: ID) => req<{ ok: true }>('DELETE', `/api/games/${gameId}/cutter`),

  listSessions: (gameId: ID) => req<SessionSummary[]>('GET', `/api/games/${gameId}/sessions`),
  getSession: (gameId: ID, sid: ID) => req<Session>('GET', `/api/games/${gameId}/sessions/${sid}`),
  createSession: (gameId: ID, body: Partial<Session>) => req<Session>('POST', `/api/games/${gameId}/sessions`, body),
  saveSession: (gameId: ID, sid: ID, body: Partial<Session>) => req<Session>('PUT', `/api/games/${gameId}/sessions/${sid}`, body),
  deleteSession: (gameId: ID, sid: ID) => req<{ ok: true }>('DELETE', `/api/games/${gameId}/sessions/${sid}`),

  exportUrl: (gameId: ID, withSessions = false, withPhotos = false) => {
    const q = [withSessions && 'sessions=1', withPhotos && 'photos=1'].filter(Boolean).join('&');
    return `/api/games/${gameId}/export${q ? `?${q}` : ''}`;
  },
  importGame: (file: File, onProgress?: (p: number) => void) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return upload<Game>('/api/import', form, onProgress);
  },
};

/** URL for an asset file. Accepts the Asset or its on-disk filename. */
export function assetUrl(gameId: ID, asset: Asset | string | null | undefined): string | undefined {
  if (!asset) return undefined;
  const file = typeof asset === 'string' ? asset : asset.file;
  return `/api/games/${gameId}/assets/${file}`;
}

/** Resolve an asset id within a loaded game to its URL. */
export function assetUrlById(game: Pick<Game, 'id' | 'assets'> | null | undefined, id: ID | null | undefined) {
  if (!game || !id) return undefined;
  const a = game.assets[id];
  return a ? assetUrl(game.id, a) : undefined;
}
