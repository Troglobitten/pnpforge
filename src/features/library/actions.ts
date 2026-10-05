import { api } from '@/api/client';
import { setPendingUploads } from '@/state/pendingUploads';
import type { Game } from '@/shared/types';
import { isSourceFile, nameFromFiles } from './util';

/**
 * Create a game (named after the files unless a name is given) and hand the
 * PnP files to the Sources page, which imports them with its progress UI.
 */
export async function createGameFromFiles(files: File[], name?: string): Promise<Game> {
  const game = await api.createGame(name?.trim() || nameFromFiles(files));
  const sources = files.filter(isSourceFile);
  if (sources.length) setPendingUploads(game.id, sources);
  return game;
}
