import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import * as store from './storage.js';
import type { Game, Session } from '../src/shared/types.js';
import { seedIfEmpty } from './seed.js';

const PORT = Number(process.env.PNPFORGE_PORT ?? 3717);
const HOST = process.env.PNPFORGE_HOST ?? '0.0.0.0';
const DIST = path.resolve(process.cwd(), 'dist');

const app = Fastify({
  logger: { level: process.env.PNPFORGE_LOG ?? 'warn' },
  bodyLimit: 128 * 1024 * 1024,
});

await app.register(multipart, {
  limits: { fileSize: 1024 * 1024 * 1024, files: 2000, fields: 50 },
});

app.setErrorHandler((err: any, _req, reply) => {
  const code = err.statusCode ?? 500;
  if (code >= 500) app.log.error(err);
  reply.code(code).send({ error: err.message ?? 'Server error', ...(typeof err.updatedAt === 'number' ? { updatedAt: err.updatedAt } : {}) });
});

type P = { id: string };
type PS = { id: string; sid: string };

/* ---------------- app settings ---------------- */

app.get('/api/settings', async () => store.readSettings());

app.put<{ Body: unknown }>('/api/settings', async (req) => store.patchSettings(req.body ?? {}));

/* ---------------- games ---------------- */

app.get('/api/health', async () => ({ ok: true, data: store.DATA_DIR }));

app.get('/api/games', async () => store.listGames());

app.post<{ Body: Partial<Game> & { name?: string } }>('/api/games', async (req) => {
  const { name = 'Untitled game', ...rest } = req.body ?? {};
  return store.createGame(name, rest);
});

app.get<{ Params: P }>('/api/games/:id', async (req) => store.readGame(req.params.id));

app.put<{ Params: P; Body: Game }>('/api/games/:id', async (req) => store.saveGame(req.params.id, req.body));

app.delete<{ Params: P }>('/api/games/:id', async (req) => {
  await store.deleteGame(req.params.id);
  return { ok: true };
});

app.post<{ Params: P; Querystring: { photos?: string } }>('/api/games/:id/duplicate', async (req) =>
  store.duplicateGame(req.params.id, { photos: req.query.photos === '1' }),
);

/* ---------------- assets ---------------- */

app.post<{ Params: P; Querystring: { role?: string } }>('/api/games/:id/assets', async (req) => {
  const out = [];
  for await (const part of req.parts()) {
    if (part.type !== 'file') continue;
    const buf = await part.toBuffer();
    out.push(
      await store.addAsset(req.params.id, buf, {
        name: part.filename,
        mime: part.mimetype,
        role: (req.query.role as any) ?? undefined,
      }),
    );
  }
  return out;
});

app.post<{ Params: P; Body: { ids: string[] } }>('/api/games/:id/assets/delete', async (req) => {
  await store.deleteAssets(req.params.id, req.body?.ids ?? []);
  return { ok: true };
});

app.get<{ Params: { id: string; file: string } }>('/api/games/:id/assets/:file', async (req, reply) => {
  const file = req.params.file;
  const p = store.assetFilePath(req.params.id, file);
  const ext = file.split('.').pop()!.toLowerCase();
  const stat = await fs.stat(p);
  reply
    .header('Content-Type', store.MIME_BY_EXT[ext] ?? 'application/octet-stream')
    .header('Content-Length', stat.size)
    .header('Cache-Control', 'public, max-age=31536000, immutable');
  return reply.send(store.assetStream(req.params.id, file));
});

/* ---------------- photo import draft ---------------- */

/** Retired with the photo importer (v3): the draft can still be READ, for the migration. */
app.get<{ Params: P }>('/api/games/:id/photo-draft', async (req) => ({ draft: await store.readPhotoDraft(req.params.id) }));

/* ---------------- unified cutter (v3) ---------------- */

/** `{ cutter: null }` for a game that has no cutter state yet. */
app.get<{ Params: P }>('/api/games/:id/cutter', async (req) => ({ cutter: await store.readCutter(req.params.id) }));

/** Body: the CutterDoc. `?base=<updatedAt>` = only if unchanged since (409 otherwise). */
app.put<{ Params: P; Body: unknown; Querystring: { base?: string } }>('/api/games/:id/cutter', async (req) => {
  const base = req.query.base != null && req.query.base !== '' ? Number(req.query.base) : undefined;
  if (base != null && !Number.isFinite(base)) throw Object.assign(new Error('Invalid base'), { statusCode: 400 });
  return store.saveCutter(req.params.id, req.body, base);
});

app.delete<{ Params: P }>('/api/games/:id/cutter', async (req) => {
  await store.deleteCutter(req.params.id);
  return { ok: true };
});

/* ---------------- sessions ---------------- */

app.get<{ Params: P }>('/api/games/:id/sessions', async (req) => store.listSessions(req.params.id));

app.post<{ Params: P; Body: Partial<Session> }>('/api/games/:id/sessions', async (req) =>
  store.saveSession(req.params.id, null, req.body ?? {}),
);

app.get<{ Params: PS }>('/api/games/:id/sessions/:sid', async (req) => store.readSession(req.params.id, req.params.sid));

app.put<{ Params: PS; Body: Partial<Session> }>('/api/games/:id/sessions/:sid', async (req) =>
  store.saveSession(req.params.id, req.params.sid, req.body ?? {}),
);

app.delete<{ Params: PS }>('/api/games/:id/sessions/:sid', async (req) => {
  await store.deleteSession(req.params.id, req.params.sid);
  return { ok: true };
});

/* ---------------- import / export ---------------- */

app.get<{ Params: P; Querystring: { sessions?: string; photos?: string } }>('/api/games/:id/export', async (req, reply) => {
  const game = await store.readGame(req.params.id);
  const zip = await store.exportGame(req.params.id, { sessions: req.query.sessions === '1', photos: req.query.photos === '1' });
  const safe = game.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'game';
  reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', `attachment; filename="${safe}.pnpforge"`);
  return reply.send(Buffer.from(zip));
});

app.post('/api/import', async (req) => {
  const file = await req.file();
  if (!file) throw Object.assign(new Error('No file uploaded'), { statusCode: 400 });
  const buf = await file.toBuffer();
  return store.importGame(new Uint8Array(buf));
});

/* ---------------- production static ---------------- */

if (existsSync(DIST)) {
  await app.register(fastifyStatic, { root: DIST, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.type('text/html').sendFile('index.html');
    }
    reply.code(404).send({ error: 'Not found' });
  });
}

await store.ensureDataDirs();
await seedIfEmpty().catch((e) => app.log.warn(`demo seed skipped: ${e?.message ?? e}`));
await app.listen({ port: PORT, host: HOST });
console.log(`pnpforge api listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${store.DATA_DIR})`);
