import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import * as store from './storage.js';

/**
 * On first run (no games at all) import the bundled demo game(s) from
 * samples/*.pnpforge so a new user immediately has something to play.
 * A marker file prevents re-seeding after the user deletes the demo.
 */
export async function seedIfEmpty() {
  const marker = path.join(store.DATA_DIR, '.seeded');
  if (existsSync(marker)) return;
  const games = await store.listGames();
  const dir = path.resolve(process.cwd(), 'samples');
  if (games.length === 0 && existsSync(dir)) {
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.pnpforge')) continue;
      await store.importGame(new Uint8Array(await fs.readFile(path.join(dir, f))));
    }
  }
  await fs.writeFile(marker, new Date().toISOString());
}
