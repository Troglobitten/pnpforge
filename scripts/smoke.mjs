/**
 * API smoke test. Checks that the server is up and its main routes answer — no
 * browser, no UI. Creates one game of its own, exercises it, deletes it, and
 * never touches a game it did not create.
 *
 *   node scripts/smoke.mjs [http://localhost:3717]
 */
const BASE = process.argv[2] ?? 'http://localhost:3717';

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => (cond ? (pass++, console.log(`  ok   ${name}`)) : (fails.push(name), console.log(`  FAIL ${name} ${detail}`)));

const api = async (method, path, body, raw) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body && !raw ? { 'content-type': 'application/json' } : undefined,
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: r.status, json, text };
};

const before = await api('GET', '/api/games');
ok('GET /api/games', before.status === 200 && Array.isArray(before.json), `status ${before.status}`);
if (before.status !== 200) {
  console.log(`\nServer not answering at ${BASE} — start it with \`npm run dev\`.`);
  process.exit(1);
}
const owned = before.json.map((g) => g.id);

const made = await api('POST', '/api/games', { title: 'smoke test' });
ok('POST /api/games', made.status === 200 && !!made.json?.id, `status ${made.status}`);
const id = made.json?.id;
if (!id) process.exit(1);

try {
  const got = await api('GET', `/api/games/${id}`);
  ok('GET /api/games/:id', got.status === 200 && got.json?.id === id);

  const saved = await api('PUT', `/api/games/${id}`, { ...got.json, title: 'smoke test renamed' });
  ok('PUT /api/games/:id', saved.status === 200);
  ok('the rename stuck', (await api('GET', `/api/games/${id}`)).json?.title === 'smoke test renamed');

  ok('a missing asset file is a 404', (await api('GET', `/api/games/${id}/assets/nosuchfile.webp`)).status === 404);
  ok('GET /api/games/:id/cutter on an uncut game', (await api('GET', `/api/games/${id}/cutter`)).status === 200);
  ok('GET /api/settings', (await api('GET', '/api/settings')).status === 200);

  const dup = await api('POST', `/api/games/${id}/duplicate`);
  ok('POST /api/games/:id/duplicate', dup.status === 200 && !!dup.json?.id);
  if (dup.json?.id) {
    const gone = await api('DELETE', `/api/games/${dup.json.id}`);
    ok('DELETE a duplicate', gone.status === 200);
  }

  ok('a missing game is a 404', (await api('GET', '/api/games/nosuchgameid')).status === 404);
} finally {
  const gone = await api('DELETE', `/api/games/${id}`);
  ok('DELETE /api/games/:id', gone.status === 200);
}

const after = await api('GET', '/api/games');
const left = after.json.filter((g) => !owned.includes(g.id)).map((g) => g.id);
ok('nothing of mine is left behind', left.length === 0, left.join(', '));
ok('every pre-existing game is still there', owned.every((g) => after.json.some((x) => x.id === g)));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);
